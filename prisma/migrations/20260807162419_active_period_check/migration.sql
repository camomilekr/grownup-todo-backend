-- 활성 기간의 뒤집힌·빈 구간을 DB가 막는다.
--
-- Service의 `assertShape`가 같은 규칙으로 400을 던지지만, `updateTodo`의
-- 읽기→검증→쓰기 사이에 잠금이 없어 서로 반대쪽 필드를 고치는 두 요청이 각자의
-- 스냅샷으로 검증을 통과할 수 있다 — 그 경쟁의 패자가 저장하는 뒤집힌·빈 기간을
-- 여기서 거절한다(사용자 확정: 트랜잭션 직렬화 대신 CHECK 제약).
--
-- 등호 없는 `<`인 이유: 활성 판정이 반열림 구간(active_from <= 순간 < active_until)
-- 이라 두 값이 같으면 만족하는 순간이 없는 빈 구간이다 — `assertShape`의 `>=`
-- 거절과 같은 경계다. NULL은 그쪽 제한이 없다는 뜻이라 비교하지 않고 허용한다.
--
-- Prisma는 CHECK를 스키마 언어로 표현하지 못한다(RLS·컬럼 코멘트와 같은 부류).
-- 그래서 SQL에 손으로 넣고, `migrate diff`도 이 제약을 비교하지 않으므로
-- 마이그레이션을 다시 뽑을 때 이 블록을 옮겨 붙여야 한다 — src/prisma/CONTEXT.md.
ALTER TABLE "todo_template"
ADD CONSTRAINT "todo_template_active_period_check"
CHECK (
    "active_from" IS NULL
    OR "active_until" IS NULL
    OR "active_from" < "active_until"
);
