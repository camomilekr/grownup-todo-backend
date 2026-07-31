// 타입만 가져온다. 값 import가 없으므로 이 파일은 Prisma 런타임에 의존하지 않고,
// 그래서 순수 함수만 담긴 파일로 남는다.
import type {
  Prisma,
  TodoHistory,
  TodoTemplate,
} from '../generated/prisma/client';
import type { CompleteType, TodoType } from '../generated/prisma/enums';
import { formatLocalDateKey } from './todo-local-date';

/**
 * 정의 행과 완료 기록 행을 **밖으로 내보낼 형태**로 바꾸는 순수 함수들.
 *
 * Prisma 모델을 그대로 내보내지 않는 이유가 셋이다.
 *
 * 1. **`Prisma.Decimal`이 새어 나간다.** 런타임 클래스라 JSON으로 나갈 때 내부 표현이
 *    드러나고, 받는 쪽 형태가 Prisma 구현에 묶인다. `number`로 바꿔도 값이 달라지지
 *    않는다 — `@db.Decimal(12, 2)`는 소수점 이하를 포함해 유효자리가 최대 **12자리**이고
 *    (Postgres `numeric(p, s)`의 `p`가 전체 자리다), 배정밀도 부동소수점이 정확히 담는
 *    것은 15자리다. **3자리 여유가 있다** — 컬럼 정밀도를 늘릴 때 이 여유부터 확인해라
 * 2. **`@db.Date` 컬럼의 `Date`는 UTC 자정이다.** 그대로 내보내면 받는 쪽이 자기 로컬
 *    타임존으로 해석해 음수 오프셋 지역에서 하루 앞으로 밀려 보인다. 날짜만 있는 값에는
 *    애초에 타임존이 없으므로 `YYYY-MM-DD` 문자열이 옳은 표현이다
 * 3. **`userId`와 `deletedAt`이 붙어 나간다.** 컬럼을 하나 추가한 날 응답이 조용히
 *    바뀌는 것을 막는다
 *
 * **완료 여부(`isCompleted`)는 여기서 계산한다.** 저장된 값은 완료 시각 하나이고
 * (`isCompleted` 컬럼을 두면 두 값이 어긋날 수 있다), 그 해석을 화면마다 반복하면
 * 한쪽만 고쳐지는 날이 온다.
 */

/** 반복 방식이 일회성으로 좁혀진 정의. `toOnceTodoDetail`이 이것만 받는다 */
export type OnceTodoTemplate = TodoTemplate & { completeType: 'ONCE' };

/** 반복 방식이 매일 반복으로 좁혀진 정의. `toDailyTodoDetail`이 이것만 받는다 */
export type DailyTodoTemplate = TodoTemplate & { completeType: 'DAILY' };

/**
 * 반복 방식으로 갈린 정의. 상세 변환 함수 둘에 값을 넘길 때 거치는 형태다.
 *
 * **이 타입을 가진 값이 반드시 `narrowByCompleteType`을 거쳤다는 뜻은 아니다.**
 * `{ ...dailyRow, completeType: 'ONCE' }`처럼 손으로 만든 값도 검사 없이 통과하고,
 * 실제로 `todo-view.spec.ts`의 픽스처가 그렇게 만든다. TypeScript에서 닫을 수 없는
 * 구멍이므로 "그 함수만 만들 수 있다"로 읽지 마라 — 막아 주는 것은 **반복 방식이
 * 어긋난 값을 실수로 넘기는 것**까지다.
 */
export type NarrowedTodoTemplate = OnceTodoTemplate | DailyTodoTemplate;

