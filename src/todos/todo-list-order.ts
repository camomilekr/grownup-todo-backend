// 타입만 가져온다. 값 import가 없으므로 이 파일은 Prisma 런타임에 의존하지 않고,
// 그래서 순수 함수만 담긴 파일로 남는다.
import type { CompleteType } from '../generated/prisma/enums';

/**
 * 정렬이 읽는 필드만 요구하는 형태. 병합 목록(`listTodosOn`)이 넘기는
 * `TodoListItem`이 이것을 만족한다 — 2차 정렬키(`createdAt`)가 목록 응답에 있어서
 * (사용자 확정으로 열었다, `todo-view.ts`) 변환 뒤의 항목 수준에서 정렬한다.
 *
 * 구조 타입이라 넷을 가진 형태면 무엇이든 받는다. 목록 항목에 묶지 않은 것은 이
 * 파일이 응답 형태의 사정과 무관한 순수 정렬로 남게 하려는 것이다.
 */
export type TodoOrderSource = {
  todoId: bigint;
  completeType: CompleteType;
  /** 일회성의 예정일이 곧 마감이다. 없으면 마감 없음이다 */
  shouldDoAt: Date | null;
  createdAt: Date;
};

/**
 * 한 항목의 마감 순간. 일회성은 예정일이고, 매일 반복은 인자로 받은 순간이다 —
 * 그 계산(유저 타임존에서 다음 달력 날짜가 시작되는 최초의 순간, `toNextLocalDayStart`)
 * 은 타임존을 아는 쪽(Service)의 몫이라 이 파일은 결과만 받는다.
 *
 * `null`은 마감 없음이다 — 예정일 없는 일회성이 그 경우이고 정렬에서 맨 뒤로 간다.
 */
function resolveDeadline(
  item: TodoOrderSource,
  dailyDeadline: Date,
): Date | null {
  return item.completeType === 'DAILY' ? dailyDeadline : item.shouldDoAt;
}

/** `bigint`는 빼기로 비교할 수 없다 — `sort` 비교자는 `number`를 요구하는데
 * `bigint - bigint`는 `bigint`고, `Number`로 바꾸면 2^53 위에서 서로 다른 항목이
 * 같은 값이 된다. 그래서 명시적 대소 비교다. */
function compareBigint(a: bigint, b: bigint): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }

  return 0;
}

/**
 * 할 일 항목들을 **마감 순간 오름차순**으로 늘어놓은 새 배열을 돌려준다. 일회성과
 * 매일 반복을 하나의 목록으로 합쳐 보여 줄 때의 순서다(사용자 확정 — "완료일이
 * 가까운 순").
 *
 * 규칙 셋이 차례로 적용된다.
 *
 * 1. **마감 오름차순.** 일회성은 예정일(`shouldDoAt`), 매일 반복은 인자로 받은
 *    순간이다 — 출처가 달라도 값이 같으면 같은 마감 그룹이다
 * 2. **마감 없음(예정일 없는 일회성)은 맨 뒤.** 기한이 없는 일은 급한 일 뒤에 온다
 * 3. **동률은 `createdAt` 오름차순, 같으면 `todoId` 오름차순.** 기존 두 목록
 *    조회의 정렬과 같아서, 같은 마감 그룹 안(특히 매일 반복 전체)의 상대 순서가
 *    합치기 전 화면과 일치하고, 유일 키가 마지막에 있어 순서가 결정적이다
 *
 * **원본을 바꾸지 않는다.** `Array.prototype.sort`는 제자리 정렬이라 복사 후
 * 정렬한다 — 부르는 쪽이 넘긴 배열이 몰래 재배열되면 안 된다.
 *
 * **완료 여부는 반영하지 않는다**(사용자 확정). 완료된 매일 반복을 뒤로 보내면
 * 완료 토글마다 목록이 재배열되어 화면이 튄다 — 화면이 `progress.isCompleted`로
 * 구분한다.
 *
 * @param dailyDeadline 매일 반복의 마감 순간. 유저 타임존에서 다음 달력 날짜가
 *   시작되는 최초의 순간이고, 부르는 쪽이 `toNextLocalDayStart`로 만든다
 */
export function sortTodosByDeadline<T extends TodoOrderSource>(
  items: readonly T[],
  dailyDeadline: Date,
): T[] {
  return [...items].sort((a, b) => {
    const aDeadline = resolveDeadline(a, dailyDeadline);
    const bDeadline = resolveDeadline(b, dailyDeadline);

    // 마감 없는 쪽이 뒤다. 둘 다 없으면 아래 동률 규칙으로 내려간다.
    if (aDeadline !== null && bDeadline === null) {
      return -1;
    }
    if (aDeadline === null && bDeadline !== null) {
      return 1;
    }
    if (aDeadline !== null && bDeadline !== null) {
      const byDeadline = aDeadline.getTime() - bDeadline.getTime();
      if (byDeadline !== 0) {
        return byDeadline;
      }
    }

    const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return compareBigint(a.todoId, b.todoId);
  });
}
