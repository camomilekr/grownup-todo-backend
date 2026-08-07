import type { TodoListItem } from './todo-view';
import { sortTodosByDeadline } from './todo-list-order';

// 날짜는 전부 상수로 고정한다. `new Date()`를 쓰면 실행 시점에 따라 결과가 바뀐다.
//
// 매일 반복의 마감(다음 달력 날짜가 시작되는 최초의 순간)은 **인자로 받는다** —
// 이 함수는 타임존을 모르고, 그 계산은 `toNextLocalDayStart`의 몫이다. 여기서는
// 서울 기준 2026-08-03의 시작에 해당하는 값을 쓴다.
const DAILY_DEADLINE = new Date('2026-08-02T15:00:00.000Z');

/**
 * 실제 입력과 같은 `TodoListItem` 형태의 픽스처다. 정렬 함수의 요구는
 * `TodoOrderSource` 네 필드뿐이지만(구조 타입), 병합 목록(`listTodosOn`)이 넘기는
 * 것이 변환 뒤의 응답 항목이므로 그 형태로 고정한다 — 응답에서 정렬키가 빠지는
 * 변경(`createdAt` 제거 등)이 여기서 컴파일 오류로 드러난다.
 */
function createItem(overrides: Partial<TodoListItem> = {}): TodoListItem {
  return {
    // 기본키가 BIGSERIAL이라 id는 bigint다. 숫자 리터럴을 넣으면 타입이 어긋난다.
    todoId: 1n,
    title: '테스트 할 일',
    description: null,
    todoType: 'GENERAL',
    completeType: 'ONCE',
    remindAt: null,
    shouldDoAt: null,
    targetValue: null,
    targetUnit: null,
    activeFrom: null,
    activeUntil: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    progress: null,
    ...overrides,
  };
}

