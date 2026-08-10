import { Inject, Injectable, LoggerService, Optional } from '@nestjs/common';
import pino from 'pino';

/**
 * 테스트가 출력을 관찰할 수 있게 pino의 목적지 스트림을 주입하는 토큰.
 * 클래스가 아닌 것을 주입하므로 문자열 대신 상수 토큰을 쓴다(코드 규약).
 * 주입하지 않으면 pino 기본 목적지(stdout)로 나간다.
 */
export const PINO_DESTINATION = Symbol('PINO_DESTINATION');

/**
 * 요청 body·query 로그에서 가리는 민감 키. 어떤 경우에도 토큰·비밀번호가
 * 로그에 남지 않게 하는 방어선이다 — 미들웨어가 아니라 로거에 두는 이유는,
 * 값을 넘기는 모든 호출 지점이 아니라 출구 한 곳에서 강제하기 위해서다.
 * query도 대상이다 — `/password-reset?token=…`처럼 민감값은 쿼리로도 온다.
 */
const SENSITIVE_LOG_KEYS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'secret',
  'cookie',
];

/**
 * pino를 NestJS `LoggerService`에 맞춘 어댑터.
 *
 * `main.ts`가 `app.useLogger()`로 앱 로거로 등록하므로, 도메인 코드가 쓰는
 * `new Logger(X.name)` 출력까지 전부 여기를 지나 pino JSON으로 나간다 —
 * 도메인 코드는 pino를 모른다.
 */
@Injectable()
export class PinoLoggerService implements LoggerService {
  private readonly pino: pino.Logger;

  constructor(
    @Optional()
    @Inject(PINO_DESTINATION)
    destination?: pino.DestinationStream,
  ) {
    this.pino = pino(
      {
        // 레벨 필터를 걸지 않는다(trace = 전부 통과). Nest 기본 로거도 모든
        // 레벨을 내보내며, 필터 요구가 생기면 그때 환경변수로 뺀다.
        level: 'trace',
        redact: {
          // body·query 각각 바로 아래와 한 단계 중첩까지 가린다. 더 깊은
          // 중첩은 fast-redact 와일드카드가 단계마다 경로를 요구해 상한을
          // 정해야 하는데, 이 API의 body는 평평한 DTO이고 query도 Express
          // 확장 파서의 한 단계 중첩(`?auth[token]=…`)까지면 전부 덮는다.
          paths: ['body', 'query'].flatMap((field) =>
            SENSITIVE_LOG_KEYS.flatMap((key) => [
              `${field}.${key}`,
              `${field}.*.${key}`,
            ]),
          ),
          censor: '[REDACTED]',
        },
      },
      destination,
    );
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams, true);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams, true);
  }

  private write(
    level: pino.Level,
    message: unknown,
    optionalParams: unknown[],
    // NestJS 관례로 error·fatal은 `(message, stack, context)`로 불린다 —
    // 그 두 레벨에서만 남은 문자열을 stack으로 해석한다
    stackExpected = false,
  ): void {
    const params = [...optionalParams];

    // NestJS Logger 관례 — 마지막 문자열 인자가 컨텍스트 이름이다
    const context =
      typeof params[params.length - 1] === 'string'
        ? (params.pop() as string)
        : undefined;

    const fields: Record<string, unknown> = {};
    if (context !== undefined) {
      fields.context = context;
    }
    if (stackExpected && typeof params[0] === 'string') {
      fields.stack = params[0];
    }

    if (message instanceof Error) {
      // pino 표준 직렬화 대상 필드는 `err`다 — stack·message가 구조화된다
      this.pino[level]({ ...fields, err: message }, message.message);
    } else if (typeof message === 'object' && message !== null) {
      this.pino[level]({ ...fields, ...message });
    } else {
      this.pino[level](fields, String(message));
    }
  }
}
