import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { PinoLoggerService } from './pino-logger.service';

/**
 * 모든 요청의 수신과 응답 완료를 info로 남긴다.
 *
 * body는 그대로 넘긴다 — 민감 키(password·token 등)는 로거 출구의 pino
 * `redact`가 가린다(`pino-logger.service.ts`). 여기서 가리지 않는 이유는
 * 가리는 지점이 흩어지면 빠뜨린 곳이 생기기 때문이다.
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

    // 응답 로그는 `close`가 아니라 `finish`에 건다 — finish가 "응답을 다
    // 내보냈다"이고, close는 전송 완료 전에 커넥션이 끊겨도 발생한다.
    res.on('finish', () => {
      const respondedAtMs = Date.now();
      this.logger.log(
        {
          event: 'response',
          ...requestFields,
          statusCode: res.statusCode,
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
