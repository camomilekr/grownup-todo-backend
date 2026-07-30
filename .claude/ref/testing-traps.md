# 참조 — 테스트에서 막히는 지점

`.claude/rules/testing.md`의 증상 표에서 여기로 온다. 전부 이 저장소에서 실제로 막혔던 것이고, **대응이 직관과 다른 것만** 모았다.

## RNTL v14는 `UNSAFE_*` 쿼리를 전부 제거했다

**`UNSAFE_getByType`, `UNSAFE_getAllByType`, `UNSAFE_getByProps`, `UNSAFE_getAllByProps` 네 개가 모두 사라졌다.** Test Renderer가 host 요소만 렌더링하게 되면서 합성 컴포넌트를 돌려줄 수 없어서다. 근거는 `node_modules/@testing-library/react-native/docs/guides/migration-v14.md`의 "Removed queries" 절.

```
TypeError: _reactNative.screen.UNSAFE_getByType is not a function
```

**네 개가 함께 사라졌으므로 "다른 UNSAFE 쿼리로 바꾼다"는 대응이 없다.** v13까지의 예제나 라이브러리 이슈 답변을 그대로 옮기면 여기서 막힌다. 이것을 모른 채 계획서가 `UNSAFE_getByProps`를 대안으로 제시해 구현이 막힌 적이 있다.

## 렌더 결과로 확인할 수 없는 라이브러리 계약

`FlashList`나 `BottomSheetModal`처럼 렌더 결과로 확인할 수 없는 계약은 **mock이 받은 prop을 기록해** 검증한다.

```tsx
// 실제 구현을 그대로 그리면서 prop만 기록하는 한 겹을 덮는다
jest.mock('@shopify/flash-list', () => {
  const actual = jest.requireActual('@shopify/flash-list');
  return {
    ...actual,
    FlashList: (props: Record<string, unknown>) => {
      globalThis.__flashListProps = props;
      return actual.FlashList(props);
    },
  };
});
```

**통째로 대체할지 한 겹만 덮을지는 그 파일의 다른 테스트가 무엇을 보는지로 갈린다.**

| 상황 | 방식 | 예 |
|---|---|---|
| 그 컴포넌트의 실제 렌더링을 검증하는 테스트가 같은 파일에 있다 | `jest.requireActual`로 **한 겹만** 덮는다. 통째로 mock하면 그 검증이 사라진다 | `TodoList.test.tsx`의 `FlashList` — 다른 8건이 항목·빈 상태·콜백 전달을 본다 |
| 테스트 환경에서 그 컴포넌트가 애초에 아무것도 그리지 않는다 | 통째로 대체한다 | `TodoFormSheet.test.tsx`의 `BottomSheetModal` — 높이가 0이라 `present()`를 불러도 내용이 없다 |

### 전역에 기록하는 mock은 `beforeEach`에서 반드시 비운다

```ts
beforeEach(() => {
  globalThis.__flashListProps = undefined;
});
```

비우지 않으면 값이 파일 전체에 남아, **그 컴포넌트를 렌더하지 않은 테스트가 앞선 테스트가 남긴 값을 읽고 통과한다.** 값을 만든 렌더가 없는데 단정이 성공하는, 알아채기 어려운 false pass다.

### prop 단정이 정당했던 예

`TodoList`의 `maintainVisibleContentPosition`이 그 예다. FlashList는 항목 위치를 `measureLayout`으로 실측하는데, `@react-native/jest-preset`의 `MockNativeMethods.js`가 그것을 **콜백을 부르지 않는 빈 mock**으로 두어 모든 layout이 `{0,0,0,0}`이 된다. 스크롤 보정량이 항상 0이라 증상이 재현되지 않는다.

## 네이티브 모듈

`jest.setup.ts`에서 대체한다. jest-expo 프리셋이 Expo SDK 모듈은 대부분 처리하지만, 아래는 직접 설정했다.

| 모듈 | 처리 |
|---|---|
| AsyncStorage | 공식 mock(`jest/async-storage-mock`) |
| gesture-handler | 공식 `jestSetup` |
| reanimated 4 | `setUpTests()` + `jest.config.js`의 `resolver` |

