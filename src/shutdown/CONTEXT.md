# CONTEXT

> 마지막 업데이트: 2026-08-11

## 역할

자원 해제를 한 곳에서 조율하는 종료 코디네이터를 담는다. **앱에서 `OnApplicationShutdown`을 구현하는 곳은 여기 하나다** — 자원(Prisma, 추후 Redis 등)은 자체 종료 훅을 만들지 말고 `ShutdownRegistry.register(name, dispose)` 한 줄만 불러라.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `shutdown-registry.service.ts` | 해제 콜백을 모아 종료 시 공통 규칙(역순 순차·오류 격리·타임아웃·멱등·이름 붙은 로그)으로 실행 |
| `shutdown.module.ts` | `ShutdownRegistry` 등록·export. 자원 모듈이 import한다 |

## 핵심 로직

**자원마다 훅을 두면 안 되는 이유가 이 구현체의 존재 이유다.** Nest는 같은 모듈의 종료 훅을 `Promise.all` 병렬로 부르고(실측 — `hooks/on-app-shutdown.hook.js`), 시그널 경로에서 훅 하나가 던지면 `Logger.error` 후 `process.exit(1)`로 나머지 해제를 전부 건너뛴다(실측 — `nest-application-context.js`). 순서 제어도 오류 격리도 훅으로는 불가능하다.

- **등록 역순 순차 해제** — 나중에 연 자원을 먼저 닫는다. 자원 간 의존(나중 자원이 먼저 자원을 쓰는 방향)이 생겨도 안전한 쪽이 기본값이다
- **오류 격리** — 자원의 해제 실패는 error 로그 후 다음 자원으로 진행한다. **훅 자신은 절대 던지지 않는다.** "예외를 삼키지 않는다" 규약의 의도된 예외다 — 종료 경로라 위로 던질 곳이 없고, 던지면 나머지 자원 해제가 전부 스킵된다
- **자원별 타임아웃 10초** — k8s `terminationGracePeriodSeconds` 기본 30초에서 HTTP 드레인 몫을 뺀 값. 초과 시 warn 후 다음 자원으로 진행하고, 최종 방어선은 k8s의 SIGKILL이다. 건너뛴 해제 작업은 취소되지 않고 백그라운드에 남는다(JavaScript에 강제 취소가 없다) — 프로세스가 곧 종료되므로 실질적인 해는 없다
- **재호출 멱등** — e2e `afterEach`의 `app.close()`도 같은 훅을 지나므로, 멱등이 아니면 테스트에서 이중 해제가 난다. 플래그는 완료가 아니라 **진입 시점**에 세워 실행 도중 재진입도 막는다
- **로그는 `new Logger(ShutdownRegistry.name)`** — 도메인 코드는 pino를 모른다는 기존 패턴(`src/logging/CONTEXT.md`) 그대로다. 시작·완료 로그에 자원 이름과 signal 이름이 들어간다

**등록 시점은 자원의 획득 성공 직후다.** `PrismaService`가 `onModuleInit`에서 `$connect()` 성공 후 등록하는 것이 그 예다 — 연결에 실패한 자원을 해제 대상에 넣지 않는다.

**범위 밖(설계 여지)**: websocket의 종료 전 드레인(클라이언트 알림·readiness 전환)은 HTTP close **이전** 국면(`beforeApplicationShutdown`)의 일이다. 이 구현체는 "HTTP close 이후 해제" 단일 국면이고, 드레인 요구가 생기면 국면을 더한다.

## 의존성

- `@nestjs/common` — `Injectable`, `Logger`, `OnApplicationShutdown`뿐이다. 도메인 코드에 의존하지 않는다(자원 모듈이 이쪽을 import하는 단방향)
