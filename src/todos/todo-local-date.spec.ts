import {
  assertLocalDateKey,
  formatLocalDateKey,
  parseLocalDateKey,
  toHistoriedOn,
  toLocalDateKey,
  toNextLocalDayStart,
} from './todo-local-date';

describe('toLocalDateKey', () => {
  describe('Asia/Seoul (UTC+9, DST 없음)', () => {
    // KST 자정 경계. 두 순간은 1초 차이지만 유저가 보는 날짜는 다르다.
    it('KST 자정 직전은 전날로 떨어진다', () => {
      const instant = new Date('2026-07-30T14:59:59.999Z');

      expect(toLocalDateKey(instant, 'Asia/Seoul').toISOString()).toBe(
        '2026-07-30T00:00:00.000Z',
      );
    });

    it('KST 자정이 되면 다음 날로 넘어간다', () => {
      const instant = new Date('2026-07-30T15:00:00.000Z');

      expect(toLocalDateKey(instant, 'Asia/Seoul').toISOString()).toBe(
        '2026-07-31T00:00:00.000Z',
      );
    });

    it('UTC 기준으로는 월말이지만 KST 기준으로는 다음 달 1일이다', () => {
      const instant = new Date('2026-07-31T15:00:00.000Z');

      expect(toLocalDateKey(instant, 'Asia/Seoul').toISOString()).toBe(
        '2026-08-01T00:00:00.000Z',
      );
    });
  });

  describe('America/New_York (DST가 있다)', () => {
    it('DST 기간(UTC-4)의 자정 경계를 넘긴다', () => {
      // 2026-07-30T04:00:00Z = EDT 2026-07-30 00:00
      const instant = new Date('2026-07-30T04:00:00.000Z');

      expect(toLocalDateKey(instant, 'America/New_York').toISOString()).toBe(
        '2026-07-30T00:00:00.000Z',
      );
    });

    it('DST 기간의 자정 직전은 전날이다', () => {
      const instant = new Date('2026-07-30T03:59:59.999Z');

      expect(toLocalDateKey(instant, 'America/New_York').toISOString()).toBe(
        '2026-07-29T00:00:00.000Z',
      );
    });

    it('표준시 기간(UTC-5)에는 경계가 한 시간 뒤로 밀린다', () => {
      // 1월은 EST(UTC-5)다. 04:00Z는 아직 전날 23:00이다.
      const instant = new Date('2026-01-15T04:00:00.000Z');

      expect(toLocalDateKey(instant, 'America/New_York').toISOString()).toBe(
        '2026-01-14T00:00:00.000Z',
      );
    });
  });

  it('UTC 자정을 가리키는 Date를 돌려준다', () => {
    // @db.Date에 넘기는 값은 어댑터가 UTC 컴포넌트로 직렬화한다.
    // 시·분·초·밀리초가 UTC 0이 아니면 날짜가 밀릴 수 있다.
    const key = toLocalDateKey(
      new Date('2026-07-30T15:30:45.123Z'),
      'Asia/Seoul',
    );

    expect([
      key.getUTCHours(),
      key.getUTCMinutes(),
      key.getUTCSeconds(),
      key.getUTCMilliseconds(),
    ]).toEqual([0, 0, 0, 0]);
  });

  it('UTC 타임존에서는 순간의 UTC 날짜와 같다', () => {
    const instant = new Date('2026-07-30T23:59:59.999Z');

    expect(toLocalDateKey(instant, 'UTC').toISOString()).toBe(
      '2026-07-30T00:00:00.000Z',
    );
  });

  it('알 수 없는 타임존 이름이면 던진다', () => {
    // 잘못된 타임존을 조용히 UTC로 떨어뜨리면 그 유저의 날짜가 전부 하루씩
    // 어긋난 채 저장되고, 원인은 훨씬 나중에 드러난다.
    expect(() =>
      toLocalDateKey(
        new Date('2026-07-30T15:00:00.000Z'),
        'Asia/Seoul_Invalid',
      ),
    ).toThrow();
  });

  it('유효하지 않은 Date면 던진다', () => {
    expect(() => toLocalDateKey(new Date('쓰레기'), 'Asia/Seoul')).toThrow();
  });
});

