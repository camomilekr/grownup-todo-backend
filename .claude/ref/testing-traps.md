# 참조 — 테스트에서 막히는 지점 (이 저장소 고유)

**일반적인 jest 함정(전역 상태의 파일 간 격리, 통과만 하는 테스트 판별, `@ts-expect-error` 타입 가드, e2e 3원칙, ES 모듈 `jest.spyOn`, `void` promise)은 git-workflow 플러그인의 `ref/testing-traps.md`에 있다.** 여기는 이 저장소의 스택(Prisma 7 · BIGSERIAL · Supabase)에서만 걸리는 것을 모았다.

## `BigInt`는 `JSON.stringify`가 거부한다

```
TypeError: Do not know how to serialize a BigInt
```

모든 기본키가 `BIGSERIAL`이라 Prisma가 `bigint`로 돌려준다. `BigIntJsonModule`이 `BigInt.prototype.toJSON`을 심어 문자열로 내보내지만, **그 모듈을 부트하지 않은 경로에서는 여전히 죽는다.**

`Test.createTestingModule(...).createNestApplication()`은 `src/main.ts`를 거치지 않으므로, 부트스트랩에만 가드를 두면 e2e에서 꺼진 상태가 된다. 그래서 가드가 모듈 초기화 시점(`onModuleInit`)에 있고, `test/app.e2e-spec.ts`가 **`AppModule`이 그 모듈을 물고 있는지**까지 확인한다 — 단위 spec만으로는 `imports`에서 빠져도 통과한다.

**`Number`로 바꾸지 마라.** 2^53을 넘는 기본키에서 정밀도가 깨져 다른 행을 가리키는 id가 나간다.

## 실패한 단정의 `bigint` diff는 워커가 보여 주지 못한다

`toEqual` 같은 단정에 `bigint`(또는 그것을 담은 배열·객체)를 쓰는 테스트가 **실패**하면, 워커 모드에서는 무엇이 어떻게 달랐는지 대신 위와 똑같은 `TypeError: Do not know how to serialize a BigInt`만 나온다. jest-worker가 실패 결과를 부모 프로세스로 보내며 직렬화하는 자리(`messageParent`)가 `bigint`를 다루지 못하기 때문이다. **통과할 때는 아무 문제가 없다** — 실패해야 비로소 터지는 종류라, 정작 diff가 필요한 순간에만 가려진다. 원인 계층이 애플리케이션 직렬화가 아니라 jest 내부라서 `BigIntJsonModule`로도 막을 수 없다.

**`--runInBand`를 붙여 다시 돌리면 실제 diff가 보인다** (`npm run test:e2e -- --runInBand`). 워커 없이 한 프로세스에서 돌아 직렬화 경계 자체가 없다. 기본키가 전부 `BIGSERIAL`이라 이 저장소의 e2e에 이 패턴이 많다 — e2e 실패 출력이 위 문구뿐이면 테스트를 고치기 전에 먼저 이것으로 원인을 봐라.

## `@db.Date` 컬럼은 UTC 기준으로 저장된다

`@db.Date`에 넘긴 `Date`를 어댑터가 **UTC 컴포넌트로** 직렬화한다. `@prisma/adapter-pg` 패키지의 `formatDate`가 `getUTCFullYear`·`getUTCMonth`·`getUTCDate`를 쓰기 때문이다(확인 시점 7.9.1, 설치본의 `dist/index.js`). 버전이 올라 파일 배치가 바뀌면 경로가 아니라 **함수 이름과 이 세 호출을 검색어로 삼아라.**

그래서 로컬 컴포넌트로 만든 날짜는 **하루 밀린다.** KST에서 확인한 결과다.

```js
new Date(2026, 7, 1).toISOString()   // '2026-07-31T15:00:00.000Z' → 2026-07-31 로 저장된다
```

날짜 값은 반드시 `src/todos/todo-local-date.ts`가 만든 것을 쓴다. 그 파일이 `Date.UTC`로 자정을 맞춘다. 테스트에서 날짜가 하루 어긋나면 먼저 이것을 의심해라.

## e2e는 실제 공유 DB(Supabase)에 붙는다

플러그인의 e2e 3원칙(전용 데이터·남의 데이터 비전제·실패해도 정리)에 더해, 이 저장소의 구체화는 이렇다.

- **전용 유저를 `beforeAll`에서 랜덤 이메일로 만들고 `afterAll`에서 지운다.** FK(외래키)가 cascade라 하위 행이 함께 사라진다
- e2e는 `.env`의 `DATABASE_URL`이 필요하다 — 돌릴 수 없었다면 판정 보고의 "확인하지 못한 것"에 적는다
- `npm test`(단위)는 jest `rootDir`이 `src`라 `test/`를 돌지 않는다 — **e2e로 검증하는 코드(Repository가 그 경우다)는 단위 커버리지가 0으로 나온다.** 숫자만 보고 테스트가 없다고 판단하지 마라
