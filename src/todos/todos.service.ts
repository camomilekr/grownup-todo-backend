import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UsersRepository } from '../users/users.repository';
import {
  TodoTemplateDeletedError,
  TodoTemplateNotFoundError,
} from './todo-errors';
import {
  parseLocalDateKey,
  toHistoriedOn,
  toLocalDateKey,
} from './todo-local-date';
// `Prisma`만 값으로 가져온다. `PrismaClientKnownRequestError`를 `instanceof`로 판별해야
// 하기 때문이다 — 오류 코드 문자열만 보면 그 속성을 가진 아무 객체나 통과한다.
import { Prisma } from '../generated/prisma/client';
import type { TodoHistory, TodoTemplate } from '../generated/prisma/client';
import type { CompleteType, TodoType } from '../generated/prisma/enums';
import { TodoHistoriesRepository } from './todo-histories.repository';
import type { TodoHistoryChanges } from './todo-histories.repository';
import { TodoTemplatesRepository } from './todo-templates.repository';
import type { UpdateTodoTemplateInput } from './todo-templates.repository';
import {
  narrowByCompleteType,
  toDailyTodoDetail,
  toOnceTodoDetail,
  toProgress,
  toTodoListItem,
} from './todo-view';
import type { TodoDetail, TodoListItem, TodoProgress } from './todo-view';

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
 * 할 일을 새로 만들 때 받는 값.
 *
 * 활성 기간은 `TodoHistoryRange`와 같은 이유로 `YYYY-MM-DD` 문자열이다. 예정일
 * (`shouldDoAt`)은 시각(`Timestamptz`)이라 `Date`로 받는다 — 날짜만 있는 값과 달리
 * 순간을 가리키므로 문자열로 줄이면 시·분이 사라진다.
 */
export type CreateTodoInput = {
  title: string;
  description?: string | null;
  /** **만든 뒤에는 바꿀 수 없다.** 이미 쌓인 기록을 해석하는 근거가 이 값뿐이다 */
  todoType: TodoType;
  /** **만든 뒤에는 바꿀 수 없다.** 완료 기록의 날짜를 만드는 규칙이 이 값으로 갈린다 */
  completeType: CompleteType;
  remindAt?: string | null;
  shouldDoAt?: Date | null;
  targetValue?: number | null;
  targetUnit?: string | null;
  activeFrom?: string | null;
  activeUntil?: string | null;
};

/**
 * 할 일을 고칠 때 받는 값. **`todoType`과 `completeType`이 없다** — 만든 뒤 바꿀 수 없고
 * `UpdateTodoTemplateInput`이 타입으로도 막는다.
 *
 * **`undefined`는 "그대로 두라"이고 `null`은 "비우라"다.** 부분 갱신이라 둘을 구분해야
 * 하고, 검증은 **바뀐 뒤의 최종 상태**를 본다 — 주지 않은 필드는 저장된 값을 쓴다.
 */
export type UpdateTodoInput = {
  title?: string;
  description?: string | null;
  remindAt?: string | null;
  shouldDoAt?: Date | null;
  targetValue?: number | null;
  targetUnit?: string | null;
  activeFrom?: string | null;
  activeUntil?: string | null;
};

/**
 * 진행값을 저장할 때 받는 값.
 *
 * **`performedAt`이 어느 날짜의 기록인지를 정한다.** 매일 반복은 그 순간이 유저에게
 * 며칠인지가 곧 기록의 날짜다 — 유저마다 하루가 바뀌는 자리가 달라서 날짜가 아니라 순간으로
 * 받는다. 일회성은 키가 정의 생성 시각에서 나와 이 값을 쓰지 않는다(`toHistoriedOn`).
 *
 * **완료 여부는 여기 없다.** 진행값이 목표치를 넘겨도 서버가 완료를 찍지 않고, 완료는
 * `completeTodo`가 따로 받는다(사용자 확정) — 근거는 그 메서드 주석에 있다.
 */
export type SaveProgressInput = {
  /** 그날 달성한 값. **`0`도 유효한 입력이다** — 저장하지 않은 것과 다른 상태다 */
  progressValue: number;
  performedAt: Date;
};

/**
 * 검증이 보는 할 일의 최종 형태. 만들기는 입력에서, 고치기는 **입력과 저장된 값을 합쳐**
 * 이 형태를 만든 뒤 같은 규칙을 통과시킨다.
 */
