# CONTEXT

> 마지막 업데이트: 2026-08-05

## 역할

Prisma 클라이언트를 NestJS DI 컨테이너와 라이프사이클에 붙인다. 도메인 로직은 없다 — 영속화 접근의 진입점만 제공하고, 실제 쿼리는 이것을 주입받는 도메인별 `*.repository.ts`가 쓴다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `prisma.service.ts` | `PrismaClient`를 상속한 Provider. 생성자에서 어댑터를 만들고 `onModuleInit`/`onModuleDestroy`로 커넥션 풀을 여닫는다 |
| `prisma.module.ts` | `PrismaService`를 등록하고 `exports`한다. `@Global()`이 아니다 |
| `prisma.service.spec.ts` | 배선 단위 테스트. DB에 붙지 않는다 |

스키마와 마이그레이션은 이 폴더가 아니라 저장소 루트의 `prisma/`에 있다. CLI 설정은 루트 `prisma.config.ts`다.

## 스키마 (루트 `prisma/schema.prisma`)

| 모델 | 테이블 | 역할 |
|---|---|---|
| `AppUser` | `app_user` | todo 소유자. `timeZone`이 날짜 키 계산의 기준이다 (`user`는 Postgres 예약어라 테이블명을 피했다) |
| `TodoTemplate` | `todo_template` | todo의 "정의". 생성하면 이 행 하나가 생긴다 |
| `TodoHistory` | `todo_history` | 날짜별 **완료 기록**. 할 일의 내용은 담지 않고 실적만 담는다. 완료하거나 진행값을 입력할 때 **비로소** 행이 생긴다 |

enum은 `CompleteType`(일회성 `ONCE`·매일 반복 `DAILY`)과 `TodoType`(일반 `GENERAL`·숫자형 `NUMERIC`·걸음수 `STEPS`)이다. **`STEPS` 전용 수치 컬럼은 없다** — 타입별로 컬럼을 나누지 않고 `targetValue`/`targetUnit`(+ history의 `progressValue`) 한 쌍으로 통합한다. PK는 전부 `BigInt @default(autoincrement())` → `BIGSERIAL`이고, FK는 `onDelete: Cascade`다. **`AppUser` 한 행을 지우면 그 유저의 template·history가 전부 사라진다** — 테스트에서 정리할 때 이 성질을 쓴다.

**`todo_history`의 유니크는 `@@unique([todoId, historiedOn])`이고 부분 유니크가 아니다.** 두 방향 모두 시도할 이유가 있어 보이지만 둘 다 더 나쁘다.

- `where: { deletedAt: null }` → 생성되는 복합 유니크 입력 타입에 그 조건이 들어가지 않아 `upsert`/`findUnique`가 soft delete된 행을 집는다
- ONCE 전용 `@@unique([todoId], where: { completeType: ONCE })` → Prisma가 `todoId`를 **단독 유니크로 믿는다.** DAILY는 같은 `todoId`로 여러 행이 있는데 `findUnique({ where: { todoId } })`가 타입상 성립해 버린다

지운 기록도 이 제약의 대상이라 그 자리를 계속 차지한다. **한 번 지운 기록은 되살리지 않는다** — 완료 취소는 삭제가 아니라 `completed_at`을 비우는 수정이다.

### Prisma가 표현하지 못해 SQL에 손으로 넣은 것 — 둘 다 `migrate diff`가 보지 못한다

마이그레이션 SQL 맨 아래에 **RLS 블록과 코멘트 블록**이 손으로 들어가 있다. **마이그레이션을 다시 뽑을 때 반드시 두 블록을 옮겨 붙여라.**

| | 왜 손으로 넣는가 | 빠지면 |
|---|---|---|
| `ENABLE ROW LEVEL SECURITY` × 4 — 세 테이블 + `_prisma_migrations`(이쪽만 `IF EXISTS`) | Prisma 스키마에 RLS 문법이 없다 | anon 키만으로 전 데이터가 열린다 (아래) |
| `COMMENT ON TABLE` 3 + `COMMENT ON COLUMN` 32 | **Prisma의 `///` 주석은 DB로 가지 않는다** — 생성된 TS 클라이언트의 JSDoc으로만 들어간다 | psql·DataGrip·Supabase 대시보드에서 컬럼 이름만 보인다 |

