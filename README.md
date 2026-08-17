# grownup-todo-backend

할 일(todo) 관리 서비스의 백엔드다. 매일 반복·일회성 할 일의 정의와 완료 기록을 분리해 저장하고, 사용자 타임존 기준으로 "오늘"을 계산해 병합된 할 일 목록을 제공한다.

## 기술 스택

| 구분 | 기술 |
|---|---|
| 런타임 | Node.js 24 |
| 언어 | TypeScript 5 |
| 프레임워크 | NestJS 10 |
| ORM(Object-Relational Mapping, 객체-관계 매핑) | Prisma 7 (`@prisma/adapter-pg` 드라이버 어댑터) |
| 데이터베이스 | PostgreSQL (Supabase) |
| 테스트 | Jest + ts-jest, e2e(end-to-end, 전 구간 통합 테스트)는 supertest |
| 코드 품질 | ESLint, Prettier, Husky(pre-commit 훅) |

## 프로젝트 구조

도메인 하나가 폴더 하나다. 계층(`controllers/`, `services/`)으로 자르지 않고, 기능을 고칠 때 폴더 하나만 열면 끝나도록 배치한다.

```
src/
  main.ts              # 부트스트랩. 전역 파이프·필터를 여기서 건다
  app.module.ts        # 루트 모듈. 조립만 한다
  common/              # 도메인에 속하지 않는 횡단 관심사 (BigInt JSON 직렬화 등)
  config/              # 기동 시점 환경변수 검증. 값이 없으면 부팅을 실패시킨다
  prisma/              # Prisma 클라이언트를 NestJS 의존성 주입에 붙이는 모듈
  todos/               # 할 일 도메인 — Service, Repository, 날짜 계산, 응답 변환
  users/               # 유저 도메인 — 타임존 조회
  generated/prisma/    # prisma generate 산출물 (커밋하지 않는다)
prisma/
  schema.prisma        # 영속화 스키마의 단일 출처
  migrations/          # 마이그레이션 이력
docs/
  todo-schema.md       # 테이블 설계 문서
  todo-service-spec.md # Service·Repository 함수 명세
test/                  # DB에 실제로 붙는 e2e 테스트
```

각 `src/` 하위 폴더에는 그 폴더의 역할과 주의점을 담은 `CONTEXT.md`가 있다.

핵심 도메인 구조: 할 일 하나는 두 테이블에 나뉘어 저장된다. `todoTemplate`은 할 일의 **정의**(제목·목표치·알림 시각), `todoHistory`는 **완료 기록**(언제 얼마나 했는지)이다. 정의가 나중에 바뀌어도 지나간 기록이 흔들리지 않게 하기 위한 분리다. 상세는 `docs/todo-schema.md`.

## 설치

```bash
npm install   # postinstall이 prisma generate까지 실행한다
```

환경변수를 준비한다. `.env.example`을 복사해 `.env`를 만들고 값을 채운다.

```bash
cp .env.example .env
```

| 변수 | 용도 |
|---|---|
| `DATABASE_URL` | 애플리케이션 런타임용. Supabase 트랜잭션 모드 풀러(포트 6543). 없으면 부팅이 실패한다 |
| `DIRECT_URL` | Prisma CLI(Command Line Interface, 명령줄 도구)용. 세션 모드 풀러(포트 5432). 마이그레이션·studio가 쓴다 |
| `PORT` | HTTP 리슨 포트. 비워 두면 4080이다. 1~65535 범위의 10진수 정수만 받고, 그 밖의 값이면 부팅이 실패한다 |
| `SHUTDOWN_DRAIN_DELAY_MS` | 종료(SIGTERM) 후 HTTP 서버를 닫기까지 기다리는 시간(밀리초). 비워 두면 5000이다. 0~60000 범위의 10진수 정수만 받는다 |

## 실행

```bash
npm run start:dev     # 개발 모드 (파일 변경 감지)
npm run start         # 일반 실행
npm run build && npm run start:prod   # 프로덕션 빌드 후 실행
```

