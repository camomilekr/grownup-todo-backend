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
import { TodosService } from './../src/todos/todos.service';
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
  // 소유자 경계를 검증할 두 번째 유저. 이 유저의 할 일이 `userId`의 조회·수정에
  // 잡히면 안 된다.
  let otherUserId: bigint;

  // 유저 타임존은 KST로 고정한다. 날짜 경계가 UTC와 겹치지 않아 어긋남이 드러난다.
  const timeZone = 'Asia/Seoul';

  function uniqueEmail(prefix: string): string {
    // 병렬 실행·재실행에서 유니크 충돌이 나지 않게 매번 다른 값을 쓴다.
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    templates = app.get(TodoTemplatesRepository);
    histories = app.get(TodoHistoriesRepository);

    const [user, otherUser] = await Promise.all([
      prisma.appUser.create({
        data: { email: uniqueEmail('todos-e2e'), timeZone },
      }),
      prisma.appUser.create({
        data: { email: uniqueEmail('todos-e2e-other'), timeZone },
      }),
    ]);
    userId = user.userId;
    otherUserId = otherUser.userId;
  });

  afterAll(async () => {
    // cascade로 template·history가 함께 지워진다.
    await prisma.appUser.deleteMany({
      where: { userId: { in: [userId, otherUserId] } },
    });
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

      const found = await templates.findById(userId, created.todoId);

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

      const found = await templates.findById(userId, created.todoId);

      // Prisma.Decimal은 문자열로 비교한다. Number로 바꾸면 정밀도가 깨진다.
      expect(found?.targetValue?.toString()).toBe('30.5');
    });

    it('활성 기간이 시각을 보존해 왕복한다', async () => {
      // `active_from`/`active_until`은 순간 컬럼(`timestamptz`)이다. 이전의 날짜
      // 컬럼(`@db.Date`)이었다면 어댑터가 UTC 날짜 컴포넌트만 직렬화해 시각이
      // **예외 없이** 자정으로 잘렸다 — 그 회귀를 이 왕복이 잡는다. 시간 해석은
      // 클라이언트의 몫이므로 서버는 받은 순간을 그대로 저장하고 그대로 돌려준다.
      const created = await templates.create({
        userId,
        title: '아침 산책',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-08-01T10:30:00.000Z'),
        activeUntil: new Date('2026-08-31T22:15:45.500Z'),
      });

      const found = await templates.findById(userId, created.todoId);

      expect(found?.activeFrom?.toISOString()).toBe('2026-08-01T10:30:00.000Z');
      expect(found?.activeUntil?.toISOString()).toBe(
        '2026-08-31T22:15:45.500Z',
      );
    });

    it('soft delete하면 findById가 null이다', async () => {
      const created = await templates.create({
        userId,
        title: '지울 todo',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });

      await templates.softDelete(userId, created.todoId);

      expect(await templates.findById(userId, created.todoId)).toBeNull();
    });

    it('금지된 필드를 넣으면 컴파일 단계에서 막힌다', () => {
      // 이 테스트는 실행 결과가 아니라 **컴파일 성공 여부**를 검사한다. 방식이
      // 낯설 수 있어 원리를 적어 둔다.
      //
      // `@ts-expect-error`는 "바로 다음 줄에 타입 오류가 있을 것"이라고 선언하는
      // 주석이다. 오류가 **없으면** TypeScript가 거꾸로 "쓸데없는 지시자다"라며
      // `Unused '@ts-expect-error' directive` 오류를 낸다. 즉 아래 여섯 줄은 각각
      // "이 코드는 타입 오류여야 한다"는 뜻이고, 누군가 금지를 풀면 그 순간
      // `npm run verify`가 깨진다.
      //
      // 함수를 선언만 하고 부르지 않는 이유는 실행하면 실제 DB를 건드리기
      // 때문이다. 컴파일만 되면 목적이 달성된다.
      const typeGuard = async () => {
        // 아래 둘: 할 일의 종류(todoType)와 반복 방식(completeType)은 만든 뒤
        // 바꿀 수 없다. 이유는 각 Repository 타입 정의의 주석에 있다.

        // @ts-expect-error todoType은 생성 후 수정할 수 없다
        await templates.update(userId, 1n, { todoType: 'NUMERIC' });
        // @ts-expect-error completeType은 생성 후 수정할 수 없다
        await templates.update(userId, 1n, { completeType: 'ONCE' });

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

        // 아래 둘은 완료 기록으로 이어지는 **중첩 관계 경로**다. 정의를 다루는
        // 두 메서드의 입력에 이 필드가 남아 있으면 기록의 저장 통로
        // (`upsertForHistoriedOn`)와 개별 삭제 금지가 통째로 우회된다 — 갱신
        // 쪽 중첩 입력에는 행을 실제로 지우는 `deleteMany`가 들어 있어서,
        // 지울 수 없어야 하는 기록이 삭제 표시도 남기지 않고 사라진다.
        await templates.create({
          userId,
          title: '기록을 함께 만드는 todo',
          todoType: 'GENERAL',
          completeType: 'DAILY',
          // @ts-expect-error 완료 기록은 정의를 만드는 경로로 함께 만들 수 없다
          histories: { create: [] },
        });
        // @ts-expect-error 완료 기록은 정의를 고치는 경로로 지울 수 없다
        await templates.update(userId, 1n, { histories: { deleteMany: {} } });
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
      const deleted = await templates.softDelete(userId, created.todoId);

      await expect(
        templates.update(userId, created.todoId, { title: '되면 안 된다' }),
      ).rejects.toThrow();
      await expect(
        templates.softDelete(userId, created.todoId),
      ).rejects.toThrow();

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

      const updated = await templates.update(userId, created.todoId, {
        title: '바꾼 뒤',
      });

      expect(updated.title).toBe('바꾼 뒤');
      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(
        created.updatedAt.getTime(),
      );
    });
  });

  describe('소유자 경계 — 남의 할 일에는 닿지 못한다', () => {
    // 소유자 검사를 위 계층의 "조회한 뒤 비교"에 맡기지 않고 **쿼리 조건**으로 내렸다.
    // 비교를 빠뜨린 경로가 하나 생기면 그곳으로 남의 데이터가 전부 새는데, 조건이
    // 인자로 들어가 있으면 빠뜨리는 것 자체가 컴파일되지 않는다.
    async function createOthersTemplate(title: string) {
      return templates.create({
        userId: otherUserId,
        title,
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });
    }

    it('남의 할 일은 findById에서 null이다', async () => {
      // "없다"와 같게 다룬다. 권한 없음으로 구분해 알려 주면 번호를 훑어서 남이
      // 어떤 할 일을 가졌는지 세어 볼 수 있다.
      const others = await createOthersTemplate('남의 할 일');

      expect(await templates.findById(userId, others.todoId)).toBeNull();
      // 주인 본인에게는 보인다 — 조건이 과하게 걸려 아무도 못 읽는 것이 아니다.
      expect(
        (await templates.findById(otherUserId, others.todoId))?.todoId,
      ).toBe(others.todoId);
    });

    it('남의 할 일은 수정할 수 없다', async () => {
      const others = await createOthersTemplate('남의 할 일 수정');

      await expect(
        templates.update(userId, others.todoId, { title: '가로챈 제목' }),
      ).rejects.toThrow();

      // 제목이 그대로 남아 있다. 거절만 확인하면 "던지면서 이미 고쳐진" 경우를
      // 놓친다.
      const row = await prisma.todoTemplate.findUnique({
        where: { todoId: others.todoId },
      });
      expect(row?.title).toBe('남의 할 일 수정');
    });

    it('남의 할 일은 삭제할 수 없다', async () => {
      const others = await createOthersTemplate('남의 할 일 삭제');

      await expect(
        templates.softDelete(userId, others.todoId),
      ).rejects.toThrow();

      const row = await prisma.todoTemplate.findUnique({
        where: { todoId: others.todoId },
      });
      expect(row?.deletedAt).toBeNull();
    });

    it('남의 할 일을 삭제 시도해도 그 기록이 지워지지 않는다', async () => {
      // 삭제는 두 테이블을 한 트랜잭션에서 바꾼다. 이 테스트가 고정하는 것은 **결과**다 —
      // 거절된 삭제 시도가 남의 기록에 흔적을 남기지 않는다.
      //
      // **`softDelete`의 기록 쪽 소유자 조건은 이 테스트가 고정하지 못한다.** 그 조건을
      // 빼고 돌려 확인했고 그대로 통과했다. 트랜잭션의 첫 연산인 정의 쪽 수정이
      // `P2025`(고칠 행을 찾지 못했다)로 실패해 통째로 되돌아가므로, 기록 쪽 조건이
      // 있든 없든 기록에 손이 닿지 않기 때문이다.
      //
      // 그 조건만 검증하는 테스트를 만들지 않았다. 실패하게 만들려면 트랜잭션을 벗기고
      // 기록 쪽을 먼저 실행하도록 **구현 내부 구조를 조작해야** 하고, 그것은 동작이
      // 아니라 구현 방식을 검사하는 것이다(`.claude/rules/testing.md`). 그 조건을 남겨
      // 두는 이유는 `todo-templates.repository.ts`의 `softDelete` 주석에 있다.
      const others = await templates.create({
        userId: otherUserId,
        title: '남의 기록이 붙은 할 일',
        todoType: 'GENERAL',
        completeType: 'DAILY',
      });
      const history = await histories.upsertForHistoriedOn(
        {
          todoId: others.todoId,
          userId: otherUserId,
          historiedOn: parseLocalDateKey('2026-09-01'),
          targetValue: null,
          targetUnit: null,
        },
        { progressValue: '10' },
      );

      await expect(
        templates.softDelete(userId, others.todoId),
      ).rejects.toThrow();

      const row = await prisma.todoHistory.findUnique({
        where: { todoHistoryId: history.todoHistoryId },
      });
      expect(row?.deletedAt).toBeNull();
    });

    it('남의 할 일에 기록을 남기려 하면 없는 할 일로 거절한다', async () => {
      // **어떤 오류가 나는지가 이 테스트의 핵심이다.** 소유자 조건이 없어도 저장은
      // 막힌다 — 복합 외래키가 `P2003`(참조 대상이 없다)으로 거절한다. 그러나 그
      // 오류는 원인을 알기 어렵고, 로그를 보는 사람이 제약 이름부터 되짚어야 한다.
      // 확인 조회에서 소유자를 함께 보면 그 자리에서 "그런 할 일이 없다"로 끝난다.
      //
      // 그래서 `rejects.toThrow()`만 단정하면 고치기 전에도 통과한다.
      const others = await createOthersTemplate('남의 할 일에 기록');

      await expect(
        histories.upsertForHistoriedOn(
          {
            todoId: others.todoId,
            userId,
            historiedOn: parseLocalDateKey('2026-09-02'),
            targetValue: null,
            targetUnit: null,
          },
          { progressValue: '1' },
        ),
      ).rejects.toThrow(TodoTemplateNotFoundError);
    });

    it('남의 기록은 단건 조회에서 null이다', async () => {
      const others = await templates.create({
        userId: otherUserId,
        title: '남의 기록 단건 조회',
        todoType: 'GENERAL',
        completeType: 'DAILY',
      });
      const historiedOn = parseLocalDateKey('2026-09-03');
      await histories.upsertForHistoriedOn(
        {
          todoId: others.todoId,
          userId: otherUserId,
          historiedOn,
          targetValue: null,
          targetUnit: null,
        },
        { completedAt: new Date('2026-09-03T05:00:00.000Z') },
      );

      expect(
        await histories.findByTodoIdAndHistoriedOn(
          userId,
          others.todoId,
          historiedOn,
        ),
      ).toBeNull();
      // 주인에게는 보인다.
      expect(
        (
          await histories.findByTodoIdAndHistoriedOn(
            otherUserId,
            others.todoId,
            historiedOn,
          )
        )?.completedAt,
      ).not.toBeNull();
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

    it('진행값만 입력한 할 일은 그 기록을 함께 달고 나온다', async () => {
      // 목록이 진행률을 그려야 하므로 정의만으로는 부족하다. 기록을 따로 조회하면
      // 목록 길이만큼 쿼리가 늘고(N+1), 어느 기록이 어느 할 일 것인지 맞추는 코드가
      // 부르는 쪽에 생긴다.
      const template = await templates.create({
        userId,
        title: '기록이 붙어 올 ONCE',
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
        { progressValue: '30' },
      );

      const rows = await templates.findOnceWithoutCompletedHistory(userId);
      const row = rows.find((item) => item.todoId === template.todoId);

      expect(row?.histories).toHaveLength(1);
      expect(row?.histories[0]?.progressValue?.toString()).toBe('30');
    });

    it('손대지 않은 할 일은 빈 기록 배열을 달고 나온다', async () => {
      // 배열이 비어 있는 것이 "아직 손대지 않았다"는 뜻이다. `undefined`가 아니라
      // 빈 배열이어야 한다 — 부르는 쪽이 첫 항목을 꺼내 상태로 바꾸기 때문이다.
      const template = await templates.create({
        userId,
        title: '손대지 않은 ONCE',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });

      const rows = await templates.findOnceWithoutCompletedHistory(userId);
      const row = rows.find((item) => item.todoId === template.todoId);

      expect(row?.histories).toEqual([]);
    });
  });

  describe('DAILY 목록 — 어제 것이 오늘로 밀려오지 않는다', () => {
    // 활성 판정은 **요청 순간**과 활성 기간을 그대로 비교한다(사용자 확정 — 서버가
    // 시간 처리를 하지 않는다). 붙여 줄 기록은 여전히 유저 타임존 기준 날짜로 찾는다.
    const yesterday = parseLocalDateKey('2026-08-01');
    const today = parseLocalDateKey('2026-08-02');
    /** 판정 기준 순간. 요청이 도착한 시각을 흉내 낸다 — `today`에 해당하는 낮이다 */
    const at = new Date('2026-08-02T05:00:00.000Z');

    it('요청 순간이 활성 기간 안이면 그날 히스토리가 없어도 목록에 나온다', async () => {
      const template = await templates.create({
        userId,
        title: '활성 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-07-01T00:00:00.000Z'),
        activeUntil: new Date('2026-12-31T23:59:59.999Z'),
      });

      const rows = await templates.findDailyActiveAt(userId, at, today);

      const row = rows.find((item) => item.todoId === template.todoId);
      expect(row).toBeDefined();
      // 히스토리가 없다 = 그날 아무것도 하지 않았다. 판정은 Service가 한다.
      expect(row?.histories).toEqual([]);
    });

    it('요청 순간이 activeFrom 직전이면 빠지고 그 순간부터 나온다', async () => {
      // 반열림 구간에서 포함되는 쪽 경계다. `lte`를 `lt`로 바꾸는 수정이 통과하지
      // 않게 경계를 순간 단위로 고정한다 — 컬럼이 `timestamptz(3)`라 1밀리초가
      // 판별 가능한 최소 간격이다.
      const activeFrom = new Date('2026-08-02T10:30:00.000Z');
      const template = await templates.create({
        userId,
        title: '시작 순간 경계',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom,
      });

      const atStart = await templates.findDailyActiveAt(
        userId,
        activeFrom,
        today,
      );
      const justBefore = await templates.findDailyActiveAt(
        userId,
        new Date(activeFrom.getTime() - 1),
        today,
      );

      expect(atStart.map((item) => item.todoId)).toContain(template.todoId);
      // 시작 직전 순간에는 빠진다.
      expect(justBefore.map((item) => item.todoId)).not.toContain(
        template.todoId,
      );
    });

    it('activeUntil과 같은 순간에는 빠지고 직전 순간에는 나온다 (반열림)', async () => {
      // 활성 판정은 반열림 구간이다 — `activeFrom <= 순간 < activeUntil`(사용자
      // 최종 확정). 상한 순간 자체는 포함되지 않는다. `gt`를 `gte`로 되돌리는
      // 수정이 통과하지 않게 경계 양쪽을 함께 고정한다 — 컬럼이 `timestamptz(3)`라
      // 1밀리초가 판별 가능한 최소 간격이다.
      const activeUntil = new Date('2026-08-02T18:45:00.000Z');
      const template = await templates.create({
        userId,
        title: '반열림 상한 경계',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-08-01T00:00:00.000Z'),
        activeUntil,
      });

      const atBoundary = await templates.findDailyActiveAt(
        userId,
        activeUntil,
        today,
      );
      const justBefore = await templates.findDailyActiveAt(
        userId,
        new Date(activeUntil.getTime() - 1),
        today,
      );

      expect(atBoundary.map((item) => item.todoId)).not.toContain(
        template.todoId,
      );
      expect(justBefore.map((item) => item.todoId)).toContain(template.todoId);
    });

    it('activeFrom이 null이면 시작 제한 없이 나온다', async () => {
      // `null`은 "제한 없음"이다. `activeUntil: null`과 짝을 이루는 분기이고
      // 어느 테스트도 지나지 않던 자리다.
      const template = await templates.create({
        userId,
        title: '시작 제한 없는 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeUntil: new Date('2026-12-31T23:59:59.999Z'),
      });

      const rows = await templates.findDailyActiveAt(userId, at, today);

      expect(rows.map((item) => item.todoId)).toContain(template.todoId);
    });

    it('활성 기간이 지나면 목록에서 빠진다', async () => {
      const template = await templates.create({
        userId,
        title: '기간 끝난 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-07-01T00:00:00.000Z'),
        activeUntil: new Date('2026-07-31T23:59:59.999Z'),
      });

      const rows = await templates.findDailyActiveAt(userId, at, today);

      expect(rows.map((item) => item.todoId)).not.toContain(template.todoId);
    });

    it('activeUntil이 null이면 무기한으로 나온다', async () => {
      const template = await templates.create({
        userId,
        title: '무기한 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-07-01T00:00:00.000Z'),
      });

      const rows = await templates.findDailyActiveAt(userId, at, today);

      expect(rows.map((item) => item.todoId)).toContain(template.todoId);
    });

    it('어제 완료해도 오늘은 히스토리 없이 다시 나온다', async () => {
      // 확정된 요구사항의 핵심이다 — 어제 것이 오늘로 밀려오지 않고, 어제는
      // 어제 상태로 남는다. 판정 순간은 같은 활성 기간 안에 있으므로 두 조회의
      // 차이는 **어느 날짜의 기록을 붙이는가**뿐이다.
      const template = await templates.create({
        userId,
        title: '어제 완료한 DAILY',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-07-01T00:00:00.000Z'),
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

      const yesterdayRows = await templates.findDailyActiveAt(
        userId,
        new Date('2026-08-01T10:00:00.000Z'),
        yesterday,
      );
      const todayRows = await templates.findDailyActiveAt(userId, at, today);

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
        userId,
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
      await templates.softDelete(userId, template.todoId);

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
      await templates.softDelete(userId, template.todoId);

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

      await templates.softDelete(userId, template.todoId);

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
      await templates.softDelete(userId, doomed.todoId);

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
        userId,
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
      await templates.softDelete(userId, template.todoId);

      expect(
        await histories.findByTodoIdAndHistoriedOn(
          userId,
          template.todoId,
          historiedOn,
        ),
      ).toBeNull();
    });
  });

  describe('기간 범위 기록 조회 — 상세 화면의 이력', () => {
    // 매일 반복 할 일의 상세는 날짜별 이력을 보여 준다. 범위를 인자로 받는 이유는
    // 전체를 돌려주면 오래 쓴 할 일에서 결과가 무한히 커지기 때문이다.
    async function createRangeTemplate(owner: bigint, title: string) {
      return templates.create({
        userId: owner,
        title,
        todoType: 'NUMERIC',
        completeType: 'DAILY',
        targetValue: '100',
        targetUnit: '회',
      });
    }

    async function record(
      template: { todoId: bigint; userId: bigint },
      dateKey: string,
      progressValue: string,
    ) {
      return histories.upsertForHistoriedOn(
        {
          todoId: template.todoId,
          userId: template.userId,
          historiedOn: parseLocalDateKey(dateKey),
          targetValue: '100',
          targetUnit: '회',
        },
        { progressValue },
      );
    }

    it('양 끝 날짜를 포함하고 범위 밖은 빼낸다', async () => {
      // `gte`/`lte`를 `gt`/`lt`로 바꾸는 수정이 통과하지 않게 경계를 고정한다.
      // 사용자가 고른 날짜는 양쪽을 포함한다. (활성 기간은 순간 컬럼이 되면서
      // 반열림으로 갔지만, 이쪽은 날짜 알갱이 그대로라 그 이유가 적용되지 않는다 —
      // 날짜에는 "그날의 끝"이 필요 없다.)
      const template = await createRangeTemplate(userId, '범위 경계');
      await record(template, '2026-10-04', '10');
      await record(template, '2026-10-05', '20');
      await record(template, '2026-10-07', '30');
      await record(template, '2026-10-10', '40');
      await record(template, '2026-10-11', '50');

      const rows = await histories.findByTodoIdBetween(
        userId,
        template.todoId,
        parseLocalDateKey('2026-10-05'),
        parseLocalDateKey('2026-10-10'),
      );

      expect(
        rows.map((row) => row.historiedOn.toISOString().slice(0, 10)),
      ).toEqual(['2026-10-05', '2026-10-07', '2026-10-10']);
    });

    it('날짜 오름차순으로 돌려준다', async () => {
      // 화면이 시간 순서로 그린다. 넣은 순서를 뒤섞어 두고 정렬이 실제로 걸리는지
      // 본다 — 저장 순서대로 나오면 이 단정이 깨진다.
      const template = await createRangeTemplate(userId, '정렬 확인');
      await record(template, '2026-11-03', '30');
      await record(template, '2026-11-01', '10');
      await record(template, '2026-11-02', '20');

      const rows = await histories.findByTodoIdBetween(
        userId,
        template.todoId,
        parseLocalDateKey('2026-11-01'),
        parseLocalDateKey('2026-11-03'),
      );

      expect(rows.map((row) => row.progressValue?.toString())).toEqual([
        '10',
        '20',
        '30',
      ]);
    });

    it('남의 할 일 기록은 빼낸다', async () => {
      const others = await createRangeTemplate(otherUserId, '남의 이력');
      await record(others, '2026-12-01', '10');

      const rows = await histories.findByTodoIdBetween(
        userId,
        others.todoId,
        parseLocalDateKey('2026-12-01'),
        parseLocalDateKey('2026-12-31'),
      );

      expect(rows).toEqual([]);
      // 주인에게는 보인다 — 조건이 과하게 걸려 아무도 못 읽는 것이 아니다.
      expect(
        await histories.findByTodoIdBetween(
          otherUserId,
          others.todoId,
          parseLocalDateKey('2026-12-01'),
          parseLocalDateKey('2026-12-31'),
        ),
      ).toHaveLength(1);
    });

    it('지워진 할 일의 기록은 빼낸다', async () => {
      const template = await createRangeTemplate(userId, '지울 이력');
      await record(template, '2027-01-05', '10');
      await templates.softDelete(userId, template.todoId);

      expect(
        await histories.findByTodoIdBetween(
          userId,
          template.todoId,
          parseLocalDateKey('2027-01-01'),
          parseLocalDateKey('2027-01-31'),
        ),
      ).toEqual([]);
    });

    it('범위 안에 기록이 없으면 빈 배열이다', async () => {
      const template = await createRangeTemplate(userId, '기록 없는 범위');
      await record(template, '2027-02-01', '10');

      expect(
        await histories.findByTodoIdBetween(
          userId,
          template.todoId,
          parseLocalDateKey('2027-03-01'),
          parseLocalDateKey('2027-03-31'),
        ),
      ).toEqual([]);
    });
  });

  describe('상세 조회의 이력 범위 — 순간을 유저 타임존 날짜로 자른다', () => {
    it('자정 아닌 범위 순간이 유저 타임존에서 속한 날짜의 기록을 포함한다', async () => {
      // 이력 범위는 순간으로 받고, Service가 유저 타임존(여기서는 서울)을 읽어
      // 그 순간이 속한 날짜로 자른 뒤 날짜 키 비교(양 끝 포함)에 넘긴다.
      // `2026-08-01T20:00:00Z`는 서울에서 8월 2일 05:00이므로 8월 2일 기록까지
      // 포함되어야 한다 — 순간을 UTC 날짜로 자르면(8월 1일) 이 기록이 빠진다.
      const service = app.get(TodosService);
      const template = await templates.create({
        userId,
        title: '이력 범위 순간화',
        todoType: 'NUMERIC',
        completeType: 'DAILY',
        targetValue: '100',
        targetUnit: '회',
      });
      await histories.upsertForHistoriedOn(
        {
          todoId: template.todoId,
          userId: template.userId,
          historiedOn: parseLocalDateKey('2026-08-02'),
          targetValue: '100',
          targetUnit: '회',
        },
        { progressValue: '10' },
      );

      const detail = await service.getTodo(userId, template.todoId, {
        // 서울 기준 8월 1일 05:00 — 유저 타임존 날짜로 8월 1일이다.
        from: new Date('2026-07-31T20:00:00.000Z'),
        // 서울 기준 8월 2일 05:00 — 유저 타임존 날짜로 8월 2일이다.
        until: new Date('2026-08-01T20:00:00.000Z'),
      });

      expect(detail.completeType).toBe('DAILY');
      const items = detail.completeType === 'DAILY' ? detail.histories : [];
      expect(items.map((item) => item.historiedOn)).toContain('2026-08-02');
    });
  });

  describe('병합 목록 — 마감 순간 오름차순 (listTodosOn)', () => {
    // 이 파일의 다른 테스트들이 공유 유저(`userId`)에 할 일을 계속 만들어 두므로,
    // **목록 전체의 순서**를 단정하려면 전용 유저가 필요하다.
    let mergedUserId: bigint;

    beforeAll(async () => {
      const user = await prisma.appUser.create({
        data: { email: uniqueEmail('todos-e2e-merged'), timeZone },
      });
      mergedUserId = user.userId;
    });

    afterAll(async () => {
      // cascade로 template·history가 함께 지워진다.
      await prisma.appUser.deleteMany({ where: { userId: mergedUserId } });
    });

    it('연체 일회성 < 매일 반복 < 미래 일회성 < 예정일 없는 일회성(만든 순)으로 나온다', async () => {
      // 사용자 요구 문장("완료일이 가까운 순") 그대로의 관찰이다. 기준 순간은
      // 서울 8월 2일 14:00 — 매일 반복의 마감은 유저 타임존(서울)에서 다음 달력
      // 날짜(8월 3일)가 시작되는 최초의 순간 = 2026-08-02T15:00:00Z다.
      const service = app.get(TodosService);
      const at = new Date('2026-08-02T05:00:00.000Z');

      // **마감 순서와 다르게 만든다** — 만든 순이 그대로 나오면 통과하지 않게
      // 하려는 것이다. 예정일 없는 둘만 "만든 순" 단정을 위해 순서대로 만든다.
      const futureOnce = await templates.create({
        userId: mergedUserId,
        title: '미래 예정일 일회성',
        todoType: 'GENERAL',
        completeType: 'ONCE',
        // 매일 반복의 마감(2026-08-02T15:00:00Z)보다 뒤다.
        shouldDoAt: new Date('2026-09-01T09:00:00.000Z'),
      });
      const noDueFirst = await templates.create({
        userId: mergedUserId,
        title: '예정일 없는 일회성 (먼저 만든 것)',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });
      const daily = await templates.create({
        userId: mergedUserId,
        title: '활성 매일 반복',
        todoType: 'GENERAL',
        completeType: 'DAILY',
        activeFrom: new Date('2026-07-01T00:00:00.000Z'),
      });
      const overdueOnce = await templates.create({
        userId: mergedUserId,
        title: '연체된 일회성',
        todoType: 'GENERAL',
        completeType: 'ONCE',
        // 기준 순간보다 한참 앞이다 — 지났어도 완료 전에는 목록에 남는다.
        shouldDoAt: new Date('2026-07-20T09:00:00.000Z'),
      });
      const noDueSecond = await templates.create({
        userId: mergedUserId,
        title: '예정일 없는 일회성 (나중에 만든 것)',
        todoType: 'GENERAL',
        completeType: 'ONCE',
      });

      const items = await service.listTodosOn(mergedUserId, at);

      expect(items.map((item) => item.todoId)).toEqual([
        overdueOnce.todoId,
        daily.todoId,
        futureOnce.todoId,
        noDueFirst.todoId,
        noDueSecond.todoId,
      ]);
    });
  });

  describe('복합 외래키 — 소유자 위조를 DB가 막는다', () => {
    it('남의 todoId에 자기 userId를 붙인 기록은 삽입 자체가 거절된다', async () => {
      // 라운드 1에서 `db execute`로 실측한 것을 테스트로 고정한다. 이 제약이
      // 사라지면 남의 할 일 스냅샷이 내 목록에 섞이고 원래 소유자의 조회에서는
      // 그 날짜 기록이 사라진다.
      //
      // **Repository를 거치지 않고 `prisma`로 직접 삽입한다.** 이제 저장 경로가 확인
      // 조회에서 소유자를 함께 보므로, Repository를 통하면 `TodoTemplateNotFoundError`로
      // 먼저 막혀 **DB 제약까지 도달하지 않는다.** 그 상태로 두면 이 테스트가 통과하면서
      // 정작 검증 대상인 제약은 아무것도 지키지 못한다 — 두 겹 중 바깥쪽만 확인하는
      // 셈이다. 안쪽 겹(DB 제약)은 여기서, 바깥쪽 겹(Repository 거절)은 위
      // "소유자 경계" 절에서 각각 고정한다.
      const victimTemplate = await templates.create({
        userId: otherUserId,
        title: '피해자의 할 일',
        todoType: 'GENERAL',
        completeType: 'DAILY',
      });

      await expect(
        prisma.todoHistory.create({
          data: {
            todoId: victimTemplate.todoId,
            // 소유자가 어긋난다. 할 일은 `otherUserId`의 것이다.
            userId,
            historiedOn: parseLocalDateKey('2026-08-20'),
          },
        }),
        // 제약 이름까지 확인한다. 다른 이유로 실패해도 통과하는 것을 막는다.
      ).rejects.toThrow('todo_history_todo_id_user_id_fkey');
    });
  });
});
