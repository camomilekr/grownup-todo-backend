import { Injectable } from '@nestjs/common';
import type { Prisma, TodoHistory } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  TodoTemplateDeletedError,
  TodoTemplateNotFoundError,
} from './todo-errors';

/**
 * 완료 기록을 새로 만들 때 필요한 값.
 *
 * **할 일의 내용(제목·설명·종류 등)이 여기 없는 것은 의도한 것이다.** 그런 정보는
 * `todoTemplate`에만 두고 기록에는 복사하지 않는다 — 복사하면 제목을 한 번 고칠
 * 때마다 과거 기록과 현재 정의가 어긋난다.
 *
 * 예외가 목표치 한 쌍(`targetValue`·`targetUnit`)이다. 이것만 복사하는 이유는 목표를
 * 5에서 8로 올렸을 때 5를 채웠던 날의 달성률이 100%에서 62%로 소급해 바뀌는 것을 막기
 * 위해서다.
 *
 * **`userId`는 반드시 `todoTemplate`에서 가져와 채워라.** 로그인한 사용자 정보에서
 * 채우면 남의 할 일에 자기 기록을 붙이는 요청이 통과한다. DB에 걸린 복합 외래키가
 * 막아 주긴 하지만 그때 나오는 것은 원인을 알기 어려운 제약 위반 오류다.
 */
export type TodoHistorySnapshot = {
  todoId: bigint;
  userId: bigint;
  /** `toHistoriedOn`으로 만든 값만 넣는다. 반복 방식에 따라 규칙이 다르다 */
  historiedOn: Date;
  targetValue: Prisma.Decimal | string | number | null;
  targetUnit: string | null;
};

/**
 * 이미 있는 기록을 고칠 때 바꿀 수 있는 값. **실적 두 개뿐이다.**
 *
 * 나머지는 고칠 대상이 아니다. `historiedOn`은 어떤 기록인지 가려내는 열쇠라서 바꾸면
 * "다른 날 기록으로 옮기는" 일이 되고, 목표치 한 쌍은 그날 기준을 남겨 두려고 복사한
 * 것이라 나중에 덮어쓰면 복사한 의미가 없어진다.
 */
export type TodoHistoryChanges = {
  progressValue?: Prisma.Decimal | string | number | null;
  completedAt?: Date | null;
};

/**
 * `todo_history` 테이블 접근.
 *
 * 완료 기록은 **완료하거나 진행값을 입력할 때 비로소 만들어진다.** 미리 만들어 두지
 * 않으므로 "그날 행이 없다"가 곧 "그날 아무것도 하지 않았다"는 뜻이고, 그래서 저장
 * 경로가 "새로 만들기"와 "고치기"로 나뉘지 않고 하나(`upsertForHistoriedOn`)다.
 *
 * **완료 기록은 지울 수 없다.** 사용자가 확정한 규칙이라 개별 삭제 메서드를 두지
 * 않았다 — 문서로 경고하는 대신 **없는 메서드는 부를 수 없게** 했다. `deletedAt`이
 * 찍히는 경로는 **할 일 자체가 지워질 때 하나뿐**이고, 그것은
 * `TodoTemplatesRepository.softDelete`가 한 트랜잭션에서 처리한다.
 *
 * **완료를 취소하는 것은 삭제가 아니다.** `completedAt`을 비우는 수정이고 행은 그대로
 * 남는다.
 *
 * **조회는 지워진 할 일의 기록을 내보내지 않는다.** 기록 자체의 삭제 표시와 할 일의
 * 삭제 표시를 둘 다 본다 — 이유는 각 메서드 주석에 있다.
 */
