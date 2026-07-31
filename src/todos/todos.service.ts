import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UsersRepository } from '../users/users.repository';
import {
  parseLocalDateKey,
  toHistoriedOn,
  toLocalDateKey,
} from './todo-local-date';
import { TodoHistoriesRepository } from './todo-histories.repository';
import { TodoTemplatesRepository } from './todo-templates.repository';
import {
  narrowByCompleteType,
  toDailyTodoDetail,
  toOnceTodoDetail,
  toTodoListItem,
} from './todo-view';
import type { TodoDetail, TodoListItem } from './todo-view';

/**
 * 상세 조회가 이력을 가져올 기간. **양 끝 날짜를 포함한다.**
 *
 * `Date`가 아니라 `YYYY-MM-DD` 문자열로 받는다. `@db.Date` 컬럼에 넘길 `Date`를 손으로
 * 만들면 한국 시간대에서 하루 앞으로 밀리므로(`todo-local-date.ts`) **이 폴더 밖에서
 * `Date`를 만들 기회를 주지 않는 것**이 목적이다. 형식과 달력 검증도 함께 걸린다.
 */
export type TodoHistoryRange = {
  from: string;
  until: string;
};

/**
 * 할 일 도메인의 유일한 진입점.
 *
 * **일회성과 매일 반복을 하나의 "할 일"로 다룬다.** 내용은 정의(`todoTemplate`)에서 오고
 * 상태는 완료 기록(`todoHistory`)에서 오는데, 그 둘을 합쳐 내보내는 형태로 바꾸는 것이
 * 이 계층의 일이다. 변환 자체는 순수 함수(`todo-view.ts`)가 하고 Service는 **무엇을
 * 조회할지 고르는 판단**을 한다.
 *
 * **조회 3종이 목록 둘과 상세 하나다.** 목록을 반복 방식별로 나눈 것은 조회 조건이 아예
 * 다르기 때문이다 — 일회성은 날짜로 거르지 않고 매일 반복은 날짜가 조건의 중심이다.
 * 둘을 하나로 합쳐 내보낼지는 그 형태를 받는 계층이 정하면 된다.
 */
@Injectable()
export class TodosService {
  private readonly logger = new Logger(TodosService.name);

  constructor(
    private readonly templates: TodoTemplatesRepository,
    private readonly histories: TodoHistoriesRepository,
    private readonly users: UsersRepository,
  ) {}

  /**
   * 아직 완료하지 않은 일회성 할 일 전부. 예정일이 지나도 사라지지 않는다.
   *
   * **유저 타임존을 읽지 않는다.** 이 목록은 날짜로 거르지 않으므로 필요가 없고, 읽으면
   * 조회가 한 번 늘면서 "탈퇴하지 않은 유저인지"가 목록 결과를 바꾸게 된다.
   */
  async listOnce(userId: bigint): Promise<TodoListItem[]> {
    const rows = await this.templates.findOnceWithoutCompletedHistory(userId);

    // 붙어 오는 기록은 0개 또는 1개다(근거는 Repository 주석에 있다). 비어 있으면
    // `undefined`가 넘어가는데 `toTodoListItem`이 그것을 "없음"으로 받는다.
    return rows.map((row) => toTodoListItem(row, row.histories[0]));
  }

  /**
   * 그 순간이 유저에게 **며칠인지**를 계산해, 그날 활성인 매일 반복 할 일을 돌려준다.
   *
   * 어제 하지 않은 것이 오늘로 밀려오지 않는다 — 그날 기준으로 다시 시작한다.
   *
   * @param at 기준 순간(보통 요청이 도착한 시각). 날짜가 아니라 순간이다 — 유저마다
   *   하루가 바뀌는 자리가 달라서 날짜를 정하는 것이 이 메서드의 일이다
   * @throws {NotFoundException} 그 유저가 없거나 탈퇴했을 때
   */
  async listDailyOn(userId: bigint, at: Date): Promise<TodoListItem[]> {
    const timeZone = await this.readTimeZone(userId);
    const rows = await this.templates.findDailyActiveOn(
      userId,
      toLocalDateKey(at, timeZone),
    );

    return rows.map((row) => toTodoListItem(row, row.histories[0]));
  }

