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

/**
 * 유저 타임존에서 `at`의 **다음 달력 날짜가 시작되는 최초의 순간**을 돌려준다.
 * 매일 반복 할 일의 마감 순간이 이 값이다 — "오늘까지"의 끝이 곧 다음 날짜의 시작이다.
 *
 * **계약을 "다음 자정"으로 두지 않았다.** DST(일광 절약 시간) 전환일에는 자정이
 * 없거나 두 번 있기 때문이다 — `America/Santiago`의 봄 전환은 시계가 00:00을
 * 건너뛰어 그날이 01:00에 시작하고, `America/Havana`의 가을 전환은 00:00~01:00이
 * 두 번 온다. "다음 달력 날짜의 최초 순간"은 두 경우를 모두 흡수한다 — 없으면
 * 그날의 첫 순간(01:00), 두 번이면 이른 쪽이다.
 *
 * **구현은 오프셋 역산이 아니라 `toLocalDateKey` 기준의 이진 탐색이다.** 벽시계
 * 자정에서 순간을 역산하면 위 두 경우와 비정수 오프셋(`Asia/Kathmandu` +05:45)을
 * 각각 따로 다뤄야 하는데, "로컬 날짜가 다음 날이 되는 최초 순간"을 직접 찾으면
 * 정의가 곧 구현이라 그 경우들이 저절로 맞는다. 탐색 폭이 48시간(밀리초 단위)이라
 * 반복이 28회 남짓이고, 요청당 한 번 부르는 자리라 비용 문제가 없다.
 *
 * 반환값은 항상 `at`보다 **엄격히 뒤다.** `at`이 자정 정각이어도 다음 날의 시작을
 * 돌려준다 — 같은 순간을 돌려주면 마감이 "이미 지난" 것으로 읽힌다.
 *
 * @param at 기준 순간 (보통 요청이 도착한 시각)
 * @param timeZone IANA 타임존 이름. `AppUser.timeZone`이 이 값을 들고 있다
 * @throws {RangeError} `at`이 유효하지 않거나 `timeZone`이 알 수 없는 이름일 때
 */
export function toNextLocalDayStart(at: Date, timeZone: string): Date {
  // 유효성 검사를 겸한다 — Invalid Date와 알 수 없는 타임존은 여기서 던진다.
  const currentKey = toLocalDateKey(at, timeZone);

  // 다음 달력 날짜의 키. 날짜 키는 UTC 자정 `Date`라 하루치 밀리초를 더하면 된다 —
  // 이 덧셈은 키 공간(UTC)의 산술이고, 타임존의 하루 길이(23~25시간)와 무관하다.
  const targetKeyTime = currentKey.getTime() + MILLISECONDS_PER_DAY;

  // 불변식 — `low`의 로컬 날짜는 아직 오늘이고, `high`의 로컬 날짜는 다음 날
  // 이상이다. `at`+48시간이면 DST로 한 시간이 되돌아가도 로컬 시계가 47시간은
  // 나아가므로 날짜가 반드시 넘어가 있다.
  //
  // 로컬 날짜는 순간에 대해 단조 증가다(가을 전환도 시계를 자정 너머로 되돌리지는
  // 않는다 — Havana 실측에서 확인). 그래서 "처음으로 다음 날이 되는 순간"을 이진
  // 탐색으로 찾을 수 있다.
  let low = at.getTime();
  let high = at.getTime() + 2 * MILLISECONDS_PER_DAY;

  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);

    // 목표 날짜를 건너뛰는 타임존 변경(달력에서 하루가 통째로 사라진 사례가 실제로
    // 있다)까지 견디도록 등호가 아니라 `>=`로 비교한다 — 그때의 답은 "그다음으로
    // 시작되는 날짜의 최초 순간"이다.
    if (toLocalDateKey(new Date(middle), timeZone).getTime() >= targetKeyTime) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return new Date(high);
}

/** `YYYY-MM-DD` 형식만 받는다. 앞뒤 공백도 허용하지 않는다. */
const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `"2026-08-01"` 같은 날짜 문자열을 `@db.Date` 컬럼에 넣을 UTC 자정 `Date`로 바꾼다.
 *
 * 이력 조회 범위(`TodoHistoryRange`)처럼 **사용자가 고르는 날짜**는 "순간"이 없어
 * `toLocalDateKey`로 만들 수 없다. 그런데 `@db.Date` 컬럼과 비교되는 `Date`는 어댑터가
 * UTC 컴포넌트로 직렬화하므로, 손으로 만들면 조용히 하루가 밀린다 — KST에서
 * `new Date(2026, 7, 1).toISOString()`은 `2026-07-31T15:00:00.000Z`이고, 비교되는
 * 값은 `2026-07-31`이다. 어떤 예외도 나지 않아 어긋난 기간의 기록이 돌아온다.
 * (활성 기간은 순간 컬럼이 되면서 이 함수의 용례에서 빠졌다 — 시간 해석은
 * 클라이언트의 몫이다.)
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

