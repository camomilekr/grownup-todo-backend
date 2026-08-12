/**
 * 기동 시점 환경변수 검증.
 *
 * `ConfigModule.forRoot({ validate })`에 걸어 **부팅 자체를 실패시킨다.**
 * 첫 요청에서 `undefined`로 터지게 두면 어떤 값이 빠졌는지 스택트레이스가
 * 말해 주지 않고, 그 사실이 배포 뒤에야 드러난다.
 */

/** `postgresql://`과 `postgres://`를 모두 받는다. libpq와 Supabase 문서가 섞어 쓴다 */
const POSTGRES_SCHEME = /^postgres(ql)?:\/\//;

/**
 * `PORT`를 주지 않았을 때 애플리케이션이 리슨하는 포트.
 *
 * 컨테이너 이미지의 EXPOSE와 k8s 배포 매니페스트의 containerPort는 이 값과
 * 같아야 한다 — 아직 이 저장소에 그 파일들이 없으므로, 추가할 때 맞춘다.
 */
const DEFAULT_PORT = 4080;

/** TCP 포트 번호의 유효 범위. 0은 "빈 포트를 아무거나"라 서버 설정으로는 오류다 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * 10진수 숫자만으로 이루어진 표기. `Number()`에 그대로 넘기지 않기 위한 관문이다
 * — `Number()`는 `0x10`(=16)·`8e3`(=8000)·`+8080`까지 조용히 받아 주는데,
 * 문서와 오류 메시지는 "1~65535 범위의 정수"를 약속한다. `PORT=0x10`을 적은
 * 사람이 오류도 받지 못하고 16번 포트로 떴다는 사실도 모르는 것이 가장 나쁘다.
 */
const DECIMAL_INTEGER = /^\d+$/;

export type ValidatedEnv = Record<string, unknown> & {
  DATABASE_URL: string;
  PORT: number;
};

/**
 * `PORT`를 숫자로 정규화한다. 값을 읽는 쪽이 아니라 여기서 바꾸는 이유는
 * `process.env`의 값이 언제나 문자열이라, 변환을 소비 지점마다 반복하면
 * 한 곳이 빠졌을 때 문자열이 그대로 새기 때문이다.
 */
function parsePort(rawPort: unknown): number {
  // 값이 없거나 비어 있으면 기본값이다. `.env.example`이 `PORT=`로 비워 두고
  // 있어 빈 문자열이 실제로 들어온다 — 오류로 보면 예시를 그대로 복사한
  // `.env`가 부팅을 막는다
  if (rawPort === undefined || rawPort === null) {
    return DEFAULT_PORT;
  }

  // 값은 문자열로만 온다(`process.env`). 앞뒤 공백은 손으로 편집하다 남기
  // 쉬우므로 떼고 본다
  const trimmed = String(rawPort).trim();
  if (trimmed === '') {
    return DEFAULT_PORT;
  }

  // 포트 번호는 비밀값이 아니므로 메시지에 실어 준다 — DATABASE_URL과 달리
  // 값을 보여 주는 편이 원인을 훨씬 빨리 좁힌다
  const port = Number(trimmed);
  if (
    !DECIMAL_INTEGER.test(trimmed) ||
    !Number.isInteger(port) ||
    port < MIN_PORT ||
    port > MAX_PORT
  ) {
    throw new Error(
      `환경변수 PORT가 ${MIN_PORT}~${MAX_PORT} 범위의 10진수 정수가 아니다: ${trimmed}`,
    );
  }
  return port;
}

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
  return {
    ...config,
    DATABASE_URL: databaseUrl,
    PORT: parsePort(config['PORT']),
  };
}