/**
 * Repository가 돌려준 정의를 **반복 방식으로 갈린 합집합으로 다시 선언한다.** 상세 변환
 * 함수 둘에 값을 넘기려면 이것을 거친다.
 *
 * **런타임 동작이 없다. 받은 것을 그대로 돌려준다** — 이 함수가 하는 일은 값을 바꾸는
 * 것이 아니라 반환 타입 애노테이션이 전부다.
 *
 * **그런데도 필요한 이유는 조건 분기만으로 좁혀지지 않기 때문이다.** `TodoTemplate`은
 * 판별 속성을 가진 합집합이 아니라 단일 객체 타입이라, `if (template.completeType ===
 * 'ONCE')` 안쪽에서도 `template` 자체의 타입은 그대로 남는다 — `completeType`
 * **속성만** 좁혀진다. 그래서 `toOnceTodoDetail(template, …)`이 `TS2345`로 거절된다.
 *
 * 그 상태에서 가장 짧은 우회는 `template as OnceTodoTemplate`인데, 그러면 반복 방식을
 * 타입으로 막아 둔 장치가 **그것이 필요한 유일한 지점에서** 사라진다.
 *
 * **왜 반환문 하나로 되는가.** TypeScript는 어떤 값을 **합집합 타입에 할당**할 때, 소스의
 * 판별 속성이 유한한 리터럴 합집합이면 값별로 쪼개어 대상의 각 멤버에 맞춰 본다.
 * `completeType`이 `'ONCE' | 'DAILY'`이므로 `TodoTemplate`이 이 합집합에 그대로 들어간다.
 * 반면 **함수 인자 자리**는 매개변수 타입이 `OnceTodoTemplate` 하나뿐이라 쪼개 맞출 대상이
 * 없어 거절된다. 그 차이가 이 함수의 존재 이유다.
 *
 * **사용자 정의 타입 가드(`t is OnceTodoTemplate`)로는 반쪽만 해결된다.** 참인 갈래는
 * 좁혀지지만 거짓인 갈래는 그대로다 — 교차 타입은 합집합에서 빼낼 수 있는 형태가
 * 아니라서 `else` 쪽이 여전히 넓은 `TodoTemplate`이다.
 *
 * 위 셋(조건 분기·이 반환문·타입 가드)은 모두 tsc 5.9.3에서 실측했다.
 */
export function narrowByCompleteType(
  template: TodoTemplate,
): NarrowedTodoTemplate {
  return template;
}

/**
 * 완료 기록 한 건이 말하는 **상태**.
 *
 * **`historiedOn`을 담지 않는다.** 일회성의 그 값은 정의 생성 시각에서 나온 중복 방지
 * 키라서 화면에 보여 줄 날짜가 아닌데(`todo-local-date.ts`), 이 타입은 일회성과 매일
 * 반복이 함께 쓰기 때문이다. 날짜가 필요한 쪽은 매일 반복 이력뿐이고 그것만
 * `TodoHistoryItem`이 담는다.
 */
export type TodoProgress = {
  /** 그날 달성한 값. **`0`과 `null`은 다르다** — 0을 입력한 것과 입력하지 않은 것이다 */
  progressValue: number | null;
  /**
   * **그 기록에 복사된** 목표치와 단위. 정의 쪽 값이 아니다 — 목표를 나중에 올려도
   * 지난 기록의 달성률이 소급해 바뀌지 않게 하려고 복사해 둔 값이다
   */
  targetValue: number | null;
  targetUnit: string | null;
  /** 완료 시각이 채워져 있는가. 저장된 값이 아니라 여기서 계산한 결과다 */
  isCompleted: boolean;
  /** 완료한 순간. 일회성의 완료 시점을 답하는 값이 이것뿐이다 */
  completedAt: Date | null;
};

/** 매일 반복 이력의 한 항목. 상태에 **표시용 날짜**가 붙은 형태다 */
export type TodoHistoryItem = TodoProgress & {
  /** 유저 타임존 기준 날짜(`YYYY-MM-DD`). 매일 반복에서만 표시용으로 성립한다 */
  historiedOn: string;
};

/** 정의에서 나오는 값들. 목록 항목과 상세 두 갈래가 함께 쓴다 */
type TodoTemplateView = {
  todoId: bigint;
  title: string;
  description: string | null;
  todoType: TodoType;
  remindAt: string | null;
  /** 일회성의 예정일. 시각(`Timestamptz`)이라 날짜 문자열로 줄이지 않는다 */
  shouldDoAt: Date | null;
  /** **현재** 목표치와 단위. 기록에 복사된 값과 다를 수 있다 */
  targetValue: number | null;
  targetUnit: string | null;
  /** 매일 반복의 활성 기간(`YYYY-MM-DD`). 양 끝을 포함하고 `null`은 제한 없음이다 */
  activeFrom: string | null;
  activeUntil: string | null;
};

/**
 * 목록의 항목 하나. 일회성 목록과 매일 반복 목록이 같은 형태를 쓴다.
 *
 * `progress`가 `null`이면 **아직 손대지 않았다**는 뜻이다. 기록은 완료하거나 진행값을
 * 입력할 때 비로소 생기므로 빈 객체로 바꾸면 그 구분이 사라진다.
 */
