import { Injectable } from '@nestjs/common';
import type { Prisma, TodoHistory } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 히스토리를 만들 때 template에서 **복제해 넘기는** 값.
 *
 * 복제 자체는 Service가 한다(어떤 필드를 어떻게 옮길지는 비즈니스 판단이다). 이 계층은
 * 받은 스냅샷을 **행을 새로 만들 때만** 쓴다 — 이미 있는 행에는 반영되지 않는다
 * (`upsertForHistoriedOn` 주석).
 *
 * **`userId`는 반드시 template에서 복제해라.** 요청 컨텍스트(로그인 유저)에서 채우면
 * 남의 `todoId`에 자기 기록을 붙이는 요청이 된다 — `(todoId, userId)` 복합 FK가 DB에서
 * 막지만 결과는 FK 위반이라 원인이 드러나지 않는다.
 */
export type TodoHistorySnapshot = {
  todoId: bigint;
  userId: bigint;
  /** `toHistoriedOn`으로 만든 값만 넣는다. `completeType`에 따라 규칙이 다르다 */
  historiedOn: Date;
  title: string;
  description: string | null;
  todoType: Prisma.TodoHistoryUncheckedCreateInput['todoType'];
  completeType: Prisma.TodoHistoryUncheckedCreateInput['completeType'];
  remindAt: string | null;
  shouldDoAt: Date | null;
  targetValue: Prisma.Decimal | string | number | null;
  targetUnit: string | null;
};

/**
 * upsert의 `update` 분기에 들어가는 값.
 *
 * **`todoType`·`completeType`이 없는 것은 의도한 것이다.** 두 값은 생성 시 복제한 뒤
 * 수정하지 않는다(사용자 정의). 그날의 기록이 어떤 타입이었는지가 나중에 바뀌면 지나간
 * 통계가 소급해 달라진다. `historiedOn`도 없다 — 그것은 유니크 키이고 바꾸는 것은
 * "다른 날 기록으로 옮기는 것"이라 upsert의 일이 아니다.
 */
export type TodoHistoryChanges = {
  title?: string;
  description?: string | null;
  /** 복제 후 수정 가능하다 — "오늘만 다른 시각에 알림" */
  remindAt?: string | null;
  progressValue?: Prisma.Decimal | string | number | null;
  completedAt?: Date | null;
};

/**
 * `todo_history` 접근.
 *
 * 히스토리는 **완료하거나 진행값을 기록할 때 비로소 생긴다**(lazy). 미리 만들어 두지
 * 않으므로 "행이 없다"가 곧 "그날 아무것도 하지 않았다"다. 그래서 쓰기 경로가 create와
 * update로 갈리지 않고 upsert 하나다.
 *
 * **조회는 전부 `deletedAt: null`을 건다.**
 */
@Injectable()
export class TodoHistoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 그 날짜의 히스토리를 만들거나 갱신한다.
   *
   * `where`가 `todoId_historiedOn` 복합 유니크로 성립하는 것은 유니크가 **부분 유니크가
   * 아닌** 일반 `@@unique([todoId, historiedOn])`이기 때문이다. 부분 유니크로 만들면
   * 생성되는 복합 유니크 입력 타입에 조건이 들어가지 않아 soft delete된 행을 집는다.
   *
   * `update` 분기가 `deletedAt: null`을 함께 건다 — **soft delete 복구 경로다.** 완료를
   * 취소했다가 다시 완료하면 새 행이 생기는 대신 같은 행이 되살아난다. 그렇지 않으면
   * 유니크 제약에 걸려 `P2002`가 난다.
   *
   * **기존 행이 있으면 `snapshot`은 전부 무시된다.** `update` 분기에 들어가는 것은
   * `changes`와 `deletedAt: null`뿐이고, `title`·`targetValue`·`shouldDoAt` 같은 스냅샷
   * 필드는 반영되지 않는다(실제로 나가는 SQL의 `DO UPDATE SET`에 그 컬럼들이 없다).
   * 지나간 기록을 소급 변경하지 않는다는 설계 의도이지만, **template의 변경을 기존
   * 히스토리에 반영하고 싶다면 그 필드를 `changes`에 담아야 한다** — `snapshot`에 넣어도
   * 조용히 아무 일도 일어나지 않는다.
   */
  async upsertForHistoriedOn(
    snapshot: TodoHistorySnapshot,
    changes: TodoHistoryChanges,
  ): Promise<TodoHistory> {
    return this.prisma.todoHistory.upsert({
      where: {
        todoId_historiedOn: {
          todoId: snapshot.todoId,
          historiedOn: snapshot.historiedOn,
        },
      },
      create: { ...snapshot, ...changes },
      update: { ...changes, deletedAt: null },
    });
  }

  async findByTodoIdAndHistoriedOn(
    todoId: bigint,
    historiedOn: Date,
  ): Promise<TodoHistory | null> {
    // 유니크 키에 `deletedAt`이 없어서 `findUnique`로는 soft delete된 행을
    // 걸러낼 수 없다.
    return this.prisma.todoHistory.findFirst({
      where: { todoId, historiedOn, deletedAt: null },
    });
  }

  /**
   * 그 유저의 특정 날짜 기록 전체. `@@index([userId, historiedOn])`가 이 경로다.
   *
   * **DAILY 기준이다.** ONCE의 `historiedOn`은 유저가 보는 날짜가 아니라 중복 방지
   * 키이므로 이 조회에 걸리는 것은 우연이고 의미가 없다.
   */
  async findManyByUserIdAndHistoriedOn(
    userId: bigint,
    historiedOn: Date,
  ): Promise<TodoHistory[]> {
    return this.prisma.todoHistory.findMany({
      where: { userId, historiedOn, deletedAt: null },
      orderBy: { todoHistoryId: 'asc' },
    });
  }

  /**
   * **두 번째 호출은 `P2025`로 거절된다.** `deletedAt: null` 조건이 없으면 이미 삭제된
   * 행의 `deletedAt`을 새 시각으로 덮어써서 최초 삭제 시각이 조용히 사라진다.
   *
   * 복구는 이 메서드의 반대가 아니라 `upsertForHistoriedOn`이 한다 — 그쪽 `update`
   * 분기가 `deletedAt: null`을 걸어 같은 행을 되살린다.
   */
  async softDelete(todoHistoryId: bigint): Promise<TodoHistory> {
    return this.prisma.todoHistory.update({
      where: { todoHistoryId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  }
}