/** 하루의 밀리초. UTC 자정인지를 나머지 연산으로 판별하는 데 쓴다 */
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * 그 `Date`가 **날짜 컬럼(`@db.Date`)에 넣어도 되는 값인지** 확인한다. 어긋나면 던지고
 * 맞으면 아무것도 하지 않는다.
 *
 * **이 검사가 필요한 이유는 어긋난 값이 조용히 통과하기 때문이다.** 어댑터가 `@db.Date`
 * 컬럼에 넘길 값을 `getUTCFullYear`/`getUTCMonth`/`getUTCDate`로 직렬화하므로, UTC 자정이
 * 아닌 `Date`를 넘기면 시각 부분이 잘려 나가면서 날짜가 어긋난다 — 한국 시간대에서
 * `new Date(2026, 7, 1)`은 `2026-07-31T15:00:00.000Z`이고 비교되는 값은 `2026-07-31`이다.
 * **예외가 하나도 나지 않아** 이력 조회 범위가 하루 밀린 채 결과가 돌아오고 어떤
 * 테스트도 잡지 못한다.
 *
 * 시각 컬럼(`Timestamptz`)인 `completedAt`·`shouldDoAt`을 실수로 넘기는 경우도 같은
 * 검사에 걸린다. 그쪽은 UTC 기준 날짜가 나오는데 그 값이 유저 타임존 기준 날짜와
 * 어긋나서, 한국 시간대 오전에 완료한 기록은 맞아 보이다가 **저녁에 완료한 기록에서만
 * 하루 어긋난다.**
 *
 * **값이 없는 경우도 `RangeError`로 거절한다.** `tsconfig.json`이
 * `strictNullChecks: false`라 `undefined`를 넘기는 호출을 컴파일러가 막지 못하는데,
 * 그대로 두면 `undefined.getTime()`이 `TypeError`가 된다. **어긋난 입력을 오류 종류
 * 하나로 모으는 것**이 이 검사의 값어치다 — `Cannot read properties of undefined
 * (reading 'getTime')`은 무엇을 잘못 넘겼는지 말해 주지 않고, 이 함수를 잡지 않는
 * 경로(`formatLocalDateKey`)에서는 그 문구가 그대로 500 응답의 원인 기록이 된다.
 *
 * @throws {RangeError} 값이 없거나, 유효하지 않은 `Date`거나, UTC 자정이 아닐 때
 */
export function assertLocalDateKey(dateKey: Date): void {
  if (dateKey == null) {
    throw new RangeError(
      'assertLocalDateKey: 날짜가 없다 (null 또는 undefined)',
    );
  }

  if (Number.isNaN(dateKey.getTime())) {
    throw new RangeError(
      'assertLocalDateKey: 유효하지 않은 Date가 넘어왔다 (Invalid Date)',
    );
  }

  if (dateKey.getTime() % MILLISECONDS_PER_DAY !== 0) {
    throw new RangeError(
      `assertLocalDateKey: UTC 자정이 아닌 Date다 (${dateKey.toISOString()}). ` +
        '시각에서 날짜를 뽑으려면 toLocalDateKey를, 사용자가 고른 날짜 문자열이라면 ' +
        'parseLocalDateKey를 거쳐라',
    );
  }
}

/**
 * 날짜 키(`UTC 자정 Date`)를 `"2026-08-01"` 형식 문자열로 바꾼다. `parseLocalDateKey`의
 * 반대 방향이고, **`@db.Date` 컬럼에서 읽은 값을 밖으로 내보낼 때 쓴다.**
 *
 * `Date`를 그대로 내보내면 받는 쪽이 자기 로컬 타임존으로 해석한다. UTC 자정은 음수
 * 오프셋 지역에서 **전날 오후**이므로, 8월 1일 시작인 할 일이 7월 31일 시작으로 보인다.
 * 날짜만 있고 시각이 없는 값에는 애초에 타임존이 없으므로 문자열이 옳은 표현이다.
 *
 * 구현이 `toISOString`을 자르는 것은 그 함수에 로컬 컴포넌트를 쓸 변형이 없기 때문이다.
 * `getFullYear`/`getMonth`/`getDate`로 조립하면 로컬 타임존에서 하루 밀리는 함정이
 * 되살아나고, **한국 시간대(UTC+9)에서는 그 실수가 테스트에 드러나지도 않는다**
 * (UTC 자정의 로컬 날짜가 같은 날이다).
 *
 * @throws {RangeError} `dateKey`가 유효하지 않거나 UTC 자정이 아닐 때
 */
export function formatLocalDateKey(dateKey: Date): string {
  // 검사를 `assertLocalDateKey`에 맡긴다. 같은 규칙을 `Date`를 인자로 받는 자리도
  // 걸어야 하는데, 두 곳에 두면 한쪽만 고쳐지는 날이 온다.
  assertLocalDateKey(dateKey);

  return dateKey.toISOString().slice(0, 10);
}
