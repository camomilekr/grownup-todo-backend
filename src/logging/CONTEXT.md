# CONTEXT

> 마지막 업데이트: 2026-08-13

## 역할

pino 기반 구조화 로깅을 담는다. 도메인 코드는 pino를 모른다 — `new Logger(X.name)`를 그대로 쓰고, `main.ts`의 `app.useLogger()`가 출력을 전부 이 폴더의 어댑터로 보낸다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `pino-logger.service.ts` | pino를 NestJS `LoggerService`에 맞춘 어댑터. 레벨 매핑(`log`→info, `verbose`→trace, `fatal`→fatal)·민감 키 redact·기본 목적지(동기 쓰기 stdout) 생성을 담당 |
| `request-logging.middleware.ts` | 요청 수신·응답 완료를 info 2건으로 남긴다 — method, url(쿼리를 뗀 경로), query, body(요청 본문), responseBody(응답 본문, 응답 로그에만), 상태 코드, 수신·응답 시각, 소요 시간(ms) |
| `logging.module.ts` | `PinoLoggerService` 등록·export. `main.ts`가 `app.get()`으로 꺼낸다 |
| `process-error-handlers.ts` | `uncaughtException`·`unhandledRejection`을 fatal로 남기고 프로세스를 살려 두는 등록 함수 |

## 핵심 로직

**앱 로거 등록은 `main.ts` 두 줄이 한 쌍이다.** `NestFactory.create(AppModule, { bufferLogs: true })` + `app.useLogger(app.get(PinoLoggerService))` — `bufferLogs`가 없으면 DI 컨테이너가 서기 전의 부팅 로그만 Nest 기본 포맷으로 갈라진다. 이 배선은 `bootstrap()`에 있어 테스트가 지나지 않는다(`src/common/CONTEXT.md`의 같은 문제) — e2e는 `createNestApplication()`으로 부트해 `useLogger`를 거치지 않으므로, **Nest `Logger`를 경유하는 로그(부팅 로그, `PrismaService`의 커넥션 로그 등)는 e2e 출력에 pino JSON으로 나오지 않는다.** 반면 `RequestLoggingMiddleware`는 `PinoLoggerService`를 의존성 주입으로 직접 받아 stdout에 쓰므로, **요청·응답 로그는 e2e 출력에도 pino JSON으로 나온다**(실측) — e2e 출력에 JSON 줄이 섞여 있어도 이상이 아니다.

**민감 키 redact는 로거 출구 한 곳에서 강제한다.** `body`·`query`·`responseBody` 아래의 `SENSITIVE_LOG_KEYS`를 `[REDACTED]`로 가린다 — 값을 넘기는 호출 지점마다 가리게 하면 빠뜨린 곳이 생긴다. query도 대상인 이유는 `/password-reset?token=…`처럼 민감값이 쿼리로도 오기 때문이고, responseBody도 대상인 이유는 로그인 응답의 accessToken처럼 민감값이 응답으로도 나가기 때문이다. 깊이는 각 필드 바로 아래와 와일드카드 두 단계(`*.${key}`·`*.*.${key}`)까지다 — 두 단계인 이유는 배열 응답이다. **배열 인덱스가 와일드카드 한 단계를 소비해** `*` 하나로는 목록 응답 `[{ auth: { token } }]`의 중첩 키가 원문으로 샌다(리뷰 3라운드 실측). `*.*`는 객체 두 단계 중첩에도 적용된다(실측·테스트 고정). **남는 상한**: 배열 요소의 두 단계 중첩(`[{ a: { b: { token } } }]`)부터는 가려지지 않는다(실측) — fast-redact가 단계마다 경로를 요구하기 때문이고, 응답 DTO가 그만큼 깊어지면 경로 한 단계를 더하거나 재귀 마스킹으로 바꿔야 한다. 경로 수 72개의 비용은 로그 1건당 약 19µs 실측(요청당 2건 = 약 37µs)으로 무시했다. **redact는 부분 문자열을 가리지 못한다**(실측) — 그래서 미들웨어의 url 필드는 쿼리 문자열을 뗀 경로만 담는다. URL 원문을 통째로 로그 필드에 넣지 마라.

