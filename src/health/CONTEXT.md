# CONTEXT

> 마지막 업데이트: 2026-08-12

## 역할

k8s liveness·readiness 프로브가 때리는 헬스 체크 엔드포인트를 담는다. 도메인 로직이 없다 — 프로세스가 HTTP 요청에 응답할 수 있는지만 답한다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `health.controller.ts` | `GET /api/v1/ping` → 200 `pong`. Service가 없다 — 조건 분기·계산이 전혀 없어 내릴 로직이 없다. 경로 조각 `ping`을 `HEALTH_PING_PATH`로 export한다 |
| `health.module.ts` | `HealthController` 등록만 한다 |

검증은 `test/health.e2e-spec.ts`다 — 컨트롤러 단위 spec은 규약상 만들지 않는다(라우팅 검증은 e2e의 몫, `.claude/rules/nestjs.md`). e2e가 `AppModule`로 부트하므로 **`AppModule`이 이 모듈을 물고 있는지**까지 함께 고정된다. e2e도 `setupApp()`을 불러야 프로덕션과 같은 경로를 본다 — 부르지 않으면 `/ping`을 검증하게 된다.

## 핵심 로직

**의도적으로 DB를 보지 않는다.** 프로브가 DB 상태에 묶이면 DB 장애 때 k8s가 멀쩡한 파드를 재시작해 장애를 키운다. DB 헬스가 필요해지는 날이 오면 별도 엔드포인트로 분리한다 — 이 엔드포인트에 덧붙이지 마라.

**경로는 `/api/v1/ping`이다.** 컨트롤러는 `@Controller()`(경로 없음) + `@Get('ping')`이고, 앞의 `api/v1`은 `src/app-setup.ts`의 전역 prefix가 붙인다. **컨트롤러에 `api`를 다시 쓰지 마라** — `@Controller('api')`면 실제 경로가 `/api/v1/api/ping`이 된다(전역 prefix 도입 전의 배선이 그랬고, 머지하며 걷어냈다).

**`/api/v1/ping`은 요청 로깅에서 제외된다.** `AppModule.configure`의 `exclude`가 `HEALTH_PING_PATH`를 가져다 쓴다 — 프로브가 수 초마다 때려 로그가 잠기기 때문이다. 상수를 공유하므로 경로를 바꾸면 exclude도 함께 따라간다. **exclude에는 전역 prefix를 붙이지 않는다** — Nest가 자동으로 붙이며, 직접 쓰면 `/api/v1/api/v1/ping`이 되어 제외가 조용히 풀린다(실측 근거는 `src/logging/CONTEXT.md`). 제외가 풀려도 응답은 정상이라 사람이 알아채지 못하므로, `test/health.e2e-spec.ts`의 '요청 로깅 제외'가 로거를 대역으로 바꿔 미들웨어 통과 여부를 직접 단정한다. 그 두 건은 **짝으로 의미가 있다** — 프로브가 로그를 남기지 않는 것만 단정하면 미들웨어가 아예 걸리지 않은 상태에서도 통과하므로, 프로브가 아닌 요청이 로그를 남기는 것을 함께 본다.

## 의존성

- `@nestjs/common` — `Controller`, `Get`, `Module`뿐이다. 다른 모듈에 의존하지 않는다
