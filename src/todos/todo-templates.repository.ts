import { Injectable } from '@nestjs/common';
import type { Prisma, TodoTemplate } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** 할 일을 새로 만들 때 받는 값. 번호와 시각 컬럼은 DB가 채운다. */
export type CreateTodoTemplateInput = Omit<
  Prisma.TodoTemplateUncheckedCreateInput,
  'todoId' | 'createdAt' | 'updatedAt' | 'deletedAt'
>;

/**
 * 할 일을 고칠 때 받는 값.
 *
 * **할 일의 종류(`todoType`)와 반복 방식(`completeType`)은 뺐다** — 만든 뒤에는 바꿀 수
 * 없다는 것이 사용자가 확정한 요구다. **두 값 모두 완료 기록에 저장되지 않아서, 이미
 * 쌓인 기록을 해석하는 근거가 이 정의 하나뿐이라는 것이 공통된 이유다.** 무엇이 어긋나는지가
 * 다르다.
 *
 * `todoType`을 바꾸면 **완료 기록에는 종류가 저장되지 않아서** 지나간 기록을 해석하는
 * 근거가 이 컬럼 하나뿐이다. 값을 바꾸면 이미 쌓인 기록이 전부 새 종류로 다시 해석된다 —
 * 숫자형에서 일반으로 바꾸면 목표치를 가진 과거 기록이 "체크만 하는 할 일"의 기록으로
 * 표시된다. (목표치와 단위 자체는 기록에 복사돼 있어 흔들리지 않는다. 흔들리는 것은 그
 * 값을 무엇으로 읽을지다.)
 *
 * `completeType`을 바꾸면 완료 기록의 날짜를 만드는 규칙이 달라진다. 일회성과 매일
 * 반복이 서로 다른 규칙을 쓰기 때문이다. 게다가 **완료 기록에는 반복 방식이 저장되지
 * 않아서**, 이미 쌓인 날짜들을 해석할 근거가 이 컬럼 하나뿐이다.
 *
 * `userId`도 뺐다. 소유자를 옮기는 것은 이 계층이 할 일이 아니다.
 *
 * 막는 것은 DB 제약이 아니라 TypeScript 타입이다. 그래서 이 `Omit`이 사라지면 컴파일만
 * 실패하고 DB는 조용히 허용한다 — `test/todos.e2e-spec.ts`가 그 컴파일 오류의 존재를
 * 붙잡아 둔다.
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

/** `findDailyActiveOn`이 돌려주는 행. 그날 완료 기록이 0개 또는 1개 붙는다. */
export type DailyTemplateWithHistory = TodoTemplate & {
  histories: Prisma.TodoHistoryGetPayload<object>[];
};

/**
 * `todo_template` 테이블 접근.
 *
 * **판단하지 않고 조회 조건만 담는다.** "완료했는가"를 계산하거나 "무엇을 보여 줄지"를
 * 정하는 것은 위 계층(Service)의 몫이다 — `findDailyActiveOn`이 그날 기록을 붙여 주기만
 * 하고 완료 여부를 따지지 않는 것이 그 경계를 보여 준다.
 *
 * **조회와 수정 모두 삭제되지 않은 행만 대상으로 한다.** 조회에서는 보이지 않는데 수정은
 * 되는 상태를 만들지 않기 위해서다. 삭제된 할 일을 고치거나 다시 삭제하려 하면 Prisma가
 * "고칠 행을 찾지 못했다"는 오류를 낸다.
 */