**응답 본문 캡처는 `res.json`·`res.send` 래핑이다 — 인터셉터가 아니다.** 인터셉터는 컨트롤러 성공 경로만 보고 예외 필터가 내보내는 오류 응답을 놓치며, 로깅 배선이 미들웨어와 인터셉터 두 곳으로 갈라진다. **redact가 키 단위로 작동하려면 직렬화 전 객체가 필요하다** — 그래서 `res.json`에서 객체를 잡고, Express json이 내부에서 직렬화된 문자열로 send를 다시 부를 때 덮지 않는다. 컨트롤러가 JSON 문자열을 직접 만들어 반환하면(규약 위반 — DTO 객체로 반환하라) 문자열로 잡혀 redact가 못 가린다. 한계와 대가: ① `res.write` 직접 스트리밍은 잡지 못한다(이 API에 없음 — 생기면 그 라우트만 별도 처리) ② 응답 로그 한 줄이 커지는 것을 막기 위해 직렬화 10KB 상한을 두고 넘으면 생략 표기로 대체한다(Docker json-file 드라이버가 16KB 초과 줄을 분할해 JSON 파싱이 깨진다) ③ 버퍼는 크기 표기로 대체 ④ 본문 없는 응답(204 등)은 필드 자체를 넣지 않는다 — `null`·빈 문자열과 구별하기 위해서다. 필드 의미: `body`는 요청 로그·응답 로그 모두에서 **요청** 본문이고, 응답 본문은 응답 로그의 `responseBody`다.

**레벨 필터가 없다(`level: 'trace'`).** Nest 기본 로거도 전부 내보낸다. 필터 요구가 생기면 환경변수로 뺀다.

**요청 로깅 배선은 `AppModule.configure`에 있다.** 전역(`forRoutes('*')`)에 걸되 헬스 프로브 둘(`/api/v1/ping`·`/api/v1/ready`)을 exclude한다 — k8s 프로브가 수 초마다 때려서, 남기면 로그가 프로브 기록에 잠긴다. 경로 문자열은 `src/health/health.controller.ts`의 `HEALTH_PING_PATH`·`HEALTH_READY_PATH`를 가져다 쓴다 — 양쪽에 따로 적으면 한쪽만 바뀌었을 때 제외가 조용히 풀린다. **규칙은 하나다 — `forRoutes`든 `exclude`든 전역 prefix(`api/v1`)를 직접 쓰지 않는다.** Nest가 양쪽 모두에 붙여 준다(`forRoutes`는 `RouteInfoPathExtractor.extractPathsFrom`, `exclude`는 `MiddlewareBuilder.ConfigProxy.exclude` → `extractPathFrom`, @nestjs/core 10.4.22). exclude 쪽은 비교 대상이 prefix가 포함된 요청 URL 원문이라 직접 붙여야 할 것처럼 읽히지만 그렇지 않다 — `'api/v1/ping'`이라고 쓰면 `/api/v1/api/v1/ping`이 되어 어떤 요청과도 맞지 않고, 제외가 조용히 풀린다. 최소 앱을 띄워 실측했고(2026-08-12), 회귀는 `test/health.e2e-spec.ts`의 '요청 로깅 제외' 두 건이 잡는다(잘못된 배선에서 실제로 실패하는 것을 확인했다). 미들웨어는 body를 가리지 않고 그대로 넘긴다 — 가리는 것은 로거 출구의 redact다. 응답 로그는 `close`가 아니라 `finish` 이벤트에 건다(close는 전송 완료 전 커넥션이 끊겨도 발생한다). URL fragment(`#…`)는 브라우저가 서버로 보내지 않아 로그 항목에 없다(2026-08-10 사용자 확정).

**"프로세스를 살려 둔다" 정책은 런타임에만 적용된다 — 부팅 실패는 종료 코드 1로 죽는다(2026-08-12 사용자 확정).** 정책이 뒤집힌 것이 아니라 **적용 구간이 다르다.**

| 구간 | 무엇이 일어나면 | 어떻게 하는가 | 왜 |
|---|---|---|---|
| 기동 후(런타임) | `uncaughtException`·`unhandledRejection` | fatal 로그 후 **살려 둔다** | 요청 하나의 실패로 이미 처리 중인 다른 요청까지 끊지 않는다(사용자 명시 요청) |
| 부팅 중 — 컨테이너 생성(`NestFactory.create`) | 환경변수 검증 실패 등 | **Nest가** fatal 로그 후 `process.exit(1)` | 우리 코드가 개입하지 않아도 이미 목표 상태다(아래 참조) |
| 부팅 중 — 그 이후 | 리슨 실패 | `bootstrap().catch()`가 fatal 로그 후 **`process.exit(1)`** | 살려 두면 배포 실패가 종료 코드 0으로 위장된다 |

**`bootstrap().catch()`는 컨테이너 생성 실패를 잡지 않는다.** `ConfigModule.forRoot`가 `async`라 검증 실패가 모듈 로드 시점의 동기 throw가 아니라 **거절된 Promise**가 되고, Nest의 `ExceptionsZone`이 `exceptionHandler.handle` → `Logger.flush()` → `teardown`(기본값 `() => process.exit(1)`, `abortOnError` 기본 true)까지 스스로 끝낸다(@nestjs/core 10.4.22 `errors/exceptions-zone.js`). `SHUTDOWN_DRAIN_DELAY_MS=60001`로 띄우면 종료 코드는 `1`이지만 `[Bootstrap] 부팅에 실패해 프로세스를 종료한다` 줄이 **없고** Nest의 `[ExceptionHandler]` 줄만 남는 것으로 확인했다(실측 2026-08-12). 종료 코드와 근본 원인 로그를 Nest가 대신 보장하므로 목표는 두 경로 모두 달성돼 있다 — 다만 **그 경로에서 우리 fatal 줄을 찾지 마라.**

