# 테스트 규약 (TDD)

## 개발 순서

1. **실패하는 테스트를 먼저 작성한다**
2. **테스트가 실패하는 것을 실제로 확인한다.** 건너뛰면 통과를 보장하지 않는 테스트를 쓰게 된다
3. 통과시키는 **최소한의 코드**를 작성한다
4. 통과를 확인한 뒤 구조를 다듬는다. 이때 테스트는 계속 통과해야 한다

버그를 고칠 때는 **먼저 그 버그를 재현하는 테스트**를 쓴다. 재현 테스트 없이 고치면 같은 버그가 돌아왔는지 알 수 없다.

## 무엇을 테스트하는가

우선순위가 높은 순서다.

1. **`utils/`의 순수 함수** — 가장 값싸고 확실하다. 분기마다 테스트를 쓴다
2. **경계 조건** — 날짜 경계, 빈 배열, `null`과 `0`의 구별, 범위의 양 끝
3. **컴포넌트의 관찰 가능한 동작** — 화면에 무엇이 보이는지, 탭하면 어떤 콜백이 불리는지
4. **버그 재현** — 한 번 발생한 버그는 테스트로 고정한다

테스트하지 않는 것: 구현 세부사항(내부 state 이름, 호출 순서), 스타일 값, 서드파티 라이브러리의 동작.

## 파일 배치와 이름

테스트는 **대상 파일 옆에** 두고 `.test.ts` / `.test.tsx`를 붙인다. 별도 `__tests__/` 폴더를 만들지 않는다.

```
src/utils/todoStatus.ts
src/utils/todoStatus.test.ts
```

## 작성 방식

- `describe`로 대상을, `it`으로 **기대하는 행동**을 한국어로 쓴다. `it('목표에 도달하면 true다')`처럼 읽어서 명세가 되게 한다
- 테스트 하나에 단정은 하나의 관심사만 담는다
- 픽스처는 **필요한 필드만 덮어쓰는 생성 함수**로 만든다

  ```ts
  function createTodo(overrides: Partial<Todo> = {}): Todo {
    return { id: 'test-id', title: '테스트 할 일', /* ... */ ...overrides };
  }
  ```

- 같은 규칙이 여러 입력에 적용되면 `it.each`를 쓴다
- 날짜는 **테스트 안에 상수로 고정한다.** `new Date()`를 쓰면 실행 시점에 따라 결과가 바뀐다

## 컴포넌트 테스트

`@testing-library/react-native` v14를 쓴다. 셋을 지킨다.

### 거의 다 Promise를 반환한다 — 전부 await한다

**v14부터 `render`, `renderHook`, `fireEvent`, `unmount`가 모두 Promise를 반환한다**(v13까지는 동기였다).

| 함수 | await를 빼면 |
|---|---|
| `render` / `renderHook` | `screen`이 비어 `` `render` function has not been called ``로 실패 |
| `fireEvent` | 상태 변경이 반영되기 전에 단정이 실행돼 **낡은 화면을 보고 실패** |
| `unmount` | 정리가 끝나기 전에 다음 줄이 돌아 검증이 헛돈다 |

```tsx
await render(<TodoItem {...props} />);
await fireEvent(screen.getByRole('switch'), 'valueChange', true);
expect(screen.getByText('우유 사기')).toBeOnTheScreen();
```

`fireEvent` 쪽이 특히 헷갈린다. 실패 메시지가 "요소를 못 찾았다"로 나와 셀렉터 문제처럼 보이지만 실제로는 렌더가 아직 안 끝난 것이다.

### 접근성 라벨로 요소를 찾는다

`getByLabelText`, `getByRole`, `getByText`를 쓴다. `testID`는 다른 방법이 없을 때만. 접근성 속성으로 찾으면 스크린리더 사용자가 실제로 보는 것을 검증하게 된다.

### 콜백이 불리지 않은 것도 확인한다