@Injectable()
export class TodoHistoriesRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 그 날짜의 기록을 만들거나 고친다. 있으면 고치고 없으면 새로 만드는 동작(upsert)이다.
   *
   * 어떤 행인지는 `(todoId, historiedOn)` 조합으로 찾는다. 이 조합이 열쇠로 성립하는
   * 것은 스키마에 그 조합의 유일 제약이 **조건 없이** 걸려 있기 때문이다. 조건부
   * 제약이었다면 Prisma가 만들어 주는 조회 타입에 그 조건이 빠져서 엉뚱한 행을 집는다.
   *
   * **고치는 쪽으로 갈 때 `snapshot`은 쓰이지 않는다.** 반영되는 것은 `changes`뿐이고,
   * 실제로 나가는 SQL의 갱신 목록에 목표치 컬럼이 없다. 지나간 기록을 나중 변경으로
   * 덮지 않으려는 의도이지만, **기존 기록에 반영하고 싶은 값이 있다면 `changes`에
   * 담아야 한다** — `snapshot`에 넣으면 아무 일도 일어나지 않고 오류도 나지 않는다.
   *
   * 삭제 표시를 비우는 동작은 **없다.** 한 번 지워진 기록은 되살아나지 않는다.
   *
   * **완료 취소는 이 메서드로 한다.** `changes.completedAt`에 `null`을 넣으면 된다 —
   * 행을 지우는 것이 아니라 완료 시각을 비우는 수정이다.
   *
   * **지워진 할 일이면 거절한다.** 기록을 개별적으로 지울 수 없게 되면서, 지워진 기록은
   * 곧 **할 일 자체가 지워졌다는 뜻**이 됐다. 그래서 검사 대상이 "그 날짜의 지워진
   * 기록"이 아니라 할 일의 삭제 여부다 — 기록이 아예 없던 날짜도 함께 막힌다.
   *
   * 막지 않으면 두 갈래로 잘못된다. 지워진 기록이 남아 있는 날짜면 행을 찾는 기준이
   * `(todoId, historiedOn)` 조합이라 **그 지워진 행을 집어 값만 조용히 바꾼다.** 조회는
   * 지워진 것을 빼고 보므로 "기록했는데 화면에 안 나온다"가 되고 오류도 나지 않는다.
   * 기록이 없던 날짜면 새 행이 만들어지는데, 주인 없는 기록이 생기는 셈이다.
   *
   * 미리 확인한 뒤 저장하므로 그 사이에 삭제가 끼어들 여지가 아주 좁게 남는다. 조회
   * 쪽에서도 할 일의 삭제 여부를 함께 보는 이유가 그것이다. 확인을 저장과 한 문장으로
   * 합치지 않은 이유는 **저장 자체의 원자성을 지키기 위해서다** — 지금은 DB가 한
   * 문장으로 처리해서 같은 날짜에 두 요청이 겹쳐도 안전한데, 찾기와 저장을 나누면 둘 다
   * "없다"고 보고 하나가 중복 오류를 받는다.
   *
   * @throws {TodoTemplateNotFoundError} 그런 할 일이 아예 없을 때
   * @throws {TodoTemplateDeletedError} 할 일이 있지만 지워졌을 때
   */
  async upsertForHistoriedOn(
    snapshot: TodoHistorySnapshot,
    changes: TodoHistoryChanges,
  ): Promise<TodoHistory> {
    // 삭제 여부를 조건에 넣지 않고 행을 그대로 가져온다. 조건에 넣으면 "지워졌다"와
    // "애초에 없다"가 똑같이 빈 결과로 돌아와 구분할 수 없다.
    const template = await this.prisma.todoTemplate.findUnique({
      where: { todoId: snapshot.todoId },
      select: { deletedAt: true },
    });

    if (!template) {
      throw new TodoTemplateNotFoundError(snapshot.todoId);
    }
    if (template.deletedAt) {
      throw new TodoTemplateDeletedError(snapshot.todoId);
    }

    return this.prisma.todoHistory.upsert({
      where: {
        todoId_historiedOn: {
          todoId: snapshot.todoId,
          historiedOn: snapshot.historiedOn,
        },
      },
      create: { ...snapshot, ...changes },
      update: changes,
    });
  }

  async findByTodoIdAndHistoriedOn(
    todoId: bigint,
    historiedOn: Date,
  ): Promise<TodoHistory | null> {
    // 단건 조회(`findUnique`)가 아니라 `findFirst`를 쓴다. 유일 제약에 `deletedAt`이
    // 들어 있지 않아서, 단건 조회로는 "삭제되지 않은 것만"이라는 조건을 걸 수 없다.
    //
    // 할 일의 삭제 여부도 함께 본다. 할 일을 지우면 기록에도 삭제 표시가 찍히므로
    // 보통은 앞 조건만으로 걸러지지만, 저장 거절과 삭제가 겹치는 아주 좁은 시간차에
    // 만들어진 기록은 그 표시가 없다.
    return this.prisma.todoHistory.findFirst({
      where: {
        todoId,
        historiedOn,
        deletedAt: null,
        template: { deletedAt: null },
      },
    });
  }

  /**
   * 그 유저가 특정 날짜에 남긴 기록 전체. **매일 반복(DAILY) 할 일만 나온다.**
   *
   * 일회성을 걸러 내는 것을 이 계층에서 하는 이유가 있다. 일회성의 `historiedOn`은
   * 화면에 보여 줄 날짜가 아니라 중복을 막는 열쇠라서(스키마 주석 참고) 날짜별 목록에
   * 섞이면 안 된다. 그런데 **완료 기록에는 반복 방식이 저장되지 않으므로** 결과를 받은
   * 쪽에서 나중에 걸러 낼 방법이 없다. 문서로 "섞일 수 있으니 조심하라"고만 적어 두면
   * 지켜지지 않으므로 쿼리 조건으로 못 박는다.
   *
   * **지워진 할 일의 기록도 뺀다.** 할 일을 지울 때 그 시점의 기록에 삭제 표시를
   * 찍지만, 그것은 **지우는 순간에 있던 기록만** 덮는다. 저장 거절과 삭제가 겹치는
   * 좁은 시간차로 그 뒤에 만들어진 기록은 표시가 없으므로, 조회에서도 할 일의 삭제
   * 여부를 함께 본다. 이미 할 일 테이블을 함께 보고 있어서 조건을 더하는 비용이 없다.
   */
  async findDailyHistoriesOn(
    userId: bigint,
    historiedOn: Date,
  ): Promise<TodoHistory[]> {
    return this.prisma.todoHistory.findMany({
      where: {
        userId,
        historiedOn,
        deletedAt: null,
        template: { completeType: 'DAILY', deletedAt: null },
      },
      orderBy: { todoHistoryId: 'asc' },
    });
  }
}