type TodoShape = {
  todoType: TodoType;
  completeType: CompleteType;
  targetValue: number | Prisma.Decimal | null;
  targetUnit: string | null;
  shouldDoAt: Date | null;
  activeFrom: Date | null;
  activeUntil: Date | null;
};

/** Prisma가 **고칠 행을 찾지 못했을 때** 붙이는 오류 코드 */
const PRISMA_RECORD_NOT_FOUND = 'P2025';

/**
 * 값이 `undefined`인 키를 뺀 객체를 만든다.
 *
 * 고치기에서 `undefined`는 "그대로 두라"는 뜻이다. Prisma도 `undefined` 필드를 무시하므로
 * 동작은 같지만, **키 자체를 없애 두면 무엇을 고치는 요청인지가 넘기는 값에 그대로
 * 드러난다** — 의도하지 않은 필드가 섞였는지 로그와 테스트에서 눈으로 확인할 수 있다.
 */
function omitUndefined<T extends object>(source: T): T {
  // `Object.fromEntries`의 반환 타입은 인덱스 시그니처라 원래 타입으로 되돌릴 방법이
  // 없다. 키를 빼기만 하고 값은 손대지 않으므로 `T`가 유지되는 것은 이 함수 안에서
  // 확인된다 — 그래서 이 단정은 밖으로 새지 않는다.
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined),
  ) as T;
}

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
 *
 * **정의를 다루는 쓰기가 만들기·고치기·삭제 셋이다.** 셋의 공통점이 둘 있다. 하나는
 * 입력 규칙을 `assertShape` 한 곳에 모아 만들기와 고치기가 **같은 규칙**을 통과한다는 것,
 * 다른 하나는 이미 있는 행을 다루는 둘이 먼저 `findById(userId, todoId)`로 정의를
 * 읽는다는 것이다.
 *
 * **기록을 다루는 쓰기가 진행값 저장·완료·완료 취소 셋이다.** 셋 다 정의를 소유자로 좁혀
 * 읽고(`readOwnTemplate`), `toHistoriedOn`으로 날짜 키를 만들고(`resolveHistoriedOn`),
 * 저장 통로 하나를 지난다(`writeHistoryOn`). 그 뒤로 갈리는 것은 각 메서드 주석에 있다.
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
   * 할 일을 새로 만든다.
   *
   * **소유자를 인자로 받아 삽입할 값으로 넣는다.** 새로 만드는 행의 주인을 정하는 자리라
   * 견줄 기존 행이 없어 Repository에는 검사할 것이 원리적으로 없고, 요청자의 식별자를
   * 넣는 것이 이 계층의 책임이다(`todo-templates.repository.ts`).
   *
   * **만든 결과를 목록 항목 형태로 돌려주고 상태는 `null`이다.** 방금 만든 정의라 완료
   * 기록이 있을 수 없으므로 조회하지 않는다 — `null`이 "아직 손대지 않았다"는 사실과
   * 일치하기 때문에 값을 지어내는 것이 아니다.
   *
   * @throws {BadRequestException} 입력이 규칙에 어긋나거나 활성 기간 날짜가 올바르지 않을 때
   */
  async createTodo(
    userId: bigint,
    input: CreateTodoInput,
  ): Promise<TodoListItem> {
    // 날짜 문자열을 먼저 `Date`로 바꾼다. `@db.Date` 컬럼에 넘길 값을 손으로 만들면
    // 한국 시간대에서 하루 앞으로 밀려 저장되고 예외가 나지 않는다(`todo-local-date.ts`).
    const activeFrom = this.parseActiveDate('활성 시작일', input.activeFrom);
    const activeUntil = this.parseActiveDate('활성 종료일', input.activeUntil);

    this.assertShape({
      todoType: input.todoType,
      completeType: input.completeType,
      targetValue: input.targetValue ?? null,
      targetUnit: input.targetUnit ?? null,
      shouldDoAt: input.shouldDoAt ?? null,
      activeFrom,
      activeUntil,
    });

    // `?? null`로 못 박은 자리는 값을 주지 않았을 때 무엇이 저장되는지를 이 자리에서 읽게
    // 하려는 것이다. `undefined`로 둬도 결과는 같다 — Prisma가 그 컬럼을 빼고, 이 테이블의
    // 해당 컬럼들에는 기본값이 없다.
    const created = await this.templates.create({
      userId,
      title: input.title,
      description: input.description ?? null,
      todoType: input.todoType,
      completeType: input.completeType,
      remindAt: input.remindAt ?? null,
      shouldDoAt: input.shouldDoAt ?? null,
      targetValue: input.targetValue ?? null,
      targetUnit: input.targetUnit ?? null,
      activeFrom,
      activeUntil,
    });

    return toTodoListItem(created, null);
  }

  /**
   * 할 일의 내용을 고친다. **부분 갱신이다** — 주지 않은 필드는 저장된 값이 그대로 남는다.
   *
   * **`todoType`과 `completeType`은 고칠 수 없다.** 이미 쌓인 완료 기록을 해석하는 근거가
   * 그 두 값뿐이라서, 바꾸면 지나간 기록의 의미가 소급해 달라진다. `UpdateTodoInput`과
   * `UpdateTodoTemplateInput`이 양쪽에서 타입으로 막는다.
   *
   * **돌려주는 값이 없다.** 목록 항목 형태로 돌려주려면 완료 기록이 필요한데, 매일 반복은
   * 날짜마다 상태가 달라 어느 날짜의 것을 담을지에 답이 없다(`getTodo`의 매일 반복 갈래에
   * `progress`가 없는 것과 같은 이유다). 고친 뒤의 상태가 필요하면 `getTodo`를 부른다.
   *
   * @throws {NotFoundException} 그런 할 일이 없거나 남의 것일 때
   * @throws {BadRequestException} 바뀐 뒤의 형태가 규칙에 어긋날 때
   */
  async updateTodo(
    userId: bigint,
    todoId: bigint,
    input: UpdateTodoInput,
  ): Promise<void> {
    // 고치기 전에 반드시 읽는다. 이유가 둘이다 — 남의 할 일을 "없는 것"으로 거절하는
    // 것이 하나고, **검증이 저장된 `todoType`·`completeType`을 필요로 하는 것**이 다른
    // 하나다. 그 두 값은 입력에 없으므로 저장된 행에서만 얻을 수 있다.
    const stored = await this.templates.findById(userId, todoId);
    if (stored === null) {
      throw new NotFoundException(`그런 할 일이 없다 (todoId=${todoId})`);
    }

    const activeFrom = this.parseActiveDate('활성 시작일', input.activeFrom);
    const activeUntil = this.parseActiveDate('활성 종료일', input.activeUntil);

    // 검증은 **바뀐 뒤의 최종 상태**를 본다. 주지 않은 필드(`undefined`)에는 저장된 값이
    // 그대로 남으므로 그것을 넣고, `null`("비우라")은 그대로 쓴다. 입력만 보면 "숫자형
    // 할 일의 목표치를 비우는" 요청이 통과해 무엇을 채워야 완료인지 알 수 없게 된다.
    this.assertShape({
      todoType: stored.todoType,
      completeType: stored.completeType,
      targetValue:
        input.targetValue === undefined
          ? stored.targetValue
          : input.targetValue,
      targetUnit:
        input.targetUnit === undefined ? stored.targetUnit : input.targetUnit,
      shouldDoAt:
        input.shouldDoAt === undefined ? stored.shouldDoAt : input.shouldDoAt,
      activeFrom: activeFrom === undefined ? stored.activeFrom : activeFrom,
      activeUntil: activeUntil === undefined ? stored.activeUntil : activeUntil,
    });

    const data = omitUndefined<UpdateTodoTemplateInput>({
      title: input.title,
      description: input.description,
      remindAt: input.remindAt,
      shouldDoAt: input.shouldDoAt,
      targetValue: input.targetValue,
      targetUnit: input.targetUnit,
      // 파싱한 값을 넣는다. 입력이 `undefined`면 파싱하지 않아 `undefined`가 그대로
      // 남고 위 함수가 키를 빼낸다.
      activeFrom,
      activeUntil,
    });

    try {
      await this.templates.update(userId, todoId, data);
    } catch (error) {
      throw this.toTodoNotFound(error, todoId);
    }
  }

  /**
   * 할 일을 지운다. 행을 지우지 않고 삭제 시각을 적는 방식이고, 그 할 일의 완료 기록도
   * 함께 표시된다(`TodoTemplatesRepository.softDelete`).
   *
   * **지우기 전에 읽는다.** 없는 대상에 삭제를 부르면 Repository가 트랜잭션을 열어 두
   * 테이블을 건드린 뒤 되돌리는데, 미리 읽으면 그 왕복이 아예 없다. 그래도 아래 오류
   * 변환이 필요한 이유는 읽기와 삭제 사이에 지워질 수 있기 때문이다.
   *
   * @throws {NotFoundException} 그런 할 일이 없거나 남의 것일 때
   */
  async deleteTodo(userId: bigint, todoId: bigint): Promise<void> {
    const stored = await this.templates.findById(userId, todoId);
    if (stored === null) {
      throw new NotFoundException(`그런 할 일이 없다 (todoId=${todoId})`);
    }

    try {
      await this.templates.softDelete(userId, todoId);
    } catch (error) {
      throw this.toTodoNotFound(error, todoId);
    }
  }

  /**
   * 그날 달성한 진행값을 저장한다. 그 날짜의 기록이 없으면 만들어진다.
   *
   * **목표치를 채워도 완료로 찍지 않는다**(사용자 확정). 저장 하나가 두 가지 사실을 동시에
   * 바꾸면, 진행값을 잘못 입력해 목표를 넘겼을 때 완료가 딸려 오고 되돌리려면 두 번
   * 고쳐야 한다. 완료는 `completeTodo`가 받는 별도의 요청이다.
   *
   * **완료 시각을 갱신 대상에 넣지 않는다.** 이미 완료한 날의 진행값을 고쳐도 완료 표시가
   * 그대로 남는다 — 이 메서드가 답하는 사실이 "얼마나 했는가" 하나이기 때문이다.
   *
   * @throws {NotFoundException} 그런 할 일이 없거나 남의 것일 때, 타임존을 읽을 유저가 없을 때
   * @throws {BadRequestException} 일반(GENERAL) 할 일일 때
   */
  async saveProgress(
    userId: bigint,
    todoId: bigint,
    input: SaveProgressInput,
  ): Promise<TodoProgress> {
    const template = await this.readOwnTemplate(userId, todoId);

    // 일반 할 일에는 목표치를 둘 수 없으므로(`assertShape`) 진행값을 그릴 기준이 없다.
    // 저장해 두면 화면이 분모 없는 진행률을 만들려 하고, 그 값을 되돌릴 경로도 없다 —
    // 체크만 하는 할 일의 상태는 완료 여부 하나이고 그것은 `completeTodo`가 맡는다.
    if (template.todoType === 'GENERAL') {
      throw new BadRequestException(
        `이 종류의 할 일에는 진행값을 둘 수 없다 (todoType=${template.todoType})`,
      );
    }

    const historiedOn = await this.resolveHistoriedOn(
      userId,
      template,
      input.performedAt,
    );

    return this.writeHistoryOn(userId, template, historiedOn, {
      progressValue: input.progressValue,
    });
  }

  /**
   * 할 일을 완료로 표시한다. 그 날짜의 기록이 없으면 만들어진다 — 진행값 없이 완료만 찍는
   * 일반(GENERAL) 할 일이 그 경우다.
   *
   * **진행값을 갱신 대상에 넣지 않는다.** 이미 입력한 진행값이 그대로 남고
   * (`upsertForHistoriedOn`은 `changes`에 담은 것만 갱신한다), 목표치를 채우지 않은 채
   * 완료하는 것도 사용자의 선택이라 여기서 막지 않는다.
   *
   * @param performedAt 완료한 순간. **두 곳에 쓰인다** — 매일 반복이 어느 날짜의 기록인지
   *   정하는 값이고(일회성은 쓰지 않는다), 그대로 완료 시각으로 저장된다. 두 값을 따로
   *   받으면 8월 2일 기록에 8월 5일 완료 시각이 들어가는 조합이 만들어진다
   * @throws {NotFoundException} 그런 할 일이 없거나 남의 것일 때, 타임존을 읽을 유저가 없을 때
   */
  async completeTodo(
    userId: bigint,
    todoId: bigint,
    performedAt: Date,
  ): Promise<TodoProgress> {
    const template = await this.readOwnTemplate(userId, todoId);
    const historiedOn = await this.resolveHistoriedOn(
      userId,
      template,
      performedAt,
    );

    return this.writeHistoryOn(userId, template, historiedOn, {
      completedAt: performedAt,
    });
  }

  /**
   * 완료 표시를 지운다. **행을 지우는 것이 아니라 완료 시각을 비우는 수정이고** 진행값은
   * 그대로 남는다.
   *
   * 삭제가 아닌 이유는 일회성 할 일에 있다. 그쪽 날짜 키는 정의당 하나로 고정돼 기록
   * 슬롯이 평생 하나뿐이라, 취소가 삭제였다면 그 하나가 지워진 행에 막혀 **영영 완료할 수
   * 없는 할 일**이 된다(목록에는 계속 보이는데 체크가 안 된다).
   *
   * **그날 기록이 없으면 거절한다.** 저장 경로는 행이 없으면 만들기 때문에, 그대로 부르면
   * 진행값도 완료 시각도 빈 행이 생긴다. 그러면 "기록이 없다 = 아직 손대지 않았다"가
   * 성립하지 않아 손대지 않은 할 일과 구별되지 않는다.
   *
   * **기록이 있는지만 보고 완료 여부는 보지 않는다.** 이미 완료가 아닌 기록에 불러도
   * 거절하지 않는다 — 두 화면에서 취소를 두 번 누르는 것이 정상 조작이라, 그것을 오류로
   * 만들면 사용자가 취소에 실패한 것으로 읽는다.
   *
   * @param performedAt 어느 날짜의 기록을 취소하는지 정하는 순간. 매일 반복만 쓴다
   * @throws {NotFoundException} 할 일이 없거나 남의 것일 때, **그날 기록이 없을 때**,
   *   타임존을 읽을 유저가 없을 때
   */
  async uncompleteTodo(
    userId: bigint,
    todoId: bigint,
    performedAt: Date,
  ): Promise<TodoProgress> {
    const template = await this.readOwnTemplate(userId, todoId);
    const historiedOn = await this.resolveHistoriedOn(
      userId,
      template,
      performedAt,
    );

    const stored = await this.histories.findByTodoIdAndHistoriedOn(
      userId,
      todoId,
      historiedOn,
    );
    if (stored === null) {
      // **날짜를 메시지에 담지 않는다.** 일회성의 이 값은 표시용 날짜가 아니라 중복을 막는
      // 열쇠라서 밖으로 내보내지 않는다(`todo-local-date.ts`). 뷰 계층이 이력 항목 변환
      // 함수를 내보내지 않아 막아 둔 경로를, 오류 메시지가 우회하게 두지 않으려는 것이다.
      throw new NotFoundException(`취소할 완료 기록이 없다 (todoId=${todoId})`);
    }

    return this.writeHistoryOn(userId, template, historiedOn, {
      completedAt: null,
    });
  }

  /**
   * 요청자의 할 일 정의를 읽는다. 없거나 남의 것이면 **"없는 것"으로 거절한다** — 권한
   * 없음으로 구분해 알려 주면 번호를 훑어서 남이 어떤 할 일을 가졌는지 세어 볼 수 있다.
   *
   * **기록 쓰기 셋이 이것을 반드시 먼저 거친다.** 이유가 셋이다. 남의 할 일을 거르는 것이
   * 하나, 날짜 키와 목표치를 정의에서 얻어야 하는 것이 둘, **소유자로 좁혀 읽은 정의라야
   * 저장 경로에 넘길 소유자 값이 요청자와 같다는 것이 보장되는 것**이 셋이다
   * (`TodoHistorySnapshot`).
   *
   * @throws {NotFoundException} 그런 할 일이 없거나 남의 것일 때
   */
  private async readOwnTemplate(
    userId: bigint,
    todoId: bigint,
  ): Promise<TodoTemplate> {
    const template = await this.templates.findById(userId, todoId);
    if (template === null) {
      throw new NotFoundException(`그런 할 일이 없다 (todoId=${todoId})`);
    }

    return template;
  }

  /**
   * 기록을 쓸 날짜 키를 만든다. **`toHistoriedOn`이 유일한 통로다** — 반복 방식에 따라
   * 규칙이 완전히 다르고, 그 선택을 부르는 쪽에 맡기면 일회성에 매일 반복 규칙을 쓰는
   * 코드가 컴파일도 되고 테스트도 통과한다(`todo-local-date.ts`).
   *
   * **매일 반복만 유저 타임존을 읽는다.** 일회성 키는 정의 생성 시각의 UTC 날짜라 타임존이
   * 결과를 바꾸지 않으므로, 읽으면 조회가 하나 늘고 "탈퇴하지 않은 유저인지"가 기록 저장의
   * 성공 여부를 바꾸게 된다. `getTodo`의 일회성 갈래와 같은 판단이다.
   *
   * @throws {NotFoundException} 매일 반복인데 타임존을 읽을 유저가 없을 때
   */
  private async resolveHistoriedOn(
    userId: bigint,
    template: TodoTemplate,
    performedAt: Date,
  ): Promise<Date> {
    // 일회성 갈래에 넘기는 `'UTC'`는 결과에 영향을 주지 않는 자리 채우기다 —
    // `toHistoriedOn`이 그 갈래에서 이 값을 쓰지 않는다.
    const timeZone =
      template.completeType === 'DAILY'
        ? await this.readTimeZone(userId)
        : 'UTC';

    return toHistoriedOn({
      completeType: template.completeType,
      createdAt: template.createdAt,
      performedAt,
      timeZone,
    });
  }

  /**
   * 그 날짜의 기록에 바뀐 값을 쓰고 **결과 상태를 돌려준다.** 기록 쓰기 셋이 공유한다.
   *
   * @param userId **요청자의 식별자.** 정의 행의 소유자 컬럼을 복제하지 않는다 — 저장
   *   경로의 확인 조회가 이 값으로 정의를 찾아 소유자를 검사하므로, 정의에서 복제하면 그
   *   정의와 자기 자신을 비교하는 동어반복이 되어 아무것도 거르지 못한다. 위
   *   `readOwnTemplate`이 소유자로 좁혀 읽어 두 값이 같기는 하지만, **요청자를 넘기는
   *   형태를 지켜야** 좁히지 않고 읽는 코드가 생겨도 그 검사가 살아 있다
   *   (`TodoHistorySnapshot`)
   * @param changes 갱신할 값만 담는다. **담지 않은 값은 그대로 남는다**
   */
  private async writeHistoryOn(
    userId: bigint,
    template: TodoTemplate,
    historiedOn: Date,
    changes: TodoHistoryChanges,
  ): Promise<TodoProgress> {
    let saved: TodoHistory;
    try {
      saved = await this.histories.upsertForHistoriedOn(
        {
          todoId: template.todoId,
          userId,
          historiedOn,
          // 그날 기준의 목표치를 남긴다. 복사하지 않으면 목표를 5에서 8로 올렸을 때 5를
          // 채웠던 날의 달성률이 소급해 바뀐다. 새로 만들 때만 반영되므로 지나간 기록의
          // 목표치는 나중 변경에 흔들리지 않는다(`TodoHistorySnapshot`).
          targetValue: template.targetValue,
          targetUnit: template.targetUnit,
        },
        changes,
      );
    } catch (error) {
      throw this.toHistoryTargetNotFound(error, template.todoId);
    }

    // 저장 결과는 반드시 행 하나라서 `null` 갈래에 도달하지 않는다. 그래서 반환 타입을
    // `TodoProgress`로 좁혀 두었다 — `strictNullChecks`가 꺼져 있어 컴파일된다.
    return toProgress(saved);
  }

  /**
   * 할 일의 **최종 형태**가 규칙에 맞는지 본다.
   *
   * **만들기와 고치기가 이 함수 하나를 통과한다.** 규칙을 두 곳에 두면 한쪽만 고쳐지는
   * 날이 오고, 그러면 만들 때는 막히는 상태를 고쳐서 만들 수 있게 된다. 고치기는 입력과
   * 저장된 값을 합쳐 이 형태를 만든 뒤 넘긴다.
   *
   * @throws {BadRequestException} 규칙에 어긋날 때
   */
  private assertShape(shape: TodoShape): void {
    // 목표치는 값과 단위가 **한 쌍**이다. 한쪽만 있는 상태를 어느 종류에서도 만들지 않는
    // 이유는, 값만 있으면 화면이 무엇의 수량인지 말할 수 없고 단위만 있으면 채울 목표가
    // 없어서다. 그래서 개수를 세어 0이나 2만 허용한다.
    const targetGiven = [shape.targetValue, shape.targetUnit].filter(
      (value) => value != null,
    ).length;

    // 숫자형과 걸음수는 목표치를 채우는 것이 완료 조건이라 목표치가 없으면 무엇을 채워야
    // 완료인지 알 수 없다. 일반은 체크만 하는 할 일이라 반대로 목표치가 있으면 화면이
    // 진행률을 그리려 하는데 채울 값이 들어올 경로가 없다.
    const needsTarget =
      shape.todoType === 'NUMERIC' || shape.todoType === 'STEPS';

    if (needsTarget && targetGiven !== 2) {
      throw new BadRequestException(
        `이 종류의 할 일에는 목표치와 단위가 함께 필요하다 (todoType=${shape.todoType})`,
      );
    }
    if (!needsTarget && targetGiven !== 0) {
      throw new BadRequestException(
        `이 종류의 할 일에는 목표치를 둘 수 없다 (todoType=${shape.todoType})`,
      );
    }

    // 활성 기간은 매일 반복이 그날 목록에 나올지를 정하는 값이다. 일회성 목록은 날짜로
    // 거르지 않으므로(`findOnceWithoutCompletedHistory`) 저장해도 아무것도 하지 않는다 —
    // 조용히 무시하면 사용자는 기간이 걸린 줄 알고 기다린다.
    const activeRangeGiven = [shape.activeFrom, shape.activeUntil].some(
      (value) => value != null,
    );
    if (shape.completeType === 'ONCE' && activeRangeGiven) {
      throw new BadRequestException('일회성 할 일에는 활성 기간을 둘 수 없다');
    }

    // 예정일은 일회성을 언제까지 해야 하는지를 답하는 값이다. 매일 반복에는 뜻이 없다.
    if (shape.completeType === 'DAILY' && shape.shouldDoAt != null) {
      throw new BadRequestException('매일 반복 할 일에는 예정일을 둘 수 없다');
    }

    // 뒤집힌 활성 기간은 어느 날짜에도 활성이 아니라 목록에 영영 나오지 않는다. 오류가
    // 나지 않고 "만들었는데 보이지 않는" 상태가 되는 쪽이라 여기서 막는다.
    if (
      shape.activeFrom != null &&
      shape.activeUntil != null &&
      shape.activeFrom.getTime() > shape.activeUntil.getTime()
    ) {
      throw new BadRequestException('활성 기간의 시작일이 종료일보다 늦다');
    }
  }

  /**
   * 활성 기간 문자열을 `@db.Date` 컬럼에 넘길 UTC 자정 `Date`로 바꾼다.
   *
   * **`undefined`와 `null`을 바꾸지 않고 그대로 통과시킨다.** 고치기에서 앞은 "그대로
   * 두라"이고 뒤는 "비우라"라서 뜻이 다른데, 어느 쪽도 날짜로 바꿀 것이 없다. 여기서 둘을
   * `null` 하나로 뭉개면 부르는 쪽이 그 구분을 되찾을 방법이 없다.
   *
   * **두 갈래를 느슨한 비교 하나로 합칠 수 없다.** `tsconfig.json`이
   * `strictNullChecks: false`라서 반환 타입의 `| null | undefined`가 `Date`로 붕괴하고
   * 인자의 `string | null | undefined`도 `string`으로 붕괴한다. 그래서
   * `value == null ? value : …`는 `string`을 `Date` 자리에 반환하는 것이 되어
   * `TS2322`로 거절된다(실측). **그 구분을 지키는 것은 타입이 아니라 아래 두 문장이다.**
   */
  private parseActiveDate(
    label: string,
    value: string | null | undefined,
  ): Date | null | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (value === null) {
      return null;
    }

    return this.parseDateKey(label, value);
  }

  /**
   * 쓰기가 실패했을 때 던질 오류를 고른다. **`P2025`(고칠 행을 찾지 못했다)만
   * `NotFoundException`으로 바꾸고 나머지는 그대로 돌려준다.**
   *
   * 미리 `findById`로 읽어도 이 자리가 필요하다. 읽은 뒤 쓰기 사이에 그 할 일이 지워지면
   * 대상이 사라지고, 그때 Prisma 오류가 그대로 새어 나가 **클라이언트에게 500으로
   * 보인다** — 사용자가 두 화면에서 같은 할 일을 다루면 실제로 도달하는 경로다.
   *
   * **남의 할 일과 이미 지워진 할 일이 같은 코드로 온다.** 소유자 조건이 쿼리에 들어 있어
   * 둘 다 "대상을 찾지 못했다"가 되고, 구분해 알려 주지 않는 것이 의도다 — 권한 없음으로
   * 나누면 번호를 훑어서 남이 어떤 할 일을 가졌는지 세어 볼 수 있다.
   *
   * **다른 코드를 함께 바꾸지 않는다.** 진짜 장애를 "없는 할 일"로 위장시키면 원인을 찾을
   * 단서가 사라진다.
   */
  private toTodoNotFound(error: unknown, todoId: bigint): unknown {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_RECORD_NOT_FOUND
    ) {
      return new NotFoundException(`그런 할 일이 없다 (todoId=${todoId})`);
    }

    return error;
  }

  /**
   * 기록 쓰기가 실패했을 때 던질 오류를 고른다. **Repository의 도메인 오류 둘만
   * `NotFoundException`으로 바꾸고 나머지는 그대로 돌려준다.**
   *
   * **두 오류를 같은 응답으로 합친다.** 지워진 행이 실제로 있다는 사실을 알려 주면 번호를
   * 훑어서 남이 어떤 할 일을 가졌는지 세어 볼 수 있고, 사용자가 할 수 있는 일도 같다.
   * 대신 **원본 메시지를 로그에 남긴다** — 오타로 잘못된 번호를 보낸 것과 실제로 지워진
   * 행이 있는 것은 원인을 찾는 사람에게 다른 사실이고, 두 오류를 따로 둔 값어치가 거기에
   * 있다(`todo-errors.ts`).
   *
   * `instanceof`로 판별한다. 메시지 문자열로 구분하면 문구를 다듬는 순간 조용히 깨진다.
   *
   * **`P2025`(고칠 행을 찾지 못했다)를 여기서 다루지 않는다.** 저장이 없으면 만드는
   * 동작이라 고칠 행을 찾지 못하는 경우가 없고, 도달하지 않는 분기를 넣으면 그것이 무엇을
   * 막는지 아무도 확인할 수 없다.
   */
  private toHistoryTargetNotFound(error: unknown, todoId: bigint): unknown {
    if (
      error instanceof TodoTemplateNotFoundError ||
      error instanceof TodoTemplateDeletedError
    ) {
      // 클라이언트가 대상을 잘못 가리킨 것이므로 `error`가 아니라 `warn`이다.
      this.logger.warn(error.message);

      return new NotFoundException(`그런 할 일이 없다 (todoId=${todoId})`);
    }

    return error;
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

    const from = this.parseDateKey('기간 범위의 시작일', range.from);
    const until = this.parseDateKey('기간 범위의 종료일', range.until);

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
   * **날짜 한 쪽씩 나눠 부르는 이유가 둘이다.** 어느 값이 문제인지 응답에 담을 수 있고,
   * `catch`가 검사 대상을 **다시 읽지 않는다** — 인자로 이미 받은 값을 쓰므로 오류를
   * 다루는 자리가 스스로 던질 여지가 없다.
   *
   * **자리 이름을 인자로 받아 기간 범위와 활성 기간이 같은 함수를 쓴다.** 둘 다
   * `YYYY-MM-DD` 문자열을 `@db.Date` 컬럼용 `Date`로 바꾸는 같은 일이고, 다른 것은 응답에
   * 실을 이름뿐이다.
   *
   * @param label 응답에 실을 자리 이름. 어느 값이 어긋났는지 알려 준다. 그대로 문장의
   *   주어가 되므로 `'기간 범위의 시작일'`처럼 완결된 이름을 넘긴다
   */
  private parseDateKey(label: string, value: string): Date {
    try {
      return parseLocalDateKey(value);
    } catch (error) {
      // 원인을 삼키지 않는다. 어떻게 어긋났는지가 이 메시지에 있고 그것을 응답이 아니라
      // 로그에 남긴다 — 클라이언트 입력 오류이므로 `error`가 아니라 `warn`이다.
      this.logger.warn(
        `${label}을 해석할 수 없다: ${(error as Error).message}`,
      );

      throw new BadRequestException(`${label}이 올바르지 않다 (${value})`);
    }
  }
}
