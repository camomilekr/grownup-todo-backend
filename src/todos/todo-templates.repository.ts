import { Injectable } from '@nestjs/common';
import type { Prisma, TodoTemplate } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 할 일을 새로 만들 때 받는 값. 번호와 시각 컬럼은 DB가 채운다.
 *
 * **완료 기록으로 이어지는 중첩 관계 입력(`histories`)도 뺐다.** 남겨 두면 정의를
 * 만드는 이 경로로 기록을 함께 삽입할 수 있고, 그러면 날짜 키를 만드는 유일한
 * 통로(`toHistoriedOn`)와 저장 통로(`upsertForHistoriedOn`)를 둘 다 지나지 않는
 * 기록이 생긴다. 일회성 할 일에서 특히 나쁘다 — 그 날짜 키는 중복을 막는
 * 열쇠이고, 다른 값이 들어가면 기록이 둘 생겨 목록에 어느 것이 잡히는지 정해지지
 * 않는다.
 */
export type CreateTodoTemplateInput = Omit<
  Prisma.TodoTemplateUncheckedCreateInput,
  'todoId' | 'createdAt' | 'updatedAt' | 'deletedAt' | 'histories'
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
 * **완료 기록으로 이어지는 중첩 관계 입력(`histories`)도 뺐다.** 이쪽이 가장 위험하다 —
 * 그 중첩 입력에는 `deleteMany`가 들어 있어서, **개별적으로 지울 수 없어야 하는 완료
 * 기록이 삭제 표시(`deletedAt`)조차 남기지 않고 행째로 사라진다.** 기록을 지우는 개별
 * 메서드를 두지 않은 것만으로는 그 금지가 성립하지 않았다.
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
  | 'histories'
>;

/**
 * 완료 기록이 함께 붙어 오는 정의 행. 목록 조회 둘이 이 형태를 돌려준다.
 *
 * **어떤 기록이 붙는지는 메서드마다 다르고 배열 길이는 둘 다 0개 또는 1개다.** 매일
 * 반복은 그날 기록, 일회성은 그 할 일의 유일한 기록이다 — 근거는 각 메서드 주석에 있다.
 *
 * 두 메서드에 이름이 다른 타입을 주지 않았다. 구조가 같으면 서로 대입되므로 이름만
 * 다르게 두는 구분은 환상이고, 매일 반복 조회 결과를 일회성 목록 자리에 넣어도
 * 컴파일된다. 구분이 필요한 것은 **무엇이 붙었는가**이고 그것은 문서가 맡는다.
 */
export type TodoTemplateWithHistories = TodoTemplate & {
  histories: Prisma.TodoHistoryGetPayload<object>[];
};

/**
 * `todo_template` 테이블 접근.
 *
 * **판단하지 않고 조회 조건만 담는다.** "완료했는가"를 계산하거나 "무엇을 보여 줄지"를
 * 정하는 것은 위 계층(Service)의 몫이다 — `findDailyActiveAt`이 그날 기록을 붙여 주기만
 * 하고 완료 여부를 따지지 않는 것이 그 경계를 보여 준다.
 *
 * **조회와 수정 모두 삭제되지 않은 행만 대상으로 한다.** 조회에서는 보이지 않는데 수정은
 * 되는 상태를 만들지 않기 위해서다. 삭제된 할 일을 고치거나 다시 삭제하려 하면 Prisma가
 * "고칠 행을 찾지 못했다"는 오류를 낸다.
 *
 * **이미 있는 행을 다루는 메서드는 소유자를 위치 인자로 받아 쿼리 조건에 넣는다**
 * (`findById`·`update`·`softDelete`와 목록 조회 둘). 소유자 검사를 위 계층의 "조회한 뒤
 * 비교"에 맡기지 않는 이유는, 비교를 빠뜨린 경로가 하나 생기면 그곳으로 남의 데이터가
 * 전부 새기 때문이다. 조건이 인자로 들어가 있으면 **빠뜨리는 것 자체가 컴파일되지
 * 않는다.**
 *
 * **`create`는 예외이고 그럴 수밖에 없다.** 소유자를 `data.userId`로 받아 **조건이 아니라
 * 삽입할 값으로** 쓴다. 새로 만드는 행의 소유자를 정하는 자리라서 견줄 기존 행이 없고,
 * 그래서 이 계층에는 검사할 것이 없다 — **요청자의 식별자를 넣는 것은 부르는 쪽의
 * 책임이다.** 아무 소유자로나 만들 수 있다는 뜻이고, 실제로 `test/todos.e2e-spec.ts`가
 * 그 성질을 써서 남의 소유 할 일을 만들어 소유자 경계를 검증한다.
 *
 * **남의 할 일은 "없는 것"과 같게 다룬다.** 조회는 `null`, 수정과 삭제는 대상을 찾지 못해
 * 거절된다. 권한 없음으로 구분해 알려 주면 번호를 훑어서 남이 어떤 할 일을 가졌는지
 * 세어 볼 수 있다.
 */