**`migrate diff`는 둘 중 어느 것도 비교하지 않는다.** 빠져도 `migrate status`·`migrate diff`·`verify`·나머지 테스트가 전부 초록으로 통과한다(drift 검사가 `No difference detected.`로 통과하는 것을 확인했다). **유일한 관문은 `test/schema-guard.e2e-spec.ts`다** — `public`을 훑어 RLS가 꺼진 테이블이나 코멘트 없는 테이블·컬럼이 하나라도 있으면 실패한다. **목록을 하드코딩하지 않았으므로 앞으로 추가하는 테이블·컬럼에도 자동으로 적용된다.**

**RLS는 예외가 없다 — `_prisma_migrations`도 켠다.** 그 테이블도 default ACL로 `anon`에게 전권이 붙는데, 지워지면 다음 `migrate deploy`가 첫 마이그레이션을 재적용하려 들어 `CREATE TABLE`에서 깨지고, 가짜 행이 들어가면 적용되지 않은 마이그레이션이 조용히 건너뛰어진다.

**그 한 줄만 `ALTER TABLE IF EXISTS`다. `IF EXISTS`를 빼면 마이그레이션이 적용되지 않는다** — `migrate dev`가 마이그레이션을 먼저 shadow DB에서 검증하는데 **그쪽에는 이력 테이블이 없어서** `ERROR: relation "_prisma_migrations" does not exist`로 죽는다(실측). 실제 DB에서는 Prisma가 이력 테이블을 마이그레이션 실행 **전에** 만들므로 존재하고, `IF EXISTS`가 shadow DB에서만 조용히 넘어간다. 이력 테이블을 드롭한 빈 DB(첫 배포와 같은 조건)에서 RLS가 실제로 켜지고 `migrate status`가 그 뒤에도 도는 것을 확인했다.

**코멘트는 `_prisma_migrations`를 제외한다.** 이쪽 예외는 정당하다 — Prisma가 소유·관리하는 테이블이라 우리 스키마 문서화 대상이 아니고, Prisma가 구조를 바꿀 때 코멘트가 어긋난 채 남는다.

**RLS는 켜져 있고 정책은 0개다 — 그게 의도한 상태다.**

없으면 무엇이 열리는가: Supabase에는 `postgres` 롤이 `public`에 만드는 모든 테이블에 `anon`·`authenticated`·`service_role` 권한을 자동으로 붙이는 default ACL이 있다(`pg_default_acl`). Prisma로 만든 테이블도 대상이라 **`anon`에게 `SELECT,INSERT,UPDATE,DELETE`가 붙는다.**

**이 프로젝트는 현재 Data API(PostgREST)가 비활성이라 그 권한에 도달하는 경로가 없다.** RLS는 그것이 켜지는 경우를 위한 **대비**이고 현재 노출된 구멍을 막는 것이 아니다 — 위험을 실제보다 크게 읽지 마라. 켜지면 `public`이 노출되어 클라이언트에 배포되는 anon 키만으로 전 유저 이메일과 todo가 열리고, 복합 FK로 지킨 소유자 일치가 인증을 지나지 않는 경로 앞에서 무의미해진다. 백엔드는 `rolbypassrls`라 **미리 켜 두는 비용이 0이다.**

**정책을 만들지 않는 이유**: 이 앱은 백엔드를 경유하고 PostgREST를 쓰지 않는다. 정책 0개면 `anon`·`authenticated`는 권한이 있어도 아무 행에 닿지 못하고, 백엔드가 쓰는 `postgres` 롤은 `rolbypassrls=true`라 영향을 받지 않는다. 실측하면 같은 트랜잭션에서 `postgres`가 본 행 수 1 / `anon`이 본 행 수 0이다. Data API를 쓰기로 하면 그때 정책을 추가한다.

