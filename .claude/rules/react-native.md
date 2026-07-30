# React Native 코드 규약

## 컴포넌트

- 모든 컴포넌트는 함수형 컴포넌트로 작성한다 (클래스 컴포넌트 금지)
- 컴포넌트 파일명과 컴포넌트명은 PascalCase로 작성한다 (예: `TodoItem.js`)
- 컴포넌트는 `export default`로 내보낸다
- 파일 하나에 컴포넌트 하나만 작성한다

## 폴더 구조

```
src/
  components/   # 재사용 가능한 공통 컴포넌트
  screens/      # 화면 단위 컴포넌트
  hooks/        # 커스텀 훅 (use* 접두사)
  utils/        # 순수 유틸리티 함수
  constants/    # 상수 (색상, 크기, 문자열 등)
  store/        # 전역 상태 관리
```

## 스타일

- 인라인 스타일 객체 사용 금지, 반드시 `StyleSheet.create()`를 사용한다
- 스타일 정의는 파일 하단에 위치시킨다
- 색상, 폰트 크기 등 디자인 토큰은 `constants/` 에 정의하고 참조한다

## 상태 관리

- 로컬 상태는 `useState`, 부수 효과는 `useEffect`를 사용한다
- 컴포넌트 간 공유 상태는 Context API 또는 전역 상태 라이브러리를 사용한다
- `useEffect` 의존성 배열은 생략하지 않는다

## 성능

- 무거운 연산은 `useMemo`, 콜백 함수는 `useCallback`으로 메모이제이션한다
- 리스트는 `FlatList` 또는 `SectionList`를 사용하고 `ScrollView` + `map()` 조합은 피한다
- 이미지는 크기를 명시하고, 필요한 경우 `resizeMode`를 지정한다

## 네이밍

- 훅: `use` 접두사 (예: `useTodos`)
- 이벤트 핸들러: `handle` 접두사 (예: `handlePress`, `handleSubmit`)
- 불리언 변수/props: `is`, `has`, `can` 접두사 (예: `isLoading`, `hasError`)
- 상수: UPPER_SNAKE_CASE (예: `MAX_TODO_LENGTH`)

## Expo 관련

- Expo SDK API를 우선 사용하고, 네이티브 모듈이 꼭 필요한 경우에만 서드파티를 도입한다
- 코드 작성 전 반드시 https://docs.expo.dev/versions/v57.0.0/ 에서 해당 버전 문서를 확인한다
- `expo-constants`, `expo-device` 등 Expo 제공 유틸리티를 적극 활용한다
