# CONTEXT

> 마지막 업데이트: 2026-07-30

## 역할

Prisma 클라이언트를 NestJS DI 컨테이너와 라이프사이클에 붙인다. 도메인 로직은 없다 — 영속화 접근의 진입점만 제공하고, 실제 쿼리는 이것을 주입받는 도메인별 `*.repository.ts`가 쓴다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `prisma.service.ts` | `PrismaClient`를 상속한 Provider. 생성자에서 어댑터를 만들고 `onModuleInit`/`onModuleDestroy`로 커넥션 풀을 여닫는다 |
| `prisma.module.ts` | `PrismaService`를 등록하고 `exports`한다. `@Global()`이 아니다 |
| `prisma.service.spec.ts` | 배선 단위 테스트. DB에 붙지 않는다 |

스키마와 마이그레이션은 이 폴더가 아니라 저장소 루트의 `prisma/`에 있다. CLI 설정은 루트 `prisma.config.ts`다.

## 핵심 로직

**접속 문자열이 두 개고, 쓰는 주체가 다르다.**

| 환경변수 | 포트 | 모드 | 누가 쓰는가 |
|---|---|---|---|
| `DATABASE_URL` | 6543 | 트랜잭션 | 애플리케이션 런타임 (이 폴더) |
| `DIRECT_URL` | 5432 | 세션 | Prisma CLI — 마이그레이션·`db pull`·`studio` |

마이그레이션이 세션 모드를 쓰는 이유는 트랜잭션 모드가 커넥션을 트랜잭션 단위로 회수해서 DDL과 advisory lock이 깨지기 때문이다. **`DIRECT_URL`은 이 폴더의 코드가 읽지 않는다** — 런타임 배포 환경에 없어도 부팅된다.

**Prisma 7에서 달라진 것 셋.** 6까지의 예제를 그대로 옮기면 전부 걸린다.

1. **드라이버 어댑터가 필수다.** Rust 쿼리 엔진이 없어졌고, `@prisma/adapter-pg`의 `PrismaPg`를 생성자에 넘긴다. `datasourceUrl` 옵션은 제거됐다 — 넘기면 `PrismaClientConstructorValidationError`가 난다
2. **`datasource` 블록에 `url`/`directUrl`이 없다.** 스키마 파일에는 `provider`만 남고, URL은 `prisma.config.ts`(CLI)와 이 Service(런타임)로 갈라졌다
3. **클라이언트가 `src/generated/prisma`에 생성된다.** `node_modules` 안이 아니다. `import { PrismaClient } from '../generated/prisma/client'`

**`?pgbouncer=true`를 URL에 붙이지 않는다.** 그 파라미터는 Rust 엔진에게 named prepared statement를 끄라는 지시였다. node-postgres는 애초에 이름 없는 statement를 쓰므로 지금은 아무 효과가 없고 오해만 남는다. 트랜잭션 모드 풀러에서 동시 쿼리가 엉키지 않는다는 것은 `test/prisma.e2e-spec.ts`가 고정한다.

**생성자에서 `configService`를 `private readonly`로 받지 않는다.** 파라미터 프로퍼티로 만들면 TypeScript가 `super()`를 첫 문장으로 요구하는데, 접속 문자열을 검증한 뒤 `super()`에 넘겨야 해서 순서가 맞지 않는다.

**`DATABASE_URL`이 비면 생성자가 던진다.** `ConfigModule`의 `validate`(`src/config/env.validation.ts`)가 이미 막지만 한 겹 더 둔 이유가 있다 — 비어 있으면 node-postgres가 libpq 기본값인 localhost로 조용히 붙어서, 장애가 "데이터가 없음"으로 위장한다.

**종료 훅이 `src/main.ts`의 `app.enableShutdownHooks()`에 달려 있다.** 이것을 지우면 `onModuleDestroy`가 불리지 않아 재배포마다 풀러 쪽에 커넥션이 타임아웃까지 남는다.

## 의존성

- `@nestjs/common` — `Injectable`, `Logger`, 라이프사이클 인터페이스
- `@nestjs/config` — `ConfigService`. `AppModule`이 `isGlobal: true`로 열어 두므로 이 모듈에서 다시 import하지 않는다
- `@prisma/adapter-pg` — `PrismaPg`. 내부적으로 `pg`(node-postgres)를 쓴다
- `src/generated/prisma` — `prisma generate` 산출물. 추적되지 않으며 `postinstall`이 다시 만든다
- `src/config/env.validation.ts` — 이 Service가 읽는 `DATABASE_URL`을 부팅 시점에 검증한다