## 테스트

```bash
npm test              # 단위 테스트 (src/ 아래 *.spec.ts)
npm run test:e2e      # DB에 실제로 붙는 e2e 테스트 (test/ 아래)
npm run test:cov      # 커버리지 리포트
```

단위 테스트의 jest `rootDir`이 `src`라 `npm test`는 `test/` 아래를 돌지 않는다 — e2e는 반드시 별도로 돌린다.

## 코드 품질 검사

```bash
npm run verify        # lint → prettier → typecheck. 커밋 전에 돌린다
```

pre-commit 훅이 `verify`를 자동으로 실행한다. 단, 테스트는 훅에 들어 있지 않으므로 커밋 전에 `npm test`와 `npm run test:e2e`를 직접 돌려야 한다.

## 컨테이너와 쿠버네티스

```bash
docker build -t grownup-todo-backend:local .                        # 이미지 빌드
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/secret.yaml                                    # 예시 파일을 복사해 값을 채운 것
kubectl apply -f k8s/deployment.yaml -f k8s/service.yaml
```

파일을 하나씩, 위 순서대로 지정한다. `kubectl apply -f k8s/`처럼 폴더째 넘기면
**Deployment가 만들어지지 않는데 오류가 마지막 한 줄로만 나와 성공한 것처럼
보인다.** 기전과 실측은
[`docs/k8s-local-verification.md`](docs/k8s-local-verification.md)의 3단계에 있다 —
설명을 두 곳에 두면 갈라지므로 그쪽에만 둔다.

| 경로 | 역할 |
|---|---|
| `Dockerfile` | 빌드 단계와 실행 단계를 나눈 이미지 정의. 실행은 루트가 아닌 사용자로, node가 1번 프로세스가 되게 한다 |
| `k8s/namespace.yaml` | 전용 이름공간 `grownup-todo` |
| `k8s/deployment.yaml` | 배포 정의. 무중단 갱신, 세 종류의 프로브, 종료 유예·드레인 설정 |
| `k8s/service.yaml` | 파드 앞의 고정 진입점 |
| `k8s/secret.example.yaml` | `DATABASE_URL`을 담을 Secret의 예시. **값은 비어 있고, 실제 값은 커밋하지 않는다** |

Docker Desktop에 들어 있는 쿠버네티스로 직접 띄워 보고, 프로브·정상 종료·종료
로그·재배포 중 요청 실패 0건까지 확인하는 절차는
**[`docs/k8s-local-verification.md`](docs/k8s-local-verification.md)**에 명령 단위로 있다.

애플리케이션이 듣는 포트는 환경변수 `PORT`가 정하고, 비워 두면 4080으로 뜬다.
이 값은 `Dockerfile`의 `EXPOSE`, `k8s/`의 포트 설정과 반드시 같아야 하며 그
일치는 `src/config/deployment-port.spec.ts`가 테스트로 고정한다.

프로브는 경로가 둘로 갈린다 — 생존 확인·기동 확인은 종료 중에도 200인
`/api/v1/ping`을, 준비 확인은 종료가 시작되면 503이 되는 `/api/v1/ready`를 본다.
매니페스트가 준비 확인의 주기·실패 허용 횟수를 드레인 대기
(`SHUTDOWN_DRAIN_DELAY_MS`)와 짝으로 맞춰야 하고, 그 짝을
`src/health/deployment-probe.spec.ts`가 테스트로 고정한다. 어긋나도 오류가 나지
않고 배출만 조용히 사라지므로 눈으로만 관리하지 않는다.

## 데이터베이스 마이그레이션

```bash
npm run prisma:migrate    # 마이그레이션 생성·적용 (개발)
npm run prisma:deploy     # 마이그레이션 적용만 (배포)
npm run prisma:status     # 적용 상태 확인
npm run prisma:studio     # 데이터 브라우저
```

Prisma 7은 `migrate dev`가 클라이언트를 재생성하지 않는다. 스키마를 바꿨다면 `npm run prisma:generate`를 별도로 실행한다.
