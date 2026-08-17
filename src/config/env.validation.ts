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
 * 컨테이너 이미지의 EXPOSE(`Dockerfile`)와 k8s 배포 매니페스트의 containerPort·
 * `PORT`·Service 포트가 이 값과 같아야 한다. 그 일치는
 * `src/config/deployment-port.spec.ts`가 테스트로 고정한다 — 그 테스트는 이
 * 상수를 직접 읽지 않고 `validateEnv`를 지나서 기본 포트를 얻는다.
 */
const DEFAULT_PORT = 4080;

/** TCP 포트 번호의 유효 범위. 0은 "빈 포트를 아무거나"라 서버 설정으로는 오류다 */
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * 종료 시작 후 HTTP 서버를 닫기까지 기다리는 시간의 기본값.
 *
 * k8s가 파드를 지울 때 "엔드포인트에서 제거"와 "컨테이너에 SIGTERM 전달"은
 * 병렬로 일어나, 시그널을 받은 뒤에도 잠시 새 요청이 들어온다. 그 사이에
 * HTTP 서버를 닫으면 커넥션 거절이 된다 — 이 대기가 그 창을 덮는다.
 *
 * 매니페스트를 전제하지 않고 앱 스스로 드레인이 되는 값을 기본값으로 둔다
 * (사용자 확정 2026-08-12). **이 저장소의 k8s 매니페스트는 기본값에 맡기지 않고
 * 8000을 명시적으로 주입한다** — 그 값은 준비 확인 프로브의 주기·실패 허용
 * 횟수와 짝을 맞춘 결과이고, 근거와 계산은 `k8s/deployment.yaml`에 있다.
 */
const DEFAULT_SHUTDOWN_DRAIN_DELAY_MS = 5_000;

/**
 * 드레인 대기의 상한. 막는 것은 **자릿수를 하나 더 찍은 오타**(`5000`을
 * `500000`으로 적는 류)까지다 — 그 값이면 대기만으로 500초라 SIGKILL이
 * 드레인 중간을 자르고 자원 해제가 통째로 스킵된다.
 *
 * **이 상한을 통과한 값이 `terminationGracePeriodSeconds`와 양립한다는 뜻은
 * 아니다.** 상한값 60초에 자원 해제 예산(`DISPOSE_TIMEOUT_MS` 10초)만 더해도
 * k8s 기본 유예 30초를 이미 넘는다. 대기 시간과 유예 기간을 실제로 맞추는 것은
 * 매니페스트를 쓰는 쪽의 몫이고, 이 저장소의 매니페스트는
 * `k8s/deployment.yaml`의 `terminationGracePeriodSeconds` 주석에서 그 예산을
 * 더해 보인다. 맞춰야 할 조건 목록은 `src/health/CONTEXT.md`에 있다.
 */
const MAX_SHUTDOWN_DRAIN_DELAY_MS = 60_000;

/**
 * 10진수 숫자만으로 이루어진 표기. `Number()`에 그대로 넘기지 않기 위한 관문이다
 * — `Number()`는 `0x10`(=16)·`8e3`(=8000)·`+8080`까지 조용히 받아 주는데,
 * 문서와 오류 메시지는 "10진수 정수"를 약속한다. `PORT=0x10`을 적은 사람이
 * 오류도 받지 못하고 16번 포트로 떴다는 사실도 모르는 것이 가장 나쁘다.
 */
const DECIMAL_INTEGER = /^\d+$/;

export type ValidatedEnv = Record<string, unknown> & {
  DATABASE_URL: string;
  PORT: number;
  SHUTDOWN_DRAIN_DELAY_MS: number;
};

/** 정수 환경변수 하나의 명세. 이름을 담는 이유는 오류 메시지에 싣기 위해서다 */
interface IntegerEnvSpec {
  name: string;
  defaultValue: number;
  min: number;
  max: number;
}

/**
 * 정수 환경변수를 검증하고 숫자로 정규화한다. 값을 읽는 쪽이 아니라 여기서
 * 바꾸는 이유는 `process.env`의 값이 언제나 문자열이라, 변환을 소비 지점마다
 * 반복하면 한 곳이 빠졌을 때 문자열이 그대로 새기 때문이다.
 *
 * 값이 비밀값이 아니라는 전제로 오류 메시지에 값을 싣는다 — 포트 번호·대기
 * 시간이 그렇다. `DATABASE_URL`처럼 비밀값을 담는 변수는 이 헬퍼를 쓰지 않는다.
 */
function parseIntegerEnv(rawValue: unknown, spec: IntegerEnvSpec): number {
  // 값이 없거나 비어 있으면 기본값이다. `.env.example`이 키를 값 없이
  // 나열하고 있어 빈 문자열이 실제로 들어온다 — 오류로 보면 예시를 그대로
  // 복사한 `.env`가 부팅을 막는다
  if (rawValue === undefined || rawValue === null) {
    return spec.defaultValue;
  }

  // 앞뒤 공백은 손으로 편집하다 남기 쉬우므로 떼고 본다
  const trimmed = String(rawValue).trim();
  if (trimmed === '') {
    return spec.defaultValue;
  }

  // `Number.isInteger`를 함께 보지 않는다 — `/^\d+$/`를 통과한 값은 항상
  // 정수라 판정에 관여하지 못하는 조건이었다. 표기가 10진수 정수인지는
  // 정규식이, 크기는 범위 비교가 각각 혼자 판정한다
  const value = Number(trimmed);
  if (!DECIMAL_INTEGER.test(trimmed) || value < spec.min || value > spec.max) {
    throw new Error(
      `환경변수 ${spec.name}가 ${spec.min}~${spec.max} 범위의 10진수 정수가 아니다: ${trimmed}`,
    );
  }
  return value;
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
    PORT: parseIntegerEnv(config['PORT'], {
      name: 'PORT',
      defaultValue: DEFAULT_PORT,
      min: MIN_PORT,
      max: MAX_PORT,
    }),
    SHUTDOWN_DRAIN_DELAY_MS: parseIntegerEnv(
      config['SHUTDOWN_DRAIN_DELAY_MS'],
      {
        name: 'SHUTDOWN_DRAIN_DELAY_MS',
        defaultValue: DEFAULT_SHUTDOWN_DRAIN_DELAY_MS,
        // 0은 유효한 값이다 — 매니페스트가 `preStop: sleep`으로 대기를
        // 대신하기로 하면 앱 내부 대기를 꺼야 한다(`PORT`와 다른 점)
        min: 0,
        max: MAX_SHUTDOWN_DRAIN_DELAY_MS,
      },
    ),
  };
}