@Injectable()
export class TodoTemplatesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: CreateTodoTemplateInput): Promise<TodoTemplate> {
    return this.prisma.todoTemplate.create({ data });
  }

  /** 남의 할 일이거나 삭제된 할 일이면 `null`이다. */
  async findById(userId: bigint, todoId: bigint): Promise<TodoTemplate | null> {
    // 단건 조회(`findUnique`)가 아니라 `findFirst`를 쓴다. 유일 제약에 `deletedAt`이
    // 들어 있지 않아서, 단건 조회로는 "삭제되지 않은 것만"이라는 조건을 걸 수 없다.
    return this.prisma.todoTemplate.findFirst({
      where: { todoId, userId, deletedAt: null },
    });
  }

  /**
   * 삭제된 할 일은 고칠 수 없다. 대상이 없으면 Prisma가 오류를 낸다.
   *
   * **남의 할 일도 같은 오류로 거절된다.** 소유자가 조건에 들어가 있어 대상 행을 찾지
   * 못하기 때문이다 — 조회한 뒤 소유자를 비교하는 방식과 달리 위 계층이 검사를 빠뜨릴
   * 여지가 없다.
   */
  async update(
    userId: bigint,
    todoId: bigint,
    data: UpdateTodoTemplateInput,
  ): Promise<TodoTemplate> {
    return this.prisma.todoTemplate.update({
      where: { todoId, userId, deletedAt: null },
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
   *
   * **소유자 조건을 기록 쪽에도 넣는다. 다만 그것은 방어적 중복이고, 어떤 테스트로도
   * 고정되지 않는다.**
   *
   * 정의 쪽 수정이 트랜잭션의 첫 연산이라 남의 할 일이면 그 자리에서 `P2025`(고칠 행을
   * 찾지 못했다)로 실패하고 통째로 되돌아간다. 그래서 **기록 쪽 조건을 빼도 남의 기록에
   * 손이 닿지 않는다** — 실제로 빼고 돌려 확인했고 관련 e2e 테스트가 그대로 통과했다.
   * 조건이 실질적으로 필요해지는 것은 트랜잭션을 벗기거나 두 연산의 순서를 뒤집을 때다.
   *
   * 그래도 남겨 두는 이유는 **비용이 0이고**(같은 조건 하나) 그 순서에 의존하지 않는
   * 상태를 만들기 때문이다. 이 문장 하나만 떼어 놓고 보면 남의 기록을 지울 수 있는
   * `updateMany`이고, 나중에 누가 트랜잭션 구조를 바꿀 때 그 위험이 되살아난다.
   *
   * 그 조건만 검증하는 테스트는 두지 않았다. 실패하게 만들려면 구현 내부 구조를 조작해야
   * 하고 그것은 동작이 아니라 구현 방식을 검사하는 것이다 — 근거는
   * `test/todos.e2e-spec.ts`의 "남의 할 일을 삭제 시도해도" 테스트 주석에 있다.
   *
   * 기록의 소유자가 정의의 소유자와 같다는 것은 복합 외래키가 보장한다.
   */
  async softDelete(userId: bigint, todoId: bigint): Promise<TodoTemplate> {
    const deletedAt = new Date();

    const [template] = await this.prisma.$transaction([
      this.prisma.todoTemplate.update({
        where: { todoId, userId, deletedAt: null },
        data: { deletedAt },
      }),
      this.prisma.todoHistory.updateMany({
        where: { todoId, userId, deletedAt: null },
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
   *
   * **기록을 함께 돌려준다.** 목록이 진행률을 그려야 하는데 기록을 따로 조회하면 목록
   * 길이만큼 쿼리가 늘고, 어느 기록이 어느 할 일 것인지 맞추는 코드가 부르는 쪽에 생긴다.
   *
   * **붙는 기록은 0개 또는 1개다. 그 전제에 근거가 있고, 깨질 수 있다.**
   *
   * 근거는 둘이 맞물린 것이다. `@@unique([todoId, historiedOn])`이 같은 할 일에 같은
   * 날짜의 기록을 하나로 제한하고, 일회성의 `historiedOn`은 정의 생성 시각에서 나와
   * **정의당 하나로 고정된다**(`todo-local-date.ts`의 `toHistoriedOn`). 날짜가 하나뿐이니
   * 그 조합도 하나뿐이고, 따라서 행도 최대 하나다. **그래서 `orderBy`가 필요 없다** —
   * 여러 건이 올 수 없으므로 순서를 정할 것이 없다.
   *
   * 깨지는 조건은 하나다. **저장 경로가 `toHistoriedOn`을 거치지 않고 다른 날짜를 넣으면**
   * 같은 일회성 할 일에 여러 행이 생기고, 그때 부르는 쪽이 첫 항목만 읽으면 어느 것이
   * 잡히는지 정해지지 않는다. 그 통로는 `TodoHistoriesRepository.upsertForHistoriedOn`
   * 하나이고 날짜를 인자로 받으므로, **이 조건은 타입이 아니라 규약이 지킨다.**
   *
   * 아래 `where`의 필터 조건(`histories.none`)은 그대로 둔다 — 그것이 목록 규칙 자체이고,
   * `include`가 보는 것과 다른 질문에 답한다. 필터는 "완료된 기록이 있는가"를 묻고
   * `include`는 "삭제되지 않은 기록을 달아 달라"고 한다.
   */
  async findOnceWithoutCompletedHistory(
    userId: bigint,
  ): Promise<TodoTemplateWithHistories[]> {
    return this.prisma.todoTemplate.findMany({
      where: {
        userId,
        deletedAt: null,
        completeType: 'ONCE',
        histories: {
          none: { deletedAt: null, completedAt: { not: null } },
        },
      },
      include: { histories: { where: { deletedAt: null } } },
      // `createdAt`은 밀리초까지만 저장하므로 빠르게 연속 생성하거나 한 트랜잭션에서
      // 여러 건을 만들면 값이 겹칠 수 있다. 그때 정렬키가 하나뿐이면 순서를 DB가
      // 정하게 되어 같은 조회가 실행할 때마다 다른 차례로 나올 수 있다. 유일 키를
      // 2차 정렬키로 두면 겹쳐도 순서가 하나로 정해진다.
      orderBy: [{ createdAt: 'asc' }, { todoId: 'asc' }],
    });
  }

  /**
   * 주어진 순간에 **활성인** 매일 반복(DAILY) 할 일과 그날의 완료 기록.
   *
   * 사용자가 확정한 규칙: 어제 하지 않아 기록이 없으면 어제는 그대로 미완료로 남고,
   * 오늘은 오늘대로 다시 목록에 나온다. **밀린 일이 오늘로 넘어오지 않는다.** 그래서
   * 조건이 "그 순간 활성인가"일 뿐이고 기록이 있는지는 조건이 아니다.
   *
   * **활성 판정은 요청 순간과 활성 기간을 그대로 비교한다**(`activeFrom <= at <=
   * activeUntil`, 사용자 확정). 서버는 그 두 값에 날짜 의미를 부여하지 않는다 — 시간
   * 해석은 클라이언트의 몫이고, "그날 활성"이 아니라 "그 순간 활성"이다. 양 끝을
   * 포함하고, 값이 비어 있으면 그쪽 제한이 없다는 뜻이다(시작이 없으면 언제부터든,
   * 종료가 없으면 기한 없이).
   *
   * **판정하는 값과 기록을 찾는 값이 다르다.** 활성은 순간(`at`)으로 판정하고, 붙여 줄
   * 기록은 유저 타임존 기준 날짜(`historiedOn`)로 찾는다 — 기록의 키가 날짜 컬럼이기
   * 때문이다. 두 값은 보통 같은 요청 순간에서 나온다(Service의 `listDailyOn`).
   *
   * `histories`에는 그날 기록만 0개 또는 1개가 붙는다. 여기서는 근거가 더 단단하다 —
   * 날짜를 `where`로 못 박으므로 `@@unique([todoId, historiedOn])`이 **직접** 한 건을
   * 보장한다(일회성 목록은 날짜를 고정하지 못해 저장 경로의 규약에 의존한다).
   * **완료 여부를 판정하지 않는다** — 이 계층은 완료 시각을 읽지 않고 붙여 주기만 한다.
   *
   * @param at 활성 판정의 기준 순간(보통 요청이 도착한 시각)
   * @param historiedOn 붙여 줄 기록의 유저 타임존 기준 날짜. `toLocalDateKey`로 만든다
   */
  async findDailyActiveAt(
    userId: bigint,
    at: Date,
    historiedOn: Date,
  ): Promise<TodoTemplateWithHistories[]> {
    return this.prisma.todoTemplate.findMany({
      where: {
        userId,
        deletedAt: null,
        completeType: 'DAILY',
        AND: [
          { OR: [{ activeFrom: null }, { activeFrom: { lte: at } }] },
          { OR: [{ activeUntil: null }, { activeUntil: { gte: at } }] },
        ],
      },
      include: {
        histories: { where: { historiedOn, deletedAt: null } },
      },
      // `createdAt`은 밀리초까지만 저장하므로 빠르게 연속 생성하거나 한 트랜잭션에서
      // 여러 건을 만들면 값이 겹칠 수 있다. 그때 정렬키가 하나뿐이면 순서를 DB가
      // 정하게 되어 같은 조회가 실행할 때마다 다른 차례로 나올 수 있다. 유일 키를
      // 2차 정렬키로 두면 겹쳐도 순서가 하나로 정해진다.
      orderBy: [{ createdAt: 'asc' }, { todoId: 'asc' }],
    });
  }
}
