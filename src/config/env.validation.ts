/**
 * 기동 시점 환경변수 검증.
 *
 * `ConfigModule.forRoot({ validate })`에 걸어 **부팅 자체를 실패시킨다.**
 * 첫 요청에서 `undefined`로 터지게 두면 어떤 값이 빠졌는지 스택트레이스가
 * 말해 주지 않고, 그 사실이 배포 뒤에야 드러난다.
 */

/** `postgresql://`과 `postgres://`를 모두 받는다. libpq와 Supabase 문서가 섞어 쓴다 */
const POSTGRES_SCHEME = /^postgres(ql)?:\/\//;

export type ValidatedEnv = Record<string, unknown> & { DATABASE_URL: string };

export function validateEnv(config: Record<string, unknown>): ValidatedEnv {
  const databaseUrl = config['DATABASE_URL'];

  if (typeof databaseUrl !== 'string' || databaseUrl.trim() === '') {
    throw new Error(
      '환경변수 DATABASE_URL이 비어 있다. `.env.example`을 보고 `.env`를 채워라.',
    );
  }

  if (!POSTGRES_SCHEME.test(databaseUrl)) {
    // 값을 메시지에 싣지 않는다 — 접속 문자열에 비밀번호가 들어 있어서
    // 부팅 실패 로그가 그대로 비밀값 유출이 된다
    throw new Error(
      '환경변수 DATABASE_URL이 postgres 접속 문자열이 아니다. `postgresql://`로 시작해야 한다.',
    );
  }

  // DIRECT_URL은 검증하지 않는다. Prisma CLI(마이그레이션)만 쓰는 값이라
  // 런타임 배포 환경에 없는 것이 정상이고, 필수로 걸면 그 환경의 부팅이 막힌다.

  // 반환값이 설정 객체를 **교체한다.** 검증한 키만 돌려주면 나머지가
  // ConfigService에서 조용히 사라지므로 원본을 펼쳐서 함께 넘긴다.
  return { ...config, DATABASE_URL: databaseUrl };
}
