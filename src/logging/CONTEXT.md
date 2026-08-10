# CONTEXT

> 마지막 업데이트: 2026-08-10

## 역할

pino 기반 구조화 로깅을 담는다. 도메인 코드는 pino를 모른다 — `new Logger(X.name)`를 그대로 쓰고, `main.ts`의 `app.useLogger()`가 출력을 전부 이 폴더의 어댑터로 보낸다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `pino-logger.service.ts` | pino를 NestJS `LoggerService`에 맞춘 어댑터. 레벨 매핑(`log`→info, `verbose`→trace, `fatal`→fatal)과 민감 키 redact를 담당 |
| `request-logging.middleware.ts` | 요청 수신·응답 완료를 info 2건으로 남긴다 — method, url(쿼리를 뗀 경로), query, body, 상태 코드, 수신·응답 시각, 소요 시간(ms) |
| `logging.module.ts` | `PinoLoggerService` 등록·export. `main.ts`가 `app.get()`으로 꺼낸다 |
| `process-error-handlers.ts` | `uncaughtException`·`unhandledRejection`을 fatal로 남기고 프로세스를 살려 두는 등록 함수 |

## 핵심 로직

**앱 로거 등록은 `main.ts` 두 줄이 한 쌍이다.** `NestFactory.create(AppModule, { bufferLogs: true })` + `app.useLogger(app.get(PinoLoggerService))` — `bufferLogs`가 없으면 DI 컨테이너가 서기 전의 부팅 로그만 Nest 기본 포맷으로 갈라진다. 이 배선은 `bootstrap()`에 있어 테스트가 지나지 않는다(`src/common/CONTEXT.md`의 같은 문제) — e2e는 `createNestApplication()`으로 부트해 `useLogger`를 거치지 않으므로, **Nest `Logger`를 경유하는 로그(부팅 로그, `PrismaService`의 커넥션 로그 등)는 e2e 출력에 pino JSON으로 나오지 않는다.** 반면 `RequestLoggingMiddleware`는 `PinoLoggerService`를 의존성 주입으로 직접 받아 stdout에 쓰므로, **요청·응답 로그는 e2e 출력에도 pino JSON으로 나온다**(실측) — e2e 출력에 JSON 줄이 섞여 있어도 이상이 아니다.

**민감 키 redact는 로거 출구 한 곳에서 강제한다.** `body`·`query` 아래의 `SENSITIVE_LOG_KEYS`를 `[REDACTED]`로 가린다 — 값을 넘기는 호출 지점마다 가리게 하면 빠뜨린 곳이 생긴다. query도 대상인 이유는 `/password-reset?token=…`처럼 민감값이 쿼리로도 오기 때문이다. 깊이는 각 필드 바로 아래와 한 단계 중첩까지다(fast-redact 와일드카드가 단계마다 경로를 요구해 상한이 필요하고, 이 API의 body는 평평한 DTO, query는 Express 확장 파서의 한 단계 중첩까지다). **redact는 부분 문자열을 가리지 못한다**(실측) — 그래서 미들웨어의 url 필드는 쿼리 문자열을 뗀 경로만 담는다. URL 원문을 통째로 로그 필드에 넣지 마라.

**레벨 필터가 없다(`level: 'trace'`).** Nest 기본 로거도 전부 내보낸다. 필터 요구가 생기면 환경변수로 뺀다.

**요청 로깅 배선은 `AppModule.configure`에 있다.** 전역(`forRoutes('*')`)에 걸되 `/api/ping`만 exclude한다 — k8s 프로브가 수 초마다 때려서, 남기면 로그가 프로브 기록에 잠긴다. ping 경로를 바꾸면 그 exclude도 함께 바꿔야 한다. 미들웨어는 body를 가리지 않고 그대로 넘긴다 — 가리는 것은 로거 출구의 redact다. 응답 로그는 `close`가 아니라 `finish` 이벤트에 건다(close는 전송 완료 전 커넥션이 끊겨도 발생한다). URL fragment(`#…`)는 브라우저가 서버로 보내지 않아 로그 항목에 없다(2026-08-10 사용자 확정).

**프로세스 오류 핸들러는 DI Provider가 아니라 함수다.** 프로세스 전역(리스너)을 만지는 배선이라 Nest 라이프사이클에 묶으면 앱 인스턴스가 여럿일 때(테스트) 리스너가 중복 등록된다 — `main.ts`가 부팅 시 한 번 부른다. 리스너를 다는 것만으로 Node 기본 동작(uncaughtException 즉시 종료)이 대체되며, 프로세스를 살리는 것은 사용자 명시 요청이다. **등록 함수는 해제 함수를 반환한다** — 프로세스 전역을 만지는 spec은 그것으로 반드시 원상 복구한다(`src/common/CONTEXT.md`의 프로토타입 규칙과 같은 원리). spec은 `process.emit`으로 발화시키지 않는다 — jest 자체 리스너까지 불려 러너가 오작동하므로, 등록 전후 리스너 차집합으로 우리 리스너만 직접 부른다.

**테스트는 출력을 관찰한다.** `PINO_DESTINATION` 토큰(optional)으로 sink 스트림을 주입해 pino가 실제로 내보낸 JSON 줄을 파싱해 단정한다 — pino 내부 상태를 들여다보지 않는다.

## 의존성

- `pino` — 구조화 JSON 로거. 어댑터 파일만 의존하고 도메인 코드로 새어 나가지 않는다
- `@nestjs/common` — `LoggerService` 인터페이스(10.4부터 `fatal` 지원), DI 데코레이터
