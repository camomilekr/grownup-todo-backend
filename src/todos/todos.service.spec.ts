import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import type { TodoHistory, TodoTemplate } from '../generated/prisma/client';
import { UsersRepository } from '../users/users.repository';
import { parseLocalDateKey } from './todo-local-date';
import { TodoHistoriesRepository } from './todo-histories.repository';
import type { TodoTemplateWithHistories } from './todo-templates.repository';
import { TodoTemplatesRepository } from './todo-templates.repository';
import { TodosService } from './todos.service';

/**
 * Repository를 대역으로 바꾼 단위 테스트다(`.claude/rules/nestjs.md`). 실제 DB에 붙는
 * 검증은 Repository 쪽 e2e가 이미 하고 있고, 여기서 볼 것은 **Service가 무엇을 반환하고
 * 어떤 입력을 거절하는가**다.
 */

// 날짜는 전부 상수로 고정한다. `new Date()`를 쓰면 실행 시점에 따라 결과가 바뀐다.
const CREATED_AT = new Date('2026-07-20T02:00:00.000Z');
const USER_ID = 10n;
const TIME_ZONE = 'Asia/Seoul';

function createTemplate(overrides: Partial<TodoTemplate> = {}): TodoTemplate {
  return {
    todoId: 1n,
    userId: USER_ID,
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

function createHistory(overrides: Partial<TodoHistory> = {}): TodoHistory {
  return {
    todoHistoryId: 100n,
    todoId: 1n,
    userId: USER_ID,
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

/** 목록 조회가 돌려주는 형태 — 정의에 기록 배열이 붙는다 */
function withHistories(
  template: TodoTemplate,
  histories: TodoHistory[] = [],
): TodoTemplateWithHistories {
  return { ...template, histories };
}

describe('TodosService', () => {
  let service: TodosService;
  let templates: {
    findOnceWithoutCompletedHistory: jest.Mock;
    findDailyActiveOn: jest.Mock;
    findById: jest.Mock;
  };
  let histories: {
    findByTodoIdAndHistoriedOn: jest.Mock;
    findByTodoIdBetween: jest.Mock;
  };
  let users: { findTimeZone: jest.Mock };

  /** 매일 반복 상세가 받는 기본 범위. 형식 검증을 보는 테스트만 다른 값을 넘긴다 */
  const range = { from: '2026-08-01', until: '2026-08-31' };

  beforeEach(async () => {
    templates = {
      findOnceWithoutCompletedHistory: jest.fn(),
      findDailyActiveOn: jest.fn(),
      findById: jest.fn(),
    };
    histories = {
      findByTodoIdAndHistoriedOn: jest.fn(),
      findByTodoIdBetween: jest.fn(),
    };
    users = { findTimeZone: jest.fn().mockResolvedValue(TIME_ZONE) };

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        TodosService,
        { provide: TodoTemplatesRepository, useValue: templates },
        { provide: TodoHistoriesRepository, useValue: histories },
        { provide: UsersRepository, useValue: users },
      ],
    }).compile();

    service = moduleRef.get(TodosService);
  });

  describe('listOnce', () => {
    it('손대지 않은 할 일의 progress가 null이다', async () => {
      // 기록 배열이 비어 있는 것이 "아직 손대지 않았다"는 뜻이다.
      templates.findOnceWithoutCompletedHistory.mockResolvedValue([
        withHistories(createTemplate({ completeType: 'ONCE' })),
      ]);

      const items = await service.listOnce(USER_ID);

      expect(items).toHaveLength(1);
      expect(items[0]?.progress).toBeNull();
    });

    it('붙어 온 기록으로 progress를 만든다', async () => {
      templates.findOnceWithoutCompletedHistory.mockResolvedValue([
        withHistories(createTemplate({ completeType: 'ONCE' }), [
          createHistory({ progressValue: new Prisma.Decimal('30') }),
        ]),
      ]);

      const items = await service.listOnce(USER_ID);

      expect(items[0]?.progress?.progressValue).toBe(30);
    });

    it('소유자를 그대로 넘긴다', async () => {
      // 소유자는 조회 조건이므로 다른 값으로 바뀌면 남의 목록이 나온다.
      templates.findOnceWithoutCompletedHistory.mockResolvedValue([]);

      await service.listOnce(USER_ID);

      expect(templates.findOnceWithoutCompletedHistory).toHaveBeenCalledWith(
        USER_ID,
      );
    });

    it('유저 타임존을 읽지 않는다', async () => {
      // 일회성 목록은 날짜로 거르지 않으므로 타임존이 필요 없다. 읽으면 조회가
      // 한 번 늘고, 탈퇴하지 않은 유저인지가 목록 결과를 바꾸게 된다.
      templates.findOnceWithoutCompletedHistory.mockResolvedValue([]);

      await service.listOnce(USER_ID);

      expect(users.findTimeZone).not.toHaveBeenCalled();
    });
  });

  describe('listDailyOn', () => {
    it('유저 타임존 기준 날짜로 조회한다', async () => {
      // 한국 시간대 자정 직전이다. UTC로는 8월 1일이지만 유저가 보는 날짜는 8월 2일이다.
      templates.findDailyActiveOn.mockResolvedValue([]);

      await service.listDailyOn(USER_ID, new Date('2026-08-01T15:00:00.000Z'));

      expect(templates.findDailyActiveOn).toHaveBeenCalledWith(
        USER_ID,
        parseLocalDateKey('2026-08-02'),
      );
    });

    it('같은 순간이라도 타임존이 다르면 다른 날짜를 조회한다', async () => {
      // 날짜 경계가 유저 설정으로 정해진다는 것을 고정한다.
      users.findTimeZone.mockResolvedValue('America/New_York');
      templates.findDailyActiveOn.mockResolvedValue([]);

      await service.listDailyOn(USER_ID, new Date('2026-08-01T15:00:00.000Z'));

      expect(templates.findDailyActiveOn).toHaveBeenCalledWith(
        USER_ID,
        parseLocalDateKey('2026-08-01'),
      );
    });

    it('그날 기록에서 progress를 만든다', async () => {
      templates.findDailyActiveOn.mockResolvedValue([
        withHistories(createTemplate(), [
          createHistory({
            progressValue: new Prisma.Decimal('800'),
            completedAt: new Date('2026-08-02T05:00:00.000Z'),
          }),
        ]),
      ]);

      const items = await service.listDailyOn(
        USER_ID,
        new Date('2026-08-02T02:00:00.000Z'),
      );

      expect(items[0]?.progress?.progressValue).toBe(800);
      expect(items[0]?.progress?.isCompleted).toBe(true);
    });

    it('그날 기록이 없으면 progress가 null이다', async () => {
      templates.findDailyActiveOn.mockResolvedValue([
        withHistories(createTemplate()),
      ]);

      const items = await service.listDailyOn(
        USER_ID,
        new Date('2026-08-02T02:00:00.000Z'),
      );

      expect(items[0]?.progress).toBeNull();
    });

    it('타임존을 읽을 유저가 없으면 NotFoundException이다', async () => {
      // 없는 번호와 탈퇴한 유저를 구분하지 않는다. Repository가 둘 다 `null`로
      // 돌려주고, 탈퇴한 유저가 존재한다는 사실을 알려 줄 이유도 없다.
      users.findTimeZone.mockResolvedValue(null);

      await expect(
        service.listDailyOn(USER_ID, new Date('2026-08-02T02:00:00.000Z')),
      ).rejects.toThrow(NotFoundException);
    });

    it('유저가 없으면 목록을 조회하지 않는다', async () => {
      users.findTimeZone.mockResolvedValue(null);

      await expect(
        service.listDailyOn(USER_ID, new Date('2026-08-02T02:00:00.000Z')),
      ).rejects.toThrow(NotFoundException);
      expect(templates.findDailyActiveOn).not.toHaveBeenCalled();
    });
  });

  describe('getTodo', () => {
    it('없는 할 일이면 NotFoundException이다', async () => {
      // 남의 할 일도 같은 결과다 — `findById`가 소유자를 조건에 넣으므로 `null`로
      // 돌아오고, 그것이 "없는 것"과 구별되지 않는 것이 의도다.
      templates.findById.mockResolvedValue(null);

      await expect(service.getTodo(USER_ID, 1n, range)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('소유자를 조건으로 정의를 읽는다', async () => {
      // 이 값이 완료 기록의 소유자 검사에도 쓰이므로, 정의를 소유자로 좁혀 읽는 것이
      // 뒤따르는 쓰기 경로의 전제가 된다.
      templates.findById.mockResolvedValue(null);

      await expect(service.getTodo(USER_ID, 7n, range)).rejects.toThrow(
        NotFoundException,
      );
      expect(templates.findById).toHaveBeenCalledWith(USER_ID, 7n);
    });

    describe('범위 검증', () => {
      it.each(['2026-8-1', '20260801', '', '2026-13-01'])(
        '범위 날짜가 %p면 BadRequestException이다',
        async (from) => {
          // `parseLocalDateKey`는 `RangeError`를 던진다. 그대로 새게 두면 클라이언트가
          // 잘못 보낸 값이 500이 되므로 400으로 바꾼다.
          templates.findById.mockResolvedValue(
            createTemplate({ completeType: 'DAILY' }),
          );

          await expect(
            service.getTodo(USER_ID, 1n, { from, until: '2026-08-31' }),
          ).rejects.toThrow(BadRequestException);
        },
      );

      // 범위의 **양 끝을 각각** 단정한다. 날짜 변환이 두 번 일어나므로 한쪽만 검사하면
      // 다른 쪽에서 오류 처리를 건너뛰는 변경이 통과한다 — 종료일 변환만 `try` 밖으로
      // 빼내는 한 줄 변이를 실제로 주입해 아래 두 테스트가 그것을 잡는 것을 확인했다.
      //
      // 자리 이름까지 보는 이유는 **응답이 어느 쪽 날짜가 문제인지 알려 주는 것**이 함수를
      // 둘로 나눈 목적이기 때문이다. `'시작일'`과 `'종료일'`을 뒤바꾸면 응답이 반대로
      // 알려 주는데, 종류만 단정하면 그 변경도 통과한다. 문구 전체를 단정하지 않는 것은
      // 다듬을 때마다 깨지기 때문이고, 자리 이름은 장식이 아니라 뜻을 담은 값이다.
      it('시작일이 잘못되면 그 자리를 알려 준다', async () => {
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        const thrown = await service
          .getTodo(USER_ID, 1n, { from: '엉터리', until: '2026-08-31' })
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as Error).message).toContain('시작일');
        expect((thrown as Error).message).not.toContain('종료일');
      });

      it('종료일이 잘못되면 그 자리를 알려 준다', async () => {
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        const thrown = await service
          .getTodo(USER_ID, 1n, { from: '2026-08-01', until: '엉터리' })
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as Error).message).toContain('종료일');
        expect((thrown as Error).message).not.toContain('시작일');
      });

      it('범위 자체가 비어 있어도 BadRequestException이다', async () => {
        // `strictNullChecks`가 꺼져 있어 컴파일러가 이 호출을 막지 못한다. 막지 않으면
        // 값을 읽는 자리에서 `TypeError`가 나고, **오류를 400으로 바꾸는 처리가 통째로
        // 건너뛰어져** 클라이언트 입력 문제가 500으로 나간다.
        const thrown = await service
          .getTodo(USER_ID, 1n, undefined)
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
      });

      it('거절 메시지에 내부 함수 이름을 담지 않는다', async () => {
        // `2026-13-01`은 **형식은 맞지만** 달력에 없는 날짜다. 원본 오류 메시지를 그대로
        // 이어 붙이면 두 가지가 잘못된다 — 내부 함수 이름(`parseLocalDateKey:`)이
        // 클라이언트 응답에 나가고, "형식이 올바르지 않다"는 문구가 달력 오류에 붙어
        // 앞뒤가 서로 반대인 문장이 된다.
        //
        // 문구 전체를 단정하지 않는 이유는 다듬을 때마다 깨지기 때문이다. 대신 원본을
        // 이어 붙이지 않는다는 것만 함수 이름으로 고정한다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        const thrown = await service
          .getTodo(USER_ID, 1n, { from: '2026-13-01', until: '2026-08-31' })
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as Error).message).not.toContain('parseLocalDateKey');
      });

      it('시작일이 종료일보다 늦으면 BadRequestException이다', async () => {
        // 뒤집힌 범위는 항상 빈 결과이고, 그것은 "기록이 없다"와 구별되지 않는다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        await expect(
          service.getTodo(USER_ID, 1n, {
            from: '2026-08-31',
            until: '2026-08-01',
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('같은 날짜는 허용한다', async () => {
        // 양 끝을 포함하므로 하루짜리 범위가 성립한다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );
        histories.findByTodoIdBetween.mockResolvedValue([]);

        await service.getTodo(USER_ID, 1n, {
          from: '2026-08-05',
          until: '2026-08-05',
        });

        expect(histories.findByTodoIdBetween).toHaveBeenCalledWith(
          USER_ID,
          1n,
          parseLocalDateKey('2026-08-05'),
          parseLocalDateKey('2026-08-05'),
        );
      });

      it('일회성이어도 범위를 검증한다', async () => {
        // 같은 요청이 반복 방식에 따라 다르게 거절되면 클라이언트가 예측할 수 없다.
        // 일회성 갈래는 범위를 쓰지 않지만 검증은 분기 전에 한다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'ONCE' }),
        );

        await expect(
          service.getTodo(USER_ID, 1n, { from: '엉터리', until: '2026-08-31' }),
        ).rejects.toThrow(BadRequestException);
      });

      it('범위가 잘못되면 정의도 읽지 않는다', async () => {
        await expect(
          service.getTodo(USER_ID, 1n, { from: '엉터리', until: '2026-08-31' }),
        ).rejects.toThrow(BadRequestException);
        expect(templates.findById).not.toHaveBeenCalled();
      });
    });

    describe('일회성', () => {
      const onceTemplate = createTemplate({
        completeType: 'ONCE',
        shouldDoAt: new Date('2026-08-10T14:30:00.000Z'),
      });

      it('정의 생성 시각의 UTC 날짜를 키로 기록을 찾는다', async () => {
        // 일회성의 기록은 한 건이고 그 날짜가 정의 생성 시각에서 나온다. 수행 시각이나
        // 타임존이 키에 섞이면 기록이 둘 생긴다.
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        await service.getTodo(USER_ID, 1n, range);

        expect(histories.findByTodoIdAndHistoriedOn).toHaveBeenCalledWith(
          USER_ID,
          1n,
          parseLocalDateKey('2026-07-20'),
        );
      });

      it('그 기록 한 건이 progress가 된다', async () => {
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(
          createHistory({
            progressValue: new Prisma.Decimal('40'),
            completedAt: new Date('2026-08-11T05:00:00.000Z'),
          }),
        );

        const detail = await service.getTodo(USER_ID, 1n, range);

        expect(detail.completeType).toBe('ONCE');
        expect(detail.progress?.progressValue).toBe(40);
        expect(detail.progress?.isCompleted).toBe(true);
      });

      it('기록이 없으면 progress가 null이다', async () => {
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        const detail = await service.getTodo(USER_ID, 1n, range);

        expect(detail.progress).toBeNull();
      });

      it('이력 배열 필드가 없다', async () => {
        // 빈 배열로 두면 "기록이 없다"와 "일회성이라 주지 않는다"가 겹쳐 뜻한다.
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(createHistory());

        const detail = await service.getTodo(USER_ID, 1n, range);

        expect(detail).not.toHaveProperty('histories');
      });

      it('기간 범위 조회를 하지 않는다', async () => {
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        await service.getTodo(USER_ID, 1n, range);

        expect(histories.findByTodoIdBetween).not.toHaveBeenCalled();
      });

      it('유저 타임존을 읽지 않는다', async () => {
        // 일회성 키는 UTC로 고정이고 범위는 인자로 받으므로 타임존이 필요 없다.
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        await service.getTodo(USER_ID, 1n, range);

        expect(users.findTimeZone).not.toHaveBeenCalled();
      });
    });

    describe('매일 반복', () => {
      const dailyTemplate = createTemplate({ completeType: 'DAILY' });

      it('기간 범위의 이력 배열을 준다', async () => {
        templates.findById.mockResolvedValue(dailyTemplate);
        histories.findByTodoIdBetween.mockResolvedValue([
          createHistory({ historiedOn: parseLocalDateKey('2026-08-01') }),
          createHistory({ historiedOn: parseLocalDateKey('2026-08-02') }),
        ]);

        const detail = await service.getTodo(USER_ID, 1n, range);

        expect(detail.completeType).toBe('DAILY');
        expect(detail.histories).toHaveLength(2);
        expect(detail.histories?.[0]?.historiedOn).toBe('2026-08-01');
      });

      it('범위 날짜를 UTC 자정 Date로 바꿔 넘긴다', async () => {
        // 손으로 만든 `Date`는 한국 시간대에서 하루 앞으로 밀려 저장·조회된다.
        templates.findById.mockResolvedValue(dailyTemplate);
        histories.findByTodoIdBetween.mockResolvedValue([]);

        await service.getTodo(USER_ID, 1n, range);

        expect(histories.findByTodoIdBetween).toHaveBeenCalledWith(
          USER_ID,
          1n,
          parseLocalDateKey('2026-08-01'),
          parseLocalDateKey('2026-08-31'),
        );
      });

      it('기록이 없으면 빈 배열이다', async () => {
        templates.findById.mockResolvedValue(dailyTemplate);
        histories.findByTodoIdBetween.mockResolvedValue([]);

        const detail = await service.getTodo(USER_ID, 1n, range);

        expect(detail.histories).toEqual([]);
      });

      it('progress 필드가 없다', async () => {
        // 날짜마다 상태가 다르므로 하나를 골라 담으면 어느 날짜의 것인지 드러나지 않는다.
        templates.findById.mockResolvedValue(dailyTemplate);
        histories.findByTodoIdBetween.mockResolvedValue([createHistory()]);

        const detail = await service.getTodo(USER_ID, 1n, range);

        expect(detail).not.toHaveProperty('progress');
      });

      it('단건 기록 조회를 하지 않는다', async () => {
        templates.findById.mockResolvedValue(dailyTemplate);
        histories.findByTodoIdBetween.mockResolvedValue([]);

        await service.getTodo(USER_ID, 1n, range);

        expect(histories.findByTodoIdAndHistoriedOn).not.toHaveBeenCalled();
      });
    });
  });
});