**마이그레이션을 다시 뽑을 때는 `--create-only`를 끼운다.** `migrate dev`로 바로 적용한 뒤 SQL을 편집하면 체크섬이 어긋나 "modified after it was applied"가 된다. 순서는 `migrate dev --create-only` → RLS·코멘트 블록 추가 → `migrate dev`(적용)다. 그러면 체크섬이 편집된 파일로 기록된다.

### DB가 강제하는 것과 코드가 지켜야 하는 것

**소유자 일치는 DB가 강제한다. 다만 "일치"의 뜻이 좁다.** `todo_history`는 `(todo_id, user_id)` **복합 FK**로 `todo_template`을 참조한다(`todo_history_todo_id_user_id_fkey`). 그래서 남의 `todoId`에 자기 `userId`를 붙인 행은 삽입 자체가 거절된다 — 실측하면 `insert or update on table "todo_history" violates foreign key constraint "todo_history_todo_id_user_id_fkey"`다. 이 FK의 참조 대상을 만들기 위해 `todo_template`에 `@@unique([todoId, userId])`가 있다(PK와 논리적으로 중복이지만 Postgres가 복합 FK에 유니크 제약을 요구한다).

**그 FK가 강제하는 것은 "기록에 적힌 소유자가 그 할 일의 실제 소유자인가"다. "요청자가 그 소유자인가"는 강제하지 못한다** — DB는 요청자가 누구인지 모른다. 그 둘의 차이가 코드의 몫이고, `TodoHistoriesRepository.upsertForHistoriedOn`의 확인 조회가 그 자리를 맡는다(`(todo_id, user_id)`로 정의를 찾아 없으면 거절한다).

**그래서 `user_id`에 넣는 값은 요청자의 식별자여야 한다.** FK는 값이 일치하는지만 보고 **어디서 왔는지는 모른다.** 소유자로 좁히지 않고 읽은 정의에서 복제하면 그 값이 제3자의 것이어도 정의와 일치하므로 **FK도, 앞서는 소유자 검사도 둘 다 통과한다.** 근거와 실패 경로는 `src/todos/todo-histories.repository.ts`의 `TodoHistorySnapshot` 주석에 있다.

**이 지시는 한 곳에 있지 않았다.** 코드 주석·스키마 주석·폴더 문서·저장소 문서·마이그레이션 SQL, 그리고 **실제 DB의 컬럼 코멘트**까지 여러 계층에 같은 말이 흩어져 있었고 방향을 뒤집을 때 전부 찾아야 했다. **그래서 이런 서술을 고칠 때는 저장소를 `grep`하는 것만으로 부족하다** — DB 코멘트와 `prisma generate` 산출물까지 봐야 한다.

**어긋남을 잡아 주는 자동 관문은 없다.** `test/schema-guard.e2e-spec.ts`는 코멘트의 **존재**만 보고 내용을 비교하지 않으며(목록을 하드코딩하지 않는 설계의 대가다), `migrate diff`도 코멘트를 비교 대상에 넣지 않는다. **컬럼 코멘트만 고치는 마이그레이션은 `--create-only`로 만들면 빈 파일이 나오는 것이 정상이고**(구조 차이가 없다) 거기에 `COMMENT ON COLUMN`을 손으로 넣는다.

**ONCE의 "히스토리 한 건"은 DB가 강제하지 못한다.** 제약은 `(todo_id, historied_on)` 하나뿐이라 DAILY의 "날짜별 한 행"만 직접 표현한다. ONCE가 단건이 되는 것은 **`historied_on`이 template당 하나로 고정되기 때문**이고, 그 값을 만드는 것은 `src/todos/todo-local-date.ts`의 `toHistoriedOn` 하나다.

그 고정을 위해 **ONCE의 `historied_on`은 template `created_at`의 UTC 날짜만 쓴다.** `created_at`은 `@default(now())`이고 `@updatedAt`이 아니라 절대 변하지 않는다 — 반면 `should_do_at`은 수정 가능하고 `time_zone`은 유저가 언제든 바꾸는 설정이다(여행, 기기 설정). 그중 하나라도 키에 들어가면 **그 todo와 무관한 변경으로** 키가 옮겨져 완료 기록이 둘 남는다. **결과적으로 ONCE 키에는 가변 입력이 하나도 없다.**

