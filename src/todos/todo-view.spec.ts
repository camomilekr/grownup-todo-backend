import { Prisma } from '../generated/prisma/client';
import type { TodoHistory, TodoTemplate } from '../generated/prisma/client';
import { parseLocalDateKey } from './todo-local-date';
import {
  narrowByCompleteType,
  toDailyTodoDetail,
  toOnceTodoDetail,
  toProgress,
  toTodoListItem,
} from './todo-view';
import type {
  DailyTodoTemplate,
  OnceTodoTemplate,
  TodoDetail,
} from './todo-view';

/**
 * 날짜는 전부 상수로 고정한다. `new Date()`를 쓰면 실행 시점에 따라 결과가 바뀐다.
 */
const CREATED_AT = new Date('2026-07-20T02:00:00.000Z');

function createTemplate(overrides: Partial<TodoTemplate> = {}): TodoTemplate {
  return {
    // 기본키가 BIGSERIAL이라 `bigint`다. 숫자 리터럴을 넣으면 타입이 어긋난다
    todoId: 1n,
    userId: 10n,
    title: '물 마시기',
    description: '하루 2리터',
    todoType: 'NUMERIC',
    completeType: 'DAILY',
    remindAt: '09:00',
    shouldDoAt: null,
    targetValue: new Prisma.Decimal('2000'),
    targetUnit: 'ml',
    activeFrom: parseLocalDateKey('2026-08-01'),
    activeUntil: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

// 변환 함수가 `completeType`을 타입으로 요구하므로 반복 방식별 픽스처를 따로 둔다.
// `completeType`을 전개 뒤에 두어 `overrides`가 그것을 덮을 수 없게 한다.
function createOnceTemplate(
  overrides: Partial<TodoTemplate> = {},
): OnceTodoTemplate {
  return { ...createTemplate(overrides), completeType: 'ONCE' };
}

function createDailyTemplate(
  overrides: Partial<TodoTemplate> = {},
): DailyTodoTemplate {
  return { ...createTemplate(overrides), completeType: 'DAILY' };
}

function createHistory(overrides: Partial<TodoHistory> = {}): TodoHistory {
  return {
    todoHistoryId: 100n,
    todoId: 1n,
    userId: 10n,
    historiedOn: parseLocalDateKey('2026-08-02'),
    targetValue: new Prisma.Decimal('2000'),
    targetUnit: 'ml',
    progressValue: new Prisma.Decimal('500'),
    completedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    deletedAt: null,
    ...overrides,
  };
}

describe('toProgress', () => {
  it('기록이 null이면 null이다', () => {
    // 기록은 완료하거나 진행값을 입력할 때 비로소 생긴다. 행이 없다는 것이 곧
    // "아직 손대지 않았다"는 뜻이므로 빈 객체로 바꾸면 그 구분이 사라진다.
    expect(toProgress(null)).toBeNull();
  });

  it('빈 배열에서 꺼낸 기록(undefined)도 null이다', () => {
    // **실제 공급자는 배열의 첫 항목이다.** `findDailyActiveAt`이 돌려주는 행의
    // `histories`는 0개 또는 1개이고, 비어 있을 때 `histories[0]`은 `null`이 아니라
    // `undefined`다. 이 프로젝트는 `strictNullChecks: false`라 그 값이 `TodoHistory`
    // 타입으로 통과하므로 **컴파일러가 막아 주지 않는다** — 함수가 직접 감당한다.
    //
    // "아직 손대지 않은 할 일"은 예외적인 입력이 아니라 매일 반복 목록에서 가장 흔한
    // 상태이므로, 막지 않으면 목록 조회 전체가 500으로 떨어진다.
    const empty: TodoHistory[] = [];

    expect(toProgress(empty[0])).toBeNull();
  });

  it('완료 시각 속성이 아예 없는 기록을 완료로 보지 않는다', () => {
    // `completedAt !== null`로 비교하면 속성이 빠진 객체에서 뜻이 **뒤집힌다** —
    // 하지 않은 일이 완료로 표시되고 오류는 나지 않는다. Service 단위 테스트가
    // 대역 행을 부분 객체로 만들면 닿는 상태다.
    const partial = {
      progressValue: null,
      targetValue: null,
      targetUnit: null,
    } as TodoHistory;

    expect(toProgress(partial)?.isCompleted).toBe(false);
    expect(toProgress(partial)?.completedAt).toBeNull();
  });

  it('completedAt이 있으면 isCompleted가 true다', () => {
    const progress = toProgress(
      createHistory({ completedAt: new Date('2026-08-02T05:00:00.000Z') }),
    );

    expect(progress?.isCompleted).toBe(true);
  });

  it('completedAt이 없으면 isCompleted가 false다', () => {
    expect(toProgress(createHistory({ completedAt: null }))?.isCompleted).toBe(
      false,
    );
  });

  it('완료 시각을 함께 내보낸다', () => {
    // 일회성 할 일의 완료 시점을 답하는 값이 이것뿐이다 — `historiedOn`은 표시용
    // 날짜가 아니라 중복 방지 키다.
    const completedAt = new Date('2026-08-02T05:00:00.000Z');

    expect(toProgress(createHistory({ completedAt }))?.completedAt).toEqual(
      completedAt,
    );
  });

  it('진행값이 0이어도 null과 구별된다', () => {
    // 0은 "0을 입력했다"이고 null은 "입력하지 않았다"다. 둘을 뭉치면 화면이
    // 진행률 0%와 미입력을 같게 그린다.
    expect(
      toProgress(createHistory({ progressValue: new Prisma.Decimal(0) }))
        ?.progressValue,
    ).toBe(0);
    expect(
      toProgress(createHistory({ progressValue: null }))?.progressValue,
    ).toBeNull();
  });

  it('Decimal을 number로 내보낸다', () => {
    // `Prisma.Decimal`은 런타임 클래스다. 그대로 내보내면 클라이언트가 받는 형태가
    // Prisma 구현에 묶이고, JSON으로 나갈 때 내부 필드가 드러난다.
    const progress = toProgress(
      createHistory({
        progressValue: new Prisma.Decimal('30.50'),
        targetValue: new Prisma.Decimal('100'),
      }),
    );

    expect(progress?.progressValue).toBe(30.5);
    expect(progress?.targetValue).toBe(100);
  });

  it('목표치가 없는 기록은 null로 내보낸다', () => {
    // 일반(GENERAL) 타입은 목표치를 쓰지 않는다.
    const progress = toProgress(
      createHistory({ targetValue: null, targetUnit: null }),
    );

    expect(progress?.targetValue).toBeNull();
    expect(progress?.targetUnit).toBeNull();
  });

  it('historiedOn을 담지 않는다', () => {
    // 일회성의 `historiedOn`은 정의 생성 시각에서 나온 중복 방지 키라서 화면에
    // 보여 줄 날짜가 아니다. 이 타입은 일회성도 쓰므로 날짜를 아예 담지 않는다.
    expect(toProgress(createHistory())).not.toHaveProperty('historiedOn');
  });
});

describe('toTodoListItem', () => {
  it('정의의 내용을 그대로 옮긴다', () => {
    const item = toTodoListItem(
      createTemplate({ title: '스쿼트', description: '30회' }),
      null,
    );

    expect(item.todoId).toBe(1n);
    expect(item.title).toBe('스쿼트');
    expect(item.description).toBe('30회');
    expect(item.todoType).toBe('NUMERIC');
    expect(item.completeType).toBe('DAILY');
    expect(item.remindAt).toBe('09:00');
  });

  it('활성 기간을 Date 그대로 내보낸다', () => {
    // 활성 기간은 순간 컬럼(`Timestamptz`)이다 — `shouldDoAt`과 같은 성질이라 날짜
    // 문자열로 줄이면 시·분이 사라진다. 시간 해석은 받는 쪽(클라이언트)의 몫이다.
    const activeFrom = new Date('2026-08-01T10:30:00.000Z');
    const activeUntil = new Date('2026-12-31T22:15:45.500Z');

    const item = toTodoListItem(
      createTemplate({ activeFrom, activeUntil }),
      null,
    );

    expect(item.activeFrom).toEqual(activeFrom);
    expect(item.activeUntil).toEqual(activeUntil);
  });

  it('활성 기간이 비어 있으면 null이다', () => {
    const item = toTodoListItem(
      createTemplate({ activeFrom: null, activeUntil: null }),
      null,
    );

    expect(item.activeFrom).toBeNull();
    expect(item.activeUntil).toBeNull();
  });

  it('예정일은 시각이므로 Date로 내보낸다', () => {
    // `shouldDoAt`은 `Timestamptz`다. 날짜만 있는 활성 기간과 달리 순간을 가리키므로
    // 날짜 문자열로 줄이면 시·분이 사라진다.
    const shouldDoAt = new Date('2026-08-05T14:30:00.000Z');

    const item = toTodoListItem(createTemplate({ shouldDoAt }), null);

    expect(item.shouldDoAt).toEqual(shouldDoAt);
  });

  it('정의의 목표치를 number로 내보낸다', () => {
    const item = toTodoListItem(
      createTemplate({ targetValue: new Prisma.Decimal('30.50') }),
      null,
    );

    expect(item.targetValue).toBe(30.5);
  });

  it('기록이 없으면 progress가 null이다', () => {
    expect(toTodoListItem(createTemplate(), null).progress).toBeNull();
  });

  it('매일 반복 목록이 넘기는 빈 histories의 첫 항목도 받아 낸다', () => {
    // 목록 조회가 실제로 밟는 경로다. `findDailyActiveAt`은 행에 `histories` 배열을
    // 붙여 주고 부르는 쪽이 그 첫 항목을 넘기는데, 아직 손대지 않은 날은 그 배열이
    // 비어 있다. `?? null`을 빼먹어도 조용히 넘어가거나 터지지 않아야 한다.
    const row = { ...createTemplate(), histories: [] as TodoHistory[] };

    expect(toTodoListItem(row, row.histories[0]).progress).toBeNull();
  });

  it('기록이 있으면 그 기록으로 progress를 만든다', () => {
    const item = toTodoListItem(
      createTemplate(),
      createHistory({ progressValue: new Prisma.Decimal('500') }),
    );

    expect(item.progress?.progressValue).toBe(500);
  });

  it('progress의 목표치는 정의가 아니라 기록에 복사된 값이다', () => {
    // 목표를 나중에 올려도 지난 기록의 달성률이 소급해서 바뀌지 않게 하려고 기록에
    // 목표치를 복사해 둔다. 뷰가 정의 쪽 값을 읽으면 그 장치가 무의미해진다.
    const item = toTodoListItem(
      createTemplate({ targetValue: new Prisma.Decimal('200') }),
      createHistory({ targetValue: new Prisma.Decimal('100') }),
    );

    expect(item.targetValue).toBe(200);
    expect(item.progress?.targetValue).toBe(100);
  });

  it('소유자 번호와 삭제 시각을 내보내지 않는다', () => {
    // 자기 것만 조회하므로 소유자 번호는 쓸 데가 없고, 응답에 다른 유저의 번호가
    // 새는 경로를 구조적으로 없앤다. 삭제 시각은 밖에서 알 필요가 없는 내부 상태다.
    const item = toTodoListItem(createTemplate(), createHistory());

    expect(item).not.toHaveProperty('userId');
    expect(item).not.toHaveProperty('deletedAt');
  });
});

describe('toOnceTodoDetail', () => {
  it('기록 한 건이 progress가 된다', () => {
    const detail = toOnceTodoDetail(
      createOnceTemplate(),
      createHistory({ completedAt: new Date('2026-08-02T05:00:00.000Z') }),
    );

    expect(detail.progress?.isCompleted).toBe(true);
  });

  it('기록이 없으면 progress가 null이다', () => {
    expect(toOnceTodoDetail(createOnceTemplate(), null).progress).toBeNull();
  });

  it('이력 배열 필드가 없다', () => {
    // 빈 배열로 두면 "기록이 없다"와 "일회성이라 주지 않는다"가 겹쳐 뜻한다.
    expect(
      toOnceTodoDetail(createOnceTemplate(), createHistory()),
    ).not.toHaveProperty('histories');
  });

  it('어느 자리에도 historiedOn이 없다', () => {
    // 일회성의 `historiedOn`은 정의 생성 시각에서 나온 중복 방지 키다. 화면에
    // 날짜로 보여 주면 사용자가 만든 날을 수행한 날로 읽는다.
    const detail = toOnceTodoDetail(createOnceTemplate(), createHistory());

    expect(detail).not.toHaveProperty('historiedOn');
    expect(detail.progress).not.toHaveProperty('historiedOn');
  });

  it('매일 반복 정의를 넣으면 컴파일 단계에서 막힌다', () => {
    // 반복 방식에 맞지 않는 변환을 타입이 거절한다. `@ts-expect-error`는 다음 줄에
    // 타입 오류가 있어야 한다는 선언이고, 오류가 없으면 거꾸로 verify가 깨진다.
    const typeGuard = () => {
      // @ts-expect-error 일회성 상세는 completeType이 ONCE인 정의만 받는다
      toOnceTodoDetail(createDailyTemplate(), null);
    };

    expect(typeGuard).toBeInstanceOf(Function);
  });
});

describe('toDailyTodoDetail', () => {
  it('기간 범위의 이력을 배열로 준다', () => {
    const detail = toDailyTodoDetail(createDailyTemplate(), [
      createHistory({ historiedOn: parseLocalDateKey('2026-08-01') }),
      createHistory({ historiedOn: parseLocalDateKey('2026-08-02') }),
    ]);

    expect(detail.histories).toHaveLength(2);
  });

  it('이력 항목의 날짜를 YYYY-MM-DD 문자열로 내보낸다', () => {
    // 매일 반복의 `historiedOn`은 유저 타임존 기준 날짜이고 그것이 곧 표시 날짜다.
    const detail = toDailyTodoDetail(createDailyTemplate(), [
      createHistory({ historiedOn: parseLocalDateKey('2026-08-02') }),
    ]);

    expect(detail.histories[0]?.historiedOn).toBe('2026-08-02');
  });

  it('이력 항목이 progress와 같은 상태 값을 담는다', () => {
    const detail = toDailyTodoDetail(createDailyTemplate(), [
      createHistory({
        progressValue: new Prisma.Decimal('40'),
        targetValue: new Prisma.Decimal('100'),
        completedAt: new Date('2026-08-02T05:00:00.000Z'),
      }),
    ]);

    expect(detail.histories[0]?.progressValue).toBe(40);
    expect(detail.histories[0]?.targetValue).toBe(100);
    expect(detail.histories[0]?.isCompleted).toBe(true);
  });

  it('기록이 하나도 없으면 빈 배열이다', () => {
    expect(toDailyTodoDetail(createDailyTemplate(), []).histories).toEqual([]);
  });

  it('progress 필드가 없다', () => {
    // 매일 반복의 상태는 날짜마다 다르다. 하나를 골라 담으면 어느 날짜인지가
    // 결과에 드러나지 않아 클라이언트가 잘못된 날의 상태를 그린다.
    expect(
      toDailyTodoDetail(createDailyTemplate(), [createHistory()]),
    ).not.toHaveProperty('progress');
  });

  it('일회성 정의를 넣으면 컴파일 단계에서 막힌다', () => {
    const typeGuard = () => {
      // @ts-expect-error 매일 반복 상세는 completeType이 DAILY인 정의만 받는다
      toDailyTodoDetail(createOnceTemplate(), []);
    };

    expect(typeGuard).toBeInstanceOf(Function);
  });
});

describe('narrowByCompleteType', () => {
  /**
   * **Repository가 돌려주는 넓은 정의로 상세를 만드는 실제 경로다.**
   *
   * 위의 `@ts-expect-error` 테스트는 이 경로를 지키지 못한다. 그쪽이 넘기는 값은
   * 픽스처가 이미 리터럴 타입으로 반환한 것이고, `findById`가 돌려주는 것은
   * `completeType`이 `CompleteType`으로 넓은 `TodoTemplate`이다.
   *
   * **조건 분기만으로는 그 넓은 타입이 좁혀지지 않는다.** `TodoTemplate`이 판별 속성을
   * 가진 합집합이 아니라 단일 객체 타입이라 `if (t.completeType === 'ONCE')` 안쪽에서도
   * `t` 자체는 그대로다(tsc 5.9.3으로 실측했고 `TS2345`가 난다). 여기서 컴파일되지
   * 않으면 상세 조회를 만드는 쪽이 `as` 캐스팅으로 우회하게 되고, 그러면 반복 방식을
   * 타입으로 막아 둔 장치가 **그것이 필요한 유일한 지점에서** 사라진다.
   */
  function buildDetail(
    template: TodoTemplate,
    history: TodoHistory | null,
    histories: TodoHistory[],
  ): TodoDetail {
    const narrowed = narrowByCompleteType(template);

    return narrowed.completeType === 'ONCE'
      ? toOnceTodoDetail(narrowed, history)
      : toDailyTodoDetail(narrowed, histories);
  }

  it('넓은 정의를 일회성 상세로 보낼 수 있다', () => {
    const detail = buildDetail(
      createTemplate({ completeType: 'ONCE' }),
      createHistory({ progressValue: new Prisma.Decimal('30') }),
      [],
    );

    expect(detail.completeType).toBe('ONCE');
    expect(detail.progress?.progressValue).toBe(30);
    expect(detail).not.toHaveProperty('histories');
  });

  it('넓은 정의를 매일 반복 상세로 보낼 수 있다', () => {
    const detail = buildDetail(
      createTemplate({ completeType: 'DAILY' }),
      null,
      [createHistory({ historiedOn: parseLocalDateKey('2026-08-02') })],
    );

    expect(detail.completeType).toBe('DAILY');
    expect(detail.histories?.[0]?.historiedOn).toBe('2026-08-02');
    expect(detail).not.toHaveProperty('progress');
  });

  it('값을 바꾸지 않고 받은 것을 그대로 돌려준다', () => {
    // 이 함수가 하는 일은 **타입을 합집합으로 다시 선언하는 것**이고 런타임 동작이
    // 없다. 복사해서 돌려주면 원본과 다른 객체가 되어, 지킬 필요가 없는 제약("참조
    // 동일성을 기대하지 마라")을 문서로 관리해야 한다.
    const template = createTemplate({ completeType: 'ONCE' });

    const narrowed = narrowByCompleteType(template);

    expect(narrowed).toBe(template);
    expect(narrowed.completeType).toBe('ONCE');
  });
});