describe('toHistoriedOn', () => {
  // 히스토리 `historiedOn`을 만드는 **유일한 진입점**이다. `completeType`에 따라
  // 규칙이 완전히 다른데, 그 선택을 호출자에게 맡기면 ONCE에 DAILY 규칙을 쓰는
  // 코드가 타입체크를 통과한다 — 그것이 라운드 1에서 잡힌 결함이었다.
  const createdAt = new Date('2026-07-20T02:00:00.000Z');
  const performedAt = new Date('2026-08-01T02:00:00.000Z');

  describe('ONCE', () => {
    function onceKey(overrides: {
      createdAt?: Date;
      performedAt?: Date;
      timeZone?: string;
    }) {
      return toHistoriedOn({
        completeType: 'ONCE',
        createdAt,
        performedAt,
        timeZone: 'Asia/Seoul',
        ...overrides,
      });
    }

    it('template 생성 시각의 UTC 날짜를 키로 쓴다', () => {
      expect(onceKey({}).toISOString()).toBe('2026-07-20T00:00:00.000Z');
    });

    it('언제 수행했는지와 무관하게 같은 키를 돌려준다', () => {
      // 완료 → 취소 → 다른 날 재완료에서 키가 달라지면 유니크 제약을 비켜 가
      // 완료 기록이 둘 남는다.
      const first = onceKey({
        performedAt: new Date('2026-08-01T02:00:00.000Z'),
      });
      const second = onceKey({
        performedAt: new Date('2026-09-15T20:00:00.000Z'),
      });

      expect(first.toISOString()).toBe(second.toISOString());
    });

    it('유저 타임존이 바뀌어도 같은 키를 돌려준다', () => {
      // `app_user.time_zone`은 유저가 언제든 바꾸는 설정 컬럼이다. 여기에
      // 의존하면 그 todo와 무관한 설정 변경 하나로 기록이 둘 생긴다.
      const seoul = onceKey({ timeZone: 'Asia/Seoul' });
      const newYork = onceKey({ timeZone: 'America/New_York' });

      expect(seoul.toISOString()).toBe(newYork.toISOString());
    });

    it('createdAt이 UTC 자정 경계를 넘으면 키가 갈린다', () => {
      // 경계는 UTC에 있다. 유저가 어느 타임존이든 같은 자리에서 갈린다.
      expect(
        onceKey({
          createdAt: new Date('2026-08-01T23:59:59.999Z'),
        }).toISOString(),
      ).toBe('2026-08-01T00:00:00.000Z');
      expect(
        onceKey({
          createdAt: new Date('2026-08-02T00:00:00.000Z'),
        }).toISOString(),
      ).toBe('2026-08-02T00:00:00.000Z');
    });
  });

  describe('DAILY', () => {
    function dailyKey(overrides: {
      createdAt?: Date;
      performedAt?: Date;
      timeZone?: string;
    }) {
      return toHistoriedOn({
        completeType: 'DAILY',
        createdAt,
        performedAt,
        timeZone: 'Asia/Seoul',
        ...overrides,
      });
    }

    it('수행 시각을 유저 타임존 기준 날짜로 바꾼다', () => {
      // DAILY의 이 값은 유저에게 보여 주는 날짜다.
      expect(dailyKey({}).toISOString()).toBe('2026-08-01T00:00:00.000Z');
    });

    it('KST 자정 경계에서 날짜가 넘어간다', () => {
      expect(
        dailyKey({
          performedAt: new Date('2026-08-01T14:59:59.999Z'),
        }).toISOString(),
      ).toBe('2026-08-01T00:00:00.000Z');
      expect(
        dailyKey({
          performedAt: new Date('2026-08-01T15:00:00.000Z'),
        }).toISOString(),
      ).toBe('2026-08-02T00:00:00.000Z');
    });

    it('template 생성 시각과 무관하다', () => {
      const first = dailyKey({
        createdAt: new Date('2020-01-01T00:00:00.000Z'),
      });
      const second = dailyKey({
        createdAt: new Date('2026-07-20T02:00:00.000Z'),
      });

      expect(first.toISOString()).toBe(second.toISOString());
    });
  });

  it('같은 입력에 대해 ONCE와 DAILY가 다른 키를 낸다', () => {
    // 두 규칙이 실제로 갈린다는 것을 고정한다. 한쪽으로 합쳐지면 이 테스트가 깨진다.
    const once = toHistoriedOn({
      completeType: 'ONCE',
      createdAt,
      performedAt,
      timeZone: 'Asia/Seoul',
    });
    const daily = toHistoriedOn({
      completeType: 'DAILY',
      createdAt,
      performedAt,
      timeZone: 'Asia/Seoul',
    });

    expect(once.toISOString()).not.toBe(daily.toISOString());
  });
});