@Injectable()
export class TodoTemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateTodoTemplateInput): Promise<TodoTemplate> {
    return this.prisma.todoTemplate.create({ data });
  }

  async findById(todoId: bigint): Promise<TodoTemplate | null> {
    // 단건 조회(`findUnique`)가 아니라 `findFirst`를 쓴다. 유일 제약에 `deletedAt`이
    // 들어 있지 않아서, 단건 조회로는 "삭제되지 않은 것만"이라는 조건을 걸 수 없다.
    return this.prisma.todoTemplate.findFirst({
      where: { todoId, deletedAt: null },
    });
  }

  /** 삭제된 할 일은 고칠 수 없다. 대상이 없으면 Prisma가 오류를 낸다. */
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
   * 할 일을 삭제한다. 행을 지우지 않고 `deletedAt`에 시각을 적는다.
   *
   * **그 할 일의 완료 기록도 함께 지운다.** 할 일이 사라졌는데 기록만 남아 있으면
   * 날짜별 조회에 주인 없는 기록이 계속 나온다. 두 테이블을 **한 트랜잭션에서** 바꾸는
   * 이유는 한쪽만 반영되면 그 어중간한 상태가 그대로 남기 때문이다.
   *
   * 두 테이블에 **같은 시각**을 찍어서 함께 지워졌다는 것이 데이터에 드러나게 한다.
   *
   * 이미 지워진 기록은 건드리지 않는다(`deletedAt: null` 조건). 최초 삭제 시각은
   * 복구·감사에 쓰는 값이라 덮어쓰면 안 된다.
   *
   * **이미 삭제된 할 일에 다시 부르면 거절된다.** 같은 이유이고, 이때는 트랜잭션이
   * 통째로 되돌아가 기록도 그대로 남는다.
   */
  async softDelete(todoId: bigint): Promise<TodoTemplate> {
    const deletedAt = new Date();

    const [template] = await this.prisma.$transaction([
      this.prisma.todoTemplate.update({
        where: { todoId, deletedAt: null },
        data: { deletedAt },
      }),
      this.prisma.todoHistory.updateMany({
        where: { todoId, deletedAt: null },
        data: { deletedAt },
      }),
    ]);

    return template;
  }

  /**
   * 일회성(ONCE) 할 일 중 **아직 완료하지 않은 것 전부.**
   *
   * 사용자가 확정한 규칙: 일회성 할 일은 완료할 때까지 계속 목록에 나오고, 예정일이
   * 지나도 사라지지 않는다. 완료하면 사라진다. 그래서 **날짜로 거르지 않는다** —
   * 예정일도 기록의 날짜도 조건에 넣지 않는다.
   *
   * 조회를 기록이 아니라 할 일 정의에서 시작하는 것이 핵심이다. 기록은 완료하거나
   * 진행값을 입력할 때 비로소 생기므로, 기록을 기준으로 찾으면 **아직 손대지 않은 것이
   * 전부 빠진다.**
   *
   * "완료했다"는 **완료 시각이 채워진 기록이 있다**는 뜻이다. 완료를 취소하면 그 시각이
   * 비므로 조건에서 빠져 목록에 다시 나온다 — 삭제와는 무관하고 `completedAt` 하나가
   * 그 동작을 담당한다. 지워진 기록을 완료로 세지 않는 것은 별개의 조건이고, 할 일이
   * 지워질 때만 생기는 상태다.
   */
  async findOnceWithoutCompletedHistory(
    userId: bigint,
  ): Promise<TodoTemplate[]> {
    return this.prisma.todoTemplate.findMany({
      where: {
        userId,
        deletedAt: null,
        completeType: 'ONCE',
        histories: {
          none: { deletedAt: null, completedAt: { not: null } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * 주어진 날짜에 **활성인** 매일 반복(DAILY) 할 일과 그날의 완료 기록.
   *
   * 사용자가 확정한 규칙: 어제 하지 않아 기록이 없으면 어제는 그대로 미완료로 남고,
   * 오늘은 오늘대로 다시 목록에 나온다. **밀린 일이 오늘로 넘어오지 않는다.** 그래서
   * 조건이 "그날 활성인가"일 뿐이고 기록이 있는지는 조건이 아니다.
   *
   * 활성 기간은 시작일과 종료일 **양쪽을 포함**하고, 값이 비어 있으면 그쪽 제한이 없다는
   * 뜻이다(시작일이 없으면 언제부터든, 종료일이 없으면 기한 없이).
   *
   * `histories`에는 그날 기록만 0개 또는 1개가 붙는다(같은 할 일에 같은 날짜 기록은
   * 하나뿐이다). **완료 여부를 판정하지 않는다** — 이 계층은 완료 시각을 읽지 않고
   * 붙여 주기만 한다.
   *
   * @param historiedOn 유저 타임존 기준 날짜. `toLocalDateKey`로 만든다
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
