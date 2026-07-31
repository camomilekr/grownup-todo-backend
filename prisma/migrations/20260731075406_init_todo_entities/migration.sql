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
-- 아래 네 문장은 Prisma가 만든 것이 아니라 손으로 추가한 것이다. Prisma 스키마에는
-- RLS(행 단위 접근 제어)를 표현하는 문법이 없기 때문이다.
--
-- **이 파일을 다시 뽑을 일이 생기면 이 블록과 아래 코멘트 블록을 반드시 옮겨 붙여라.**
-- `prisma migrate diff`는 둘 중 어느 것도 비교하지 않아서, 빠뜨려도 마이그레이션 상태
-- 확인·스키마 비교·`npm run verify`가 전부 통과한다. 잡아 주는 곳은
-- `test/schema-guard.e2e-spec.ts` 하나뿐이다.
--
-- 왜 필요한가: Supabase 프로젝트에는 `postgres` 역할이 `public` 스키마에 만드는 모든
-- 테이블에 `anon`(로그인하지 않은 사용자)·`authenticated`·`service_role` 권한을 자동으로
-- 붙이는 설정이 있다. Prisma가 만든 테이블도 예외가 아니라서 전부 `anon`에게 조회·삽입·
-- 수정·삭제 권한이 붙는다.
--
-- **이 프로젝트는 현재 Supabase Data API(DB를 HTTP로 직접 노출하는 기능)가 꺼져 있어서
-- 그 권한에 닿을 수 있는 경로가 없다.** 지금 뚫려 있는 구멍을 막는 것이 아니라 그 기능을
-- 켜는 날을 위한 대비다. 켜지면 앱에 심어 배포되는 anon 키만으로 전 유저의 이메일과 할
-- 일을 읽고 남의 기록을 지울 수 있게 된다. 백엔드가 쓰는 `postgres` 역할은 RLS를
-- 통과하도록 되어 있으므로 **미리 켜 두는 비용이 0이다.**
--
-- `_prisma_migrations`(Prisma가 마이그레이션 이력을 적어 두는 테이블)도 포함한다. 이
-- 테이블 역시 위 자동 권한의 대상이고, 내용이 지워지면 다음 배포가 첫 마이그레이션을
-- 다시 적용하려 들어 "테이블이 이미 있다"로 실패한다. 반대로 가짜 행이 들어가면 적용해야
-- 할 마이그레이션이 조용히 건너뛰어진다.
--
-- **그 한 줄만 `IF EXISTS`인 이유가 있다. 빼면 마이그레이션이 아예 적용되지 않는다.**
-- `prisma migrate dev`는 마이그레이션을 실제 DB에 넣기 전에 임시 DB(shadow database)에서
-- 먼저 시험하는데, **그 임시 DB에는 이력 테이블이 없어서** 평범한 `ALTER TABLE`은
-- `relation "_prisma_migrations" does not exist`로 죽는다(실제로 겪었다). 실제 DB에서는
-- Prisma가 이력 테이블을 마이그레이션 실행 **전에** 만들어 두므로 존재한다. 그래서
-- `IF EXISTS`가 임시 DB에서만 조용히 넘어가는 역할을 한다. 이력 테이블까지 지운 빈 DB에
-- 적용해 RLS가 실제로 켜지는 것과 그 뒤에도 마이그레이션 명령이 도는 것을 확인했다.
--
-- 왜 정책(POLICY)을 하나도 만들지 않는가: 이 앱은 모든 접근이 백엔드를 거치고 Data API를
-- 쓰지 않는다. 정책이 0개면 `anon`·`authenticated`는 권한이 있어도 어떤 행에도 닿지
-- 못하고 백엔드가 쓰는 역할만 통과한다 — 그것이 지금 원하는 상태다. 나중에 Data API를
-- 쓰기로 하면 그때 정책을 추가한다.
ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "todo_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "todo_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS "_prisma_migrations" ENABLE ROW LEVEL SECURITY;