**대가**: ONCE의 `historied_on`은 표시용 날짜가 아니라 중복 방지 키다. 실질 비용은 없다 — ONCE 목록은 `todo_template`을 진입점으로 "완료 히스토리가 없는 것"을 찾고 **날짜로 필터하지 않는다.** 예정일은 `should_do_at`이, 완료 시점은 `completed_at`이 답한다. 반면 DAILY의 `historied_on`은 유저 타임존 기준이고 그것이 곧 표시 날짜다.

**`app_user.email @unique`는 두 가지와 부딪힌다.**

- **soft delete** — 탈퇴 후 같은 이메일로 재가입하면 `P2002`가 나는데, 조회가 `deletedAt: null`을 걸어 그 행은 코드에서 보이지 않는다. **가입 경로는 soft delete된 행까지 조회해야 하는 예외 자리다**
- **대소문자** — `varchar` 비교는 기본 collation에서 대소문자를 구분하므로 `Foo@x.com`과 `foo@x.com`이 별개 계정이 된다. **저장 전에 소문자로 정규화한다.** `citext`는 Prisma가 네이티브 타입으로 지원하지 않아 `Unsupported()`가 되고 그러면 이 컬럼을 Prisma로 읽고 쓸 수 없다. 표현식 유니크 인덱스(`lower(email)`)도 Prisma가 모르는 인덱스라 `findUnique({ where: { email } })`를 깬다 — 정규화는 입력 경계의 책임이다

### 입력 경계에서 검증·정규화해야 하는 것 (아직 아무것도 없다)

DTO 계층이 생기는 라운드가 **이 셋을 한 묶음으로** 처리해야 한다. 지금은 어느 것도 DB가 막지 않는다.

| 컬럼 | 무엇이 필요한가 | 막지 않으면 |
|---|---|---|
| `app_user.email` | `trim()` + `toLowerCase()` | 같은 사람이 두 계정을 갖는다 |
| `app_user.time_zone` | IANA 이름인지 (`Intl.supportedValuesOf('timeZone')`) | `toLocalDateKey`가 `RangeError`를 던져 **그 유저의 모든 날짜 계산이 영구히 실패한다** |
| `todo_template.remind_at` | `HH:mm` 형식인지 (00~23시, 00~59분). 정규식은 표 아래에 | 스캔이 문자열 동등 비교라 **에러 없이 영원히 알림이 오지 않는다** |

`todo_template.active_from`/`active_until`은 이 표에서 빠졌다. 순간 컬럼(`timestamptz`)이
되면서(마이그레이션 `20260805111110_active_period_to_timestamptz`) `should_do_at`과 같은
성질이 됐고, 날짜 형식 검증이 필요 없다 — 시간 해석은 클라이언트의 몫이다(사용자 확정).

`remind_at`에 쓸 정규식이다. 표 안에 두면 마크다운이 파이프를 열 구분자로 읽어 표가
깨지므로(이스케이프하면 렌더링은 되지만 raw 텍스트에서 복사하면 틀린 식이 된다) 여기에
따로 둔다. **복사해서 그대로 쓰면 된다.**

```ts
@Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
```

### 날짜·시각 컬럼에 어떤 타입을 쓰는가

**순간을 담는 컬럼은 `@db.Timestamptz(3)`, 달력의 날짜를 담는 컬럼은 `@db.Date`다.** 생성·수정·삭제 시각과 `should_do_at`·`completed_at`·`active_from`·`active_until`이 앞쪽이고, 날짜 컬럼은 이제 `historied_on` 하나다. 타임존 없는 `timestamp`를 쓰는 컬럼은 하나도 없다. (활성 기간 두 컬럼은 원래 `@db.Date`였다가 순간이 됐다 — 서버가 시간 처리를 하지 않고 클라이언트가 해석한다는 전제가 확정되면서다.)

