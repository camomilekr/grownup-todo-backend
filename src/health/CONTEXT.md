# CONTEXT

> 마지막 업데이트: 2026-08-17

## 역할

k8s liveness·readiness 프로브가 때리는 헬스 체크 엔드포인트를 담는다. 도메인 로직이 없다 — 프로세스가 HTTP 요청에 응답할 수 있는지, 그리고 **지금 새 요청을 받아도 되는지**만 답한다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `health.controller.ts` | `GET /api/v1/ping` → 200 `pong`(liveness), `GET /api/v1/ready` → 200 `ready`(readiness). 경로 조각을 `HEALTH_PING_PATH`·`HEALTH_READY_PATH`로 export한다 |
| `readiness.service.ts` | readiness 판정. 종료가 시작됐으면 `ServiceUnavailableException`(503) |
| `health.module.ts` | `HealthController`·`ReadinessService` 등록, `ShutdownModule` import |
| `deployment-probe.spec.ts` | k8s 매니페스트의 프로브 배선이 이 폴더의 설계와 맞는지 대조한다. 짝이 되는 소스 파일이 없는 spec이고, 검사 대상은 `k8s/deployment.yaml`이다 |

검증은 `readiness.service.spec.ts`(판정)와 `test/health.e2e-spec.ts`(라우팅·상태 전환·로깅 제외)로 나뉜다 — 컨트롤러 단위 spec은 규약상 만들지 않는다(라우팅 검증은 e2e의 몫, `.claude/rules/nestjs.md`). e2e가 `AppModule`로 부트하므로 **`AppModule`이 이 모듈을 물고 있는지**까지 함께 고정된다. e2e도 `setupApp()`을 불러야 프로덕션과 같은 경로를 본다 — 부르지 않으면 `/ping`을 검증하게 된다.

## 핵심 로직

**의도적으로 DB를 보지 않는다.** 프로브가 DB 상태에 묶이면 DB 장애 때 k8s가 멀쩡한 파드를 재시작하거나 엔드포인트에서 빼 장애를 키운다. DB 헬스가 필요해지는 날이 오면 별도 엔드포인트로 분리한다 — 이 엔드포인트들에 덧붙이지 마라.

**liveness와 readiness를 나눈 이유가 이 폴더의 핵심이다.**

| 경로 | 의미 | 종료 중(SIGTERM 이후) |
|---|---|---|
| `GET /api/v1/ping` | 프로세스가 살아 있는가 | **200 유지** |
| `GET /api/v1/ready` | 새 요청을 받아도 되는가 | **503** |

**종료 중에 liveness를 실패시키면 안 된다.** 겸용 경로 하나를 종료 시 503으로 바꾸는 구현이 정확히 이 함정이고, `test/health.e2e-spec.ts`의 '종료가 시작돼도 liveness는 200을 유지한다'가 그 회귀를 잡는다 — liveness에 종료 판정을 넣는 변형에서 이 단정만 실패하는 것을 확인했다(2026-08-12).

**왜 그래야 하는지(어느 종료 경로에서 무엇을 잃는지)는 `docs/k8s-local-verification.md`의 ① 절 한 곳에 실측과 함께 있다.** 이 폴더 문서에도, 매니페스트 주석에도, 코드 주석에도 그 인과를 다시 유도하지 않는다 — 같은 인과를 여러 곳에서 유도하다 한쪽만 고쳐지는 일이 실제로 반복됐다. 여기서 알아야 할 것은 위 표의 규칙(무엇이 200이고 무엇이 503인가)까지다.

**판정은 컨트롤러가 아니라 `ReadinessService`에 있다.** 컨트롤러에 조건 분기를 두지 않는 규약이고, 판정이 한 줄이어도 Service에 있어야 "종료 중" 외의 미준비 조건이 생겼을 때 둘 자리가 이미 있다. 판정 근거는 `ShutdownRegistry.isShuttingDown()`이다(`src/shutdown/CONTEXT.md`).

**경로는 전역 prefix 아래에 있다.** 컨트롤러는 `@Controller()`(경로 없음) + `@Get('ping')`·`@Get('ready')`이고, 앞의 `api/v1`은 `src/app-setup.ts`의 전역 prefix가 붙인다. **컨트롤러에 `api`를 다시 쓰지 마라** — `@Controller('api')`면 실제 경로가 `/api/v1/api/ping`이 된다(전역 prefix 도입 전의 배선이 그랬고, 머지하며 걷어냈다).

