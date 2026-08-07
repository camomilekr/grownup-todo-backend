# 참조 — 테스트에서 막히는 지점

`.claude/rules/core.md`와 `testing.md`가 여기로 보낸다. 전부 이 저장소에서 실제로 막혔던 것이고, **대응이 직관과 다른 것만** 모았다.

## 전역 상태는 파일 안에서만 남는다 — 파일 사이로는 넘어가지 않는다

이 구분을 거꾸로 알면 두 방향으로 틀린다. 없는 문제를 막는 코드를 넣거나, 있는 문제를 놓친다.

**파일 사이로는 넘어가지 않는다.** jest는 테스트 **파일마다 별도의 실행 문맥**을 새로 만들고, `BigInt`·`Array` 같은 표준 내장 객체는 그 문맥마다 **다른 객체**다. A 파일에서 `BigInt.prototype.toJSON`을 심어도 B 파일의 `BigInt.prototype`에는 흔적이 없다.

근거는 `jest-environment-node` 패키지의 소스에 있다(확인 시점 29.7.0, 설치본의 `build/index.js`). 부모 프로세스의 전역을 테스트 문맥으로 복사하는 반복문에 `if (!contextGlobals.has(nodeGlobalsKey))` 조건이 걸려 있어, **새 문맥이 이미 갖고 있는 전역은 복사하지 않는다.** 경로가 아니라 **이 조건문을 검색어로 삼아라** — 버전이 오르면 파일 배치가 바뀔 수 있지만 조건 자체가 사라졌다면 그때는 위의 실측을 다시 해야 한다는 신호다.

실측했다. 두 spec을 만들어 순서를 고정하고 `--runInBand`(워커 1개, 가장 오염되기 쉬운 조건)로 돌렸다.

```
PASS a.spec.ts       A: BigInt.prototype.toJSON 을 심고 원복하지 않음
  console.log
    B가 본 BigInt.prototype.toJSON = undefined
PASS b.spec.ts
```

**그래서 파일 끝의 `afterAll` 원복은 효과가 관찰될 수 없다.** `afterAll`이 돌고 나면 그 문맥 자체가 버려지므로 되돌린 값을 읽을 코드가 없다. 실제로 e2e 세 곳에 그 원복을 "단위 spec에 이미 있으니 마저 넣는다"는 근거로 추가했다가 되돌린 적이 있다 — 효과 없는 30줄과 사실이 아닌 주석이 남을 뻔했다.

**파일 안에서는 남는다.** 같은 파일의 테스트들은 한 문맥을 공유하므로, 앞 테스트가 바꾼 전역이 뒤 테스트에 그대로 보인다. `src/common/bigint-json.module.spec.ts`가 "초기화 전에는 꺼져 있다"를 단정하는데, 그 단정이 성립하려면 앞 테스트가 남긴 것이 없어야 한다. 그래서 그쪽은 원복이 **필요하다.**

정리하면 이렇다.

| 어디서 | 남는가 | 정리가 필요한가 |
|---|---|---|
| 같은 파일의 다른 테스트 | 남는다 | 필요하다 — `beforeEach`/`afterEach` |
| 다른 테스트 파일 | 남지 않는다 | 필요 없다 |

## 통과만 하는 테스트를 알아보는 방법

**"고치기 전에도 통과하는 테스트"는 회귀를 잡지 못한다.** 초록불이 보장하는 것이 없는데 있다고 착각하게 만들어 없느니만 못하다.

이 저장소에서 실제로 두 번 나왔다.

**하나 — 순수 함수를 같은 인자로 두 번 부르고 결과를 비교했다.** `it('언제 수행했는지와 무관하게 항상 같은 키를 돌려준다')`가 동일 입력으로 두 번 호출해 같은지 봤다. 순수 함수라 어떤 구현에서도 통과한다 — 본문을 `return new Date(0)`으로 바꿔도 초록이다.

