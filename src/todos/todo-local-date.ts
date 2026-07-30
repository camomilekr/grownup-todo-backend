// 타입만 가져온다. 런타임 값(`CompleteType.ONCE`)을 쓰지 않고 문자열 리터럴로
// 비교하므로 이 파일은 여전히 Prisma 런타임에 의존하지 않는다 — 그래도 스키마의
// enum과는 타입으로 묶여 있어 값이 늘면 여기서 걸린다.
import type { CompleteType } from '../generated/prisma/enums';

/**
 * 어떤 순간이 유저 타임존에서 **며칠인지**를 계산해 날짜 키로 돌려준다.
 *
 * DAILY 히스토리의 `historied_on`과, "오늘 달성해야 할 항목" 조회에 넘길 오늘 날짜가
 * 이 함수로 만들어진다. **히스토리 키를 직접 만들 때는 이것을 쓰지 말고
 * `toHistoriedOn`을 써라** — ONCE는 규칙이 다르다.
 *
 * "그 날짜"를 정하는 주체를 이 함수 하나로 고정한다. Repository는 계산하지 않고
 * 결과를 인자로 받는다 — 같은 계산이 두 곳에 생기면 한쪽만 고쳐진 순간 유니크
 * 키가 갈라져 하루에 두 개의 history가 생긴다.
 *
 * 반환값은 **UTC 자정**을 가리키는 `Date`다. `@prisma/adapter-pg`가 `@db.Date`
 * 컬럼에 넘길 값을 `getUTCFullYear`/`getUTCMonth`/`getUTCDate`로 직렬화하기
 * 때문이다. 로컬 타임존 자정으로 만들면 UTC 컴포넌트가 전날이 되어 하루가 밀린다.
 *
 * @param instant 기준 순간 (보통 요청이 도착한 시각)
 * @param timeZone IANA 타임존 이름. `AppUser.timeZone`이 이 값을 들고 있다
 * @throws {RangeError} `instant`가 유효하지 않거나 `timeZone`이 알 수 없는 이름일 때
 */
export function toLocalDateKey(instant: Date, timeZone: string): Date {
  if (Number.isNaN(instant.getTime())) {
    // Invalid Date를 그대로 통과시키면 Invalid Date 키가 만들어져 DB 저장
    // 시점에야 터진다. 값이 들어온 자리에서 막는다.
    throw new RangeError(
      'toLocalDateKey: 유효하지 않은 Date가 넘어왔다 (Invalid Date)',
    );
  }

  // 알 수 없는 타임존 이름이면 이 생성자가 RangeError를 던진다. 조용히 UTC로
  // 떨어뜨리지 않는 것이 중요하다 — 그러면 그 유저의 날짜가 전부 하루씩 어긋난
  // 채 저장되고, 원인은 데이터가 쌓인 뒤에 드러난다.
  //
  // `calendar: 'gregory'`를 못 박는다. 로케일을 생략하면 실행 환경의 기본
  // 로케일이 쓰이고, 그중에는 그레고리력이 아닌 것도 있어 연도가 달라진다.
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // 포맷된 **문자열**을 파싱하지 않고 부품을 뽑는다. 문자열은 로케일마다 순서와
  // 구분자가 달라 파싱이 조용히 깨진다.
  const partsByType = new Map(
    formatter
      .formatToParts(instant)
      .map((part) => [part.type, part.value] as const),
  );

  // year·month·day는 위 옵션으로 요청했으므로 ECMA-402가 반환을 보장한다.
  const year = Number(partsByType.get('year'));
  const month = Number(partsByType.get('month'));
  const day = Number(partsByType.get('day'));

  return new Date(Date.UTC(year, month - 1, day));
}

/** `toHistoriedOn`의 입력. */
export type HistoriedOnSource = {
  /** template의 `completeType`. 이 값이 규칙을 고른다 */
  completeType: CompleteType;
  /** template의 생성 시각. ONCE 키의 유일한 재료다 */
  createdAt: Date;
  /** 수행 시각(보통 요청이 도착한 시각). DAILY 키의 재료다 */
  performedAt: Date;
  /** 유저 타임존(`app_user.time_zone`). DAILY에만 쓰인다 */
  timeZone: string;
};

