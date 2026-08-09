# CONTEXT

> 마지막 업데이트: 2026-08-10

## 역할

도메인에 속하지 않는 횡단 관심사를 담는다. 특정 도메인에서만 쓰는 것은 여기 두지 않고 그 도메인 폴더로 보낸다 — 여기가 잡동사니가 되면 의존 방향을 읽을 수 없게 된다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `bigint-json.ts` | `BigInt.prototype.toJSON`을 등록해 `BigInt` PK가 JSON 응답에서 터지는 것을 막는다 |
| `bigint-json.module.ts` | 그 등록을 **앱 초기화 시점에** 호출한다. `AppModule`이 import한다 |
| `bigint-json.spec.ts` | 문자열 직렬화·정밀도·멱등성 검증 |
| `bigint-json.module.spec.ts` | **호출 지점** 검증. 모듈을 초기화하면 켜지는지 본다 |
| `parse-bigint.pipe.ts` | 경로 파라미터 문자열 → `bigint` 파이프와, 헤더 데코레이터가 공유하는 파싱 함수(`parseBigIntOrNull`) |
| `parse-bigint.pipe.spec.ts` | 변환·2^53 초과 정밀도 보존·형식 어긋난 입력의 400 거절 |
| `request-user-id.decorator.ts` | `X-User-Id` 헤더 → `bigint` 파라미터 데코레이터. **인증이 없는 동안의 임시 통로다** — 인증이 들어오면 이 구현만 교체한다 |

## 핵심 로직

**경로 파라미터와 `X-User-Id` 헤더는 `number`가 아니라 `bigint`로 받는다.** 기본키가
BIGSERIAL이라 `ParseIntPipe`(`number` 반환)를 거치면 2^53 경계에서 서로 다른 행이 같은
값이 되어 다른 행을 가리키는 조회가 조용히 성립한다. 파싱 규칙(십진 숫자만, 음수·소수점
거절)은 `parseBigIntOrNull` 하나를 파이프와 데코레이터가 공유한다 — 각자 파싱하면 두
자리가 받는 값의 범위가 조용히 갈린다.

**`RequestUserId` 데코레이터는 단위 spec이 없다.** 단위로 만들려면 `ExecutionContext`
대역을 조립해야 하는데 그것은 동작이 아니라 구현 방식 검사다 — 실제 요청을 지나는
`test/todos-http.e2e-spec.ts`가 헤더 없음·비숫자 헤더의 400 거절을 고정한다.

**호출 지점은 `BigIntJsonModule.onModuleInit` 하나다. `main.ts`가 아니다.** `bootstrap()`은 어떤 테스트도 실행하지 않는다 — e2e조차 `createNestApplication()`으로 앱을 만들어 `main.ts`를 거치지 않는다. 부트스트랩에만 두면 이 가드는 **아무 테스트도 지나지 않는 코드**가 되어 지워도 전부 초록으로 통과하고, 그동안 **테스트 환경과 프로덕션의 직렬화 동작이 갈린다.** 모듈에 두면 앱을 부트하는 모든 경로가 같은 상태를 본다. **`enableBigIntJsonSerialization()`을 다른 곳에서 직접 부르지 마라.**

배선은 두 겹으로 고정돼 있다. `bigint-json.module.spec.ts`가 "모듈을 초기화하면 켜진다"를, `test/app.e2e-spec.ts`가 "**`AppModule`이 그 모듈을 물고 있다**"를 본다 — 후자가 없으면 `AppModule`의 `imports`에서 빠져도 단위 spec은 통과한다.

**`bigint`를 `Number`가 아니라 문자열로 내보낸다.** `Number`로 바꾸면 2^53을 넘는 PK에서 정밀도가 깨져 다른 행을 가리키는 ID가 클라이언트로 나간다. 응답 DTO에서 이 필드를 다룰 때 **숫자가 아니라 문자열이 온다는 것**을 전제해라.

`Prisma.Decimal`은 자체 `toJSON`이 있어 문자열로 나가므로 별도 대응이 필요 없다.

**`declare global`로 `BigInt` 인터페이스를 확장하지 않는다.** 확장하면 프로그램 전체에서 `someBigInt.toJSON()`이 typecheck를 통과하는데, 가드가 켜지지 않은 경로에서는 런타임에 `toJSON is not a function`으로 죽는다 — 타입이 런타임 보장 없이 존재를 약속하게 된다. 대신 할당하는 한 줄에서만 `as { toJSON?: () => string }`으로 좁게 단언한다. `JSON.stringify`는 프로퍼티 이름으로 `toJSON`을 찾으므로 타입 선언과 무관하게 동작하고, 값을 직접 문자열로 바꿀 때는 `String(value)`를 쓴다.

**프로토타입을 건드리는 spec은 원래 상태를 저장해 두고 `afterAll`에서 되돌린다.** jest는 같은 워커에서 여러 spec 파일을 돌리므로 누출을 남기면 **실행 순서에 따라 통과하는 테스트**가 만들어진다(`--runInBand`, `-t` 필터, 워커 수 변경에서 결과가 갈린다). 위험한 방향은 "여러 번 불러도 멱등"이 아니라 **다른 spec이 켜진 상태를 물려받는 것**이다.

## 의존성

- `@nestjs/common` — `Module`, `OnModuleInit`. `bigint-json.ts` 자체는 프레임워크에 의존하지 않고, 모듈 파일만 의존한다
- 도메인 코드에는 의존하지 않는다 (`src/app.module.ts`가 이쪽을 import하는 단방향이다)
