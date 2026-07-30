-- CreateEnum
CREATE TYPE "complete_type" AS ENUM ('ONCE', 'DAILY');

-- CreateEnum
CREATE TYPE "todo_type" AS ENUM ('GENERAL', 'NUMERIC', 'STEPS');

-- CreateTable
CREATE TABLE "app_user" (
    "user_id" BIGSERIAL NOT NULL,
    "email" VARCHAR(320) NOT NULL,
    "time_zone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Seoul',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "todo_template" (
    "todo_id" BIGSERIAL NOT NULL,
    "user_id" BIGINT NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "todo_type" "todo_type" NOT NULL,
    "complete_type" "complete_type" NOT NULL,
    "remind_at" VARCHAR(5),
    "should_do_at" TIMESTAMPTZ(3),
    "target_value" DECIMAL(12,2),
    "target_unit" VARCHAR(16),
    "active_from" DATE,
    "active_until" DATE,
    "suspended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "todo_template_pkey" PRIMARY KEY ("todo_id")
);

-- CreateTable
CREATE TABLE "todo_history" (
    "todo_history_id" BIGSERIAL NOT NULL,
    "todo_id" BIGINT NOT NULL,
    "user_id" BIGINT NOT NULL,
    "historied_on" DATE NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "todo_type" "todo_type" NOT NULL,
    "complete_type" "complete_type" NOT NULL,
    "remind_at" VARCHAR(5),
    "should_do_at" TIMESTAMPTZ(3),
    "target_value" DECIMAL(12,2),
    "target_unit" VARCHAR(16),
    "progress_value" DECIMAL(12,2),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "todo_history_pkey" PRIMARY KEY ("todo_history_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE INDEX "todo_template_user_id_deleted_at_idx" ON "todo_template"("user_id", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "todo_template_todo_id_user_id_key" ON "todo_template"("todo_id", "user_id");

-- CreateIndex
CREATE INDEX "todo_history_user_id_historied_on_idx" ON "todo_history"("user_id", "historied_on");

-- CreateIndex
CREATE UNIQUE INDEX "todo_history_todo_id_historied_on_key" ON "todo_history"("todo_id", "historied_on");

-- AddForeignKey
ALTER TABLE "todo_template" ADD CONSTRAINT "todo_template_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_history" ADD CONSTRAINT "todo_history_todo_id_user_id_fkey" FOREIGN KEY ("todo_id", "user_id") REFERENCES "todo_template"("todo_id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "todo_history" ADD CONSTRAINT "todo_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- EnableRowLevelSecurity
--
-- 아래 네 문장은 Prisma가 생성한 것이 아니라 손으로 추가한 것이다. Prisma 스키마에는
-- RLS를 표현하는 문법이 없다. 이 파일을 다시 뽑을 일이 생기면 **이 블록과 아래 코멘트
-- 블록을 반드시 옮겨 붙여라** — `migrate diff`가 둘 다 감지하지 못해서 빠져도 아무
-- 검사가 실패하지 않는다. 유일한 관문은 `test/schema-guard.e2e-spec.ts`다.
--
-- 왜 필요한가: Supabase 프로젝트에는 `postgres` 롤이 `public`에 만드는 모든 테이블에
-- `anon`·`authenticated`·`service_role` 권한을 자동으로 붙이는 default ACL이 걸려
-- 있다(`pg_default_acl`). Prisma 마이그레이션으로 만든 테이블도 그 대상이라 전부
-- `anon`에게 SELECT·INSERT·UPDATE·DELETE가 붙는다.
--
-- **이 프로젝트는 현재 Supabase Data API(PostgREST)가 비활성이라 그 권한에 도달하는
-- 경로가 없다.** RLS는 그것이 켜지는 경우를 위한 대비다 — 켜지면 클라이언트에 배포되는
-- anon 키만으로 전 유저의 이메일과 todo가 열리고 남의 수행 내역을 지울 수 있어서,
-- 복합 FK로 지킨 소유자 일치가 인증을 지나지 않는 경로 앞에서 무의미해진다. 백엔드가
-- 쓰는 롤은 `rolbypassrls=true`라 **미리 켜 두는 비용이 0이다.**
--
-- `_prisma_migrations`도 포함한다. Prisma가 만드는 테이블이지만 default ACL의 대상인
-- 것은 똑같고, 지워지면 다음 `migrate deploy`가 첫 마이그레이션을 재적용하려 들어
-- `CREATE TABLE`에서 깨진다. 반대로 가짜 행이 들어가면 적용되지 않은 마이그레이션이
-- 조용히 건너뛰어진다.
--
-- **그 한 줄만 `IF EXISTS`인 이유가 있다. 빼면 마이그레이션이 적용되지 않는다.**
-- `migrate dev`는 마이그레이션을 먼저 shadow DB에서 검증하는데 **그쪽에는 이력 테이블이
-- 없어서** `ERROR: relation "_prisma_migrations" does not exist`로 죽는다(실측). 실제 DB
-- 에서는 Prisma가 이력 테이블을 마이그레이션 실행 **전에** 만들므로 존재하고, 그래서
-- `IF EXISTS`가 shadow DB에서만 조용히 넘어간다. 이력 테이블을 드롭한 빈 DB에 적용해
-- RLS가 실제로 켜지는 것과 `migrate status`가 그 뒤에도 도는 것을 확인했다.
--
-- 왜 정책(POLICY)을 만들지 않는가: 이 앱은 백엔드를 경유하고 PostgREST를 쓰지 않는다.
-- 정책이 0개면 `anon`·`authenticated`는 권한이 있어도 아무 행에 접근하지 못하고,
-- `postgres`는 RLS를 우회한다 — 그것이 이 구조에서 원하는 상태다. 나중에 Data API를
-- 쓰기로 하면 그때 정책을 추가한다.
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "todo_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "todo_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- Comment
--
-- 이 블록도 손으로 추가한 것이다. **Prisma의 `///` 주석은 DB로 가지 않는다** —
-- 생성된 TS 클라이언트의 JSDoc으로만 들어가서, psql·DataGrip·Supabase 대시보드로
-- 스키마를 열면 아무 설명이 없다. 그래서 컬럼 하나하나에 COMMENT를 건다.
--
-- 배경·함정·왜 그렇게 설계했는지는 `prisma/schema.prisma`의 `///` 주석과 각 폴더
-- `CONTEXT.md`가 담는다. 여기서는 "이게 무슨 컬럼인가"에만 답한다.
-- `_prisma_migrations`에는 달지 않는다 — Prisma가 소유·관리하는 테이블이라 우리 스키마
-- 문서화 대상이 아니고, Prisma가 구조를 바꿀 때 코멘트가 어긋난 채 남는다.
COMMENT ON TABLE "app_user" IS 'todo 소유자. Supabase auth.users 와는 아직 연결하지 않았고 email 이 유일 식별자다.';
COMMENT ON COLUMN "app_user"."user_id" IS 'id';
COMMENT ON COLUMN "app_user"."email" IS '로그인·식별용 이메일. 소문자로 정규화해 저장한다 (대소문자가 다르면 별개 계정이 된다)';
COMMENT ON COLUMN "app_user"."time_zone" IS 'IANA 타임존 이름 (예: Asia/Seoul). DAILY todo 의 historied_on 을 계산하는 기준이다';
COMMENT ON COLUMN "app_user"."created_at" IS '유저가 생성된 일시';
COMMENT ON COLUMN "app_user"."updated_at" IS '유저 정보가 최종 수정된 일시';
COMMENT ON COLUMN "app_user"."deleted_at" IS '유저가 soft delete (탈퇴) 된 일시';

COMMENT ON TABLE "todo_template" IS 'todo 의 원본 데이터. 어떤 일을 할지에 대한 원본 정의가 들어갑니다.';
COMMENT ON COLUMN "todo_template"."todo_id" IS 'id';
COMMENT ON COLUMN "todo_template"."user_id" IS 'todo 소유자 (app_user) 의 id';
COMMENT ON COLUMN "todo_template"."title" IS 'todo 제목';
COMMENT ON COLUMN "todo_template"."description" IS 'todo 의 설명 (markdown 문서)';
COMMENT ON COLUMN "todo_template"."todo_type" IS 'todo의 타입 (일반 GENERAL, 숫자형 NUMERIC, 걸음수 STEPS). 생성 후에는 수정 불가능 - 히스토리가 생성시 이 값을 복제하므로, 바꾸면 같은 todo 의 기록이 타입별로 갈린다';
COMMENT ON COLUMN "todo_template"."complete_type" IS '완료 타입 (일회성 ONCE, 매일 반복 DAILY). 생성 후에는 수정 불가능 - 이미 쌓인 히스토리의 historied_on 파생 규칙이 소급해 달라진다';
COMMENT ON COLUMN "todo_template"."remind_at" IS '리마인드 알림 시간 (HH:mm)';
COMMENT ON COLUMN "todo_template"."should_do_at" IS 'todo를 완료해야 하는 일시';
COMMENT ON COLUMN "todo_template"."target_value" IS '목표 수치. NUMERIC·STEPS 타입에서 쓰고 GENERAL 에서는 NULL 이다';
COMMENT ON COLUMN "todo_template"."target_unit" IS '목표 수치의 단위 (예: 회, 걸음, 분). 타입별로 컬럼을 나누지 않고 target_value 와 이 한 쌍으로 통합한다';
COMMENT ON COLUMN "todo_template"."active_from" IS 'DAILY todo 의 반복 시작 날짜';
COMMENT ON COLUMN "todo_template"."active_until" IS 'DAILY todo 의 반복 종료 날짜. NULL 이면 무기한이다';
COMMENT ON COLUMN "todo_template"."suspended_at" IS 'DAILY todo 가 일시 중지된 일시. 활성 기간이 남아 있어도 값이 있으면 DAILY 목록·리마인드 대상에서 빠진다. ONCE 에는 무의미하다 - ONCE 목록 조회는 이 컬럼을 보지 않는다';
COMMENT ON COLUMN "todo_template"."created_at" IS 'todoTemplate 가 생성된 일시';
COMMENT ON COLUMN "todo_template"."updated_at" IS 'todoTemplate 가 최종 수정된 일시';
COMMENT ON COLUMN "todo_template"."deleted_at" IS 'todoTemplate 가 soft delete 된 일시';

COMMENT ON TABLE "todo_history" IS 'todo 가 어떻게 실행되었는지를 기록하는 히스토리 데이터. 단건의 경우 한 건만 생성되고, 데일리인 경우 완료하거나 수정한 경우 날짜별로 생성·수정된다.';
COMMENT ON COLUMN "todo_history"."todo_history_id" IS 'id';
COMMENT ON COLUMN "todo_history"."todo_id" IS '원본 todoTemplate 의 id';
COMMENT ON COLUMN "todo_history"."user_id" IS 'todo 소유자 (app_user) 의 id. todoTemplate 에서 복제하며 (todo_id, user_id) 복합 FK 가 소유자 일치를 강제한다';
COMMENT ON COLUMN "todo_history"."historied_on" IS 'history 를 기록한 일자. DAILY 는 수행한 날 (유저 타임존 기준) 이고, ONCE 는 todoTemplate 생성일의 UTC 날짜다 — ONCE 에서는 표시용 날짜가 아니라 한 건만 생기게 하는 중복 방지 키이므로 조회·표시에 쓰지 말 것';
COMMENT ON COLUMN "todo_history"."title" IS 'todoHistory 의 제목 (todoTemplate 에서 복제되어 생성되나 후에 편집 가능함)';
COMMENT ON COLUMN "todo_history"."description" IS 'todoHistory 의 설명 (markdown 문서. todoTemplate 에서 복제되어 생성되나 후에 편집 가능함)';
COMMENT ON COLUMN "todo_history"."todo_type" IS 'todo의 타입. todoTemplate 로부터 생성시 복제됨. 생성 후에는 수정 불가능 (GENERAL, NUMERIC, STEPS)';
COMMENT ON COLUMN "todo_history"."complete_type" IS '완료 타입. todoTemplate 로부터 생성시 복제됨. 생성 후에는 수정 불가능 (ONCE, DAILY)';
COMMENT ON COLUMN "todo_history"."remind_at" IS '리마인드 알림 시간 (HH:mm). todoTemplate 로부터 생성시 복제됨. 생성 후 수정 가능';
COMMENT ON COLUMN "todo_history"."should_do_at" IS 'todo를 완료해야 하는 일시';
COMMENT ON COLUMN "todo_history"."target_value" IS '목표 수치. todoTemplate 에서 복제됨';
COMMENT ON COLUMN "todo_history"."target_unit" IS '목표 수치의 단위. todoTemplate 에서 복제됨';
COMMENT ON COLUMN "todo_history"."progress_value" IS '그날 실제로 달성한 값. NUMERIC 은 사용자 입력, STEPS 는 건강 데이터가 출처다. GENERAL 에서는 NULL 이다';
COMMENT ON COLUMN "todo_history"."completed_at" IS 'todoHistory 가 언제 완료되었는지. 완료 여부는 이 값이 NULL 인지로 판정한다 (todoTemplate 의 완료 여부가 아니라 이 히스토리의 완료 여부다)';
COMMENT ON COLUMN "todo_history"."created_at" IS 'todoHistory 가 생성된 일시';
COMMENT ON COLUMN "todo_history"."updated_at" IS 'todoHistory 가 최종 수정된 일시';
COMMENT ON COLUMN "todo_history"."deleted_at" IS 'todoHistory 가 soft delete 된 일시';