/**
 * `todo_history.historied_on`에 넣을 날짜 키를 만든다. **히스토리 키를 만드는 유일한
 * 진입점이다** — `completeType`에 따라 규칙이 완전히 다르고, 그 선택을 호출자에게
 * 맡기면 ONCE에 DAILY 규칙을 쓰는 코드가 타입체크·lint·테스트를 전부 통과한다.
 *
 * | `completeType` | 무엇에서 파생하는가 | 타임존 |
 * |---|---|---|
 * | `DAILY` | 수행 시각 | **유저 타임존.** 이 값이 곧 유저에게 보여 주는 날짜다 |
 * | `ONCE`  | template 생성 시각 | **UTC 고정.** 표시용이 아니라 중복 방지 키다 |
 *
 * **ONCE가 `createdAt`만 쓰는 이유.** 사용자 정의상 ONCE 히스토리는 한 건만 생겨야
 * 하는데 DB 제약은 `@@unique([todoId, historiedOn])` 하나다. 그래서 이 키가 움직이지
 * 않는 것이 단건성의 유일한 근거이고, 움직일 수 있는 입력을 **전부** 배제해야 한다.
 * `createdAt`은 `@default(now())`이고 `@updatedAt`이 아니라 절대 변하지 않는다 —
 * 반면 `shouldDoAt`은 수정 가능한 컬럼이고 `timeZone`은 유저가 언제든 바꾸는 설정이다.
 * **결과적으로 ONCE 키에는 가변 입력이 하나도 없다.**
 *
 * **대가**: ONCE의 `historied_on`은 유저가 보는 날짜와 무관한 식별자다. 실질 비용은
 * 없다 — ONCE 목록은 "완료 히스토리가 있는가"만 보고 **날짜로 필터하지 않으며**,
 * 예정일은 `shouldDoAt`이, 완료 시점은 `completedAt`이 답한다. 다만 **ONCE를 날짜별로
 * 묶어 보여 주는 데 이 컬럼을 쓰지 마라.**
 */
export function toHistoriedOn({
  completeType,
  createdAt,
  performedAt,
  timeZone,
}: HistoriedOnSource): Date {
  // 이름 있는 객체로 받는다. `createdAt`·`performedAt`이 둘 다 `Date`라 위치 인자로
  // 두면 순서를 바꿔 넣어도 컴파일되고, 결과가 "그럴듯하게 잘못된 날짜"가 된다.
  return completeType === 'ONCE'
    ? toLocalDateKey(createdAt, 'UTC')
    : toLocalDateKey(performedAt, timeZone);
}

/** `YYYY-MM-DD` 형식만 받는다. 앞뒤 공백도 허용하지 않는다. */
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `"2026-08-01"` 같은 날짜 문자열을 `@db.Date` 컬럼에 넣을 UTC 자정 `Date`로 바꾼다.
 *
 * `activeFrom`/`activeUntil`은 **사용자가 고르는 날짜**라 "순간"이 없고
 * `toLocalDateKey`로 만들 수 없다. 그런데 `@db.Date` 컬럼에 넘긴 `Date`는 어댑터가
 * UTC 컴포넌트로 직렬화하므로, 손으로 만들면 조용히 하루가 밀린다 — KST에서
 * `new Date(2026, 7, 1).toISOString()`은 `2026-07-31T15:00:00.000Z`이고, 저장되는
 * 값은 `2026-07-31`이다. 어떤 예외도 나지 않아 DAILY todo가 하루 일찍 활성화된다.
 *
 * `new Date('2026-08-01')`이 마침 UTC 자정으로 파싱되는 것에 기대지 않는다. 그 동작은
 * 문자열 형식에 따라 갈리고(`'2026-8-1'`은 구현 정의 동작으로 로컬 시각이 된다),
 * 존재하지 않는 날짜를 조용히 넘겨 버린다.
 *
 * @throws {RangeError} 형식이 `YYYY-MM-DD`가 아니거나 달력에 없는 날짜일 때
 */
export function parseLocalDateKey(isoDate: string): Date {
  const matched = DATE_KEY_PATTERN.exec(isoDate);
  if (!matched) {
    throw new RangeError(
      `parseLocalDateKey: 날짜 형식이 YYYY-MM-DD가 아니다 (${isoDate})`,
    );
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);

  const key = new Date(Date.UTC(year, month - 1, day));

  // `Date.UTC`는 범위를 넘는 값을 조용히 넘긴다 — 2026-02-30은 03-02가 되고
  // 2026-13-01은 2027-01-01이 된다. 넣은 값이 그대로 돌아왔는지 확인해서 막는다.
  // 막지 않으면 사용자가 잘못 보낸 날짜가 다른 날짜로 저장된다.
  if (
    key.getUTCFullYear() !== year ||
    key.getUTCMonth() !== month - 1 ||
    key.getUTCDate() !== day
  ) {
    throw new RangeError(`parseLocalDateKey: 달력에 없는 날짜다 (${isoDate})`);
  }

  return key;
}
