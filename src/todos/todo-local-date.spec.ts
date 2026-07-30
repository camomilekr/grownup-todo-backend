import {
  parseLocalDateKey,
  toHistoriedOn,
  toLocalDateKey,
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
