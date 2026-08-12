import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const VALID_URL =
    'postgresql://postgres.abc:pw@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres';

  it('DATABASE_URL이 올바르면 그 값을 담아 돌려준다', () => {
    expect(validateEnv({ DATABASE_URL: VALID_URL }).DATABASE_URL).toBe(
      VALID_URL,
    );
  });

  it('검증하지 않는 키도 원본 그대로 함께 통과시킨다', () => {
    // ConfigModule은 validate의 **반환값으로** 설정 객체를 교체한다.
    // 검증하지 않은 키를 빼서 돌려주면 ConfigService에서 조용히 사라진다.
    // 예시로 DIRECT_URL을 쓰는 이유는 PORT가 검증·정규화 대상이 되어
    // "손대지 않고 통과시키는 키"의 예가 될 수 없기 때문이다.
    const result = validateEnv({
      DATABASE_URL: VALID_URL,
      DIRECT_URL: 'postgres://postgres:pw@localhost:5432/postgres',
    });

    expect(result.DIRECT_URL).toBe(
      'postgres://postgres:pw@localhost:5432/postgres',
    );
  });

  it.each([
    ['키가 없다', {}],
    ['undefined다', { DATABASE_URL: undefined }],
    ['빈 문자열이다', { DATABASE_URL: '' }],
    ['공백뿐이다', { DATABASE_URL: '   ' }],
    ['문자열이 아니다', { DATABASE_URL: 5432 }],
  ])('DATABASE_URL이 %s면 던진다', (_설명, config) => {
    expect(() => validateEnv(config)).toThrow(/DATABASE_URL/);
  });

  it.each([
    ['mysql://user:pw@localhost:3306/db'],
    ['https://tujgxueaqkbkoetbqppc.supabase.co'],
    ['aws-1-ap-northeast-2.pooler.supabase.com:6543'],
  ])('DATABASE_URL이 postgres 스킴이 아니면 던진다: %s', (url) => {
    expect(() => validateEnv({ DATABASE_URL: url })).toThrow(/postgres/);
  });

  it('postgres:// 스킴도 받는다', () => {
    // libpq와 Supabase 문서가 두 스킴을 섞어 쓴다. 둘 다 유효하다
    const url = 'postgres://postgres:pw@localhost:5432/postgres';

    expect(validateEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });

  it('DIRECT_URL이 없어도 통과한다', () => {
    // DIRECT_URL은 Prisma CLI만 쓴다. 런타임 배포 환경에는 없는 것이 정상이고,
    // 여기서 필수로 걸면 마이그레이션을 돌리지 않는 환경의 부팅이 막힌다
    expect(() => validateEnv({ DATABASE_URL: VALID_URL })).not.toThrow();
  });

  describe('PORT', () => {
    it('없으면 기본값 4080이다', () => {
      expect(validateEnv({ DATABASE_URL: VALID_URL }).PORT).toBe(4080);
    });

    it.each([
      ['빈 문자열', ''],
      ['공백뿐인 문자열', '  '],
      ['undefined', undefined],
    ])('%s면 기본값 4080이다', (_설명, port) => {
      // `.env.example`이 `PORT=`로 비워 두고 있어 빈 문자열이 실제로 들어온다.
      // 빈 값을 오류로 보면 예시 파일을 그대로 복사한 `.env`가 부팅을 막는다
      expect(validateEnv({ DATABASE_URL: VALID_URL, PORT: port }).PORT).toBe(
        4080,
      );
    });

    it('문자열로 온 포트를 숫자로 바꿔 돌려준다', () => {
      // process.env의 값은 언제나 문자열이다. 여기서 숫자로 바꿔 두지 않으면
      // 값을 읽는 쪽마다 변환을 반복하게 되고, 한 곳이 빠지면 문자열이 샌다
      expect(validateEnv({ DATABASE_URL: VALID_URL, PORT: '8080' }).PORT).toBe(
        8080,
      );
    });

    it('앞뒤 공백은 떼고 받는다', () => {
      // 값을 손으로 편집하다 남는 공백까지 오류로 볼 이유는 없다
      expect(
        validateEnv({ DATABASE_URL: VALID_URL, PORT: ' 8080 ' }).PORT,
      ).toBe(8080);
    });

    it.each([
      ['정수가 아니다', '8080.5'],
      ['숫자가 아니다', 'http'],
      ['0이다', '0'],
      ['음수다', '-1'],
      ['65535를 넘는다', '65536'],
      // 아래 셋은 `Number()`가 조용히 받아 주던 표기다. 문서와 오류 메시지가
      // "10진수 정수"를 약속하므로 여기서 거절해야 한다 — `0x10`을 적은 사람이
      // 16번 포트로 떴다는 사실을 어디서도 알 수 없는 것이 가장 나쁘다
      ['16진수 표기다', '0x10'],
      ['지수 표기다', '8e3'],
      ['부호가 붙었다', '+8080'],
    ])('PORT가 %s면 던진다', (_설명, port) => {
      expect(() =>
        validateEnv({ DATABASE_URL: VALID_URL, PORT: port }),
      ).toThrow(/PORT/);
    });
  });
});
