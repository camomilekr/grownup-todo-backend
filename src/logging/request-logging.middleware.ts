import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { PinoLoggerService } from './pino-logger.service';

/**
 * 로그에 담는 응답 본문의 상한(직렬화 기준 바이트). Docker json-file 로그
 * 드라이버가 한 줄 16KB 초과분을 분할해 JSON 줄이 깨지므로, 나머지 필드
 * 여유를 남기고 10KB로 자른다 — 로그는 관찰용이지 응답의 사본이 아니다.
 */
const MAX_LOGGED_RESPONSE_BODY_BYTES = 10 * 1024;

/**
 * 캡처한 응답 본문을 로그에 담을 수 있는 형태로 줄인다. 구조화된 객체는
 * 그대로 통과시켜야 로거 출구의 redact가 키 단위로 작동한다 — 대체 표기로
 * 바뀌는 경우는 본문 전체가 사라지므로 민감값도 함께 사라진다.
 */
function summarizeResponseBody(body: unknown): unknown {
  if (Buffer.isBuffer(body)) {
    // 바이너리는 로그에 원문으로 담을 수 없다
    return `[버퍼 응답 본문 생략: ${body.length} bytes]`;
  }

  let serialized: string | undefined;
  try {
    serialized = typeof body === 'string' ? body : JSON.stringify(body);
  } catch {
    // 직렬화가 던지는 본문(BigInt 가드가 꺼진 환경, 순환 참조)이 로그
    // 때문에 응답 흐름을 깨뜨리지 않게 막는다
    return '[직렬화할 수 없는 응답 본문]';
  }
  if (typeof serialized !== 'string') {
    // `JSON.stringify`는 던지는 대신 undefined를 반환하기도 한다 —
    // `{ toJSON: () => undefined }`·함수가 그 예다(실측). 바이트 계산에
    // 들어가면 TypeError로 응답 로그가 유실되므로 여기서 빠진다.
    return '[직렬화할 수 없는 응답 본문]';
  }

  if (Buffer.byteLength(serialized) > MAX_LOGGED_RESPONSE_BODY_BYTES) {
    return `[대형 응답 본문 생략: ${Buffer.byteLength(serialized)} bytes]`;
  }
  return body;
}

/**
 * 모든 요청의 수신과 응답 완료를 info로 남긴다.
 *
 * body(요청 본문)·responseBody(응답 본문)는 그대로 넘긴다 — 민감 키
 * (password·token 등)는 로거 출구의 pino `redact`가 가린다
 * (`pino-logger.service.ts`). 여기서 가리지 않는 이유는 가리는 지점이
 * 흩어지면 빠뜨린 곳이 생기기 때문이다.
 *
 * 응답 본문 캡처는 인터셉터가 아니라 `res.json`·`res.send` 래핑이다 —
 * 인터셉터는 컨트롤러 성공 경로만 보고 예외 필터가 내보내는 오류 응답을
 * 놓치며, 로깅 배선이 두 곳으로 갈라진다. `res.write`로 직접 스트리밍하는
 * 응답은 잡지 못한다 — 이 API에 스트리밍 응답이 없어 감수하고, 생기면
 * 그 라우트만 별도 처리한다.
 *
 * URL fragment(`#…`)는 항목에 없다 — 브라우저가 서버로 보내지 않아 여기서는
 * 존재하지 않는다(2026-08-10 사용자 확정).
 *
 * `/api/ping`은 이 미들웨어를 타지 않는다 — `AppModule.configure`의 exclude.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: PinoLoggerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const receivedAtMs = Date.now();
    const receivedAt = new Date(receivedAtMs).toISOString();

    // originalUrl에서 쿼리 문자열을 떼고 경로만 남긴다. `?token=…` 같은
    // 민감값이 url 원문에 실리면 redact가 부분 문자열을 가리지 못해 그대로
    // 출력된다(실측) — 쿼리 정보는 redact가 적용되는 구조화된 query 필드가
    // 담당한다. req.url이 아니라 originalUrl인 이유는 라우터가 req.url을
    // 다시 쓸 수 있기 때문이다.
    const requestFields = {
      method: req.method,
      url: req.originalUrl.split('?')[0],
      query: req.query,
      body: req.body as unknown,
    };

    this.logger.log(
      { event: 'request', ...requestFields, receivedAt },
      RequestLoggingMiddleware.name,
    );

    // 응답 본문 캡처 — `res.json`에서 직렬화 전 객체를 잡아야 redact가 키
    // 단위로 작동한다. 문자열·버퍼 응답('pong' 등)은 json을 거치지 않으므로
    // `res.send`도 래핑하되, Express json이 내부에서 직렬화된 문자열로 send를
    // 다시 부르기 때문에 이미 잡은 구조화 본문을 덮지 않는다.
    let responseBody: unknown;
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      responseBody = body;
      return originalJson(body);
    }) as Response['json'];
    const originalSend = res.send.bind(res);
    res.send = ((body: unknown) => {
      if (responseBody === undefined) {
        responseBody = body;
      }
      return originalSend(body);
    }) as Response['send'];

    // 응답 로그는 `close`가 아니라 `finish`에 건다 — finish가 "응답을 다
    // 내보냈다"이고, close는 전송 완료 전에 커넥션이 끊겨도 발생한다.
    res.on('finish', () => {
      const respondedAtMs = Date.now();
      this.logger.log(
        {
          event: 'response',
          ...requestFields,
          statusCode: res.statusCode,
          // 본문 없이 끝난 응답(204 등)에는 필드 자체를 넣지 않는다 —
          // null·빈 문자열과 "본문 없음"이 로그에서 구별돼야 한다
          ...(responseBody !== undefined && {
            responseBody: summarizeResponseBody(responseBody),
          }),
          receivedAt,
          respondedAt: new Date(respondedAtMs).toISOString(),
          durationMs: respondedAtMs - receivedAtMs,
        },
        RequestLoggingMiddleware.name,
      );
    });

    next();
  }
}
