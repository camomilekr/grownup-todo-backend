import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  const VALID_URL =
    'postgresql://postgres.abc:pw@aws-1-ap-northeast-2.pooler.supabase.com:6543/postgres';

  it('DATABASE_URL이 올바르면 그 값을 담아 돌려준다', () => {
    expect(validateEnv({ DATABASE_URL: VALID_URL }).DATABASE_URL).toBe(
      VALID_URL,
    );
  });

  it('DATABASE_URL 외의 값도 함께 통과시킨다', () => {
    // ConfigModule은 validate의 **반환값으로** 설정 객체를 교체한다.
    // 검증하지 않은 키를 빼서 돌려주면 ConfigService에서 조용히 사라진다.
    const result = validateEnv({ DATABASE_URL: VALID_URL, PORT: '3000' });

    expect(result.PORT).toBe('3000');
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
});
