# CONTEXT

> 마지막 업데이트: 2026-08-13

## 역할

k8s liveness·readiness 프로브가 때리는 헬스 체크 엔드포인트를 담는다. 도메인 로직이 없다 — 프로세스가 HTTP 요청에 응답할 수 있는지, 그리고 **지금 새 요청을 받아도 되는지**만 답한다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `health.controller.ts` | `GET /api/v1/ping` → 200 `pong`(liveness), `GET /api/v1/ready` → 200 `ready`(readiness). 경로 조각을 `HEALTH_PING_PATH`·`HEALTH_READY_PATH`로 export한다 |
| `readiness.service.ts` | readiness 판정. 종료가 시작됐으면 `ServiceUnavailableException`(503) |
| `health.module.ts` | `HealthController`·`ReadinessService` 등록, `ShutdownModule` import |

검증은 `readiness.service.spec.ts`(판정)와 `test/health.e2e-spec.ts`(라우팅·상태 전환·로깅 제외)로 나뉜다 — 컨트롤러 단위 spec은 규약상 만들지 않는다(라우팅 검증은 e2e의 몫, `.claude/rules/nestjs.md`). e2e가 `AppModule`로 부트하므로 **`AppModule`이 이 모듈을 물고 있는지**까지 함께 고정된다. e2e도 `setupApp()`을 불러야 프로덕션과 같은 경로를 본다 — 부르지 않으면 `/ping`을 검증하게 된다.

## 핵심 로직

**의도적으로 DB를 보지 않는다.** 프로브가 DB 상태에 묶이면 DB 장애 때 k8s가 멀쩡한 파드를 재시작하거나 엔드포인트에서 빼 장애를 키운다. DB 헬스가 필요해지는 날이 오면 별도 엔드포인트로 분리한다 — 이 엔드포인트들에 덧붙이지 마라.

**liveness와 readiness를 나눈 이유가 이 폴더의 핵심이다.**

| 경로 | 의미 | 종료 중(SIGTERM 이후) |
|---|---|---|
| `GET /api/v1/ping` | 프로세스가 살아 있는가 | **200 유지** |
| `GET /api/v1/ready` | 새 요청을 받아도 되는가 | **503** |

**종료 중에 liveness를 실패시키면 안 된다.** kubelet이 유예 기간 중에 컨테이너를 죽여 드레인 자체가 잘린다. 겸용 경로 하나를 종료 시 503으로 바꾸는 구현이 정확히 이 함정이고, `test/health.e2e-spec.ts`의 '종료가 시작돼도 liveness는 200을 유지한다'가 그 회귀를 잡는다 — liveness에 종료 판정을 넣는 변형에서 이 단정만 실패하는 것을 확인했다(2026-08-12).

**판정은 컨트롤러가 아니라 `ReadinessService`에 있다.** 컨트롤러에 조건 분기를 두지 않는 규약이고, 판정이 한 줄이어도 Service에 있어야 "종료 중" 외의 미준비 조건이 생겼을 때 둘 자리가 이미 있다. 판정 근거는 `ShutdownRegistry.isShuttingDown()`이다(`src/shutdown/CONTEXT.md`).

**경로는 전역 prefix 아래에 있다.** 컨트롤러는 `@Controller()`(경로 없음) + `@Get('ping')`·`@Get('ready')`이고, 앞의 `api/v1`은 `src/app-setup.ts`의 전역 prefix가 붙인다. **컨트롤러에 `api`를 다시 쓰지 마라** — `@Controller('api')`면 실제 경로가 `/api/v1/api/ping`이 된다(전역 prefix 도입 전의 배선이 그랬고, 머지하며 걷어냈다).

**두 경로 모두 요청 로깅에서 제외된다.** `AppModule.configure`의 `exclude`가 `HEALTH_PING_PATH`·`HEALTH_READY_PATH`를 가져다 쓴다 — 프로브가 수 초마다 때려 로그가 잠기기 때문이다. 상수를 공유하므로 경로를 바꾸면 exclude도 함께 따라간다. **exclude에는 전역 prefix를 붙이지 않는다** — Nest가 자동으로 붙이며, 직접 쓰면 `/api/v1/api/v1/ping`이 되어 제외가 조용히 풀린다(실측 근거는 `src/logging/CONTEXT.md`). 제외가 풀려도 응답은 정상이라 사람이 알아채지 못하므로, e2e의 '요청 로깅 제외'가 로거를 대역으로 바꿔 미들웨어 통과 여부를 직접 단정한다. 그 단정들은 **짝으로 의미가 있다** — 프로브가 로그를 남기지 않는 것만 단정하면 미들웨어가 아예 걸리지 않은 상태에서도 통과하므로, 프로브가 아닌 요청이 로그를 남기는 것을 함께 본다.

## 매니페스트가 만족해야 할 조건

매니페스트·Dockerfile은 아직 이 저장소에 없다(인프라 미정). 앱은 매니페스트를 전제하지 않고 스스로 드레인하지만, 매니페스트를 쓸 때 아래를 맞춰야 의도대로 동작한다.

- **프로브 경로 둘을 각각 연결한다.** `livenessProbe` → `/api/v1/ping`, `readinessProbe` → `/api/v1/ready`. **한 경로를 양쪽에 쓰면 안 된다** — 드레인 중 readiness 실패가 liveness 실패로도 읽혀 컨테이너가 조기에 죽는다
- **`terminationGracePeriodSeconds`는 `SHUTDOWN_DRAIN_DELAY_MS`(기본 5초) + 자원 해제 예산(`DISPOSE_TIMEOUT_MS` 10초) + 여유보다 커야 한다.** 기본값 30초면 충분하고, 드레인 대기를 늘리면 이 값도 함께 본다
- **SIGTERM이 PID 1(애플리케이션 프로세스)에 닿아야 한다.** 셸을 거쳐 뜨면(`sh -c "node dist/main"`) 셸이 시그널을 전달하지 않아 드레인이 통째로 건너뛰어지고 SIGKILL로 끝난다 — `CMD ["node", "dist/main"]` 형태(exec form)로 띄운다
- `readinessProbe.periodSeconds`가 드레인 대기보다 길면 파드가 엔드포인트에서 빠지기 전에 HTTP가 닫힌다. 대기 시간은 프로브 주기의 몇 배로 잡는다
- `preStop` 훅으로 대기를 대신하기로 하면 `SHUTDOWN_DRAIN_DELAY_MS=0`으로 둔다 — 둘 다 두면 대기가 더해진다

## 의존성

- `@nestjs/common` — `Controller`, `Get`, `Module`, `Injectable`, `ServiceUnavailableException`
- `src/shutdown` — `ShutdownRegistry.isShuttingDown()`이 readiness 판정의 근거다. 방향은 health → shutdown 한쪽이고, shutdown은 health를 모른다
