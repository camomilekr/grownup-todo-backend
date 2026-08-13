# CONTEXT

> 마지막 업데이트: 2026-08-13

## 역할

종료를 한 곳에서 조율하는 종료 코디네이터를 담는다. **앱에서 `BeforeApplicationShutdown`·`OnApplicationShutdown`을 구현하는 곳은 여기 하나다** — 자원(Prisma, 추후 Redis 등)은 자체 종료 훅을 만들지 말고 `ShutdownRegistry.register(name, dispose)` 한 줄만 불러라.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `shutdown-registry.service.ts` | 드레인 국면(종료 플래그·시그널 대기)과 자원 해제(역순 순차·오류 격리·타임아웃·멱등·이름 붙은 로그)를 함께 맡는다 |
| `shutdown.module.ts` | `ShutdownRegistry` 등록·export. 자원 모듈과 `HealthModule`이 import한다 |

## 핵심 로직

**두 국면을 맡는다.** Nest의 종료 순서는 `onModuleDestroy → beforeApplicationShutdown → HTTP 서버 close → onApplicationShutdown`이다(@nestjs/core 10.4.22 `nest-application-context.js` `close()` 실측).

| 국면 | 하는 일 | HTTP 서버 |
|---|---|---|
| `beforeApplicationShutdown` | 종료 플래그를 세우고(readiness 즉시 503) 시그널 종료면 `SHUTDOWN_DRAIN_DELAY_MS`만큼 대기 | 아직 열려 있다 — 이 동안 도착한 요청은 정상 처리된다 |
| `onApplicationShutdown` | 등록 역순으로 자원 해제 | 이미 닫혔다 — 처리 중 요청이 끊긴 DB를 만나지 않는다 |

- **플래그는 대기 전에 세운다.** 대기가 끝난 뒤에 세우면 드레인하는 동안 k8s가 파드를 계속 준비된 것으로 보고 새 요청을 보낸다 — 순서를 뒤집는 변형으로 spec 2건이 실패하는 것을 확인했다(2026-08-12)
- **시그널이 있을 때만 기다린다.** `app.close()`를 직접 부르는 경로(e2e `afterEach`)에는 signal 인자가 없다. 이 분기를 지우면 e2e가 매 테스트마다 대기 시간만큼 느려진다 — 지운 변형에서 해당 spec이 5초 타임아웃으로 실패하는 것을 확인했다
- **대기 시간 0은 대기하지 않음이다.** 매니페스트가 `preStop: sleep`으로 대기를 대신하는 경우를 위해 남긴 값이다
- **이 국면은 어떤 경우에도 던지지 않는다.** 자원 해제와 같은 이유다 — 시그널 경로에서 훅이 던지면 Nest가 `process.exit(1)`로 **이후 자원 해제를 전부 건너뛴다**. 드레인이 자원 해제를 잘라먹으면 안 된다. 대기 본문(`drain`)을 try/catch로 감싸 실패를 error 로그로 바꾸고 종료를 계속 진행시킨다 — 지금 이 안에서 던질 수 있는 문장은 `getOrThrow('SHUTDOWN_DRAIN_DELAY_MS')` 하나뿐이고 `validateEnv`가 키를 항상 채우므로 실제 발생 가능성은 없지만, **이 불변식이 깨졌을 때의 대가가 커넥션 누수라 발생 가능성보다 대가로 판단했다.** 시그널 없이 부르는 단정만으로는 그 문장을 지나지 못해(즉시 반환) 아무것도 지키지 못한다 — 설정 조회가 던지는 대역으로 세운 spec 2건이 그 자리를 덮고, 삼키는 처리를 지우면 실제로 실패하는 것을 확인했다(2026-08-13)

`isShuttingDown()`은 readiness 프로브의 판정 근거다(`src/health/readiness.service.ts`). liveness는 이 값을 보지 않는다 — 종료 중에 liveness가 실패하면 kubelet이 유예 기간 중에 컨테이너를 죽여 드레인 자체가 잘린다.

**자원마다 훅을 두면 안 되는 이유가 이 구현체의 존재 이유다.** Nest는 같은 모듈의 종료 훅을 `Promise.all` 병렬로 부르고(실측 — `hooks/on-app-shutdown.hook.js`), 시그널 경로에서 훅 하나가 던지면 `Logger.error` 후 `process.exit(1)`로 나머지 해제를 전부 건너뛴다(실측 — `nest-application-context.js`). 순서 제어도 오류 격리도 훅으로는 불가능하다.

- **등록 역순 순차 해제** — 나중에 연 자원을 먼저 닫는다. 자원 간 의존(나중 자원이 먼저 자원을 쓰는 방향)이 생겨도 안전한 쪽이 기본값이다
- **오류 격리** — 자원의 해제 실패는 error 로그 후 다음 자원으로 진행한다. **훅 자신은 절대 던지지 않는다.** "예외를 삼키지 않는다" 규약의 의도된 예외다 — 종료 경로라 위로 던질 곳이 없고, 던지면 나머지 자원 해제가 전부 스킵된다
- **자원별 타임아웃 10초** — k8s `terminationGracePeriodSeconds` 기본 30초에서 HTTP 드레인 몫을 뺀 값. 초과 시 warn 후 다음 자원으로 진행하고, 최종 방어선은 k8s의 SIGKILL이다. 건너뛴 해제 작업은 취소되지 않고 백그라운드에 남는다(JavaScript에 강제 취소가 없다) — 프로세스가 곧 종료되므로 실질적인 해는 없다
- **재호출 멱등** — e2e `afterEach`의 `app.close()`도 같은 훅을 지나므로, 멱등이 아니면 테스트에서 이중 해제가 난다. 플래그는 완료가 아니라 **진입 시점**에 세워 실행 도중 재진입도 막는다
- **로그는 `new Logger(ShutdownRegistry.name)`** — 도메인 코드는 pino를 모른다는 기존 패턴(`src/logging/CONTEXT.md`) 그대로다. 시작·완료 로그에 자원 이름과 signal 이름이 들어간다

**등록 시점은 자원의 획득 성공 직후다.** `PrismaService`가 `onModuleInit`에서 `$connect()` 성공 후 등록하는 것이 그 예다 — 연결에 실패한 자원을 해제 대상에 넣지 않는다.

**범위 밖(설계 여지)**: websocket 클라이언트에게 종료를 알리는 것은 아직 없다. 소켓이 생기면 드레인 국면에서 알림을 보내고 대기하는 쪽이 자연스럽다 — HTTP close 전이라 아직 연결이 살아 있는 국면이기 때문이다.

## 의존성

- `@nestjs/common` — `Injectable`, `Logger`, `BeforeApplicationShutdown`, `OnApplicationShutdown`. 도메인 코드에 의존하지 않는다(자원 모듈이 이쪽을 import하는 단방향)
- `@nestjs/config` — 드레인 대기 시간(`SHUTDOWN_DRAIN_DELAY_MS`)을 읽는다. 값의 기본값·범위 검증은 여기가 아니라 `src/config/env.validation.ts`에 있어, 이 클래스는 이미 검증된 number를 받는다