describe('toNextLocalDayStart', () => {
  // 매일 반복의 "마감 순간"을 만드는 함수다 — 그날이 끝나는 순간, 곧 **다음 달력
  // 날짜가 시작되는 최초의 순간**을 돌려준다. 계약을 "다음 자정"으로 두지 않은
  // 이유가 아래 DST(일광 절약 시간) 절에 있다 — 전환일에는 자정이 없거나 두 번 있다.
  //
  // DST 전환 날짜·시각은 전부 Node 런타임의 tzdata로 실측해 고정한 상수다(2026-08-07
  // 실측). tzdata가 미래 규칙을 바꾸면 이 테스트가 깨져서 알려 준다 — 그것이 의도다.

  it('서울에서 다음 날짜의 시작은 다음 KST 자정이다', () => {
    // 서울 8월 8일 05:00 → 서울 8월 9일 0시 = 2026-08-08T15:00:00Z.
    expect(
      toNextLocalDayStart(
        new Date('2026-08-07T20:00:00.000Z'),
        'Asia/Seoul',
      ).toISOString(),
    ).toBe('2026-08-08T15:00:00.000Z');
  });

  it('UTC에서는 다음 UTC 자정이다', () => {
    expect(
      toNextLocalDayStart(
        new Date('2026-08-07T20:00:00.000Z'),
        'UTC',
      ).toISOString(),
    ).toBe('2026-08-08T00:00:00.000Z');
  });

  it('음수 오프셋에서도 유저 타임존의 다음 자정이다', () => {
    // 뉴욕 8월 6일 22:00(EDT, UTC-4) → 뉴욕 8월 7일 0시 = 2026-08-07T04:00:00Z.
    expect(
      toNextLocalDayStart(
        new Date('2026-08-07T02:00:00.000Z'),
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-08-07T04:00:00.000Z');
  });

  it('자정 직전이면 바로 다음 밀리초가 답이다', () => {
    // 서울 8월 7일 23:59:59.999 → 1밀리초 뒤가 8월 8일의 시작이다.
    expect(
      toNextLocalDayStart(
        new Date('2026-08-07T14:59:59.999Z'),
        'Asia/Seoul',
      ).toISOString(),
    ).toBe('2026-08-07T15:00:00.000Z');
  });

  it('자정 정각이면 그 순간이 아니라 다음 날의 시작이다', () => {
    // 서울 8월 8일 0시 정각에 물으면 답은 8월 9일 0시다 — 반환값은 항상 `at`보다
    // 엄격히 뒤다. 같은 순간을 돌려주면 마감이 "이미 지난" 것으로 읽힌다.
    expect(
      toNextLocalDayStart(
        new Date('2026-08-07T15:00:00.000Z'),
        'Asia/Seoul',
      ).toISOString(),
    ).toBe('2026-08-08T15:00:00.000Z');
  });

  it('봄 전환으로 자정이 없는 날은 그날의 최초 순간(01:00)이다', () => {
    // America/Santiago 2026년 봄 전환(실측): 2026-09-06T04:00:00Z에 로컬이
    // 9월 5일 23:59:59(UTC-4)에서 9월 6일 01:00(UTC-3)으로 건너뛴다. 9월 6일에는
    // 00:00이 존재하지 않으므로 "다음 자정"은 답이 없고, 이 계약("다음 달력 날짜가
    // 시작되는 최초의 순간")의 답은 로컬 01:00이다.
    expect(
      toNextLocalDayStart(
        new Date('2026-09-06T03:00:00.000Z'), // 로컬 9월 5일 23:00
        'America/Santiago',
      ).toISOString(),
    ).toBe('2026-09-06T04:00:00.000Z');
  });

  it('가을 전환으로 자정이 두 번 오는 날은 이른 쪽이다', () => {
    // America/Havana 2026년 가을 전환(실측): 로컬 11월 1일 00:00~01:00이 두 번
    // 온다 — 이른 쪽 00:00은 2026-11-01T04:00:00Z(UTC-4), 늦은 쪽 00:00은
    // 2026-11-01T05:00:00Z(UTC-5)다. 그날이 "시작되는 최초의 순간"은 이른 쪽이다 —
    // 늦은 쪽을 돌려주면 그보다 앞선 한 시간이 어느 날에도 속하지 않게 된다.
    expect(
      toNextLocalDayStart(
        new Date('2026-11-01T03:00:00.000Z'), // 로컬 10월 31일 23:00
        'America/Havana',
      ).toISOString(),
    ).toBe('2026-11-01T04:00:00.000Z');
  });

  it('비정수 오프셋(+05:45)에서도 그 타임존의 자정이다', () => {
    // Asia/Kathmandu(실측): 8월 8일의 시작 = 2026-08-07T18:15:00Z. 오프셋을
    // 시간 단위로 역산하는 구현은 여기서 45분 어긋난다.
    expect(
      toNextLocalDayStart(
        new Date('2026-08-07T10:00:00.000Z'), // 로컬 8월 7일 15:45
        'Asia/Kathmandu',
      ).toISOString(),
    ).toBe('2026-08-07T18:15:00.000Z');
  });

  it('유효하지 않은 Date면 던진다', () => {
    // `toLocalDateKey`와 같은 규칙이다 — 조용히 통과시키면 Invalid Date 마감이
    // 정렬 비교에 들어가 NaN 비교(항상 거짓)로 순서가 조용히 무너진다.
    expect(() => toNextLocalDayStart(new Date('쓰레기'), 'Asia/Seoul')).toThrow(
      RangeError,
    );
  });

  it('알 수 없는 타임존 이름이면 던진다', () => {
    expect(() =>
      toNextLocalDayStart(
        new Date('2026-08-07T20:00:00.000Z'),
        'Asia/Seoul_Invalid',
      ),
    ).toThrow(RangeError);
  });
});

describe('parseLocalDateKey', () => {
  // activeFrom/activeUntil은 사용자가 고르는 날짜다. "순간"이 없으므로
  // toLocalDateKey로 만들 수 없고, 이 함수가 그 자리를 맡는다.
  it('YYYY-MM-DD를 UTC 자정 Date로 바꾼다', () => {
    expect(parseLocalDateKey('2026-08-01').toISOString()).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('로컬 타임존과 무관하게 같은 값을 돌려준다', () => {
    // `new Date('2026-08-01')`이 아니라 `new Date(2026, 7, 1)`로 만들면 KST에서
    // `2026-07-31T15:00:00Z`가 되고, 어댑터가 UTC 컴포넌트를 쓰므로 하루 앞으로
    // 밀려 저장된다. 이 함수는 그 함정을 지난다.
    const key = parseLocalDateKey('2026-08-01');

    expect([
      key.getUTCFullYear(),
      key.getUTCMonth(),
      key.getUTCDate(),
      key.getUTCHours(),
    ]).toEqual([2026, 7, 1, 0]);
  });

  it.each(['2026-8-1', '20260801', '2026-08-01T00:00:00Z', '', 'abc'])(
    '형식이 어긋난 %p는 던진다',
    (input) => {
      expect(() => parseLocalDateKey(input)).toThrow(RangeError);
    },
  );

  it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-01-32'])(
    '달력에 없는 날짜 %p는 던진다',
    (input) => {
      // 형식은 맞지만 존재하지 않는 날짜다. Date는 이것을 조용히 다음 달로
      // 넘겨 버리므로(2026-02-30 → 03-02) 직접 막는다.
      expect(() => parseLocalDateKey(input)).toThrow(RangeError);
    },
  );

  it('윤년 2월 29일은 통과한다', () => {
    expect(parseLocalDateKey('2028-02-29').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('평년 2월 29일은 던진다', () => {
    expect(() => parseLocalDateKey('2026-02-29')).toThrow(RangeError);
  });
});

describe('assertLocalDateKey', () => {
  // 날짜 컬럼(`@db.Date`)에 넣을 값이 UTC 자정인지 확인하는 검사다. `formatLocalDateKey`
  // 안에만 있던 것을 밖으로 빼냈다 — `Date`를 인자로 받는 자리(활성 기간, 이력 조회
  // 범위)가 같은 검사를 걸어야 하기 때문이다.
  it('UTC 자정 Date는 통과한다', () => {
    expect(() =>
      assertLocalDateKey(new Date('2026-08-01T00:00:00.000Z')),
    ).not.toThrow();
  });

  it('시각이 섞인 Date는 던진다', () => {
    // 시각 컬럼(`Timestamptz`)인 `completedAt`이나 `shouldDoAt`을 실수로 넘기는 경우다.
    // 그대로 두면 UTC 기준 날짜가 나오는데 그 값은 유저 타임존 기준 날짜와 어긋난다.
    expect(() =>
      assertLocalDateKey(new Date('2026-08-01T09:00:00.000Z')),
    ).toThrow(RangeError);
  });

  it('유효하지 않은 Date는 그렇다고 알려 주며 던진다', () => {
    // **오류 종류만 단정하면 이 검사를 지워도 통과한다.** Invalid Date의 `getTime()`은
    // `NaN`이라 아래 UTC 자정 검사에 걸리고, 그 분기가 메시지를 만들며 부르는
    // `toISOString()`이 `RangeError: Invalid time value`를 던지기 때문이다. 종류가 같아
    // 구별되지 않으므로 **원인을 말해 주는 문구까지** 본다. 문구 전체가 아니라 'Invalid
    // Date'만 보는 것은 다듬을 때마다 깨지지 않게 하려는 것이다.
    expect(() => assertLocalDateKey(new Date('쓰레기'))).toThrow(
      /Invalid Date/,
    );
  });

  it('값이 없으면 던진다', () => {
    // `tsconfig.json`이 `strictNullChecks: false`라 컴파일러가 이 호출을 막지 못한다.
    // 그냥 두면 `undefined.getTime()`이 `TypeError`가 되는데, 그 문구는 무엇을 잘못
    // 넘겼는지 말해 주지 않는다. **어긋난 입력을 오류 종류 하나로 모으는 것**이 이
    // 분기가 지키는 것이다. 위 Invalid Date 테스트와 달리 여기서는 종류만 단정해도
    // 되는데, 분기를 지우면 나오는 것이 `RangeError`가 아니라 `TypeError`여서다.
    expect(() => assertLocalDateKey(undefined)).toThrow(RangeError);
  });

  it('로컬 타임존 자정으로 만든 Date는 던진다', () => {
    // 한국 시간대(UTC+9)에서 `new Date(2026, 7, 1)`이 만들어 내는 값이다. 그 식을 그대로
    // 쓰지 않는 이유는 값이 **실행 환경의 타임존에 따라 달라지기** 때문이다 — 이 저장소는
    // jest에 타임존을 고정하지 않아서, UTC로 설정된 기계에서는 그 식이 진짜 UTC 자정이
    // 되어 거절되지 않는다. 그러면 이 테스트가 통과하면서 아무것도 지키지 못한다.
    //
    // 이 값이 `@db.Date` 컬럼에 들어가면 어댑터가 UTC 컴포넌트를 쓰므로 `2026-07-31`로
    // 저장되고, **예외가 하나도 나지 않아** 매일 반복 할 일이 하루 일찍 활성화된다.
    const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

    expect(() =>
      assertLocalDateKey(new Date(Date.UTC(2026, 7, 1) - KST_OFFSET_MS)),
    ).toThrow(RangeError);
  });
});

describe('formatLocalDateKey', () => {
  // `parseLocalDateKey`의 반대 방향이다. `@db.Date` 컬럼에서 읽은 값을 클라이언트에
  // 내보낼 때 쓴다 — `Date`를 그대로 내보내면 받는 쪽이 자기 로컬 타임존으로
  // 해석해서 음수 오프셋 지역에서 하루 앞으로 밀려 보인다.
  it('UTC 자정 Date를 YYYY-MM-DD로 돌려준다', () => {
    expect(formatLocalDateKey(new Date('2026-08-01T00:00:00.000Z'))).toBe(
      '2026-08-01',
    );
  });

  it('한 자리 월·일을 0으로 채운다', () => {
    expect(formatLocalDateKey(new Date('2026-01-05T00:00:00.000Z'))).toBe(
      '2026-01-05',
    );
  });

  it('parseLocalDateKey와 왕복한다', () => {
    // 두 함수가 같은 표현을 쓴다는 것을 고정한다. 한쪽만 형식을 바꾸면 깨진다.
    expect(formatLocalDateKey(parseLocalDateKey('2026-12-31'))).toBe(
      '2026-12-31',
    );
  });

  it('UTC 자정이 아니면 던진다', () => {
    // `completedAt`이나 `shouldDoAt` 같은 시각 컬럼(`Timestamptz`)을 실수로 넘기면
    // UTC 기준 날짜가 나오는데, 그것은 유저 타임존 기준 날짜가 아니라서 조용히
    // 어긋난다. 시각에서 날짜를 뽑아야 한다면 `toLocalDateKey`를 먼저 거쳐야 한다.
    expect(() =>
      formatLocalDateKey(new Date('2026-08-01T09:00:00.000Z')),
    ).toThrow(RangeError);
  });

  it('유효하지 않은 Date면 던진다', () => {
    expect(() => formatLocalDateKey(new Date('쓰레기'))).toThrow(RangeError);
  });
});