export type TodoListItem = TodoTemplateView & {
  completeType: CompleteType;
  progress: TodoProgress | null;
};

/**
 * 일회성 할 일의 상세.
 *
 * 상태가 `progress` 한 건이다 — 일회성은 완료 기록이 하나뿐이기 때문이다.
 * `histories?: never`는 **이력 배열을 주지 않는다**는 것을 타입으로 못 박는다. 합집합
 * 타입에서는 다른 갈래의 필드를 넣은 객체 리터럴이 통과하는데, 그러면 "일회성에는
 * 이력이 없다"는 규칙이 조용히 깨진다.
 */
export type OnceTodoDetail = TodoTemplateView & {
  completeType: 'ONCE';
  progress: TodoProgress | null;
  histories?: never;
};

/**
 * 매일 반복 할 일의 상세.
 *
 * 상태가 날짜별 이력 배열이다. **`progress`를 주지 않는다**(`progress?: never`) —
 * 날짜마다 상태가 다른데 하나를 골라 담으면 어느 날짜의 것인지가 결과에 드러나지 않아
 * 클라이언트가 잘못된 날의 상태를 그린다.
 */
export type DailyTodoDetail = TodoTemplateView & {
  completeType: 'DAILY';
  histories: TodoHistoryItem[];
  progress?: never;
};

/**
 * 상세 조회의 결과. **반복 방식으로 갈리는 합집합이다.**
 *
 * 한 타입에 옵셔널 필드로 합치지 않은 이유: 매일 반복 이력에는 `historiedOn`이 표시용
 * 날짜로 들어가야 하는데 일회성의 그 값은 표시용이 아니다. 섞으면 "일회성 날짜를
 * 내보내지 않는다"는 규칙을 타입이 더 이상 지키지 못한다.
 */
export type TodoDetail = OnceTodoDetail | DailyTodoDetail;

/**
 * 이 파일에서 "없음"을 판정할 때 **느슨한 비교(`== null`)를 쓴다.** `null`과 `undefined`를
 * 함께 잡으려는 것이고, 그것이 필요한 이유가 이 프로젝트의 설정에 있다.
 *
 * `tsconfig.json`이 `strictNullChecks: false`이고 `noUncheckedIndexedAccess`도 켜져 있지
 * 않다. 그래서 **빈 배열의 첫 항목(`histories[0]`)이 `TodoHistory` 타입으로 통과한다** —
 * 실제 값은 `undefined`인데 컴파일러가 아무 진단도 내지 않는다. 목록 조회가 넘기는 값이
 * 바로 그것이고(`findDailyActiveOn`의 `histories`는 0개 또는 1개다), "아직 손대지 않은
 * 할 일"은 예외가 아니라 **가장 흔한 상태**다.
 *
 * 엄격한 비교(`=== null`)로 두면 두 방향으로 잘못된다. 값을 읽는 자리에서는 예외가 나서
 * 목록 조회 전체가 실패하고, `completedAt`처럼 **없음을 판정하는 자리에서는 뜻이
 * 뒤집힌다** — 속성이 빠진 객체가 "완료"로 읽혀 하지 않은 일이 완료로 표시된다.
 *
 * 문서화 주석으로 "없으면 `null`을 넘겨라"라고 계약을 적어 두는 것으로는 부족하다.
 * 컴파일러가 검사해 주지 않는 계약은 사람의 기억에만 달려 있다.
 */

/** `Prisma.Decimal`을 `number`로. 없는 값은 `null`이다 */
function toNumberOrNull(
  value: Prisma.Decimal | null | undefined,
): number | null {
  return value == null ? null : value.toNumber();
}

/** `@db.Date` 컬럼에서 읽은 UTC 자정 `Date`를 `YYYY-MM-DD`로. 없는 값은 `null`이다 */
function toDateKeyOrNull(value: Date | null | undefined): string | null {
  return value == null ? null : formatLocalDateKey(value);
}

/** 정의에서 나오는 값들만 옮긴다. `completeType`은 갈래마다 다르게 붙인다 */
function toTemplateView(template: TodoTemplate): TodoTemplateView {
  return {
    todoId: template.todoId,
    title: template.title,
    description: template.description,
    todoType: template.todoType,
    remindAt: template.remindAt,
    shouldDoAt: template.shouldDoAt,
    targetValue: toNumberOrNull(template.targetValue),
    targetUnit: template.targetUnit,
    activeFrom: toDateKeyOrNull(template.activeFrom),
    activeUntil: toDateKeyOrNull(template.activeUntil),
  };
}

