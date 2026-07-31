import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../src/app.module';
import { PrismaService } from './../src/prisma/prisma.service';
import { TodoHistoriesRepository } from './../src/todos/todo-histories.repository';
import {
  TodoTemplateDeletedError,
  TodoTemplateNotFoundError,
} from './../src/todos/todo-errors';
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

    it('금지된 필드를 넣으면 컴파일 단계에서 막힌다', () => {
      // 이 테스트는 실행 결과가 아니라 **컴파일 성공 여부**를 검사한다. 방식이
      // 낯설 수 있어 원리를 적어 둔다.
      //
      // `@ts-expect-error`는 "바로 다음 줄에 타입 오류가 있을 것"이라고 선언하는
      // 주석이다. 오류가 **없으면** TypeScript가 거꾸로 "쓸데없는 지시자다"라며
      // `Unused '@ts-expect-error' directive` 오류를 낸다. 즉 아래 네 줄은 각각
      // "이 코드는 타입 오류여야 한다"는 뜻이고, 누군가 금지를 풀면 그 순간
      // `npm run verify`가 깨진다.
      //
      // 함수를 선언만 하고 부르지 않는 이유는 실행하면 실제 DB를 건드리기
      // 때문이다. 컴파일만 되면 목적이 달성된다.
      const typeGuard = async () => {
        // 아래 둘: 할 일의 종류(todoType)와 반복 방식(completeType)은 만든 뒤
        // 바꿀 수 없다. 이유는 각 Repository 타입 정의의 주석에 있다.

        // @ts-expect-error todoType은 생성 후 수정할 수 없다
        await templates.update(1n, { todoType: 'NUMERIC' });
        // @ts-expect-error completeType은 생성 후 수정할 수 없다
        await templates.update(1n, { completeType: 'ONCE' });

        // 아래 둘은 이번 변경으로 새로 금지된 것이다.

        // 일시 중지 기능 자체를 없앴으므로 그런 컬럼이 존재하지 않는다.
        await templates.create({
          userId,
          title: '중지 없는 todo',
          todoType: 'GENERAL',
          completeType: 'DAILY',
          // @ts-expect-error suspendedAt은 스키마에서 제거됐다
          suspendedAt: new Date(),
        });

        // 할 일의 내용(제목·설명 등)은 todoTemplate에만 두고 완료 기록에는
        // 복사하지 않는다. 그래서 스냅샷이 title을 받지 않는다.
        await histories.upsertForHistoriedOn(
          {
            todoId: 1n,
            userId,
            historiedOn: parseLocalDateKey('2026-08-01'),
            targetValue: null,
            targetUnit: null,
            // @ts-expect-error title은 todoHistory로 복사하지 않는다
            title: '복사되면 안 된다',
          },
          {},
        );
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

    it('진행값만 입력하고 완료하지 않았으면 목록에 남는다', async () => {
      // 완료 기록 행이 있다고 해서 완료한 것이 아니다. 진행값만 입력한 행도
      // 정상적으로 존재한다(30/100을 채워 둔 상태). 조건을 "기록이 없는 것"으로
      // 잘못 줄이면 이런 할 일이 목록에서 조용히 사라진다.
      const template = await templates.create({
        userId,
        title: '진행 중인 ONCE',
        todoType: 'NUMERIC',
        completeType: 'ONCE',
        targetValue: '100',
        targetUnit: '회',
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
          targetValue: template.targetValue,
          targetUnit: template.targetUnit,
        },
        // 완료 시각을 넣지 않는다. 진행값만 있다.
        { progressValue: '30' },
      );

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
          targetValue: template.targetValue,
          targetUnit: template.targetUnit,
        },
        { completedAt: new Date('2026-08-01T02:00:00.000Z') },
      );

      const rows = await templates.findOnceWithoutCompletedHistory(userId);

      expect(rows.map((row) => row.todoId)).not.toContain(template.todoId);
    });

    it('완료를 취소하면 다시 목록에 나온다', async () => {
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

      const snapshot = {
        todoId: template.todoId,
        userId: template.userId,
        historiedOn,
        targetValue: null,
        targetUnit: null,
      };
      await histories.upsertForHistoriedOn(snapshot, {
        completedAt: new Date('2026-08-01T02:00:00.000Z'),
      });

      // 완료 취소는 삭제가 아니라 **완료 시각을 비우는 수정**이다. 행은 그대로
      // 남고 `deletedAt`은 건드리지 않는다.
      const canceled = await histories.upsertForHistoriedOn(snapshot, {
        completedAt: null,
      });

      expect(canceled.completedAt).toBeNull();
      expect(canceled.deletedAt).toBeNull();

      const rows = await templates.findOnceWithoutCompletedHistory(userId);
      expect(rows.map((row) => row.todoId)).toContain(template.todoId);

      // **다시 완료할 수 있어야 한다.** 일회성의 날짜 키는 할 일 생성 시각에서
      // 나오므로 슬롯이 평생 하나뿐인데, 그 하나가 막히면 회복할 방법이 없다.
      // 기록을 지울 수 없게 만든 덕분에 그 막힘이 생기지 않는다.
      const recompleted = await histories.upsertForHistoriedOn(snapshot, {
        completedAt: new Date('2026-09-15T02:00:00.000Z'),
      });
      expect(recompleted.completedAt).not.toBeNull();
      expect(
        (await templates.findOnceWithoutCompletedHistory(userId)).map(
          (row) => row.todoId,
        ),
      ).not.toContain(template.todoId);
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

    // 완료 기록에 넣는 값은 이제 다섯 개뿐이다. 할 일의 내용(제목·설명·종류)은
    // todoTemplate에만 두고 기록에는 복사하지 않는다.
    function snapshotOf(
      template: { todoId: bigint; userId: bigint },
      historiedOn: Date,
    ) {
      return {
        todoId: template.todoId,
        userId: template.userId,
        historiedOn,
        targetValue: '100',
        targetUnit: '회',
      };
    }

    it('목표치는 기록에 함께 남아 그날 기준이 보존된다', async () => {
      // 할 일의 내용은 기록에 복사하지 않지만 **목표치 한 쌍만은 복사한다.**
      // 나중에 목표를 5에서 8로 올려도 5를 채웠던 날의 달성률이 62%로 다시
      // 계산되지 않게 하려는 것이다. 그 두 컬럼이 실수로 함께 지워지는 것을 막는다.
      const template = await createDailyTemplate('목표치 보존');
      const historiedOn = parseLocalDateKey('2026-08-25');

      await histories.upsertForHistoriedOn(snapshotOf(template, historiedOn), {
        progressValue: '40',
      });
      const found = await histories.findByTodoIdAndHistoriedOn(
        template.todoId,
        historiedOn,
      );

      expect(found?.targetValue?.toString()).toBe('100');
      expect(found?.targetUnit).toBe('회');
      expect(found?.progressValue?.toString()).toBe('40');
    });

    it('ONCE 히스토리는 날짜별 조회에서 빠진다', async () => {
      // `complete_type`이 history에서 사라지면 호출자가 결과를 사후 필터할 수단이
      // 없다. ONCE의 `historiedOn`은 유저가 보는 날짜가 아니라 중복 방지 키라서
      // 날짜별 목록에 섞이면 안 된다 — Repository가 걸러야 한다.
      const onceTemplate = await templates.create({
        userId,
        title: '날짜 조회에서 빠질 ONCE',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });
      const onceHistoriedOn = toHistoriedOn({
        completeType: 'ONCE',
        createdAt: onceTemplate.createdAt,
        performedAt: new Date('2026-08-18T02:00:00.000Z'),
        timeZone,
      });
      await histories.upsertForHistoriedOn(
        {
          todoId: onceTemplate.todoId,
          userId: onceTemplate.userId,
          historiedOn: onceHistoriedOn,
          targetValue: null,
          targetUnit: null,
        },
        { completedAt: new Date('2026-08-18T02:00:00.000Z') },
      );

      // 같은 날짜에 DAILY 한 건을 둔다. "전부 빠지는" 구현을 막는다.
      const dailyTemplate = await createDailyTemplate('같은 날 DAILY');
      await histories.upsertForHistoriedOn(
        snapshotOf(dailyTemplate, onceHistoriedOn),
        {},
      );

      const rows = await histories.findDailyHistoriesOn(
        userId,
        onceHistoriedOn,
      );

      expect(rows.map((row) => row.todoId)).not.toContain(onceTemplate.todoId);
      expect(rows.map((row) => row.todoId)).toContain(dailyTemplate.todoId);
    });

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

    it('기록을 지우는 메서드 자체가 없다', () => {
      // 사용자가 확정한 규칙이다 — 완료 기록은 만든 뒤 지울 수 없다. 문서로
      // 경고하는 대신 **메서드를 없앴다.** 없는 메서드는 부를 수 없다.
      // (할 일 자체를 지울 때 함께 지워지는 경로만 남는다.)
      const typeGuard = async () => {
        // @ts-expect-error 완료 기록은 개별적으로 지울 수 없다
        await histories.softDelete(1n);
      };

      expect(typeGuard).toBeInstanceOf(Function);
    });

    it('지워진 할 일에는 새 기록을 만들 수 없다', async () => {
      // 할 일이 지워지면 그 기록도 함께 지워지고, 지워진 기록은 되살아나지 않는다.
      // 그런데 같은 할 일에 같은 날짜 기록은 하나뿐이라는 제약이 남아 있어서
      // 지워진 행이 그 자리를 계속 차지한다. **조용히 지워진 행을 고치는 대신
      // 명시적으로 거절한다** — 그러지 않으면 "기록했는데 화면에 안 나온다"가
      // 되고 오류도 나지 않는다.
      const template = await createDailyTemplate('지워진 할 일에 재기록');
      const historiedOn = parseLocalDateKey('2026-08-12');
      const snapshot = snapshotOf(template, historiedOn);

      const created = await histories.upsertForHistoriedOn(snapshot, {});
      await templates.softDelete(template.todoId);

      await expect(
        histories.upsertForHistoriedOn(snapshot, { progressValue: '5' }),
      ).rejects.toThrow(TodoTemplateDeletedError);

      // 지워진 행은 지워진 채로 남는다.
      const row = await prisma.todoHistory.findUnique({
        where: { todoHistoryId: created.todoHistoryId },
      });
      expect(row?.deletedAt).not.toBeNull();
    });

    it('존재하지 않는 할 일이면 다른 오류로 구분해 거절한다', async () => {
      // "지워졌다"와 "애초에 없다"를 같은 오류로 뭉치면, 오타로 잘못된 번호를 보낸
      // 요청이 로그에 "지워진 할 일"로 남는다. 원인을 찾는 사람이 지워진 행을
      // 뒤지는데 그런 행이 없어서 헤맨다.
      await expect(
        histories.upsertForHistoriedOn(
          {
            todoId: 999999999n,
            userId,
            historiedOn: parseLocalDateKey('2026-08-28'),
            targetValue: null,
            targetUnit: null,
          },
          {},
        ),
      ).rejects.toThrow(TodoTemplateNotFoundError);
    });

    it('기록이 없던 날짜여도 지워진 할 일이면 거절한다', async () => {
      // 검사 대상이 "그 날짜의 지워진 기록"이 아니라 **할 일 자체의 삭제 여부**다.
      // 기록이 아예 없던 날짜에도 지워진 할 일이면 새로 만들 수 없다.
      const template = await createDailyTemplate('기록 없이 지워진 할 일');
      await templates.softDelete(template.todoId);

      await expect(
        histories.upsertForHistoriedOn(
          snapshotOf(template, parseLocalDateKey('2026-08-27')),
          { progressValue: '1' },
        ),
      ).rejects.toThrow(TodoTemplateDeletedError);
    });

    it('할 일을 지우면 그 기록도 함께 지워진다', async () => {
      // 사용자가 확정한 두 번째 삭제 경로다. 한쪽만 반영되면 "할 일은 지워졌는데
      // 기록은 살아 있는" 상태가 되므로 두 테이블을 한 트랜잭션에서 바꾼다.
      const template = await createDailyTemplate('통째로 지울 할 일');
      const first = await histories.upsertForHistoriedOn(
        snapshotOf(template, parseLocalDateKey('2026-08-21')),
        { progressValue: '10' },
      );
      const second = await histories.upsertForHistoriedOn(
        snapshotOf(template, parseLocalDateKey('2026-08-22')),
        { progressValue: '20' },
      );

      await templates.softDelete(template.todoId);

      const rows = await prisma.todoHistory.findMany({
        where: {
          todoHistoryId: { in: [first.todoHistoryId, second.todoHistoryId] },
        },
      });

      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.deletedAt !== null)).toBe(true);
    });

    it('지워진 할 일의 기록은 날짜별 조회에서 빠진다', async () => {
      // 연쇄 삭제는 **지우는 시점에 있던 기록만** 덮는다. 그래서 조회 쪽에도
      // 할 일의 삭제 여부를 조건으로 걸어 두 겹으로 막는다 — 저장 거절과
      // 조회 조건 중 하나만 있으면 좁은 시간차로 빠져나가는 경로가 남는다.
      const historiedOn = parseLocalDateKey('2026-08-24');
      const alive = await createDailyTemplate('살아 있는 할 일');
      const doomed = await createDailyTemplate('곧 지울 할 일');

      await histories.upsertForHistoriedOn(snapshotOf(alive, historiedOn), {});
      await histories.upsertForHistoriedOn(snapshotOf(doomed, historiedOn), {});
      await templates.softDelete(doomed.todoId);

      const rows = await histories.findDailyHistoriesOn(userId, historiedOn);

      expect(rows.map((row) => row.todoId)).toContain(alive.todoId);
      expect(rows.map((row) => row.todoId)).not.toContain(doomed.todoId);
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

      const rows = await histories.findDailyHistoriesOn(
        userId,
        parseLocalDateKey('2026-08-14'),
      );

      expect(rows.filter((row) => row.todoId === template.todoId)).toHaveLength(
        1,
      );
    });

    it('할 일이 지워지면 그 기록도 단건 조회에서 빠진다', async () => {
      const template = await createDailyTemplate('조회에서 빠짐');
      const historiedOn = parseLocalDateKey('2026-08-16');

      await histories.upsertForHistoriedOn(
        snapshotOf(template, historiedOn),
        {},
      );
      await templates.softDelete(template.todoId);

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