describe('sortTodosByDeadline', () => {
  it('마감 순간 오름차순으로 늘어놓고 마감 없는 것은 맨 뒤다', () => {
    // 사용자 요구 문장("완료일이 가까운 순") 그대로의 혼합 배열이다 —
    // 연체 일회성 < 매일 반복(오늘 마감) < 미래 일회성 < 예정일 없는 일회성.
    const overdueOnce = createItem({
      todoId: 1n,
      shouldDoAt: new Date('2026-07-20T09:00:00.000Z'),
    });
    const daily = createItem({ todoId: 2n, completeType: 'DAILY' });
    const futureOnce = createItem({
      todoId: 3n,
      shouldDoAt: new Date('2026-09-01T09:00:00.000Z'),
    });
    const noDueOnce = createItem({ todoId: 4n });

    const sorted = sortTodosByDeadline(
      [noDueOnce, futureOnce, daily, overdueOnce],
      DAILY_DEADLINE,
    );

    expect(sorted.map((item) => item.todoId)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('일회성의 예정일이 매일 반복의 마감과 같으면 동률이고 만든 순이다', () => {
    // 마감의 출처(예정일 컬럼 vs 인자)가 달라도 값이 같으면 같은 마감 그룹이다.
    const laterOnce = createItem({
      todoId: 1n,
      shouldDoAt: DAILY_DEADLINE,
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const earlierDaily = createItem({
      todoId: 2n,
      completeType: 'DAILY',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const sorted = sortTodosByDeadline(
      [laterOnce, earlierDaily],
      DAILY_DEADLINE,
    );

    expect(sorted.map((item) => item.todoId)).toEqual([2n, 1n]);
  });

  it('마감이 같으면 먼저 만든 것이 앞이다', () => {
    // 매일 반복은 전부 마감이 같아 이 분기가 그 목록의 기본 순서다 — 기존
    // `listDailyOn`의 정렬(createdAt asc)과 일치해야 화면 순서가 튀지 않는다.
    const older = createItem({
      todoId: 2n,
      completeType: 'DAILY',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const newer = createItem({
      todoId: 1n,
      completeType: 'DAILY',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
    });

    const sorted = sortTodosByDeadline([newer, older], DAILY_DEADLINE);

    expect(sorted.map((item) => item.todoId)).toEqual([2n, 1n]);
  });

  it('만든 시각까지 같으면 todoId 오름차순이다', () => {
    // `createdAt`은 밀리초까지만 저장돼 연속 생성에서 겹칠 수 있다. 유일 키를
    // 마지막 정렬키로 두면 순서가 하나로 정해진다 — 기존 두 목록 조회의 2차
    // 정렬키와 같은 근거다.
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const second = createItem({
      todoId: 20n,
      completeType: 'DAILY',
      createdAt,
    });
    const first = createItem({ todoId: 10n, completeType: 'DAILY', createdAt });

    const sorted = sortTodosByDeadline([second, first], DAILY_DEADLINE);

    expect(sorted.map((item) => item.todoId)).toEqual([10n, 20n]);
  });

  it('2^53 경계의 todoId도 올바르게 비교한다', () => {
    // `bigint`를 빼기로 비교하면 `sort` 비교자가 요구하는 `number`와 어긋나
    // `Number`로 바꾸는 우회가 나오는데, 2^53(9007199254740992)과 2^53+1은
    // `Number` 변환 뒤 **같은 값**이 된다 — 그 비교자는 0을 돌려주고 안정
    // 정렬이 입력 순서를 유지하므로, 큰 쪽을 앞에 넣은 이 입력이 그 회귀에서
    // 뒤집히지 않은 채 통과하지 못한다. (2^53+1과 2^53+2 쌍은 변환 뒤에도
    // 구별되어 그 회귀를 잡지 못한다 — 리뷰에서 변이로 실측된 사실이다.)
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const boundary = createItem({
      todoId: 9_007_199_254_740_992n, // 2^53
      completeType: 'DAILY',
      createdAt,
    });
    const boundaryPlusOne = createItem({
      todoId: 9_007_199_254_740_993n, // 2^53 + 1 — Number로는 위와 구별되지 않는다
      completeType: 'DAILY',
      createdAt,
    });

    const sorted = sortTodosByDeadline(
      [boundaryPlusOne, boundary],
      DAILY_DEADLINE,
    );

    expect(sorted.map((item) => item.todoId)).toEqual([
      9_007_199_254_740_992n,
      9_007_199_254_740_993n,
    ]);
  });

  it('예정일 없는 일회성끼리는 만든 순이다', () => {
    const older = createItem({
      todoId: 2n,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const newer = createItem({
      todoId: 1n,
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
    });

    const sorted = sortTodosByDeadline([newer, older], DAILY_DEADLINE);

    expect(sorted.map((item) => item.todoId)).toEqual([2n, 1n]);
  });

  it('빈 배열이면 빈 배열이다', () => {
    expect(sortTodosByDeadline([], DAILY_DEADLINE)).toEqual([]);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    // `Array.prototype.sort`는 제자리 정렬이다. 복사 없이 쓰면 부르는 쪽이 넘긴
    // 배열이 몰래 재배열되고, 이 함수가 순수라는 전제가 깨진다.
    const items = [
      createItem({ todoId: 2n, completeType: 'DAILY' }),
      createItem({
        todoId: 1n,
        shouldDoAt: new Date('2026-07-20T09:00:00.000Z'),
      }),
    ];

    const sorted = sortTodosByDeadline(items, DAILY_DEADLINE);

    expect(items.map((item) => item.todoId)).toEqual([2n, 1n]);
    expect(sorted).not.toBe(items);
  });

  it('정렬 필드 밖의 필드를 그대로 보존한다 (제네릭)', () => {
    // 병합 목록이 넘기는 것은 `progress` 같은 상태 필드가 붙은 응답 항목이다.
    // 반환 타입이 입력 타입 그대로여야 정렬 뒤에도 항목이 온전하다.
    const item = createItem({
      todoId: 1n,
      progress: {
        progressValue: 30,
        targetValue: 100,
        targetUnit: '회',
        isCompleted: false,
        completedAt: null,
      },
    });

    const sorted = sortTodosByDeadline([item], DAILY_DEADLINE);

    expect(sorted[0]?.progress?.progressValue).toBe(30);
  });
});