/**
 * 있는 기록 하나를 상태로 바꾼다. `null` 갈래를 밖으로 내보내는 `toProgress`와 나눠 둔
 * 이유는, 이력 항목을 만들 때 **결과가 반드시 있다**는 것이 타입에 드러나야 하기
 * 때문이다. 합쳐 두면 도달할 수 없는 `null` 검사를 이력 쪽에 넣어야 한다.
 */
function toProgressOf(history: TodoHistory): TodoProgress {
  return {
    progressValue: toNumberOrNull(history.progressValue),
    targetValue: toNumberOrNull(history.targetValue),
    targetUnit: history.targetUnit ?? null,
    // 느슨한 비교를 쓴다. 엄격한 비교로 두면 완료 시각 속성이 빠진 객체에서 뜻이
    // 뒤집혀 **하지 않은 일이 완료로 나간다.** 위 "없음을 판정할 때" 주석 참고
    isCompleted: history.completedAt != null,
    // 타입이 `Date | null`이므로 `undefined`가 그대로 새면 타입이 거짓말을 한다
    completedAt: history.completedAt ?? null,
  };
}

/**
 * 완료 기록 한 건을 상태로 바꾼다. **기록이 없으면 `null`이다** — 그것이 "아직 손대지
 * 않았다"는 뜻이고, 빈 객체로 바꾸면 진행값 0을 입력한 상태와 구별되지 않는다.
 *
 * **`undefined`도 "없음"으로 받는다.** 실제 공급자가 배열의 첫 항목이라서다 — 위 "없음을
 * 판정할 때" 주석에 근거가 있다.
 */
export function toProgress(
  history: TodoHistory | null | undefined,
): TodoProgress | null {
  return history == null ? null : toProgressOf(history);
}

/**
 * 이력 항목 하나를 만든다. **내보내지 않는다** — 이 함수를 부를 수 있는 곳을
 * `toDailyTodoDetail` 하나로 묶어 두려는 것이다.
 *
 * 완료 기록에는 반복 방식이 저장되지 않으므로, 이 함수만 열어 두면 일회성 기록의
 * `historiedOn`(중복 방지 키)이 표시용 날짜로 나가는 코드가 타입 검사를 통과한다.
 * 반복 방식이 DAILY임을 요구하는 함수를 유일한 통로로 두면 그 경로가 막힌다 —
 * `toHistoriedOn`을 히스토리 키의 유일한 진입점으로 둔 것과 같은 장치다.
 */
function toTodoHistoryItem(history: TodoHistory): TodoHistoryItem {
  return {
    ...toProgressOf(history),
    historiedOn: formatLocalDateKey(history.historiedOn),
  };
}

/**
 * 목록의 항목 하나를 만든다.
 *
 * @param history 그 항목에 해당하는 기록. 일회성은 정의당 한 건, 매일 반복은 그날 한
 *   건이다. **없으면 `null`이나 `undefined` 어느 쪽이든 된다** — 부르는 쪽이 배열의 첫
 *   항목(`row.histories[0]`)을 그대로 넘겨도 안전하다
 */
export function toTodoListItem(
  template: TodoTemplate,
  history: TodoHistory | null | undefined,
): TodoListItem {
  return {
    ...toTemplateView(template),
    completeType: template.completeType,
    progress: toProgress(history),
  };
}

/**
 * 일회성 할 일의 상세를 만든다.
 *
 * @param history 그 할 일의 유일한 기록. 아직 없으면 `null`이나 `undefined`
 */
export function toOnceTodoDetail(
  template: OnceTodoTemplate,
  history: TodoHistory | null | undefined,
): OnceTodoDetail {
  return {
    ...toTemplateView(template),
    completeType: 'ONCE',
    progress: toProgress(history),
  };
}

/**
 * 매일 반복 할 일의 상세를 만든다.
 *
 * @param histories 조회한 기간 범위의 기록들. 순서는 부르는 쪽이 정한다
 */
export function toDailyTodoDetail(
  template: DailyTodoTemplate,
  histories: TodoHistory[],
): DailyTodoDetail {
  return {
    ...toTemplateView(template),
    completeType: 'DAILY',
    histories: histories.map(toTodoHistoryItem),
  };
}
