-- 활성 기간 두 컬럼을 date에서 timestamptz(3)로 바꾼다.
--
-- 판정의 의미도 함께 바뀐다 — "날짜, 양 끝 포함"에서 "순간, 반열림
-- (activeFrom <= 순간 < activeUntil)"으로. 그래서 두 컬럼의 변환식이 다르다.
--
--   active_from  : 포함 시작일의 UTC 자정 → 포함 시작 순간. 그대로 옮기면 된다
--   active_until : 포함 종료일의 UTC 자정 → 미포함 상한 순간. 그대로 옮기면
--                  "그 날 하루"가 통째로 빠지므로 하루를 더해 다음 날 자정으로
--                  보정한다 (포함 종료일 → 미포함 상한)
--
-- date::timestamp는 자정의 타임존 없는 timestamp가 되고, AT TIME ZONE 'UTC'가
-- 그것을 UTC 벽시계로 읽어 timestamptz로 만든다. 캐스팅만 쓰면(::timestamptz)
-- 서버 타임존으로 해석되어 서버 설정에 따라 다른 순간이 된다.
--
-- 이 마이그레이션을 뽑은 시점에 개발 DB의 todo_template은 0행이라(직접 조회로
-- 확인) 변환식이 실제로 바꾸는 행은 없다. 그래도 명시하는 이유는, 행이 있는
-- 다른 환경에 이 마이그레이션이 적용되는 날 조용히 하루가 어긋나는 것을 막기
-- 위해서다.

-- AlterTable
ALTER TABLE "todo_template"
ALTER COLUMN "active_from" SET DATA TYPE TIMESTAMPTZ(3)
    USING ("active_from"::timestamp AT TIME ZONE 'UTC'),
ALTER COLUMN "active_until" SET DATA TYPE TIMESTAMPTZ(3)
    USING (("active_until" + INTERVAL '1 day')::timestamp AT TIME ZONE 'UTC');

-- ---------------------------------------------------------------------------
-- 컬럼 코멘트 (Prisma가 표현하지 못해 손으로 넣는다)
--
-- ALTER TYPE은 기존 코멘트를 보존하므로 갱신하지 않으면 "이 날 포함"이라는
-- 낡은 문구가 남는다. migrate diff도 schema-guard도 코멘트 **내용**은 보지
-- 않아 어떤 관문도 그것을 잡지 못한다 — 그래서 타입을 바꾸는 이 마이그레이션이
-- 코멘트도 함께 바꾼다.
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "todo_template"."active_from" IS '매일 반복 할 일이 활성인 기간의 시작 순간 (이 순간 포함). 비어 있으면 시작 제한이 없다. 활성 판정은 반열림 구간이다: active_from <= 순간 < active_until';
COMMENT ON COLUMN "todo_template"."active_until" IS '매일 반복 할 일이 활성이 아니게 되는 상한 순간 (이 순간 미포함). 비어 있으면 기한 없이 계속된다. 활성 판정은 반열림 구간이다: active_from <= 순간 < active_until';
