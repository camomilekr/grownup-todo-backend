import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { TodoHistoriesRepository } from './../src/todos/todo-histories.repository';
import { TodoTemplatesRepository } from './../src/todos/todo-templates.repository';
import {
  parseLocalDateKey,
  toHistoriedOn,
} from './../src/todos/todo-local-date';

/**
 * 실제 Supabase Postgres에 붙는다(`.claude/rules/nestjs.md` — "DB를 실제로 붙이는
 * 테스트는 e2e로 분류한다"). Repository는 단위 테스트를 만들지 않는다 —
 * `PrismaService`를 mock하면 호출 인자만 보게 되고 그건 구현 세부사항 테스트다.
 *
 * **공유 DB를 쓰므로 데이터를 남기지 않는다.** 랜덤 email로 전용 유저를 만들고
 * `afterAll`에서 그 유저를 지운다 — FK가 cascade라 하위 행이 함께 사라진다.
 */
describe('Todos Repository (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let templates: TodoTemplatesRepository;
  let histories: TodoHistoriesRepository;
  let userId: bigint;

  // 유저 타임존은 KST로 고정한다. 날짜 경계가 UTC와 겹치지 않아 어긋남이 드러난다.
  const timeZone = 'Asia/Seoul';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    templates = app.get(TodoTemplatesRepository);
    histories = app.get(TodoHistoriesRepository);

    const user = await prisma.appUser.create({
      data: {
        // 병렬 실행·재실행에서 유니크 충돌이 나지 않게 매번 다른 값을 쓴다.
        email: `todos-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        timeZone,
      },
    });
    userId = user.userId;
  });

  afterAll(async () => {
    // cascade로 template·history가 함께 지워진다.
    await prisma.appUser.delete({ where: { userId } });
    await app.close();
  });

  describe('TodoTemplatesRepository', () => {
    it('생성한 template을 id로 다시 읽는다', async () => {
      const created = await templates.create({
        userId,
        title: '물 마시기',
        description: '하루 2리터',
        todoType: 'NUMERIC',
        completeType: 'DAILY',
        remindAt: '09:00',
        targetValue: '2000',
        targetUnit: 'ml',
        activeFrom: parseLocalDateKey('2026-08-01'),
      });

      const found = await templates.findById(created.todoId);

      expect(found?.title).toBe('물 마시기');
      // BigInt PK가 왕복한다.
      expect(found?.todoId).toBe(created.todoId);
      expect(found?.userId).toBe(userId);
    });

    it('Decimal이 왕복한다', async () => {
      const created = await templates.create({
        userId,
        title: '스쿼트',
        todoType: 'NUMERIC',
        completeType: 'DAILY',
        targetValue: '30.50',
        targetUnit: '회',
      });

      const found = await templates.findById(created.todoId);

      // Prisma.Decimal은 문자열로 비교한다. Number로 바꾸면 정밀도가 깨진다.
      expect(found?.targetValue?.toString()).toBe('30.5');
    });

    it('@db.Date 컬럼이 UTC 자정 Date로 돌아온다', async () => {
      // 계획서가 확인하지 못한 항목이다. 쓰기 경로는 어댑터 소스로 확인했지만
      // 읽기는 쿼리 컴파일러가 파싱하므로 실제로 왕복하는지 여기서 고정한다.
      const created = await templates.create({
        userId,
        title: '아침 산책',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: parseLocalDateKey('2026-08-01'),
        activeUntil: parseLocalDateKey('2026-08-31'),
      });

      const found = await templates.findById(created.todoId);

      expect(found?.activeFrom?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(found?.activeUntil?.toISOString()).toBe(
        '2026-08-31T00:00:00.000Z',
      );
    });

    it('soft delete하면 findById가 null이다', async () => {
      const created = await templates.create({
        userId,
        title: '지울 todo',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });

      await templates.softDelete(created.todoId);

      expect(await templates.findById(created.todoId)).toBeNull();
    });

    it('todoType·completeType은 타입 수준에서 수정이 막혀 있다', () => {
      // 사용자 확정 요구다. **런타임 검사가 아니라 컴파일 검사로 고정한다** —
      // 아래 함수는 호출하지 않고, `@ts-expect-error`가 붙은 줄에 타입 오류가 없으면
      // tsc가 "Unused '@ts-expect-error' directive"로 거부한다. 즉
      // `UpdateTodoTemplateInput`의 `Omit`에서 두 필드를 빼는 순간 `npm run verify`가
      // 깨진다. 실행하면 실제 DB를 건드리므로 참조만 하고 부르지 않는다.
      const typeGuard = async () => {
        // @ts-expect-error todoType은 생성 후 수정할 수 없다 (히스토리가 복제한다)
        await templates.update(1n, { todoType: 'NUMERIC' });
        // @ts-expect-error completeType은 생성 후 수정할 수 없다 (historiedOn 규칙이 바뀐다)
        await templates.update(1n, { completeType: 'ONCE' });
      };

      expect(typeGuard).toBeInstanceOf(Function);
    });

    it('soft delete된 template은 수정도 재삭제도 거절된다', async () => {
      // 조회는 `deletedAt: null`을 거는데 쓰기는 걸지 않으면, 보이지 않는 행이
      // 조용히 수정되고 두 번째 softDelete가 최초 삭제 시각을 덮어쓴다.
      const created = await templates.create({
        userId,
        title: '삭제 후 쓰기',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });
      const deleted = await templates.softDelete(created.todoId);

      await expect(
        templates.update(created.todoId, { title: '되면 안 된다' }),
      ).rejects.toThrow();
      await expect(templates.softDelete(created.todoId)).rejects.toThrow();

      // 최초 삭제 시각이 그대로 남아 있다.
      const row = await prisma.todoTemplate.findUnique({
        where: { todoId: created.todoId },
      });
      expect(row?.deletedAt?.toISOString()).toBe(
        deleted.deletedAt?.toISOString(),
      );
    });

    it('update가 제목을 바꾸고 updatedAt을 올린다', async () => {
      const created = await templates.create({
        userId,
        title: '바꾸기 전',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });

      const updated = await templates.update(created.todoId, {
        title: '바꾼 뒤',
      });

      expect(updated.title).toBe('바꾼 뒤');
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.updatedAt.getTime(),
      );
    });
  });

  describe('ONCE 목록 — 완료할 때까지 계속 나온다', () => {
    it('완료 히스토리가 없으면 예정일이 지났어도 목록에 남는다', async () => {
      const past = await templates.create({
        userId,
        title: '지난 예정일 ONCE',
        todoType: 'GENERAL',
        completeType: 'ONCE',
        // 예정일이 한참 지났다. 그래도 사라지지 않아야 한다.
        shouldDoAt: new Date('2020-01-01T00:00:00.000Z'),
      });

      const rows = await templates.findOnceWithoutCompletedHistory(userId);

      expect(rows.map((row) => row.todoId)).toContain(past.todoId);
    });

    it('suspendedAt이 있어도 ONCE는 목록에 남는다', async () => {
      // 일시 중지는 DAILY의 반복을 멈추는 개념이고 ONCE에는 무의미하다. ONCE에
      // 중지 개념을 두는 것은 확정된 요구사항에 없으므로 **현재 동작을 고정한다** —
      // 스키마 주석만 읽고 "ONCE도 중지되면 빠진다"고 믿는 구현을 막는다.
      const template = await templates.create({
        userId,
        title: '중지된 ONCE',
        todoType: 'GENERAL',
        completeType: 'ONCE',
        suspendedAt: new Date('2026-07-15T00:00:00.000Z'),
      });

      const rows = await templates.findOnceWithoutCompletedHistory(userId);

      expect(rows.map((row) => row.todoId)).toContain(template.todoId);
    });

    it('완료하면 목록에서 사라진다', async () => {
      const template = await templates.create({
        userId,
        title: '완료할 ONCE',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });

      await histories.upsertForHistoriedOn(
        {
          todoId: template.todoId,
          userId: template.userId,
          historiedOn: toHistoriedOn({
            completeType: template.completeType,
            createdAt: template.createdAt,
            performedAt: new Date('2026-08-01T02:00:00.000Z'),
            timeZone,
          }),
          title: template.title,
          description: template.description,
          todoType: template.todoType,
          completeType: template.completeType,
          remindAt: template.remindAt,
          shouldDoAt: template.shouldDoAt,
          targetValue: template.targetValue,
          targetUnit: template.targetUnit,
        },
        { completedAt: new Date('2026-08-01T02:00:00.000Z') },
      );

      const rows = await templates.findOnceWithoutCompletedHistory(userId);

      expect(rows.map((row) => row.todoId)).not.toContain(template.todoId);
    });

    it('완료를 취소하면(soft delete) 다시 목록에 나온다', async () => {
      const template = await templates.create({
        userId,
        title: '완료 취소할 ONCE',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });
      const historiedOn = toHistoriedOn({
        completeType: template.completeType,
        createdAt: template.createdAt,
        performedAt: new Date('2026-08-01T02:00:00.000Z'),
        timeZone,
      });

      const history = await histories.upsertForHistoriedOn(
        {
          todoId: template.todoId,
          userId: template.userId,
          historiedOn,
          title: template.title,
          description: null,
          todoType: template.todoType,
          completeType: template.completeType,
          remindAt: null,
          shouldDoAt: null,
          targetValue: null,
          targetUnit: null,
        },
        { completedAt: new Date('2026-08-01T02:00:00.000Z') },
      );
      await histories.softDelete(history.todoHistoryId);

      const rows = await templates.findOnceWithoutCompletedHistory(userId);

      expect(rows.map((row) => row.todoId)).toContain(template.todoId);
    });
  });

  describe('DAILY 목록 — 어제 것이 오늘로 밀려오지 않는다', () => {
    const yesterday = parseLocalDateKey('2026-08-01');
    const today = parseLocalDateKey('2026-08-02');

    it('활성 기간 안이면 그날 히스토리가 없어도 목록에 나온다', async () => {
      const template = await templates.create({
        userId,
        title: '활성 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: parseLocalDateKey('2026-07-01'),
        activeUntil: parseLocalDateKey('2026-12-31'),
      });

      const rows = await templates.findDailyActiveOn(userId, today);

      const row = rows.find((item) => item.todoId === template.todoId);
      expect(row).toBeDefined();
      // 히스토리가 없다 = 그날 아무것도 하지 않았다. 판정은 Service가 한다.
      expect(row?.histories).toEqual([]);
    });

    it('activeFrom과 같은 날은 포함된다 (양 끝 포함)', async () => {
      // `lte`/`gte`를 `lt`/`gt`로 바꾸는 수정이 통과하지 않게 경계를 고정한다.
      const template = await templates.create({
        userId,
        title: '시작일 경계',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: today,
      });

      const onStart = await templates.findDailyActiveOn(userId, today);
      const dayBefore = await templates.findDailyActiveOn(userId, yesterday);

      expect(onStart.map((item) => item.todoId)).toContain(template.todoId);
      // 시작일 전날은 빠진다.
      expect(dayBefore.map((item) => item.todoId)).not.toContain(
        template.todoId,
      );
    });

    it('activeUntil과 같은 날은 포함되고 다음 날은 빠진다', async () => {
      const dayAfter = parseLocalDateKey('2026-08-03');
      const template = await templates.create({
        userId,
        title: '종료일 경계',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: yesterday,
        activeUntil: today,
      });

      const onEnd = await templates.findDailyActiveOn(userId, today);
      const afterEnd = await templates.findDailyActiveOn(userId, dayAfter);

      expect(onEnd.map((item) => item.todoId)).toContain(template.todoId);
      expect(afterEnd.map((item) => item.todoId)).not.toContain(
        template.todoId,
      );
    });

    it('activeFrom이 null이면 시작 제한 없이 나온다', async () => {
      // `null`은 "제한 없음"이다. `activeUntil: null`과 짝을 이루는 분기이고
      // 어느 테스트도 지나지 않던 자리다.
      const template = await templates.create({
        userId,
        title: '시작 제한 없는 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeUntil: parseLocalDateKey('2026-12-31'),
      });

      const rows = await templates.findDailyActiveOn(userId, today);

      expect(rows.map((item) => item.todoId)).toContain(template.todoId);
    });

    it('활성 기간이 지나면 목록에서 빠진다', async () => {
      const template = await templates.create({
        userId,
        title: '기간 끝난 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: parseLocalDateKey('2026-07-01'),
        activeUntil: parseLocalDateKey('2026-07-31'),
      });

      const rows = await templates.findDailyActiveOn(userId, today);

      expect(rows.map((item) => item.todoId)).not.toContain(template.todoId);
    });

    it('activeUntil이 null이면 무기한으로 나온다', async () => {
      const template = await templates.create({
        userId,
        title: '무기한 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: parseLocalDateKey('2026-07-01'),
      });

      const rows = await templates.findDailyActiveOn(userId, today);

      expect(rows.map((item) => item.todoId)).toContain(template.todoId);
    });

    it('중단된 DAILY는 기간이 남아 있어도 빠진다', async () => {
      const template = await templates.create({
        userId,
        title: '중단된 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: parseLocalDateKey('2026-07-01'),
        suspendedAt: new Date('2026-07-15T00:00:00.000Z'),
      });

      const rows = await templates.findDailyActiveOn(userId, today);

      expect(rows.map((item) => item.todoId)).not.toContain(template.todoId);
    });

    it('어제 완료해도 오늘은 히스토리 없이 다시 나온다', async () => {
      // 확정된 요구사항의 핵심이다 — 어제 것이 오늘로 밀려오지 않고, 어제는
      // 어제 상태로 남는다.
      const template = await templates.create({
        userId,
        title: '어제 완료한 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: parseLocalDateKey('2026-07-01'),
      });
      const snapshot = {
        todoId: template.todoId,
        userId: template.userId,
        historiedOn: yesterday,
        title: template.title,
        description: null,
        todoType: template.todoType,
        completeType: template.completeType,
        remindAt: null,
        shouldDoAt: null,
        targetValue: null,
        targetUnit: null,
      };
      await histories.upsertForHistoriedOn(snapshot, {
        completedAt: new Date('2026-08-01T10:00:00.000Z'),
      });

      const yesterdayRows = await templates.findDailyActiveOn(
        userId,
        yesterday,
      );
      const todayRows = await templates.findDailyActiveOn(userId, today);

      // 어제는 완료 기록이 붙어 있다.
      expect(
        yesterdayRows.find((item) => item.todoId === template.todoId)
          ?.histories[0]?.completedAt,
      ).not.toBeNull();
      // 오늘은 비어 있다 — 다시 달성해야 하는 항목이다.
      expect(
        todayRows.find((item) => item.todoId === template.todoId)?.histories,
      ).toEqual([]);
    });
  });

  describe('TodoHistoriesRepository', () => {
    async function createDailyTemplate(title: string) {
      return templates.create({
        userId,
        title,
        todoType: 'NUMERIC',
        completeType: 'DAILY',
        targetValue: '100',
        targetUnit: '회',
        activeFrom: parseLocalDateKey('2026-07-01'),
      });
    }

    function snapshotOf(
      template: { todoId: bigint; userId: bigint; title: string },
      historiedOn: Date,
    ) {
      return {
        todoId: template.todoId,
        userId: template.userId,
        historiedOn,
        title: template.title,
        description: null,
        todoType: 'NUMERIC' as const,
        completeType: 'DAILY' as const,
        remindAt: null,
        shouldDoAt: null,
        targetValue: '100',
        targetUnit: '회',
      };
    }

    it('같은 (todoId, historiedOn)으로 두 번 upsert하면 행이 하나다', async () => {
      const template = await createDailyTemplate('두 번 upsert');
      const historiedOn = parseLocalDateKey('2026-08-10');
      const snapshot = snapshotOf(template, historiedOn);

      const first = await histories.upsertForHistoriedOn(snapshot, {
        progressValue: '30',
      });
      const second = await histories.upsertForHistoriedOn(snapshot, {
        progressValue: '70',
      });

      expect(second.todoHistoryId).toBe(first.todoHistoryId);
      expect(second.progressValue?.toString()).toBe('70');
    });

    it('update 분기가 progressValue와 completedAt을 반영한다', async () => {
      const template = await createDailyTemplate('진행값 갱신');
      const historiedOn = parseLocalDateKey('2026-08-11');
      const snapshot = snapshotOf(template, historiedOn);
      const completedAt = new Date('2026-08-11T05:00:00.000Z');

      await histories.upsertForHistoriedOn(snapshot, { progressValue: '10' });
      const updated = await histories.upsertForHistoriedOn(snapshot, {
        progressValue: '100',
        completedAt,
      });

      expect(updated.progressValue?.toString()).toBe('100');
      expect(updated.completedAt?.toISOString()).toBe(
        completedAt.toISOString(),
      );
    });

    it('soft delete한 뒤 다시 upsert하면 deletedAt이 되돌아온다', async () => {
      const template = await createDailyTemplate('복구되는 히스토리');
      const historiedOn = parseLocalDateKey('2026-08-12');
      const snapshot = snapshotOf(template, historiedOn);

      const created = await histories.upsertForHistoriedOn(snapshot, {});
      await histories.softDelete(created.todoHistoryId);
      const revived = await histories.upsertForHistoriedOn(snapshot, {
        progressValue: '5',
      });

      // 새 행이 생기지 않고 같은 행이 되살아난다.
      expect(revived.todoHistoryId).toBe(created.todoHistoryId);
      expect(revived.deletedAt).toBeNull();
    });

    it('historiedOn이 UTC 자정 Date로 왕복한다', async () => {
      const template = await createDailyTemplate('날짜 왕복');
      const historiedOn = parseLocalDateKey('2026-08-13');

      await histories.upsertForHistoriedOn(
        snapshotOf(template, historiedOn),
        {},
      );
      const found = await histories.findByTodoIdAndHistoriedOn(
        template.todoId,
        historiedOn,
      );

      expect(found?.historiedOn.toISOString()).toBe('2026-08-13T00:00:00.000Z');
    });

    it('DAILY 이틀치는 두 행이 된다', async () => {
      const template = await createDailyTemplate('이틀치');

      await histories.upsertForHistoriedOn(
        snapshotOf(template, parseLocalDateKey('2026-08-14')),
        {},
      );
      await histories.upsertForHistoriedOn(
        snapshotOf(template, parseLocalDateKey('2026-08-15')),
        {},
      );

      const rows = await histories.findManyByUserIdAndHistoriedOn(
        userId,
        parseLocalDateKey('2026-08-14'),
      );

      expect(rows.filter((row) => row.todoId === template.todoId)).toHaveLength(
        1,
      );
    });

    it('soft delete된 행은 조회에서 빠진다', async () => {
      const template = await createDailyTemplate('조회에서 빠짐');
      const historiedOn = parseLocalDateKey('2026-08-16');

      const created = await histories.upsertForHistoriedOn(
        snapshotOf(template, historiedOn),
        {},
      );
      await histories.softDelete(created.todoHistoryId);

      expect(
        await histories.findByTodoIdAndHistoriedOn(
          template.todoId,
          historiedOn,
        ),
      ).toBeNull();
    });
  });

  describe('복합 FK — 소유자 위조를 DB가 막는다', () => {
    it('남의 todoId에 자기 userId를 붙인 히스토리는 거절된다', async () => {
      // 라운드 1에서 `db execute`로 실측한 것을 테스트로 고정한다. 이 제약이
      // 사라지면 남의 todo 스냅샷이 내 목록에 섞이고 원래 소유자의 조회에서는
      // 그 날짜 기록이 사라진다.
      const attacker = await prisma.appUser.create({
        data: {
          email: `attacker-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
        },
      });

      try {
        const victimTemplate = await templates.create({
          userId,
          title: '피해자의 todo',
          todoType: 'GENERAL',
          completeType: 'DAILY',
        });

        await expect(
          histories.upsertForHistoriedOn(
            {
              todoId: victimTemplate.todoId,
              // 소유자가 어긋난다.
              userId: attacker.userId,
              historiedOn: parseLocalDateKey('2026-08-20'),
              title: victimTemplate.title,
              description: null,
              todoType: 'GENERAL',
              completeType: 'DAILY',
              remindAt: null,
              shouldDoAt: null,
              targetValue: null,
              targetUnit: null,
            },
            {},
          ),
        ).rejects.toThrow();
      } finally {
        await prisma.appUser.delete({ where: { userId: attacker.userId } });
      }
    });
  });
});
