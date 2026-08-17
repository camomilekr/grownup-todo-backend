# 컨테이너 이미지 정의.
#
# 단계를 셋으로 나눈다. 빌드에만 필요한 것(TypeScript 컴파일러, Prisma 명령줄
# 도구, 테스트 도구)이 실행 이미지에 남지 않게 하기 위해서다. 실행 이미지에
# 남는 것은 `dist`와 운영용 의존성뿐이다.
#
# 기반 이미지는 alpine이 아니라 slim(Debian)이다. alpine은 표준 C 라이브러리가
# musl이라 이미지가 100MB 남짓 작지만, 이 프로젝트는 Prisma가 드라이버 어댑터로
# 붙어서(`@prisma/adapter-pg`) 네이티브 바이너리 의존이 언제 다시 생길지가
# 의존성 갱신에 달려 있다. 검증용 로컬 환경에서 크기보다 예측 가능성을 택했다.


# ---------------------------------------------------------------------------
# 1단계: 운영용 의존성만 설치한다
# ---------------------------------------------------------------------------
FROM node:24-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./

# `--omit=dev`로 개발용 의존성을 뺀다. 그러면 `--ignore-scripts`가 반드시
# 따라와야 한다 — 이 저장소의 `postinstall`은 `prisma generate`인데 `prisma`
# 명령줄 도구가 개발용 의존성이라, 스크립트를 켠 채로는 설치가 실패한다.
# 생성물은 2단계에서 만들어 컴파일된 형태로 넘어오므로 여기서는 필요 없다.
RUN npm ci --omit=dev --ignore-scripts


# ---------------------------------------------------------------------------
# 2단계: TypeScript를 컴파일한다
# ---------------------------------------------------------------------------
FROM node:24-slim AS builder
WORKDIR /app

# 스키마와 TypeScript 설정을 의존성 설치보다 **먼저** 넣는다. `npm ci`의
# postinstall이 `prisma generate`를 돌리기 때문이다.
#
# 스키마가 그 시점에 있어야 하는 것은 당연하지만, `tsconfig.json`이 왜
# 필요한지는 증상을 봐야 안다. Prisma 7의 클라이언트 생성기는 tsconfig를 보고
# 모듈 방식을 판단해 import 경로에 `.ts` 확장자를 붙일지 정한다. tsconfig가
# 없으면 `import ... from './internal/class.ts'`로 생성하고, 그것을
# CommonJS로 컴파일한 결과는 `require('./internal/class.ts')`가 되어 실행
# 시점에 `Cannot find module`로 죽는다(실측). 컴파일은 성공하므로 이미지
# 빌드는 조용히 통과하고, 파드가 재시작을 반복할 때에야 드러난다.
COPY package.json package-lock.json prisma.config.ts ./
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY prisma ./prisma

# 개발용 의존성까지 전부 설치한다. `prisma generate`가 만드는
# `src/generated/prisma`는 저장소에 커밋되지 않는 산출물이라
# (`.gitignore` 대상) 이미지 안에서 반드시 다시 만들어져야 한다.
RUN npm ci

COPY src ./src

RUN npm run build


# ---------------------------------------------------------------------------
# 3단계: 실행 이미지
# ---------------------------------------------------------------------------
FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

# 루트가 아닌 사용자로 실행한다. `node` 사용자(uid 1000)는 기반 이미지에 이미
# 있다. 복사한 파일의 소유자는 root로 두어 애플리케이션이 자기 코드를 고칠 수
# 없게 한다 — 쿠버네티스 쪽에서 루트 파일시스템을 읽기 전용으로 거는 설정과
# 같은 방향의 방어다.
USER node

# 실제로 듣는 포트는 환경변수 `PORT`가 정한다. EXPOSE는 실행에 아무 영향도
# 주지 않는 **문서 성격의 선언**이라, 그 값을 여기 굳이 두면 조용히 낡을 수
# 있다. 그래도 남기는 이유는 이미지를 받은 사람이 `docker image inspect`만으로
# 어느 포트를 열어야 하는지 알 수 있어야 하기 때문이다. 가리켜야 할 값은
# 환경변수를 주지 않았을 때 애플리케이션이 여는 포트, 곧
# `src/config/env.validation.ts`의 `validateEnv`가 `PORT` 없이 돌려주는
# 기본값이고, `src/config/deployment-port.spec.ts`가 이 줄과의 일치를 테스트로
# 고정한다.
EXPOSE 4080

# 실행 형식(exec form)으로 쓴다. **이것이 정상 종료의 전제 조건이다.**
# `CMD npm run start:prod`처럼 쓰면 npm이 1번 프로세스가 되고, node는 그
# 자식으로 뜬다. 쿠버네티스는 1번 프로세스에게만 SIGTERM을 보내므로 node는
# 신호를 받지 못하고, 처리 중 요청 대기도 자원 해제도 통째로 건너뛴 채
# 유예 시간이 지난 뒤 SIGKILL로 죽는다. 오류가 나지 않아서 정상으로 보인다.
#
# 문자열 형식(`CMD node dist/main`)도 셸을 한 겹 끼우므로 같은 이유로 쓰지
# 않는다. 아래 배열 형식은 node가 직접 1번 프로세스가 된다.
#
# 1번 프로세스가 되면 리눅스 커널은 처리기가 등록되지 않은 신호를 무시한다.
# 이 애플리케이션은 `app.enableShutdownHooks()`가 SIGTERM 처리기를 등록하므로
# 기동을 마친 뒤에는 정상으로 받는다. 기동 도중(약 1~2초)에 오는 SIGTERM만
# 무시되어 유예 시간 후 SIGKILL이 되는데, 그 창을 없애려면 init 프로세스를
# 하나 더 넣어야 해서 얻는 것보다 비용이 크다고 판단했다.
CMD ["node", "dist/main"]