**`timestamptz`는 이름과 달리 타임존을 저장하지 않는다.** 받은 값을 협정 세계시(Coordinated Universal Time, UTC)로 정규화하고 타임존은 버린다 — 서울 시각 9시와 협정 세계시 자정을 각각 넣으면 저장된 값이 같아진다(실측). 그래서 이 타입이 가리키는 것은 표기가 아니라 순간 하나다.

**유저별 타임존 변환은 그 순간이 있어야 성립한다.** 같은 값 하나가 서울에서는 8월 1일 09:30이고 뉴욕에서는 7월 31일 20:30이라 날짜까지 갈리는데, 매일 반복하는 할 일의 "오늘"을 유저마다 다르게 계산하는 것이 정확히 그 연산이다.

**`timestamp`로 바꾸면 잃는 것이 크다.** 표기의 타임존을 버려 벽시계 숫자만 남으므로 어느 지역 시각인지 값이 말해 주지 않고, node-postgres는 그것을 읽을 때 실행 환경의 로컬 타임존으로 해석한다 — 같은 `2026-08-01 00:00:00`이 프로세스 타임존이 `Asia/Seoul`일 때 `2026-07-31T15:00:00Z`로, `UTC`일 때 `2026-08-01T00:00:00Z`로 읽히는 것을 확인했다. **서버 타임존이 바뀌면 같은 행이 다른 순간이 된다.** 이미 저장된 값에서 어느 지역 시각이었는지 복원할 방법이 없어 되돌리기도 어렵다.

**`date`는 반대로 타임존이 붙으면 안 된다.** 사용자가 캘린더에서 고른 "8월 1일"은 어느 지역에서 보든 8월 1일이어야 한다.

**`@db.Date` 컬럼(`historied_on`)에 넘기는 `Date`는 UTC 컴포넌트로 직렬화된다.** `@prisma/adapter-pg`의 `formatDate`가 `getUTCFullYear`/`getUTCMonth`/`getUTCDate`를 쓴다. 로컬 타임존 자정 `Date`를 넘기면 하루가 밀리므로 **손으로 만들지 말고** `src/todos/todo-local-date.ts`의 세 함수(`toHistoriedOn`·`toLocalDateKey`·`parseLocalDateKey`)가 만든 값을 쓴다. 히스토리 키는 **반드시 `toHistoriedOn`**을 거친다 — `completeType`에 따라 규칙이 갈리고 그 선택을 호출자에게 맡기면 틀려도 아무것도 실패하지 않는다.

### Prisma 명령에서 걸리는 것

**`prisma migrate dev`는 클라이언트를 재생성하지 않는다.** Prisma 7에서 달라진 점이고, 스키마를 바꾼 뒤 `npx prisma generate`를 따로 돌리지 않으면 `src/generated/prisma`가 낡은 채로 남아 typecheck가 없는 모델을 모른다고 한다.

**`prisma migrate reset`을 쓰지 마라.** Supabase에서 `DROP SCHEMA public CASCADE`를 시도하고, 그러면 `anon`·`authenticated`·`service_role`에 걸린 기본 GRANT가 함께 사라져 손으로 다시 걸어야 한다. 첫 마이그레이션을 다시 뽑아야 할 때는 **마이그레이션이 만든 오브젝트만 드롭**한다(세 테이블 `CASCADE` + 두 enum 타입 + `_prisma_migrations`). 초기화가 끝났는지는 `prisma db pull --print`가 `P4001 The introspected database was empty`를 내는 것으로 확인한다.

**`npx prisma migrate diff --from-migrations …`는 이 저장소에서 그대로 돌지 않는다.** `You must set 'datasource.shadowDatabaseUrl' in your 'prisma.config.ts' if you want to diff a migrations directory.`로 거절된다 — `prisma.config.ts`가 shadow DB URL을 의도적으로 비워 뒀기 때문이다(`migrate dev`는 임시 shadow DB를 스스로 만들어서 필요가 없다). drift를 볼 때는 `--from-config-datasource prisma.config.ts --to-schema prisma/schema.prisma --exit-code`를 쓴다. DB는 마이그레이션 SQL만으로 만들어지므로 "DB ↔ 스키마 파일"이 비면 "마이그레이션 ↔ 스키마 파일"도 빈 것이다.

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