  /**
   * 할 일 하나의 상세. **반환 형태가 반복 방식으로 갈린다** — 일회성은 상태 한 건이고
   * 매일 반복은 기간 범위의 이력 배열이다(`TodoDetail`).
   *
   * **매일 반복 쪽에 "오늘의 상태"를 따로 담지 않는다.** 날짜마다 상태가 다른데 하나를
   * 골라 담으면 어느 날짜의 것인지가 결과에 드러나지 않고, 이력 배열이 범위 전체를
   * 담으므로 받는 쪽이 원하는 날짜를 고를 수 있어 잃는 정보도 없다.
   *
   * **범위는 반복 방식과 무관하게 먼저 검증한다.** 일회성 갈래는 그 값을 쓰지 않지만,
   * 같은 요청이 반복 방식에 따라 다르게 거절되면 부르는 쪽이 결과를 예측할 수 없다.
   *
   * @throws {NotFoundException} 그런 할 일이 없거나 남의 것일 때
   * @throws {BadRequestException} 범위 날짜의 형식이 어긋나거나 시작일이 종료일보다 늦을 때
   */
  async getTodo(
    userId: bigint,
    todoId: bigint,
    range: TodoHistoryRange,
  ): Promise<TodoDetail> {
    const { from, until } = this.parseRange(range);

    // 소유자를 조건으로 읽는다. 남의 할 일은 `null`로 돌아와 "없는 것"과 같아진다.
    // **완료 기록을 쓰는 경로가 이 결과의 `userId`를 요청자의 것으로 신뢰하므로**,
    // 좁혀 읽는 것이 그쪽의 전제이기도 하다.
    const template = await this.templates.findById(userId, todoId);
    if (template === null) {
      throw new NotFoundException(`그런 할 일이 없다 (todoId=${todoId})`);
    }

    // 조건 분기만으로는 정의 타입이 좁혀지지 않는다. 이것을 거치지 않으면 아래 두
    // 변환 함수가 `TS2345`로 거절하고, 그때 `as` 캐스팅으로 우회하면 반복 방식을
    // 타입으로 막아 둔 장치가 사라진다(`todo-view.ts`).
    const narrowed = narrowByCompleteType(template);

    if (narrowed.completeType === 'ONCE') {
      // 일회성의 기록은 한 건이고 그 날짜가 정의 생성 시각에서 나온다. `performedAt`과
      // `timeZone`은 일회성 규칙이 쓰지 않는 값이라 결과에 영향을 주지 않는다 —
      // **그래서 이 갈래는 유저 타임존을 읽지 않아도 된다.**
      const historiedOn = toHistoriedOn({
        completeType: 'ONCE',
        createdAt: narrowed.createdAt,
        performedAt: narrowed.createdAt,
        timeZone: 'UTC',
      });

      return toOnceTodoDetail(
        narrowed,
        await this.histories.findByTodoIdAndHistoriedOn(
          userId,
          todoId,
          historiedOn,
        ),
      );
    }

    return toDailyTodoDetail(
      narrowed,
      await this.histories.findByTodoIdBetween(userId, todoId, from, until),
    );
  }

  /**
   * 날짜 키를 만들 유저 타임존을 읽는다.
   *
   * **없는 유저와 탈퇴한 유저를 구분하지 않는다.** Repository가 둘 다 `null`로 돌려주고,
   * 탈퇴한 계정이 존재한다는 사실을 알려 줄 이유도 없다.
   */
  private async readTimeZone(userId: bigint): Promise<string> {
    const timeZone = await this.users.findTimeZone(userId);
    if (timeZone === null) {
      throw new NotFoundException(`그런 유저가 없다 (userId=${userId})`);
    }

    return timeZone;
  }

  /**
   * 범위 문자열을 `@db.Date` 컬럼에 넘길 UTC 자정 `Date` 한 쌍으로 바꾼다.
   *
   * `parseLocalDateKey`가 던지는 `RangeError`를 `BadRequestException`으로 바꾼다. 그대로
   * 새게 두면 클라이언트가 잘못 보낸 값이 500으로 나가 서버 장애처럼 보인다.
   *
   * **원본 메시지를 응답에 이어 붙이지 않는다.** 두 가지가 어긋나기 때문이다. 그 함수는
   * 형식이 어긋난 경우와 **달력에 없는 날짜**인 경우를 모두 던지므로 "형식이 잘못됐다"고
   * 단정하면 뒤쪽에서 앞뒤가 반대인 문장이 되고, 이어 붙이면 내부 함수 이름이 클라이언트
   * 응답에 나간다. 원인 상세는 로그로 보내고 응답에는 **어느 값이 문제인지**만 담는다.
   *
   * **뒤집힌 범위도 거절한다.** 그대로 조회하면 항상 빈 배열이 돌아오고, 그것은 "그 기간에
   * 기록이 없다"와 구별되지 않는다 — 아무 오류 없이 잘못된 화면이 그려지는 쪽이다.
   */
  private parseRange(range: TodoHistoryRange): { from: Date; until: Date } {
    // 범위 자체가 비어 있는 경우를 먼저 막는다. `strictNullChecks`가 꺼져 있어 컴파일러가
    // `undefined`를 넘기는 호출을 막지 못하고, 그대로 두면 값을 읽는 자리에서 `TypeError`가
    // 나 **400이어야 할 것이 500으로 나간다.**
    if (range == null) {
      throw new BadRequestException('기간 범위가 없다');
    }

    const from = this.parseDateKey('시작일', range.from);
    const until = this.parseDateKey('종료일', range.until);

    if (from.getTime() > until.getTime()) {
      throw new BadRequestException(
        `기간 범위의 시작일이 종료일보다 늦다 (from=${range.from}, until=${range.until})`,
      );
    }

    return { from, until };
  }

  /**
   * 날짜 문자열 하나를 날짜 키로 바꾸고, 실패를 `BadRequestException`으로 바꾼다.
   *
   * **한 쪽씩 나눠 부르는 이유가 둘이다.** 어느 값이 문제인지 응답에 담을 수 있고,
   * `catch`가 검사 대상을 **다시 읽지 않는다** — 인자로 이미 받은 값을 쓰므로 오류를
   * 다루는 자리가 스스로 던질 여지가 없다.
   *
   * @param label 응답에 실을 자리 이름. 어느 쪽 날짜가 어긋났는지 알려 준다
   */
  private parseDateKey(label: string, value: string): Date {
    try {
      return parseLocalDateKey(value);
    } catch (error) {
      // 원인을 삼키지 않는다. 어떻게 어긋났는지가 이 메시지에 있고 그것을 응답이 아니라
      // 로그에 남긴다 — 클라이언트 입력 오류이므로 `error`가 아니라 `warn`이다.
      this.logger.warn(
        `기간 범위를 해석할 수 없다: ${(error as Error).message}`,
      );

      throw new BadRequestException(
        `기간 범위의 ${label}이 올바르지 않다 (${value})`,
      );
    }
  }
}
