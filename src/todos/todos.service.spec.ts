import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import type { TodoHistory, TodoTemplate } from '../generated/prisma/client';
import { UsersRepository } from '../users/users.repository';
import {
  TodoTemplateDeletedError,
  TodoTemplateNotFoundError,
} from './todo-errors';
import { parseLocalDateKey } from './todo-local-date';
import { TodoHistoriesRepository } from './todo-histories.repository';
import type {
  TodoHistoryChanges,
  TodoHistorySnapshot,
} from './todo-histories.repository';
import type { TodoTemplateWithHistories } from './todo-templates.repository';
import { TodoTemplatesRepository } from './todo-templates.repository';
import type { CreateTodoInput } from './todos.service';
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

/**
 * 이력 조회 범위로 넘겨서는 안 되는 값이다. 범위가 순간이 되면서 임의의 시각이 정상
 * 입력이 됐고, 남은 거절 대상은 Invalid Date뿐이다 — 이 값은 서버가 유저 타임존
 * 날짜로 잘라 쓰는데(`toLocalDateKey`), 거르지 않으면 그 변환이 `RangeError`로 터져
 * 클라이언트 입력 문제가 500으로 나간다.
 */
const INVALID_DATE = new Date('쓰레기');

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
    findDailyActiveAt: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    softDelete: jest.Mock;
  };
  let histories: {
    findByTodoIdAndHistoriedOn: jest.Mock;
    findByTodoIdBetween: jest.Mock;
    upsertForHistoriedOn: jest.Mock;
  };
  let users: { findTimeZone: jest.Mock };

  /**
   * 매일 반복 상세가 받는 기본 범위. 거절을 보는 테스트만 다른 값을 넘긴다.
   *
   * 범위는 **순간**이라 자정일 필요가 없지만 여기서는 UTC 자정을 쓴다 — 유저 타임존
   * (서울)에서 같은 날 09:00이라 잘린 날짜 키가 입력 문자열과 같아, 단정에 쓰는 값을
   * 눈으로 맞춰 볼 수 있다.
   */
  const range = {
    from: parseLocalDateKey('2026-08-01'),
    until: parseLocalDateKey('2026-08-31'),
  };

  beforeEach(async () => {
    templates = {
      findOnceWithoutCompletedHistory: jest.fn(),
      findDailyActiveAt: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      softDelete: jest.fn(),
    };
    histories = {
      findByTodoIdAndHistoriedOn: jest.fn(),
      findByTodoIdBetween: jest.fn(),
      upsertForHistoriedOn: jest.fn(),
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
    it('활성 판정에는 요청 순간을 그대로, 기록에는 유저 타임존 기준 날짜를 넘긴다', async () => {
      // 한국 시간대 자정 직전이다. UTC로는 8월 1일이지만 유저가 보는 날짜는 8월 2일이다.
      // 활성 판정은 순간 그대로 비교하므로(사용자 확정) 순간이 손대지 않고 전달돼야
      // 한다 — 날짜 키로 뭉개면 자정 직전과 직후가 같은 값이 되어 반열림 경계가
      // 사라진다.
      templates.findDailyActiveAt.mockResolvedValue([]);
      const at = new Date('2026-08-01T15:00:00.000Z');

      await service.listDailyOn(USER_ID, at);

      expect(templates.findDailyActiveAt).toHaveBeenCalledWith(
        USER_ID,
        at,
        parseLocalDateKey('2026-08-02'),
      );
    });

    it('같은 순간이라도 타임존이 다르면 다른 날짜의 기록을 찾는다', async () => {
      // 기록 날짜의 경계가 유저 설정으로 정해진다는 것을 고정한다. 활성 판정에
      // 넘기는 순간은 타임존과 무관하게 같다.
      users.findTimeZone.mockResolvedValue('America/New_York');
      templates.findDailyActiveAt.mockResolvedValue([]);
      const at = new Date('2026-08-01T15:00:00.000Z');

      await service.listDailyOn(USER_ID, at);

      expect(templates.findDailyActiveAt).toHaveBeenCalledWith(
        USER_ID,
        at,
        parseLocalDateKey('2026-08-01'),
      );
    });

    it('그날 기록에서 progress를 만든다', async () => {
      templates.findDailyActiveAt.mockResolvedValue([
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
      templates.findDailyActiveAt.mockResolvedValue([
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
      expect(templates.findDailyActiveAt).not.toHaveBeenCalled();
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
      it('범위 시작 순간이 Invalid Date면 BadRequestException이다', async () => {
        // 그대로 내려보내면 유저 타임존으로 자르는 `toLocalDateKey`가 `RangeError`를
        // 던져 부르는 쪽이 잘못 만든 값이 500이 되므로, 여기서 400으로 거절한다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        await expect(
          service.getTodo(USER_ID, 1n, {
            from: INVALID_DATE,
            until: parseLocalDateKey('2026-08-31'),
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('자정 아닌 순간을 허용하고 유저 타임존 날짜로 잘라 넘긴다', async () => {
        // 범위는 순간이다 — 자정 검증이 없고, 각 순간이 유저 타임존(여기서는 서울)에서
        // 속한 날짜로 잘려 날짜 키 비교(양 끝 포함)에 넘어간다. UTC 날짜로 자르면
        // (7월 31일·8월 1일) 이 단정이 깨진다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );
        histories.findByTodoIdBetween.mockResolvedValue([]);

        await service.getTodo(USER_ID, 1n, {
          // 서울 기준 8월 1일 05:00.
          from: new Date('2026-07-31T20:00:00.000Z'),
          // 서울 기준 8월 2일 05:00.
          until: new Date('2026-08-01T20:00:00.000Z'),
        });

        expect(histories.findByTodoIdBetween).toHaveBeenCalledWith(
          USER_ID,
          1n,
          parseLocalDateKey('2026-08-01'),
          parseLocalDateKey('2026-08-02'),
        );
      });

      it('같은 순간이라도 타임존이 다르면 다른 날짜로 잘린다', async () => {
        // 잘리는 날짜의 경계가 유저 설정으로 정해진다는 것을 고정한다.
        users.findTimeZone.mockResolvedValue('America/New_York');
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );
        histories.findByTodoIdBetween.mockResolvedValue([]);

        await service.getTodo(USER_ID, 1n, {
          // 뉴욕 기준 7월 31일 16:00 — 서울이었다면 8월 1일이다.
          from: new Date('2026-07-31T20:00:00.000Z'),
          // 뉴욕 기준 8월 1일 16:00.
          until: new Date('2026-08-01T20:00:00.000Z'),
        });

        expect(histories.findByTodoIdBetween).toHaveBeenCalledWith(
          USER_ID,
          1n,
          parseLocalDateKey('2026-07-31'),
          parseLocalDateKey('2026-08-01'),
        );
      });

      it.each([
        [
          '시작 순간',
          { from: undefined, until: parseLocalDateKey('2026-08-31') },
        ],
        [
          '종료 순간',
          { from: parseLocalDateKey('2026-08-01'), until: undefined },
        ],
      ] as const)(
        '범위 %s이 없으면 BadRequestException이다',
        async (_label, incomplete) => {
          // `strictNullChecks`가 꺼져 있어 컴파일러가 이 호출을 막지 못한다. 한쪽만
          // 빠진 범위를 그대로 내려보내면 타임존 변환에서 `TypeError`가 나 500이
          // 된다. **거절되는 것이 이 메서드의 관찰 가능한 동작이고 그것을 고정한다.**
          //
          // 아래 `범위 자체가 비어 있어도`와 막는 자리가 다르다 — 그쪽은 값을 읽는
          // 것 자체가 터지는 경우다.
          templates.findById.mockResolvedValue(
            createTemplate({ completeType: 'DAILY' }),
          );

          await expect(
            service.getTodo(USER_ID, 1n, incomplete),
          ).rejects.toThrow(BadRequestException);
        },
      );

      // 범위의 **양 끝을 각각** 단정한다. 검사가 두 번 일어나므로 한쪽만 보면 다른 쪽에서
      // 검사를 건너뛰는 변경이 통과한다 — 종료 쪽 검사만 지우는 한 줄 변이를 실제로
      // 주입해 아래 두 테스트가 그것을 잡는 것을 확인했다.
      //
      // 자리 이름까지 보는 이유는 **응답이 어느 쪽 순간이 문제인지 알려 주는 것**이 함수를
      // 둘로 나눈 목적이기 때문이다. `'시작 순간'`과 `'종료 순간'`을 뒤바꾸면 응답이 반대로
      // 알려 주는데, 종류만 단정하면 그 변경도 통과한다. 문구 전체를 단정하지 않는 것은
      // 다듬을 때마다 깨지기 때문이고, 자리 이름은 장식이 아니라 뜻을 담은 값이다.
      it('시작 순간이 잘못되면 그 자리를 알려 준다', async () => {
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        const thrown = await service
          .getTodo(USER_ID, 1n, {
            from: INVALID_DATE,
            until: parseLocalDateKey('2026-08-31'),
          })
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as Error).message).toContain('시작 순간');
        expect((thrown as Error).message).not.toContain('종료 순간');
      });

      it('종료 순간이 잘못되면 그 자리를 알려 준다', async () => {
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        const thrown = await service
          .getTodo(USER_ID, 1n, {
            from: parseLocalDateKey('2026-08-01'),
            until: INVALID_DATE,
          })
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as Error).message).toContain('종료 순간');
        expect((thrown as Error).message).not.toContain('시작 순간');
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
        // 원본 오류 메시지나 내부 함수 이름이 클라이언트 응답에 나가면 안 된다.
        // 문구 전체를 단정하지 않는 이유는 다듬을 때마다 깨지기 때문이다. 대신 검사
        // 함수 이름으로만 고정한다 — **`assertLocalDateKey`·`parseLocalDateKey`를
        // 함께 보는 것은** 검사를 옛 자정 검증으로 되돌리는 변경에서도 이 규칙이
        // 살아 있게 하려는 것이다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        const thrown = await service
          .getTodo(USER_ID, 1n, {
            from: INVALID_DATE,
            until: parseLocalDateKey('2026-08-31'),
          })
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(BadRequestException);
        expect((thrown as Error).message).not.toContain('assertLocalDateKey');
        expect((thrown as Error).message).not.toContain('parseLocalDateKey');
      });

      it('시작 순간이 종료 순간보다 늦으면 BadRequestException이다', async () => {
        // 뒤집힌 범위는 항상 빈 결과이고, 그것은 "기록이 없다"와 구별되지 않는다.
        // 판정은 잘리기 전의 순간 기준이다 — 같은 날짜 안에서 뒤집힌 시각도 걸린다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );

        await expect(
          service.getTodo(USER_ID, 1n, {
            from: new Date('2026-08-01T10:00:00.000Z'),
            until: new Date('2026-08-01T09:00:00.000Z'),
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('같은 순간은 허용한다', async () => {
        // 잘린 날짜의 비교가 양 끝을 포함하므로 하루짜리 범위가 성립한다 — 활성
        // 기간(반열림이라 같으면 빈 구간)과 다른 자리다.
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY' }),
        );
        histories.findByTodoIdBetween.mockResolvedValue([]);

        await service.getTodo(USER_ID, 1n, {
          from: parseLocalDateKey('2026-08-05'),
          until: parseLocalDateKey('2026-08-05'),
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
          service.getTodo(USER_ID, 1n, {
            from: INVALID_DATE,
            until: parseLocalDateKey('2026-08-31'),
          }),
        ).rejects.toThrow(BadRequestException);
      });

      it('범위가 잘못되면 정의도 읽지 않는다', async () => {
        await expect(
          service.getTodo(USER_ID, 1n, {
            from: INVALID_DATE,
            until: parseLocalDateKey('2026-08-31'),
          }),
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

      it('범위 순간을 유저 타임존 기준 날짜 키로 잘라 넘긴다', async () => {
        // Repository의 인자는 날짜 컬럼(`@db.Date`)과 비교되는 UTC 자정 날짜 키다 —
        // 순간을 그대로 내려보내면 어댑터가 UTC 컴포넌트로 잘라 유저가 보는 날짜와
        // 어긋난다. UTC 자정 입력은 서울에서 같은 날 09:00이라 같은 날짜 키가 된다.
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

      it('타임존을 읽을 유저가 없으면 NotFoundException이다', async () => {
        // 범위를 자를 타임존이 필요한 갈래다. 없는 유저와 탈퇴한 유저를 구분하지
        // 않는 것은 `listDailyOn`과 같다.
        templates.findById.mockResolvedValue(dailyTemplate);
        users.findTimeZone.mockResolvedValue(null);

        await expect(service.getTodo(USER_ID, 1n, range)).rejects.toThrow(
          NotFoundException,
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

  describe('createTodo', () => {
    /** 검증을 통과하는 최소 입력. 거절을 보는 테스트만 필요한 필드를 덮어쓴다 */
    function validInput(
      overrides: Partial<CreateTodoInput> = {},
    ): CreateTodoInput {
      return {
        title: '스쿼트',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        ...overrides,
      };
    }

    beforeEach(() => {
      templates.create.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve(createTemplate(data as Partial<TodoTemplate>)),
      );
    });

    it('만든 할 일을 돌려주고 progress가 null이다', async () => {
      // 방금 만들었으므로 기록이 없는 것이 확실하다 — 조회하지 않아도 된다.
      const item = await service.createTodo(USER_ID, validInput());

      expect(item.progress).toBeNull();
      expect(item.todoId).toBe(1n);
    });

    it('소유자를 넣어 만든다', async () => {
      await service.createTodo(USER_ID, validInput());

      expect(templates.create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: USER_ID }),
      );
    });

    it('활성 기간을 그대로 넘긴다', async () => {
      // 받은 `Date`를 손대지 않고 넘긴다. 여기서 다시 만들면 그 자리가 값을 바꾸는
      // 함정이 될 수 있는 자리가 된다.
      await service.createTodo(
        USER_ID,
        validInput({
          activeFrom: parseLocalDateKey('2026-08-01'),
          activeUntil: parseLocalDateKey('2026-12-31'),
        }),
      );

      expect(templates.create).toHaveBeenCalledWith(
        expect.objectContaining({
          activeFrom: parseLocalDateKey('2026-08-01'),
          activeUntil: parseLocalDateKey('2026-12-31'),
        }),
      );
    });

    it('자정이 아닌 순간도 활성 기간으로 받아 그대로 넘긴다', async () => {
      // 활성 기간이 순간 컬럼(`Timestamptz`)이 되면서 `shouldDoAt`과 같은 입력이 됐다.
      // 자정 검증도 하지 않는다 — 시간 해석은 클라이언트의 몫이다(사용자 확정).
      //
      // 반환 대역을 픽스처로 덮는 이유: 이 테스트의 관심사는 **Repository에 무엇이
      // 전달되는가**이고, 반환값이 응답으로 바뀌는 형태는 뷰 계층 테스트(`todo-view.spec.ts`)
      // 가 고정한다.
      templates.create.mockResolvedValue(createTemplate());
      const activeFrom = new Date('2026-08-01T10:30:00.000Z');
      const activeUntil = new Date('2026-12-31T22:15:45.500Z');

      await service.createTodo(
        USER_ID,
        validInput({ activeFrom, activeUntil }),
      );

      expect(templates.create).toHaveBeenCalledWith(
        expect.objectContaining({ activeFrom, activeUntil }),
      );
    });

    it.each(['NUMERIC', 'STEPS'] as const)(
      '%s에 목표치가 없으면 BadRequestException이다',
      async (todoType) => {
        // 목표치가 없으면 무엇을 채워야 완료인지 알 수 없다.
        await expect(
          service.createTodo(USER_ID, validInput({ todoType })),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('일반 타입에 목표치를 주면 거절한다', async () => {
      // 체크만 하는 할 일이다. 목표치가 있으면 화면이 진행률을 그리려 한다.
      await expect(
        service.createTodo(
          USER_ID,
          validInput({ todoType: 'GENERAL', targetValue: 100 }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('일반 타입에 목표 단위만 주어도 거절한다', async () => {
      // 목표치 한 쌍이므로 한쪽만 있는 상태도 만들지 않는다.
      await expect(
        service.createTodo(
          USER_ID,
          validInput({ todoType: 'GENERAL', targetUnit: '회' }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('일회성에 활성 기간을 주면 거절한다', async () => {
      // 활성 기간은 매일 반복이 그날 목록에 나올지를 정하는 값이다. 일회성 목록은
      // 날짜로 거르지 않으므로 저장해도 아무것도 하지 않는다.
      await expect(
        service.createTodo(
          USER_ID,
          validInput({
            completeType: 'ONCE',
            activeFrom: parseLocalDateKey('2026-08-01'),
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('매일 반복에 예정일을 주면 거절한다', async () => {
      // 예정일은 일회성을 언제까지 해야 하는지다. 매일 반복에는 뜻이 없다.
      await expect(
        service.createTodo(
          USER_ID,
          validInput({
            completeType: 'DAILY',
            shouldDoAt: new Date('2026-08-10T00:00:00.000Z'),
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('활성 시작 순간이 상한 순간보다 늦으면 거절한다', async () => {
      await expect(
        service.createTodo(
          USER_ID,
          validInput({
            activeFrom: parseLocalDateKey('2026-12-31'),
            activeUntil: parseLocalDateKey('2026-08-01'),
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('활성 시작 순간과 상한 순간이 같으면 거절한다 (빈 구간)', async () => {
      // 반열림 구간(`activeFrom <= 순간 < activeUntil`)에서 두 값이 같으면 어느
      // 순간에도 활성이 아니다 — 뒤집힌 기간과 같은 "만들었는데 보이지 않는" 상태라
      // 같은 이유로 거절한다.
      const boundary = new Date('2026-08-01T10:00:00.000Z');

      await expect(
        service.createTodo(
          USER_ID,
          validInput({ activeFrom: boundary, activeUntil: boundary }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('거절하면 만들지 않는다', async () => {
      await expect(
        service.createTodo(USER_ID, validInput({ todoType: 'NUMERIC' })),
      ).rejects.toThrow(BadRequestException);
      expect(templates.create).not.toHaveBeenCalled();
    });
  });

  describe('updateTodo', () => {
    it('남의 할 일이면 NotFoundException이다', async () => {
      // `findById`가 소유자를 조건에 넣으므로 `null`로 돌아온다. 먼저 읽는 덕분에
      // Prisma의 `P2025`(고칠 행을 찾지 못했다)가 500으로 새지 않는다.
      templates.findById.mockResolvedValue(null);

      await expect(
        service.updateTodo(USER_ID, 1n, { title: '가로챈 제목' }),
      ).rejects.toThrow(NotFoundException);
      expect(templates.update).not.toHaveBeenCalled();
    });

    it('소유자를 조건으로 고친다', async () => {
      templates.findById.mockResolvedValue(createTemplate());
      templates.update.mockResolvedValue(createTemplate({ title: '바꾼 뒤' }));

      await service.updateTodo(USER_ID, 1n, { title: '바꾼 뒤' });

      expect(templates.update).toHaveBeenCalledWith(
        USER_ID,
        1n,
        expect.objectContaining({ title: '바꾼 뒤' }),
      );
    });

    it('저장된 타입으로 검증한다', async () => {
      // 숫자형으로 만든 할 일의 목표치를 비우면 무엇을 채워야 완료인지 알 수 없게 된다.
      // 입력에 `todoType`이 없으므로 **저장된 값**을 봐야 이 거절이 성립한다.
      templates.findById.mockResolvedValue(
        createTemplate({
          todoType: 'NUMERIC',
          targetValue: new Prisma.Decimal('100'),
          targetUnit: '회',
        }),
      );

      await expect(
        service.updateTodo(USER_ID, 1n, { targetValue: null }),
      ).rejects.toThrow(BadRequestException);
    });

    it('주지 않은 필드는 저장된 값으로 판단한다', async () => {
      // 숫자형이고 목표치가 이미 있으므로 제목만 바꾸는 요청이 통과해야 한다.
      templates.findById.mockResolvedValue(
        createTemplate({
          todoType: 'NUMERIC',
          targetValue: new Prisma.Decimal('100'),
          targetUnit: '회',
        }),
      );
      templates.update.mockResolvedValue(createTemplate());

      await service.updateTodo(USER_ID, 1n, { title: '제목만' });

      expect(templates.update).toHaveBeenCalledWith(USER_ID, 1n, {
        title: '제목만',
      });
    });

    it('저장된 반복 방식으로도 검증한다', async () => {
      // 매일 반복으로 만든 할 일에 예정일을 붙이는 요청이다.
      templates.findById.mockResolvedValue(
        createTemplate({ completeType: 'DAILY' }),
      );

      await expect(
        service.updateTodo(USER_ID, 1n, {
          shouldDoAt: new Date('2026-08-10T00:00:00.000Z'),
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('활성 기간을 그대로 넘긴다', async () => {
      templates.findById.mockResolvedValue(
        createTemplate({ completeType: 'DAILY' }),
      );
      templates.update.mockResolvedValue(createTemplate());

      await service.updateTodo(USER_ID, 1n, {
        activeUntil: parseLocalDateKey('2026-12-31'),
      });

      expect(templates.update).toHaveBeenCalledWith(USER_ID, 1n, {
        activeUntil: parseLocalDateKey('2026-12-31'),
      });
    });

    it('자정이 아닌 순간도 활성 기간으로 받아 그대로 넘긴다', async () => {
      // 만들기 쪽과 같은 규칙이 고치기 경로에도 걸리는지 따로 본다 — 두 메서드가
      // 같은 검증 경로를 지나는 것은 지금의 구현일 뿐이다.
      templates.findById.mockResolvedValue(
        createTemplate({ completeType: 'DAILY' }),
      );
      templates.update.mockResolvedValue(createTemplate());
      const activeFrom = new Date('2026-08-01T10:30:00.000Z');

      await service.updateTodo(USER_ID, 1n, { activeFrom });

      expect(templates.update).toHaveBeenCalledWith(USER_ID, 1n, {
        activeFrom,
      });
    });

    it('활성 기간을 비우는 것은 허용한다', async () => {
      // `null`은 "제한 없음"이라는 뜻이고 매일 반복에서 정상적인 값이다.
      templates.findById.mockResolvedValue(
        createTemplate({ completeType: 'DAILY' }),
      );
      templates.update.mockResolvedValue(createTemplate());

      await service.updateTodo(USER_ID, 1n, { activeUntil: null });

      expect(templates.update).toHaveBeenCalledWith(USER_ID, 1n, {
        activeUntil: null,
      });
    });

    it('읽은 뒤 지워졌으면 NotFoundException이다', async () => {
      // 미리 읽어도 읽기와 고치기 사이에 삭제가 끼어들 수 있다. 그때 대상이 사라져
      // Prisma가 `P2025`(고칠 행을 찾지 못했다)를 던지는데, 그대로 새게 두면
      // 클라이언트에게 500으로 보여 서버 장애처럼 읽힌다.
      templates.findById.mockResolvedValue(createTemplate());
      templates.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('고칠 행을 찾지 못했다', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.updateTodo(USER_ID, 1n, { title: '바꾼 뒤' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('다른 Prisma 오류는 그대로 던진다', async () => {
      // 오류 코드를 가리지 않고 404로 바꾸면 진짜 장애가 "없는 할 일"로 위장하고,
      // 원인을 찾을 단서가 사라진다.
      const conflict = new Prisma.PrismaClientKnownRequestError(
        '고유 제약을 위반했다',
        { code: 'P2002', clientVersion: 'test' },
      );
      templates.findById.mockResolvedValue(createTemplate());
      templates.update.mockRejectedValue(conflict);

      await expect(
        service.updateTodo(USER_ID, 1n, { title: '바꾼 뒤' }),
      ).rejects.toBe(conflict);
    });
  });

  describe('deleteTodo', () => {
    it('남의 할 일이면 NotFoundException이다', async () => {
      templates.findById.mockResolvedValue(null);

      await expect(service.deleteTodo(USER_ID, 1n)).rejects.toThrow(
        NotFoundException,
      );
      expect(templates.softDelete).not.toHaveBeenCalled();
    });

    it('소유자를 조건으로 지운다', async () => {
      templates.findById.mockResolvedValue(createTemplate());
      templates.softDelete.mockResolvedValue(createTemplate());

      await service.deleteTodo(USER_ID, 1n);

      expect(templates.softDelete).toHaveBeenCalledWith(USER_ID, 1n);
    });

    it('읽은 뒤 지워졌으면 NotFoundException이다', async () => {
      // 두 화면에서 같은 할 일을 지우면 두 번째 요청이 이 경로로 온다. 삭제는 트랜잭션의
      // 첫 연산이 정의 수정이라 대상을 찾지 못하는 순간 `P2025`로 실패한다.
      templates.findById.mockResolvedValue(createTemplate());
      templates.softDelete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('고칠 행을 찾지 못했다', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(service.deleteTodo(USER_ID, 1n)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('기록 쓰기', () => {
    /**
     * 한국 시간대(Asia/Seoul) 자정 직전이다. UTC 기준으로는 8월 1일이지만 유저가 보는
     * 날짜는 8월 2일이라, **매일 반복 키를 유저 타임존으로 만드는지**가 이 값에서 갈린다.
     */
    const PERFORMED_AT = new Date('2026-08-01T15:00:00.000Z');

    const dailyTemplate = createTemplate({ completeType: 'DAILY' });
    // 일회성에는 활성 기간을 둘 수 없다(`assertShape`). 저장된 값이 그 규칙을 지킨다는
    // 전제를 픽스처가 어기지 않게 비워 둔다.
    const onceTemplate = createTemplate({
      completeType: 'ONCE',
      activeFrom: null,
    });

    /**
     * 저장 경로가 넘긴 목표치·진행값을 `numeric` 컬럼의 실제 형태로 되돌린다. Prisma는 그
     * 컬럼을 `Prisma.Decimal`로 돌려주므로, 숫자를 그대로 두면 뷰 변환이 `toNumber()`를
     * 부르는 자리에서 터진다.
     */
    function toDecimalOrNull(
      value: Prisma.Decimal | string | number | null | undefined,
    ): Prisma.Decimal | null {
      return value == null ? null : new Prisma.Decimal(value);
    }

    beforeEach(() => {
      templates.findById.mockResolvedValue(dailyTemplate);
      // 완료 취소가 확인하는 "그날 기록". 없는 경우를 보는 테스트만 `null`로 덮는다.
      histories.findByTodoIdAndHistoriedOn.mockResolvedValue(createHistory());
      // 저장한 값이 반환값에 그대로 비치게 하는 대역이다.
      //
      // **실제 upsert와 다른 점이 하나 있다.** 고치는 쪽으로 갈 때 DB는 `changes`에 없는
      // 컬럼을 건드리지 않지만 이 대역은 넘긴 값만 비춘다. 그래서 "진행값을 건드리지
      // 않는다"는 반환값이 아니라 **`changes`에 그 키가 없는 것**으로 확인한다.
      histories.upsertForHistoriedOn.mockImplementation(
        (snapshot: TodoHistorySnapshot, changes: TodoHistoryChanges) =>
          Promise.resolve(
            createHistory({
              todoId: snapshot.todoId,
              userId: snapshot.userId,
              historiedOn: snapshot.historiedOn,
              targetValue: toDecimalOrNull(snapshot.targetValue),
              targetUnit: snapshot.targetUnit,
              progressValue: toDecimalOrNull(changes.progressValue),
              completedAt: changes.completedAt ?? null,
            }),
          ),
      );
    });

    /**
     * 기록 쓰기 셋을 **같은 규칙으로** 돌리기 위한 호출자 목록이다. 셋이 소유자 검사·날짜
     * 키·오류 변환을 공유하므로, 어느 하나가 그 경로를 지나지 않게 바뀌면 아래 테스트들이
     * 그 메서드에서만 실패한다.
     */
    const writers: [name: string, call: () => Promise<unknown>][] = [
      [
        'saveProgress',
        () =>
          service.saveProgress(USER_ID, 1n, {
            progressValue: 300,
            performedAt: PERFORMED_AT,
          }),
      ],
      ['completeTodo', () => service.completeTodo(USER_ID, 1n, PERFORMED_AT)],
      [
        'uncompleteTodo',
        () => service.uncompleteTodo(USER_ID, 1n, PERFORMED_AT),
      ],
    ];

    it.each(writers)(
      '%s는 남의 할 일이면 NotFoundException이고 저장하지 않는다',
      async (_name, call) => {
        // `findById`가 소유자를 조건에 넣으므로 `null`로 돌아온다.
        templates.findById.mockResolvedValue(null);

        await expect(call()).rejects.toThrow(NotFoundException);
        expect(histories.upsertForHistoriedOn).not.toHaveBeenCalled();
      },
    );

    it.each(writers)(
      '%s는 소유자를 조건으로 정의를 읽는다',
      async (_name, call) => {
        await call();

        expect(templates.findById).toHaveBeenCalledWith(USER_ID, 1n);
      },
    );

    it.each(writers)(
      '%s는 정의가 아니라 요청자의 식별자를 snapshot에 넣는다',
      async (_name, call) => {
        // 실제 `findById(userId, todoId)`는 소유자로 좁혀 읽으므로 이런 정의가 돌아올 수
        // 없다. 대역으로 그 상황을 만드는 이유는 **정의 행에서 소유자를 복제하는 변이**를
        // 잡는 것이다 — 좁히지 않고 읽는 코드가 생기면 그 복제가 저장 경로의 소유자
        // 검사를 동어반복으로 만들어 남의 할 일에 기록이 쓰인다(`TodoHistorySnapshot`).
        templates.findById.mockResolvedValue(
          createTemplate({ completeType: 'DAILY', userId: 999n }),
        );

        await call();

        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.objectContaining({ userId: USER_ID }),
          expect.anything(),
        );
      },
    );

    it.each(writers)(
      '%s는 목표치 한 쌍을 정의에서 복사해 snapshot에 넣는다',
      async (_name, call) => {
        // 그날 기준의 목표를 남기지 않으면 목표를 5에서 8로 올렸을 때 5를 채웠던 날의
        // 달성률이 소급해 바뀐다.
        templates.findById.mockResolvedValue(
          createTemplate({
            completeType: 'DAILY',
            todoType: 'NUMERIC',
            targetValue: new Prisma.Decimal('5'),
            targetUnit: '회',
          }),
        );

        await call();

        const [snapshot] = histories.upsertForHistoriedOn.mock.calls[0] as [
          TodoHistorySnapshot,
        ];
        expect(String(snapshot.targetValue)).toBe('5');
        expect(snapshot.targetUnit).toBe('회');
      },
    );

    it.each(writers)(
      '%s는 그 할 일의 번호를 snapshot에 넣는다',
      async (_name, call) => {
        await call();

        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.objectContaining({ todoId: 1n }),
          expect.anything(),
        );
      },
    );

    it.each(writers)(
      '%s는 매일 반복이면 유저 타임존 기준 날짜를 키로 쓴다',
      async (_name, call) => {
        await call();

        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.objectContaining({
            historiedOn: parseLocalDateKey('2026-08-02'),
          }),
          expect.anything(),
        );
      },
    );

    it.each(writers)(
      '%s는 일회성이면 정의 생성 시각의 UTC 날짜를 키로 쓴다',
      async (_name, call) => {
        // 수행 시각이나 타임존이 키에 섞이면 일회성 기록이 둘 생긴다.
        templates.findById.mockResolvedValue(onceTemplate);

        await call();

        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.objectContaining({
            historiedOn: parseLocalDateKey('2026-07-20'),
          }),
          expect.anything(),
        );
      },
    );

    it.each(writers)(
      '%s는 일회성이면 유저 타임존을 읽지 않는다',
      async (_name, call) => {
        // 일회성 키는 UTC로 고정이라 타임존이 결과를 바꾸지 않는다. 읽으면 조회가 하나
        // 늘고 "탈퇴하지 않은 유저인지"가 저장 성공 여부를 바꾸게 된다.
        templates.findById.mockResolvedValue(onceTemplate);

        await call();

        expect(users.findTimeZone).not.toHaveBeenCalled();
      },
    );

    it.each(writers)(
      '%s는 매일 반복이고 타임존을 읽을 유저가 없으면 NotFoundException이다',
      async (_name, call) => {
        users.findTimeZone.mockResolvedValue(null);

        await expect(call()).rejects.toThrow(NotFoundException);
        expect(histories.upsertForHistoriedOn).not.toHaveBeenCalled();
      },
    );

    it.each(writers)(
      '%s는 할 일이 없다는 Repository 오류를 NotFoundException으로 바꾼다',
      async (_name, call) => {
        // 도메인 오류를 그대로 새게 두면 NestJS가 500으로 바꿔 "서버 오류"로 보인다.
        histories.upsertForHistoriedOn.mockRejectedValue(
          new TodoTemplateNotFoundError(1n),
        );

        await expect(call()).rejects.toThrow(NotFoundException);
      },
    );

    it.each(writers)(
      '%s는 지워진 할 일 오류도 NotFoundException으로 바꾼다',
      async (_name, call) => {
        // 응답은 위와 같게 합친다. 지워진 행이 실제로 있다는 사실은 클라이언트가 알
        // 필요가 없고, 두 오류를 따로 둔 값어치는 로그에서 살아난다(`todo-errors.ts`).
        histories.upsertForHistoriedOn.mockRejectedValue(
          new TodoTemplateDeletedError(1n),
        );

        await expect(call()).rejects.toThrow(NotFoundException);
      },
    );

    it.each(writers)(
      '%s는 그 밖의 오류를 그대로 던진다',
      async (_name, call) => {
        // 오류를 가리지 않고 404로 바꾸면 진짜 장애가 "없는 할 일"로 위장하고 원인을 찾을
        // 단서가 사라진다.
        const failure = new Error('DB 연결이 끊겼다');
        histories.upsertForHistoriedOn.mockRejectedValue(failure);

        await expect(call()).rejects.toBe(failure);
      },
    );

    describe('saveProgress', () => {
      it('진행값을 저장하고 그 값이 담긴 progress를 돌려준다', async () => {
        const progress = await service.saveProgress(USER_ID, 1n, {
          progressValue: 300,
          performedAt: PERFORMED_AT,
        });

        expect(progress.progressValue).toBe(300);
        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.anything(),
          { progressValue: 300 },
        );
      });

      it('진행값 0을 떨어뜨리지 않는다', async () => {
        // **`0`과 `null`은 다르다** — 0을 입력한 것과 아직 손대지 않은 것이다. 떨어뜨리면
        // 이미 있는 행의 진행값이 `null`로 덮여 "0을 입력했다"가 "아무것도 하지 않았다"로
        // 바뀌고, 사용자가 `progress`를 그 형태로 고른 첫 번째 근거가 무너진다.
        //
        // 뷰 계층에도 같은 구별을 고정한 테스트가 있지만(`todo-view.spec.ts`) 그 지점은
        // 값이 저장 통로에 넘어간 뒤라서, **여기서 값이 떨어지는 것은 그쪽이 잡지 못한다.**
        const progress = await service.saveProgress(USER_ID, 1n, {
          progressValue: 0,
          performedAt: PERFORMED_AT,
        });

        expect(progress.progressValue).toBe(0);
        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.anything(),
          { progressValue: 0 },
        );
      });

      it('목표치를 넘겨도 완료로 찍지 않는다', async () => {
        // 완료는 클라이언트가 명시적으로 요청할 때만 찍힌다(사용자 확정). 저장 하나가 두
        // 가지 사실을 동시에 바꾸면, 진행값을 잘못 입력해 목표를 넘겼을 때 완료가 딸려
        // 오고 되돌리려면 두 번 고쳐야 한다.
        const progress = await service.saveProgress(USER_ID, 1n, {
          // 정의의 목표치는 2000이다.
          progressValue: 9999,
          performedAt: PERFORMED_AT,
        });

        expect(progress.isCompleted).toBe(false);
        expect(progress.completedAt).toBeNull();
      });

      it('완료 시각을 갱신 대상에 넣지 않는다', async () => {
        await service.saveProgress(USER_ID, 1n, {
          progressValue: 300,
          performedAt: PERFORMED_AT,
        });

        const [, changes] = histories.upsertForHistoriedOn.mock.calls[0] as [
          TodoHistorySnapshot,
          TodoHistoryChanges,
        ];
        expect(changes).not.toHaveProperty('completedAt');
      });

      it('일반 타입이면 BadRequestException이고 저장하지 않는다', async () => {
        // 일반 할 일은 목표치를 둘 수 없어(`assertShape`) 진행값을 그릴 기준이 없다.
        // 그 상태는 완료 여부 하나로 표현된다.
        templates.findById.mockResolvedValue(
          createTemplate({
            completeType: 'DAILY',
            todoType: 'GENERAL',
            targetValue: null,
            targetUnit: null,
          }),
        );

        await expect(
          service.saveProgress(USER_ID, 1n, {
            progressValue: 1,
            performedAt: PERFORMED_AT,
          }),
        ).rejects.toThrow(BadRequestException);
        expect(histories.upsertForHistoriedOn).not.toHaveBeenCalled();
      });
    });

    describe('completeTodo', () => {
      it('완료 시각을 수행 시각으로 찍는다', async () => {
        // 날짜 키와 완료 시각이 같은 순간에서 나온다. 두 값을 따로 받으면 8월 2일 기록에
        // 8월 5일 완료 시각이 들어가는 조합이 만들어진다.
        const progress = await service.completeTodo(USER_ID, 1n, PERFORMED_AT);

        expect(progress.isCompleted).toBe(true);
        expect(progress.completedAt).toEqual(PERFORMED_AT);
        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.anything(),
          { completedAt: PERFORMED_AT },
        );
      });

      it('진행값을 갱신 대상에 넣지 않는다', async () => {
        // `changes`에 담은 것만 갱신되므로(`upsertForHistoriedOn`) 이미 입력한 진행값이
        // 그대로 남는다.
        await service.completeTodo(USER_ID, 1n, PERFORMED_AT);

        const [, changes] = histories.upsertForHistoriedOn.mock.calls[0] as [
          TodoHistorySnapshot,
          TodoHistoryChanges,
        ];
        expect(changes).not.toHaveProperty('progressValue');
      });

      it('그날 기록이 없어도 만든다', async () => {
        // 진행값 없이 완료만 찍는 일반 할 일이 정확히 이 경우다. 완료 취소처럼 존재
        // 확인을 넣으면 그런 할 일을 완료할 수 없게 된다.
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        await service.completeTodo(USER_ID, 1n, PERFORMED_AT);

        expect(histories.upsertForHistoriedOn).toHaveBeenCalled();
        expect(histories.findByTodoIdAndHistoriedOn).not.toHaveBeenCalled();
      });
    });

    describe('uncompleteTodo', () => {
      it('완료 시각만 비운다', async () => {
        // 완료된 기록에서 출발한다. 갱신 대상에 진행값이 없으므로 그 값은 남는다.
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(
          createHistory({ completedAt: new Date('2026-08-02T05:00:00.000Z') }),
        );

        const progress = await service.uncompleteTodo(
          USER_ID,
          1n,
          PERFORMED_AT,
        );

        expect(progress.isCompleted).toBe(false);
        expect(histories.upsertForHistoriedOn).toHaveBeenCalledWith(
          expect.anything(),
          { completedAt: null },
        );
      });

      it('이미 완료가 아닌 기록에 불러도 거절하지 않는다', async () => {
        // 두 화면에서 취소를 두 번 누르는 것이 정상 조작이다. 기록이 있는지만 보고 완료
        // 여부는 보지 않는 이유가 이것이다 — 오류로 만들면 사용자가 취소에 실패한 것으로
        // 읽는다.
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(
          createHistory({ completedAt: null }),
        );

        const progress = await service.uncompleteTodo(
          USER_ID,
          1n,
          PERFORMED_AT,
        );

        expect(progress.isCompleted).toBe(false);
      });

      it('취소할 기록을 그 날짜 키로 찾는다', async () => {
        await service.uncompleteTodo(USER_ID, 1n, PERFORMED_AT);

        expect(histories.findByTodoIdAndHistoriedOn).toHaveBeenCalledWith(
          USER_ID,
          1n,
          parseLocalDateKey('2026-08-02'),
        );
      });

      it('그날 기록이 없으면 저장하지 않고 거절한다', async () => {
        // `upsertForHistoriedOn`은 행이 없으면 **만든다.** 그대로 부르면 진행값도 완료
        // 시각도 빈 행이 생겨 "기록이 없다 = 아직 손대지 않았다"가 성립하지 않게 되고,
        // 손대지 않은 할 일과 구별되지 않는다.
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        await expect(
          service.uncompleteTodo(USER_ID, 1n, PERFORMED_AT),
        ).rejects.toThrow(NotFoundException);
        expect(histories.upsertForHistoriedOn).not.toHaveBeenCalled();
      });

      it('일회성이면 거절 메시지에 날짜 키를 담지 않는다', async () => {
        // 일회성의 `historiedOn`은 표시용 날짜가 아니라 중복을 막는 열쇠라서 밖으로
        // 내보내지 않는다. 뷰 계층은 그 규칙을 **구조로** 막는다 — 이력 항목 변환 함수를
        // 내보내지 않고 유일한 통로가 매일 반복으로 좁혀진 정의만 받는다(`todo-view.ts`).
        // **오류 메시지 경로에는 그렇게 막을 접합면이 없다.** 템플릿 문자열 하나라 타입이
        // 볼 것이 없고, 예외 생성을 헬퍼로 감싸 날짜를 받지 않게 해도 문자열을 직접 쓰는
        // 경로가 그대로 열려 있어 방어가 아니라 관례가 하나 늘 뿐이다. 그래서 이 테스트가
        // 그 자리를 맡는다.
        //
        // **연도로 찾는 이유는 유출 형태가 셋이기 때문이다.** `formatLocalDateKey`는
        // `2026-07-20`, `toISOString()`은 `2026-07-20T00:00:00.000Z`, `Date`를 그대로
        // 템플릿에 넣으면 `Mon Jul 20 2026 …`이 된다. 셋이 공통으로 담는 것이 연도뿐이라
        // 날짜 문자열 하나만 찾으면 나머지 둘이 빠져나간다.
        templates.findById.mockResolvedValue(onceTemplate);
        histories.findByTodoIdAndHistoriedOn.mockResolvedValue(null);

        const thrown = await service
          .uncompleteTodo(USER_ID, 1n, PERFORMED_AT)
          .catch((error: Error) => error);

        expect(thrown).toBeInstanceOf(NotFoundException);
        // 메시지가 비어 있어도 아래 단정이 통과하므로 무엇을 담는지도 함께 고정한다.
        expect((thrown as Error).message).toContain('todoId=1');
        expect((thrown as Error).message).not.toContain('2026');
      });
    });
  });
});