-- Comment
--
-- 이 블록도 손으로 추가한 것이다. **Prisma 스키마에 적은 `///` 주석은 DB로 가지 않는다** —
-- 생성되는 TypeScript 코드의 주석으로만 들어가서, psql이나 DataGrip, Supabase 대시보드로
-- 스키마를 열면 설명이 하나도 보이지 않는다. 그래서 컬럼마다 따로 설명을 붙인다.
--
-- 여기는 DB 도구에서 한 줄로 보이므로 **"이게 무슨 컬럼인가"에만 답한다.** 왜 그렇게
-- 설계했는지와 어떤 함정이 있는지는 `prisma/schema.prisma`의 주석과 각 폴더의
-- `CONTEXT.md`, 그리고 `docs/todo-schema.md`가 담는다.
--
-- `_prisma_migrations`에는 달지 않는다. Prisma가 소유하고 관리하는 테이블이라 우리가
-- 문서화할 대상이 아니고, Prisma가 그 구조를 바꿀 때 설명만 남아 어긋난다.
COMMENT ON TABLE "app_user" IS '할 일의 소유자. Supabase auth.users 와는 아직 연결하지 않았고 email 이 유일 식별자다.';
COMMENT ON COLUMN "app_user"."user_id" IS 'id';
COMMENT ON COLUMN "app_user"."email" IS '로그인·식별용 이메일. 소문자로 바꿔서 저장한다 (대소문자가 다르면 서로 다른 계정이 된다)';
COMMENT ON COLUMN "app_user"."time_zone" IS '이 유저가 사는 지역의 시간대 (예: Asia/Seoul). 매일 반복 할 일의 "오늘"이 언제 바뀌는지를 정한다';
COMMENT ON COLUMN "app_user"."created_at" IS '가입 일시';
COMMENT ON COLUMN "app_user"."updated_at" IS '유저 정보를 마지막으로 고친 일시';
COMMENT ON COLUMN "app_user"."deleted_at" IS '탈퇴 일시. 값이 있으면 탈퇴한 유저다 (행은 남겨 둔다)';

COMMENT ON TABLE "todo_template" IS '할 일의 정의. 제목·설명·목표치 같은 할 일의 내용은 전부 여기에만 있고 todo_history 로 복사하지 않는다.';
COMMENT ON COLUMN "todo_template"."todo_id" IS 'id';
COMMENT ON COLUMN "todo_template"."user_id" IS '이 할 일을 만든 유저 (app_user) 의 id';
COMMENT ON COLUMN "todo_template"."title" IS '할 일 제목';
COMMENT ON COLUMN "todo_template"."description" IS '할 일의 설명 (markdown 문서)';
COMMENT ON COLUMN "todo_template"."todo_type" IS '무엇으로 달성하는가 (일반 GENERAL, 숫자형 NUMERIC, 걸음수 STEPS). 만든 뒤에는 바꿀 수 없다 - 완료 기록에는 종류가 저장되지 않아서 지나간 기록을 해석하는 근거가 이 컬럼 하나뿐이고, 바꾸면 이미 쌓인 기록이 전부 새 종류로 다시 해석된다';
COMMENT ON COLUMN "todo_template"."complete_type" IS '한 번만 하는가 매일 반복하는가 (일회성 ONCE, 매일 DAILY). 만든 뒤에는 바꿀 수 없다 - 완료 기록의 날짜를 만드는 규칙이 이 값에 따라 다르고, 기록에는 이 값이 저장되지 않아 해석할 근거가 여기뿐이다';
COMMENT ON COLUMN "todo_template"."remind_at" IS '알림을 보낼 시각 (HH:mm, 유저 타임존 기준). 알림 시각은 이 컬럼 하나로 정해진다 - 날짜별로 다르게 설정하는 기능은 없다';
COMMENT ON COLUMN "todo_template"."should_do_at" IS '일회성 할 일을 언제까지 해야 하는지. 이 시각이 지나도 목록에서 사라지지 않고 완료해야 사라진다';
COMMENT ON COLUMN "todo_template"."target_value" IS '목표 수치. 숫자형·걸음수에서 쓰고 일반에서는 비어 있다';
COMMENT ON COLUMN "todo_template"."target_unit" IS '목표 수치의 단위 (예: 회, 걸음, 분). 타입별로 컬럼을 나누지 않고 target_value 와 이 한 쌍이 전부를 담는다';
COMMENT ON COLUMN "todo_template"."active_from" IS '매일 반복 할 일이 시작되는 날짜 (이 날 포함). 비어 있으면 시작 제한이 없다';
COMMENT ON COLUMN "todo_template"."active_until" IS '매일 반복 할 일이 끝나는 날짜 (이 날 포함). 비어 있으면 기한 없이 계속된다';
COMMENT ON COLUMN "todo_template"."created_at" IS '할 일을 만든 일시. 일회성 할 일의 완료 기록 날짜를 이 값에서 만든다';
COMMENT ON COLUMN "todo_template"."updated_at" IS '할 일을 마지막으로 고친 일시';
COMMENT ON COLUMN "todo_template"."deleted_at" IS '삭제 일시. 값이 있으면 삭제된 할 일이다 (행은 남겨 둔다)';