탭 영역이 나뉜 컴포넌트에서는 **의도한 콜백만** 불렸는지 본다.

```tsx
expect(onToggle).toHaveBeenCalledWith('test-id');
expect(onEdit).not.toHaveBeenCalled();
```

## prop 단정은 최후의 수단이다

**렌더 결과로 확인할 수 있는 것을 mock이 받은 prop으로 검증하지 마라.** 그건 구현 세부사항 테스트이고 리팩터링마다 깨진다.

정당한 경우는 하나다 — **동작이 네이티브에서만 드러나고 Jest가 그것을 재현하지 못할 때.** 그때는 **왜 렌더 결과로 볼 수 없는지를 테스트 주석에 적는다.** 근거 없는 prop 단정은 다음 사람이 "이거 왜 이렇게 검증하지"에서 멈춘다. 방식과 선례는 `.claude/ref/testing-traps.md`.

## 커버리지

```bash
npm run test:cov
```

현재 문 기준 **99%**. `hooks/`, `screens/`, `store/`, `constants/`는 100%다.

**100%를 목표로 삼지 않는다.** 남은 다섯 곳은 도달할 수 없거나, 덮으려면 프로덕션 코드가 아니라 모듈 로더를 검증하게 되는 자리다. 위치와 이유는 각 폴더 `CONTEXT.md`의 "커버리지에서 비어 있는 곳"에 있다.

새 코드는 커버리지 숫자보다 **분기마다 테스트가 있는지**를 본다. 숫자를 맞추려고 `/* istanbul ignore */`를 붙이지 말 것 — 그건 100%가 아니라 100%처럼 보이는 것이다.

## 라이브러리가 예상과 다르게 동작하면

아래 증상에 걸리면 **`.claude/ref/testing-traps.md`를 읽어라.** 전부 이 저장소에서 실제로 막혔던 지점이고, 대응이 직관과 다르다.

| 증상 | 무엇이 걸린 것인가 |
|---|---|
| `UNSAFE_getByType is not a function` | v14가 `UNSAFE_*` 쿼리 **네 개를 전부** 제거했다. 다른 UNSAFE 쿼리로 바꾸는 대응이 없다 |
| `FlashList`·`BottomSheetModal`을 렌더 결과로 확인할 수 없다 | mock이 받은 prop을 기록해 검증한다. 통째로 덮을지 한 겹만 덮을지 기준이 있다 |
| `Cannot read properties of undefined (reading 'loadUnpackers')` | reanimated 4에서 `react-native-reanimated/mock`을 썼다 |
| `Cannot redefine property` | ES 모듈 네임스페이스에 `jest.spyOn`을 썼다 |
| 바텀 시트가 `present()` 뒤에도 아무것도 그리지 않는다 | 테스트 렌더러에서 높이가 0이다 |
| unhandled rejection으로 테스트가 깨진다 | `void`로 띄운 promise가 거절됐다. **프로덕션 코드의 결함 신호로 읽는다** |
| 같은 테스트가 두 번 돈다 | `jest.config.js`의 `modulePathIgnorePatterns`가 빠졌다 |

`jest.config.js`의 `resolver: 'react-native-worklets/jest/resolver.js'`와 `jest.setup.ts`의 `setUpTests()` 조합, `transformIgnorePatterns`의 추가 항목은 **지우지 말 것.** 이유는 같은 참조 문서에 있다.

## 커밋 전

```bash
npm run verify     # lint → prettier → typecheck. 2초
npm test           # verify에 테스트는 들어 있지 않다. 별도로 돌린다
npm run test:e2e   # jest rootDir이 src라 `npm test`는 test/를 돌지 않는다
```

**세 명령 중 어느 것도 pre-commit 훅이 돌려 주지 않는다.** 훅은 `verify`만 돌린다 — 테스트를 깨뜨린 커밋을 막는 자동 관문은 이 저장소에 없다.