**두 경로 모두 요청 로깅에서 제외된다.** `AppModule.configure`의 `exclude`가 `HEALTH_PING_PATH`·`HEALTH_READY_PATH`를 가져다 쓴다 — 프로브가 수 초마다 때려 로그가 잠기기 때문이다. 상수를 공유하므로 경로를 바꾸면 exclude도 함께 따라간다. **exclude에는 전역 prefix를 붙이지 않는다** — Nest가 자동으로 붙이며, 직접 쓰면 `/api/v1/api/v1/ping`이 되어 제외가 조용히 풀린다(실측 근거는 `src/logging/CONTEXT.md`). 제외가 풀려도 응답은 정상이라 사람이 알아채지 못하므로, e2e의 '요청 로깅 제외'가 로거를 대역으로 바꿔 미들웨어 통과 여부를 직접 단정한다. 그 단정들은 **짝으로 의미가 있다** — 프로브가 로그를 남기지 않는 것만 단정하면 미들웨어가 아예 걸리지 않은 상태에서도 통과하므로, 프로브가 아닌 요청이 로그를 남기는 것을 함께 본다.

## 매니페스트가 만족해야 할 조건

매니페스트(`k8s/deployment.yaml`)와 `Dockerfile`이 이 저장소에 들어왔다. 앱은 매니페스트를 전제하지 않고 스스로 드레인하지만, 아래가 맞아야 그 드레인이 의미를 갖는다. **전부 어긋나도 오류가 나지 않는 종류라** 셋은 테스트로 고정했다(`src/health/deployment-probe.spec.ts`).

| 조건 | 현재 값 | 가드 |
|---|---|---|
| `readinessProbe` → `/api/v1/ready` | `periodSeconds: 1`, `timeoutSeconds: 1`, `failureThreshold: 2` | `deployment-probe.spec.ts` |
| `livenessProbe` → `/api/v1/ping` | `periodSeconds: 10`, `timeoutSeconds: 2`, `failureThreshold: 3` | `deployment-probe.spec.ts` |
| `startupProbe` → `/api/v1/ping` | `periodSeconds: 2`, `failureThreshold: 30` | `deployment-probe.spec.ts` |
| 준비 확인 판정 시간 + 전파 여유 < 드레인 대기 | `(1+1)×2 = 4초` + 2초 < 8초 | `deployment-probe.spec.ts` |
| `terminationGracePeriodSeconds` ≥ 드레인 + 자원 해제 예산 + 여유 | 30초 = 8 + 10 + 여유 12 | 가드 없음 — 매니페스트 주석의 계산 |

**어긋났을 때 무엇을 잃는지는 `docs/k8s-local-verification.md` ① 절에 종료 경로별로 정리돼 있다.** 판정 시간의 계산식은 가드 코드가 기준이다.

- **SIGTERM이 PID 1(애플리케이션 프로세스)에 닿아야 한다.** 셸을 거쳐 뜨면(`sh -c "node dist/main"`) 셸이 시그널을 전달하지 않아 드레인이 통째로 건너뛰어지고 SIGKILL로 끝난다 — `CMD ["node", "dist/main"]` 형태(exec form)로 띄운다
- **`preStop` 훅은 두지 않는다.** 드레인 국면과 같은 창을 덮으므로 함께 두면 대기가 이중으로 쌓인다. 대기를 매니페스트로 되돌리려면 `SHUTDOWN_DRAIN_DELAY_MS=0`을 함께 내려야 한다
- **드레인 대기를 바꾸면 준비 확인 값과 유예 시간을 함께 본다.** 세 값은 독립적으로 고를 수 없다

**"재배포 중 실패 0건"을 실제로 만드는 것은 준비 확인 503이 아니라 드레인 동안 HTTP를 열어 두는 것이다.** 엔드포인트 제거의 방아쇠가 준비 확인이 아니라 파드 삭제 표식 자체라는 사실과 그 실측은 `docs/k8s-local-verification.md`의 ②-2 절에 있다 — 준비 확인을 `ready`로 두는 것은 여전히 필수지만, 그 근거는 거기 한 곳에서 읽는다.

**삭제 표식이 붙으면 kubelet은 liveness 프로브를 멈춘다**(startup도 함께 멈추는지는 측정하지 않았다 — ① 절의 미확인 목록에 있다). 이 사실이 위 배선의 근거이고, 그것을 확인한 실측 여섯 건은 `docs/k8s-local-verification.md` ① 절에 있다 — **생존 확인 경로를 잘못 배선한 대가는 이 저장소의 클러스터 검증 절차(파드 삭제·재배포)로는 관측되지 않으므로, 그 자리는 `deployment-probe.spec.ts`가 대신 지킨다.**

## 의존성

- `@nestjs/common` — `Controller`, `Get`, `Module`, `Injectable`, `ServiceUnavailableException`
- `src/shutdown` — `ShutdownRegistry.isShuttingDown()`이 readiness 판정의 근거다. 방향은 health → shutdown 한쪽이고, shutdown은 health를 모른다
