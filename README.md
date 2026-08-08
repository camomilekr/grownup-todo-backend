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

## 데이터베이스 마이그레이션

```bash
npm run prisma:migrate    # 마이그레이션 생성·적용 (개발)
npm run prisma:deploy     # 마이그레이션 적용만 (배포)
npm run prisma:status     # 적용 상태 확인
npm run prisma:studio     # 데이터 브라우저
```

Prisma 7은 `migrate dev`가 클라이언트를 재생성하지 않는다. 스키마를 바꿨다면 `npm run prisma:generate`를 별도로 실행한다.