**둘 — 정렬 동률을 재현했는데 DB가 우연히 맞는 순서를 돌려줬다.** 같은 밀리초에 세 행을 만들어 2차 정렬키가 없는 상태로 돌렸더니 그냥 통과했다. 행이 적어 Postgres가 물리적 저장 순서대로 읽었기 때문이다. **정렬키를 넣어도 빼도 통과하니 아무것도 고정하지 못한다.**

판별하는 방법은 하나다. **그 테스트를 넣기 전 코드에서 실제로 실패하는지 돌려 보는 것.** 실패를 보지 않았다면 그 테스트가 무엇을 지키는지 모르는 상태다.

둘째 경우처럼 **회귀를 잡는 형태를 감당할 만한 비용으로 만들 수 없으면 테스트를 넣지 않는 쪽이 낫다.** 대신 왜 넣지 않았는지를 남긴다 — 그러지 않으면 다음 사람이 "왜 테스트가 없지"에서 다시 시작한다.

## `BigInt`는 `JSON.stringify`가 거부한다

```
TypeError: Do not know how to serialize a BigInt
```

모든 기본키가 `BIGSERIAL`이라 Prisma가 `bigint`로 돌려준다. `BigIntJsonModule`이 `BigInt.prototype.toJSON`을 심어 문자열로 내보내지만, **그 모듈을 부트하지 않은 경로에서는 여전히 죽는다.**

`Test.createTestingModule(...).createNestApplication()`은 `src/main.ts`를 거치지 않으므로, 부트스트랩에만 가드를 두면 e2e에서 꺼진 상태가 된다. 그래서 가드가 모듈 초기화 시점(`onModuleInit`)에 있고, `test/app.e2e-spec.ts`가 **`AppModule`이 그 모듈을 물고 있는지**까지 확인한다 — 단위 spec만으로는 `imports`에서 빠져도 통과한다.

**`Number`로 바꾸지 마라.** 2^53을 넘는 기본키에서 정밀도가 깨져 다른 행을 가리키는 id가 나간다.

## 실패한 단정의 `bigint` diff는 워커가 보여 주지 못한다

`toEqual` 같은 단정에 `bigint`(또는 그것을 담은 배열·객체)를 쓰는 테스트가 **실패**하면, 워커 모드에서는 무엇이 어떻게 달랐는지 대신 이것만 나온다.

```
TypeError: Do not know how to serialize a BigInt
```

jest-worker가 실패 결과를 부모 프로세스로 보내며 직렬화하는 자리(`messageParent`)가 `bigint`를 다루지 못하기 때문이다. **통과할 때는 아무 문제가 없다** — 실패해야 비로소 터지는 종류라, 정작 diff가 필요한 순간에만 가려진다. 위의 `JSON.stringify` 함정과 원인 계층이 다르다 — 저쪽은 애플리케이션 직렬화이고 이쪽은 jest 내부라 `BigIntJsonModule`로도 막을 수 없다.

**`--runInBand`를 붙여 다시 돌리면 실제 diff가 보인다** (`npm run test:e2e -- --runInBand`). 워커 없이 한 프로세스에서 돌아 직렬화 경계 자체가 없다. 기본키가 전부 `BIGSERIAL`이라 이 저장소의 e2e에 이 패턴이 많다 — e2e 실패 출력이 위 문구뿐이면 테스트를 고치기 전에 먼저 이것으로 원인을 봐라. (병합 목록 e2e의 변이 검증 중에 실측한 함정이다.)

## `@db.Date` 컬럼은 UTC 기준으로 저장된다

`@db.Date`에 넘긴 `Date`를 어댑터가 **UTC 컴포넌트로** 직렬화한다. `@prisma/adapter-pg` 패키지의 `formatDate`가 `getUTCFullYear`·`getUTCMonth`·`getUTCDate`를 쓰기 때문이다(확인 시점 7.9.1, 설치본의 `dist/index.js`). 여기서도 경로보다 **함수 이름과 이 세 호출을 검색어로 삼아라.**

그래서 로컬 컴포넌트로 만든 날짜는 **하루 밀린다.** KST에서 확인한 결과다.

