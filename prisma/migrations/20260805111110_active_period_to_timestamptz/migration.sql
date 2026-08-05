-- 활성 기간 두 컬럼을 date 에서 timestamptz(3) 으로 바꾼다.
--
-- 서버가 시간 처리를 하지 않고 클라이언트가 해석한다는 전제(사용자 확정)로,
-- 활성 기간이 "달력의 날짜"에서 "순간"이 됐다. 활성 판정은 요청 순간과 이 두 값을
-- 그대로 비교한다.
--
-- **USING 절은 prisma migrate diff 가 만들어 주지 않아 손으로 넣었다.** USING 없이
-- date -> timestamptz 캐스팅을 하면 Postgres 가 기존 값의 자정을 **DB 세션 타임존**으로
-- 해석한다 — 세션 타임존이 UTC 가 아닌 환경에서 기존 날짜가 다른 순간으로 옮겨진다.
-- 기존 값은 코드가 UTC 자정 Date 로만 저장해 왔으므로(src/todos/todo-local-date.ts 의
-- parseLocalDateKey), `::timestamp AT TIME ZONE 'UTC'` 로 UTC 해석을 못 박아야 값이
-- 보존된다.

-- AlterTable
ALTER TABLE "todo_template" ALTER COLUMN "active_from" SET DATA TYPE TIMESTAMPTZ(3) USING ("active_from"::timestamp AT TIME ZONE 'UTC'),
ALTER COLUMN "active_until" SET DATA TYPE TIMESTAMPTZ(3) USING ("active_until"::timestamp AT TIME ZONE 'UTC');

-- 컬럼 코멘트 갱신. prisma migrate diff 는 코멘트를 비교하지 않으므로 여기에 손으로
-- 넣는다 — 빠뜨려도 test/schema-guard.e2e-spec.ts 는 코멘트의 **존재**만 보므로 기존
-- 코멘트(날짜 기준 서술)가 남은 채 통과한다. 내용 어긋남을 잡는 자동 관문은 없다.
COMMENT ON COLUMN "todo_template"."active_from" IS '매일 반복 할 일이 활성인 기간의 시작 순간 (이 순간 포함). 비어 있으면 시작 제한이 없다. 서버는 이 값에 날짜 의미를 부여하지 않는다 - 시간 해석은 클라이언트의 몫이고, 활성 판정은 요청 순간과 그대로 비교한다';
COMMENT ON COLUMN "todo_template"."active_until" IS '매일 반복 할 일이 활성인 기간의 종료 순간 (이 순간 포함). 비어 있으면 기한 없이 계속된다. 서버는 이 값에 날짜 의미를 부여하지 않는다 - 시간 해석은 클라이언트의 몫이고, 활성 판정은 요청 순간과 그대로 비교한다';
