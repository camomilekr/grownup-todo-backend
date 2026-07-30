import { Injectable } from '@nestjs/common';
import type { Prisma, TodoTemplate } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** `create`가 받는 값. `todoId`·타임스탬프는 DB가 채운다. */
export type CreateTodoTemplateInput = Omit<
  Prisma.TodoTemplateUncheckedCreateInput,
  'todoId' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

/**
 * `update`가 받는 값.
 *
 * **`todoType`·`completeType`은 생성 후 수정할 수 없다**(사용자 확정 요구). 둘을 막는
 * 이유가 다르다.
 *
 * - `todoType` — 히스토리는 생성 시 이 값을 복제하고 이후 수정하지 않는다. template의
 *   타입을 바꾸면 **그 뒤에 생기는 히스토리만 새 타입이 되어 같은 todo의 기록이 타입별로
 *   갈린다.** 지나간 통계가 어긋나고 `targetValue`·`targetUnit`의 의미도 함께 달라진다
 * - `completeType` — 이미 쌓인 히스토리의 `historiedOn` **파생 규칙이 소급해 달라진다**
 *   (ONCE는 `createdAt`, DAILY는 수행일 기준). 유니크 키의 의미가 바뀌어 어긋난다
 *
 * `userId`를 뺀 것은 소유자를 바꾸는 것이 이 계층의 일이 아니기 때문이다.
 */
export type UpdateTodoTemplateInput = Omit<
  Prisma.TodoTemplateUncheckedUpdateInput,
  | 'todoId'
  | 'userId'
  | 'todoType'
  | 'completeType'
  | 'createdAt'
  | 'updatedAt'
  | 'deletedAt'
>;

/** `findDailyActiveOn`이 돌려주는 행. 그날 히스토리가 0개 또는 1개 붙는다. */
export type DailyTemplateWithHistory = TodoTemplate & {
  histories: Prisma.TodoHistoryGetPayload<object>[];
};

/**
 * `todo_template` 접근.
 *
 * **비즈니스 판단을 하지 않는다.** 완료 여부를 계산하거나 "무엇을 보여 줄지"를 정하지
 * 않고, 쿼리 조건으로 표현되는 것만 담는다 — `findDailyActiveOn`이 히스토리를 붙여
 * 주기만 하고 완료 판정을 Service에 남기는 것이 그 경계다.
 *
 * **조회와 쓰기 모두 `deletedAt: null`을 건다.** 조회에서 보이지 않는 행이 쓰기에서는
 * 수정되는 비대칭을 두지 않는다 — soft delete된 행에 `update`/`softDelete`를 부르면
 * `P2025`가 난다.
 */
@Injectable()
export class TodoTemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateTodoTemplateInput): Promise<TodoTemplate> {
    return this.prisma.todoTemplate.create({ data });
  }

  async findById(todoId: bigint): Promise<TodoTemplate | null> {
    // `findUnique`가 아니라 `findFirst`다. 유니크 키에 `deletedAt`이 없어서
    // `findUnique`로는 soft delete된 행을 걸러낼 수 없다.
    return this.prisma.todoTemplate.findFirst({
      where: { todoId, deletedAt: null },
    });
  }

  /**
   * **soft delete된 행은 수정하지 않는다.** `where`에 `deletedAt: null`을 함께 걸어
   * 0건이면 Prisma가 `P2025`를 던진다 — 조회에서 보이지 않는 행이 쓰기에서는 조용히
   * 수정되는 비대칭을 없앤다. 호출자는 그 예외로 "없거나 이미 삭제됐다"를 알 수 있다.
   */
  async update(
    todoId: bigint,
    data: UpdateTodoTemplateInput,
  ): Promise<TodoTemplate> {
    return this.prisma.todoTemplate.update({
      where: { todoId, deletedAt: null },
      data,
    });
  }

  /**
   * **두 번째 호출은 `P2025`로 거절된다.** `deletedAt: null` 조건이 없으면 이미 삭제된
   * 행의 `deletedAt`을 새 시각으로 덮어써서, 복구·감사에 쓰이는 최초 삭제 시각이 조용히
   * 사라진다.
   */
  async softDelete(todoId: bigint): Promise<TodoTemplate> {
    return this.prisma.todoTemplate.update({
      where: { todoId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * ONCE todo 중 **완료 히스토리가 없는 것**을 전부 돌려준다.
   *
   * 확정된 요구사항: ONCE는 완료할 때까지 계속 "달성해야 할 항목"으로 나오고 예정일이
   * 지나도 사라지지 않는다. 그래서 **날짜로 필터하지 않는다** — `shouldDoAt`도
   * `historiedOn`도 조건에 넣지 않는다.
   *
   * 진입점이 template인 것이 핵심이다. 히스토리는 완료·수정 시에만 생기므로 히스토리를
   * 기준으로 조회하면 미완료 항목이 **전부** 빠진다.
   *
   * **`suspendedAt`을 보지 않는다.** 일시 중지는 DAILY의 반복을 멈추는 개념이고 ONCE에는
   * 무의미하다 — ONCE에 그 값이 들어가도 이 목록에서 빠지지 않는다. ONCE에 중지 개념을
   * 두는 것은 확정된 요구사항에 없다.
   */
  async findOnceWithoutCompletedHistory(
    userId: bigint,
  ): Promise<TodoTemplate[]> {
    return this.prisma.todoTemplate.findMany({
      where: {
        userId,
        deletedAt: null,
        completeType: 'ONCE',
        // 완료의 정의는 `completedAt IS NOT NULL`이다(스키마 규약). soft delete된
        // 히스토리는 완료로 세지 않는다 — 완료를 취소하면 다시 목록에 나와야 한다.
        histories: {
          none: { deletedAt: null, completedAt: { not: null } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * 주어진 날짜에 **활성인** DAILY todo를 돌려주고, 그날의 히스토리를 붙인다.
   *
   * 확정된 요구사항: 어제 완료하지 않아 히스토리가 없으면 어제는 그대로 미완료로 남고,
   * 오늘은 다시 달성해야 할 항목으로 나온다. **어제 것이 오늘로 밀려오지 않는다** —
   * 그래서 조건이 "그날 활성인가"이고 히스토리 유무는 조건이 아니다.
   *
   * `histories`는 그날 것만 0개 또는 1개 붙는다(`@@unique([todoId, historiedOn])`).
   * **완료 여부 판정은 Service가 한다** — 이 계층은 `completedAt`을 보지 않는다.
   *
   * @param historiedOn 유저 타임존 기준 날짜. 계산은 `toLocalDateKey`가 한다
   */
  async findDailyActiveOn(
    userId: bigint,
    historiedOn: Date,
  ): Promise<DailyTemplateWithHistory[]> {
    return this.prisma.todoTemplate.findMany({
      where: {
        userId,
        deletedAt: null,
        completeType: 'DAILY',
        // 중단된 것은 기간이 남아 있어도 빠진다.
        suspendedAt: null,
        // `null`은 "제한 없음"이다. `activeFrom`이 없으면 언제부터든,
        // `activeUntil`이 없으면 무기한이다.
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lte: historiedOn } }] },
          {
            OR: [{ activeUntil: null }, { activeUntil: { gte: historiedOn } }],
          },
        ],
      },
      include: {
        histories: { where: { historiedOn, deletedAt: null } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }
}
