# CONTEXT

> 마지막 업데이트: 2026-08-10

## 역할

k8s liveness·readiness 프로브가 때리는 헬스 체크 엔드포인트를 담는다. 도메인 로직이 없다 — 프로세스가 HTTP 요청에 응답할 수 있는지만 답한다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `health.controller.ts` | `GET /api/ping` → 200 `pong`. Service가 없다 — 조건 분기·계산이 전혀 없어 내릴 로직이 없다 |
| `health.module.ts` | `HealthController` 등록만 한다 |

검증은 `test/health.e2e-spec.ts`다 — 컨트롤러 단위 spec은 규약상 만들지 않는다(라우팅 검증은 e2e의 몫, `.claude/rules/nestjs.md`). e2e가 `AppModule`로 부트하므로 **`AppModule`이 이 모듈을 물고 있는지**까지 함께 고정된다.

## 핵심 로직

**의도적으로 DB를 보지 않는다.** 프로브가 DB 상태에 묶이면 DB 장애 때 k8s가 멀쩡한 파드를 재시작해 장애를 키운다. DB 헬스가 필요해지는 날이 오면 별도 엔드포인트로 분리한다 — 이 엔드포인트에 덧붙이지 마라.

**`/api/ping`은 요청 로깅에서 제외된다.** `AppModule.configure`의 `exclude` — 프로브가 수 초마다 때려 로그가 잠기기 때문이다. 경로를 바꾸면 그 exclude도 함께 바꿔야 한다.

**경로 충돌 주의**: 병행 브랜치 `feature/todos-controller`가 전역 접두사 `api/v1`을 도입 중이다. 머지 시점에 `setGlobalPrefix`의 `exclude` 지정 또는 경로 조정이 필요하다(PR 본문에 기록).

## 의존성

- `@nestjs/common` — `Controller`, `Get`, `Module`뿐이다. 다른 모듈에 의존하지 않는다