COMMENT ON TABLE "todo_history" IS '할 일을 실제로 수행한 완료 기록. 언제 얼마나 했는지만 담고 할 일의 내용은 담지 않는다. 완료하거나 진행값을 입력할 때 비로소 행이 생기므로, 행이 없다는 것은 그날 아무것도 하지 않았다는 뜻이다.';
COMMENT ON COLUMN "todo_history"."todo_history_id" IS 'id';
COMMENT ON COLUMN "todo_history"."todo_id" IS '어떤 할 일의 기록인지 (todo_template 의 id)';
COMMENT ON COLUMN "todo_history"."user_id" IS '기록의 소유자 (app_user) 의 id. todo_template 에서 가져와 채우며, (todo_id, user_id) 를 묶은 외래키가 소유자가 어긋난 행을 거절한다';
COMMENT ON COLUMN "todo_history"."historied_on" IS '이 기록이 속한 날짜. 매일 반복이면 실제로 수행한 날 (유저 타임존 기준) 이고, 일회성이면 todo_template 의 생성일 (UTC 기준) 이다. 일회성에서는 화면에 보여 줄 날짜가 아니라 기록이 둘 생기지 않게 막는 열쇠이므로 조회·표시에 쓰지 말 것';
COMMENT ON COLUMN "todo_history"."target_value" IS '그날 기준의 목표 수치. todo_template 에서 복사해 온다 - 나중에 목표를 바꿔도 지나간 날의 달성률이 다시 계산되지 않게 하려는 것이다';
COMMENT ON COLUMN "todo_history"."target_unit" IS '그날 기준의 목표 단위. target_value 와 같은 이유로 복사해 온다';
COMMENT ON COLUMN "todo_history"."progress_value" IS '그날 실제로 달성한 값. 숫자형은 사용자 입력, 걸음수는 건강 데이터가 출처이고 일반에서는 비어 있다';
COMMENT ON COLUMN "todo_history"."completed_at" IS '완료한 시각. 비어 있지 않으면 완료한 것이다 (별도의 완료 여부 컬럼을 두지 않는다)';
COMMENT ON COLUMN "todo_history"."created_at" IS '기록이 처음 생긴 일시';
COMMENT ON COLUMN "todo_history"."updated_at" IS '기록을 마지막으로 고친 일시';
COMMENT ON COLUMN "todo_history"."deleted_at" IS '지워진 일시. 완료 기록은 개별적으로 지울 수 없으므로 이 값은 할 일 자체가 지워질 때만 찍힌다. 완료 취소와는 다르다 - 완료 취소는 completed_at 을 비우는 수정이고 행은 그대로 남는다. 지워진 할 일에는 새 기록을 만들 수 없다';
