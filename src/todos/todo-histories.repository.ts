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
 * **`userId`에는 요청자의 식별자를 넣는다.** 이 값이 두 곳에 쓰이고 둘 다 요청자를
 * 가리켜야 맞다.
 *
 * 하나는 `upsertForHistoriedOn`의 **소유자 검사**다. 그 확인 조회가 `(todoId, userId)`로
 * 정의를 찾으므로, 요청자를 넣으면 남의 할 일에 기록을 붙이려는 요청이 그 자리에서
 * `TodoTemplateNotFoundError`로 걸린다. 다른 하나는 저장될 `todo_history.user_id` 컬럼
 * 값이고, 요청자가 주인일 때만 저장까지 가므로 결과적으로 정의의 소유자와 같아진다.
 *
 * **정의 행에서 읽은 값을 그대로 옮기면 그 검사가 무력화될 수 있다.** 소유자로 좁혀 읽은
 * 정의(`TodoTemplatesRepository.findById(userId, todoId)`)라면 그 `userId`가 요청자와
 * 같아 결과가 다르지 않다. 위험한 것은 **좁히지 않고 읽은 정의**다 — 그때는 그 정의와
 * 자기 자신을 비교하는 동어반복이 되어 아무것도 거르지 못한다. 요청자 A가 C의 할 일
 * 번호를 보내면 `{ todoId: C의 할 일, userId: C }`가 만들어지고 확인 조회와 복합 외래키를
 * 모두 통과해 **A가 C의 할 일에 기록을 쓴다.**
 *
 * 복합 외래키가 최후의 방어로 남아 있지만 그것에 기대지 마라. 위 경로는 그것도 통과하고,
 * 걸리는 경우에도 나오는 것은 원인을 알기 어려운 제약 위반 오류(`P2003`, 참조 대상이
 * 없다)다.
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
    // 삭제 여부는 조건에 넣지 않고 행을 그대로 가져온다. 조건에 넣으면 "지워졌다"와
    // "애초에 없다"가 똑같이 빈 결과로 돌아와 구분할 수 없다.
    //
    // **소유자는 조건에 넣는다.** 남의 할 일은 "없는 것"과 같게 다루는 것이 옳고, 넣지
    // 않으면 이 확인을 통과한 뒤 저장 단계에서 복합 외래키에 걸려 `P2003`(참조 대상이
    // 없다)으로 실패한다. 막히기는 하지만 **그 오류는 원인을 알기 어렵다** — 로그를 보는
    // 사람이 제약 이름부터 되짚어야 하고, 정작 원인은 소유자가 어긋났다는 것이다.
    //
    // `@@unique([todoId, userId])`가 있어 복합 유일 키로 조회할 수 있다. 그 제약은 원래
    // 기록 쪽 복합 외래키의 참조 대상을 만들려고 둔 것인데, 여기서 한 번 더 쓰인다.
    const template = await this.prisma.todoTemplate.findUnique({
      where: {
        todoId_userId: { todoId: snapshot.todoId, userId: snapshot.userId },
      },
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

  /** 그 날짜의 기록 한 건. 남의 것이거나 지워졌으면 `null`이다. */
  async findByTodoIdAndHistoriedOn(
    userId: bigint,
    todoId: bigint,
    historiedOn: Date,
  ): Promise<TodoHistory | null> {
    // 단건 조회(`findUnique`)가 아니라 `findFirst`를 쓴다. 유일 제약에 `deletedAt`이
    // 들어 있지 않아서, 단건 조회로는 "삭제되지 않은 것만"이라는 조건을 걸 수 없다.
    //
    // 할 일의 삭제 여부도 함께 본다. 할 일을 지우면 기록에도 삭제 표시가 찍히므로
    // 보통은 앞 조건만으로 걸러지지만, 저장 거절과 삭제가 겹치는 아주 좁은 시간차에
    // 만들어진 기록은 그 표시가 없다.
    //
    // 소유자는 정의를 따라가지 않고 기록 쪽 컬럼으로 본다. 복합 외래키가 둘의 일치를
    // 보장하므로 결과는 같고, `@@index([userId, historiedOn])`을 쓸 수 있다.
    return this.prisma.todoHistory.findFirst({
      where: {
        todoId,
        userId,
        historiedOn,
        deletedAt: null,
        template: { deletedAt: null },
      },
    });
  }

  /**
   * 한 할 일의 **기간 범위 기록**. 매일 반복 할 일의 상세 화면이 날짜별 이력을 그린다.
   *
   * 범위를 인자로 받는 이유는 전체를 돌려주면 오래 쓴 할 일에서 결과가 무한히 커지기
   * 때문이다. **양 끝 날짜를 포함한다** — 활성 기간과 같은 규칙이고, 사용자가 고른 날짜는
   * 그 날도 포함한다고 읽는 것이 자연스럽다.
   *
   * `historiedOn` 오름차순으로 돌려준다. 화면이 시간 순서로 그리고, 같은 할 일에 같은
   * 날짜 기록이 하나뿐이라 **이 정렬키 하나로 순서가 완전히 정해진다**(다른 목록 조회들이
   * 2차 정렬키를 두는 이유는 `createdAt`이 겹칠 수 있기 때문인데, 여기서는 그 문제가 없다).
   *
   * **기록과 할 일 양쪽의 삭제 여부를 본다.** 할 일을 지울 때 그 시점의 기록에 삭제
   * 표시를 찍지만 그것은 지우는 순간에 있던 기록만 덮으므로, 저장 거절과 삭제가 겹치는
   * 좁은 시간차로 그 뒤에 만들어진 기록은 표시가 없다.
   *
   * ### 아래 `findDailyHistoriesOn`과 달리 반복 방식을 조건에 넣지 않았다
   *
   * 그 메서드가 `template: { completeType: 'DAILY' }`를 넣는 이유는 **결과가 여러 할 일의
   * 기록이 섞인 목록**이기 때문이다. 완료 기록에는 반복 방식이 저장되지 않으므로 받는
   * 쪽에서 일회성을 나중에 걸러 낼 방법이 없어 쿼리로 못 박아야 한다.
   *
   * 이쪽은 `todoId`를 조건으로 받아 **결과가 전부 한 할 일의 기록**이다. 섞일 것이 없고
   * 부르는 쪽은 그 할 일의 반복 방식을 이미 알고 있다(정의를 읽어야 이 메서드를 부를 수
   * 있다). 그래서 걸러 낼 수 없다는 문제가 생기지 않는다.
   *
   * **오히려 조건을 넣으면 조용한 오류가 생긴다.** 일회성 `todoId`로 부르면 빈 배열이
   * 돌아와 "기록이 없다"와 구별되지 않는다. 조건이 없으면 기록이 그대로 나오고, 그 값을
   * 표시용 날짜로 내보내려는 시도는 뷰 계층이 두 겹으로 막는다 — `todo-view.ts`가 이력
   * 항목 변환 함수를 내보내지 않고, 그 유일한 통로인 `toDailyTodoDetail`이 매일 반복으로
   * 좁혀진 정의만 받는다.
   *
   * **넣을지 여부는 이 메서드를 실제로 부르는 코드가 생길 때 정한다.** 호출 형태를 보고
   * 판단할 문제이고, 지금 넣으면 위의 조용한 오류를 미리 만드는 쪽이다.
   *
   * @param from 범위 시작일(포함). `parseLocalDateKey`로 만든다
   * @param until 범위 종료일(포함)
   */
  async findByTodoIdBetween(
    userId: bigint,
    todoId: bigint,
    from: Date,
    until: Date,
  ): Promise<TodoHistory[]> {
    return this.prisma.todoHistory.findMany({
      where: {
        todoId,
        userId,
        historiedOn: { gte: from, lte: until },
        deletedAt: null,
        template: { deletedAt: null },
      },
      orderBy: { historiedOn: 'asc' },
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