부팅 실패(리슨 실패)를 살려 두면 `bootstrap()`이 거절한 Promise가 unhandledRejection으로 흘러 런타임 핸들러에 잡히고, 리슨을 못 해 이벤트 루프에 남은 일이 없으므로 **종료 코드 0으로 조용히 끝난다**(2026-08-12 포트 충돌로 실측 — `bootstrap()`만 부르던 상태에서 `echo $?`가 `0`이었다). k8s는 종료 코드로 재시작을 판단하므로 열지도 못한 서버가 "정상 종료"로 기록된다. 그래서 `bootstrap().catch()`가 런타임 핸들러보다 **먼저** 그 거절을 가져간다 — 이 순서가 두 정책이 부딪히지 않는 이유다.

**부팅 실패 경로에는 `app.flushLogs()`가 필요하다.** `bufferLogs: true`의 버퍼를 Nest가 비우는 지점은 **리슨 성공 시점 하나뿐이다**(`nest-application.js`의 `listen()`이 `flushLogs()`를 부른다 — 10.4.22 소스 확인). 리슨 전에 실패하면 부팅 로그도 fatal 로그도 버퍼에 갇힌 채 사라진다 — 실측에서 로그 파일이 **0바이트**였다(2026-08-12). 그래서 `main.ts`가 `listen()`을 try/catch로 감싸 실패 시 flush한 뒤 다시 던진다. `flushLogsOnOverride()`를 쓰지 않은 이유는 그 메서드가 `INestApplication` 인터페이스에 없어 타입 검사가 막기 때문이다(`flushLogs()`만 인터페이스에 있다).

**프로세스 오류 핸들러는 DI Provider가 아니라 함수다.** 프로세스 전역(리스너)을 만지는 배선이라 Nest 라이프사이클에 묶으면 앱 인스턴스가 여럿일 때(테스트) 리스너가 중복 등록된다 — `main.ts`가 부팅 시 한 번 부른다. 리스너를 다는 것만으로 Node 기본 동작(uncaughtException 즉시 종료)이 대체되며, 프로세스를 살리는 것은 사용자 명시 요청이다. **등록 함수는 해제 함수를 반환한다** — 프로세스 전역을 만지는 spec은 그것으로 반드시 원상 복구한다(`src/common/CONTEXT.md`의 프로토타입 규칙과 같은 원리). spec은 `process.emit`으로 발화시키지 않는다 — jest 자체 리스너까지 불려 러너가 오작동하므로, 등록 전후 리스너 차집합으로 우리 리스너만 직접 부른다.

**기본 목적지는 stdout **동기 쓰기**다(`pino.destination({ sync: true })`, 2026-08-11).** pino 기본값(비동기 SonicBoom)은 flush를 process 'exit' 이벤트에만 등록하는데(소스 확인), **Nest의 시그널 종료는 훅 완료 후 시그널 재발신으로 죽어 'exit'가 불리지 않는다** — 종료 직전의 로그(`ShutdownRegistry`의 "해제 완료" 등)가 유실될 수 있다. 유실은 플랫폼·타이밍 의존이다 — macOS·stdout 파일 리다이렉트·SIGTERM 조건에서 반복 재현됐고, 파이프 조건에서는 재현되지 않았다는 관찰도 있다. 동기 쓰기의 처리량 비용은 이 규모에서 무시하고, 종료 로그의 유실 가능성 쪽을 더 비싸게 봤다.

**테스트는 출력을 관찰한다.** `PINO_DESTINATION` 토큰(optional)으로 sink 스트림을 주입해 pino가 실제로 내보낸 JSON 줄을 파싱해 단정한다 — pino 내부 상태를 들여다보지 않는다. **의도된 예외가 하나 있다**: 기본 목적지의 sync 배선 고정 테스트는 pino 공개 symbol(`pino.symbols.streamSym`)로 목적지 설정을 직접 본다 — 이 배선의 관찰 가능한 동작(시그널 종료 직전 flush)은 프로세스 종료 없이 볼 수 없고, 배선이 지워져도 다른 어떤 테스트도 깨지지 않기 때문이다.

## 의존성

- `pino` — 구조화 JSON 로거. 어댑터 파일만 의존하고 도메인 코드로 새어 나가지 않는다
- `@nestjs/common` — `LoggerService` 인터페이스(10.4부터 `fatal` 지원), DI 데코레이터