**reanimated 4에서 `react-native-reanimated/mock`을 쓰면 안 된다.** 그 mock이 `react-native-worklets`를 거쳐 네이티브 모듈을 불러오다 `Cannot read properties of undefined (reading 'loadUnpackers')`로 죽는다. `jest.config.js`의 `resolver: 'react-native-worklets/jest/resolver.js'`가 이 문제를 해결하므로 **지우지 말 것.**

`jest.config.js`의 `transformIgnorePatterns`는 프리셋 값을 **대체**한다(병합 아님). jest-expo를 올릴 때 프리셋 목록과 비교할 것 — 변환되지 않은 코드를 배포하는 패키지(`@gorhom`, `@shopify`)를 직접 더해 두었다.

`tsconfig.json`의 `types: ["jest"]`가 없으면 `describe`/`it`을 찾지 못한다.

## ES 모듈에는 `jest.spyOn`이 통하지 않는다

`import * as Notifications from 'expo-notifications'`처럼 받은 네임스페이스 객체는 속성이 재정의 불가라 `jest.spyOn`이 `Cannot redefine property`로 죽는다. **모듈 단위 `jest.mock`으로 대체한다.**

```ts
jest.mock('expo-notifications', () => ({
  __esModule: true,
  SchedulableTriggerInputTypes: { DATE: 'date' },
  scheduleNotificationAsync: jest.fn(),
}));
```

`jest.mock`의 팩토리는 파일 최상단으로 끌어올려져 import 바인딩보다 먼저 실행되므로, 팩토리 안에서 다른 모듈을 쓰려면 그 자리에서 `require`해야 한다. 그래서 테스트 파일은 `@typescript-eslint/no-require-imports`를 끄고 있다(`eslint.config.js`).

`AsyncStorage`나 `AppState`처럼 평범한 객체는 `jest.spyOn`이 그대로 통한다. `Platform.OS`는 데이터 속성이라 `jest.replaceProperty`로 바꿀 수 있다 — 단 **렌더 중에 읽는 경우만** 통한다. 모듈 로드 시점에 상수로 굳는 값(`utils/pedometer.ts`의 `IS_STEP_TRACKING_SUPPORTED`)은 재import가 필요하다.

## 바텀 시트는 파일 단위로 mock한다

실제 `BottomSheetModal`은 컨테이너 레이아웃을 측정한 뒤에야 내용을 붙인다. 테스트 렌더러에서는 높이가 0이라 **`present()`를 불러도 아무것도 그려지지 않는다.**

`@gorhom/bottom-sheet/mock`(공식)이 있지만 `onDismiss`와 `backdropComponent`를 부르지 않아 닫힘 처리를 검증할 수 없다. `TodoFormSheet.test.tsx`와 `TodoScreen.test.tsx`는 그 두 prop을 밖으로 꺼내 주는 mock을 직접 만들어 쓴다.

이 mock은 `jest.setup.ts`의 부분 mock을 덮어쓰므로 **`BottomSheetTextInput`을 반드시 함께 내보내야** 폼이 렌더링된다.

`dismiss`가 `onDismiss`를 부르지 않는 mock을 쓰면 `isSheetOpen`이 `true`로 남아 배경이 접근성 트리에서 빠진 채가 되고, **목록과 헤더가 쿼리에 잡히지 않는다.** 이 실패는 "진단이 틀렸다"의 신호가 아니라 mock 배선 문제다 — 이 구분을 못 하면 엉뚱한 곳을 파게 된다.

## `void`로 띄운 promise가 거절되면 테스트가 깨진다

프로덕션 코드가 `void doSomethingAsync()`로 결과를 버리는 경우, 그 promise가 거절되면 아무도 붙잡지 않은 unhandled rejection이 된다. 앱에서는 경고 로그로 끝나지만 **Jest는 이것으로 테스트를 실패시킨다.**

이건 테스트를 우회해서 넘길 문제가 아니라 **프로덕션 코드의 결함 신호**로 읽는다. 결과를 버릴 작정이면 그 함수가 스스로 실패를 흡수해야 한다. `TodoProvider`의 `applyReminderSync`가 그 예로, 체인 **끝에** `.catch(() => undefined)`를 두어 반환하는 promise가 절대 거절되지 않게 한다.

`.catch`를 체인 앞에 두면 소용없다. 다음 호출이 올 때까지 아무도 붙잡지 않은 거절이 남는 창이 생긴다.