```js
new Date(2026, 7, 1).toISOString()   // '2026-07-31T15:00:00.000Z' → 2026-07-31 로 저장된다
```

날짜 값은 반드시 `src/todos/todo-local-date.ts`가 만든 것을 쓴다. 그 파일이 `Date.UTC`로 자정을 맞춘다. 테스트에서 날짜가 하루 어긋나면 먼저 이것을 의심해라.

## 타입으로만 막은 것은 테스트로 고정한다

DB 제약이 아니라 TypeScript 타입으로 막은 규칙이 있다. `UpdateTodoTemplateInput`이 `todoType`·`completeType`을 `Omit`으로 빼서 "만든 뒤 바꿀 수 없다"를 표현하는 것이 그 예다.

**타입 방어는 그 `Omit`이 사라지면 조용히 없어진다.** `@ts-expect-error`로 고정한다.

```ts
const typeGuard = async () => {
  // @ts-expect-error todoType은 생성 후 수정할 수 없다
  await templates.update(1n, { todoType: 'NUMERIC' });
};
expect(typeGuard).toBeInstanceOf(Function);
```

`@ts-expect-error`는 "다음 줄에 타입 오류가 있을 것"이라는 선언이고, 오류가 **없으면** TypeScript가 거꾸로 `Unused '@ts-expect-error' directive`로 실패한다. 즉 누군가 금지를 풀면 그 순간 `npm run verify`가 깨진다.

**함수를 선언만 하고 부르지 않는다.** 실행하면 실제 DB를 건드리고, 컴파일만 되면 목적이 달성된다.

## e2e는 실제 공유 DB에 붙는다

`test/` 아래 e2e는 Supabase에 그대로 붙는다. 그래서 셋을 지킨다.

- **전용 유저를 만들고 끝나면 지운다.** `beforeAll`에서 랜덤 이메일로 만들고 `afterAll`에서 삭제한다. FK가 cascade라 하위 행이 함께 사라진다
- **남의 데이터를 전제하지 않는다.** 테이블이 비어 있다고 가정하지도 않는다
- **실패해도 정리되게 짠다.** `afterAll`이 돌지 않는 경로를 만들지 마라

`npm test`(단위)는 `rootDir`이 `src`라 `test/`를 돌지 않는다. **e2e로 검증하는 코드는 단위 커버리지가 0으로 나온다** — 숫자만 보고 테스트가 없다고 판단하지 마라. Repository가 그 경우다.

## ES 모듈에는 `jest.spyOn`이 통하지 않는다

`import * as ns from '...'`으로 받은 네임스페이스 객체는 속성이 재정의 불가라 `jest.spyOn`이 `Cannot redefine property`로 죽는다. **모듈 단위 `jest.mock`으로 대체한다.**

`jest.mock`의 팩토리는 파일 최상단으로 끌어올려져 import 바인딩보다 먼저 실행되므로, 팩토리 안에서 다른 모듈을 쓰려면 그 자리에서 `require`해야 한다.

평범한 객체나 클래스 인스턴스는 `jest.spyOn`이 그대로 통한다. **모듈 로드 시점에 상수로 굳는 값**은 어느 쪽으로도 바꿀 수 없어 재import가 필요하다.

## `void`로 띄운 promise가 거절되면 테스트가 깨진다

프로덕션 코드가 `void doSomethingAsync()`로 결과를 버리는 경우, 그 promise가 거절되면 아무도 붙잡지 않은 unhandled rejection이 된다. 실행 중에는 경고 로그로 끝나지만 **jest는 이것으로 테스트를 실패시킨다.**

**테스트를 우회해 넘길 문제가 아니라 프로덕션 코드의 결함 신호로 읽는다.** 결과를 버릴 작정이면 그 함수가 스스로 실패를 흡수해야 한다. 체인 **끝에** `.catch(() => undefined)`를 둔다 — 앞에 두면 소용없고, 다음 호출이 올 때까지 아무도 붙잡지 않은 거절이 남는 창이 생긴다.
