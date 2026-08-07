import type { TodoOrderSource } from './todo-list-order';
import { sortTodosByDeadline } from './todo-list-order';

// 날짜는 전부 상수로 고정한다. `new Date()`를 쓰면 실행 시점에 따라 결과가 바뀐다.
//
// 매일 반복의 마감(다음 달력 날짜가 시작되는 최초의 순간)은 **인자로 받는다** —
// 이 함수는 타임존을 모르고, 그 계산은 `toNextLocalDayStart`의 몫이다. 여기서는
// 서울 기준 2026-08-03의 시작에 해당하는 값을 쓴다.
const DAILY_DEADLINE = new Date('2026-08-02T15:00:00.000Z');

function createRow(overrides: Partial<TodoOrderSource> = {}): TodoOrderSource {
  return {
    // 기본키가 BIGSERIAL이라 id는 bigint다. 숫자 리터럴을 넣으면 타입이 어긋난다.
    todoId: 1n,
    completeType: 'ONCE',
    shouldDoAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('sortTodosByDeadline', () => {
  it('마감 순간 오름차순으로 늘어놓고 마감 없는 것은 맨 뒤다', () => {
    // 사용자 요구 문장("완료일이 가까운 순") 그대로의 혼합 배열이다 —
    // 연체 일회성 < 매일 반복(오늘 마감) < 미래 일회성 < 예정일 없는 일회성.
    const overdueOnce = createRow({
      todoId: 1n,
      shouldDoAt: new Date('2026-07-20T09:00:00.000Z'),
    });
    const daily = createRow({ todoId: 2n, completeType: 'DAILY' });
    const futureOnce = createRow({
      todoId: 3n,
      shouldDoAt: new Date('2026-09-01T09:00:00.000Z'),
    });
    const noDueOnce = createRow({ todoId: 4n });

    const sorted = sortTodosByDeadline(
      [noDueOnce, futureOnce, daily, overdueOnce],
      DAILY_DEADLINE,
    );

    expect(sorted.map((row) => row.todoId)).toEqual([1n, 2n, 3n, 4n]);
  });

  it('일회성의 예정일이 매일 반복의 마감과 같으면 동률이고 만든 순이다', () => {
    // 마감의 출처(예정일 컬럼 vs 인자)가 달라도 값이 같으면 같은 마감 그룹이다.
    const laterOnce = createRow({
      todoId: 1n,
      shouldDoAt: DAILY_DEADLINE,
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const earlierDaily = createRow({
      todoId: 2n,
      completeType: 'DAILY',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const sorted = sortTodosByDeadline(
      [laterOnce, earlierDaily],
      DAILY_DEADLINE,
    );

    expect(sorted.map((row) => row.todoId)).toEqual([2n, 1n]);
  });

  it('마감이 같으면 먼저 만든 것이 앞이다', () => {
    // 매일 반복은 전부 마감이 같아 이 분기가 그 목록의 기본 순서다 — 기존
    // `listDailyOn`의 정렬(createdAt asc)과 일치해야 화면 순서가 튀지 않는다.
    const older = createRow({
      todoId: 2n,
      completeType: 'DAILY',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const newer = createRow({
      todoId: 1n,
      completeType: 'DAILY',
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
    });

    const sorted = sortTodosByDeadline([newer, older], DAILY_DEADLINE);

    expect(sorted.map((row) => row.todoId)).toEqual([2n, 1n]);
  });

  it('만든 시각까지 같으면 todoId 오름차순이다', () => {
    // `createdAt`은 밀리초까지만 저장돼 연속 생성에서 겹칠 수 있다. 유일 키를
    // 마지막 정렬키로 두면 순서가 하나로 정해진다 — 기존 두 목록 조회의 2차
    // 정렬키와 같은 근거다.
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const second = createRow({
      todoId: 20n,
      completeType: 'DAILY',
      createdAt,
    });
    const first = createRow({ todoId: 10n, completeType: 'DAILY', createdAt });

    const sorted = sortTodosByDeadline([second, first], DAILY_DEADLINE);

    expect(sorted.map((row) => row.todoId)).toEqual([10n, 20n]);
  });

  it('2^53을 넘는 todoId도 올바르게 비교한다', () => {
    // `bigint`를 빼기로 비교하면 `sort` 비교자가 요구하는 `number`와 어긋나고,
    // `Number`로 바꾸면 2^53 위에서 서로 다른 행이 같은 값이 된다. 명시적 대소
    // 비교만 이 자리를 통과한다.
    const createdAt = new Date('2026-07-01T00:00:00.000Z');
    const huge = createRow({
      todoId: 9_007_199_254_740_993n, // 2^53 + 1
      completeType: 'DAILY',
      createdAt,
    });
    const hugePlusOne = createRow({
      todoId: 9_007_199_254_740_994n, // 2^53 + 2 — Number로는 위와 구별되지 않는다
      completeType: 'DAILY',
      createdAt,
    });

    const sorted = sortTodosByDeadline([hugePlusOne, huge], DAILY_DEADLINE);

    expect(sorted.map((row) => row.todoId)).toEqual([
      9_007_199_254_740_993n,
      9_007_199_254_740_994n,
    ]);
  });

  it('예정일 없는 일회성끼리는 만든 순이다', () => {
    const older = createRow({
      todoId: 2n,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const newer = createRow({
      todoId: 1n,
      createdAt: new Date('2026-07-05T00:00:00.000Z'),
    });

    const sorted = sortTodosByDeadline([newer, older], DAILY_DEADLINE);

    expect(sorted.map((row) => row.todoId)).toEqual([2n, 1n]);
  });

  it('빈 배열이면 빈 배열이다', () => {
    expect(sortTodosByDeadline([], DAILY_DEADLINE)).toEqual([]);
  });

  it('원본 배열을 바꾸지 않는다', () => {
    // `Array.prototype.sort`는 제자리 정렬이다. 복사 없이 쓰면 Repository가 돌려준
    // 배열이 부르는 쪽 몰래 재배열되고, 이 함수가 순수라는 전제가 깨진다.
    const rows = [
      createRow({ todoId: 2n, completeType: 'DAILY' }),
      createRow({
        todoId: 1n,
        shouldDoAt: new Date('2026-07-20T09:00:00.000Z'),
      }),
    ];

    const sorted = sortTodosByDeadline(rows, DAILY_DEADLINE);

    expect(rows.map((row) => row.todoId)).toEqual([2n, 1n]);
    expect(sorted).not.toBe(rows);
  });

  it('정렬 필드 밖의 필드를 그대로 보존한다 (제네릭)', () => {
    // Service가 넘기는 것은 기록 배열이 붙은 행(`TodoTemplateWithHistories`)이다.
    // 반환 타입이 입력 타입 그대로여야 정렬 뒤에 기록을 꺼내 변환할 수 있다.
    const row = { ...createRow({ todoId: 1n }), histories: ['표식'] };

    const sorted = sortTodosByDeadline([row], DAILY_DEADLINE);

    expect(sorted[0]?.histories).toEqual(['표식']);
  });
});
