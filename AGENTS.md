# AGENTS.md — 코딩 에이전트를 위한 안내

이 저장소에서 작업하는 모든 코딩 에이전트가 먼저 알아야 할 것을 담는다. 사람을 위한 소개(기술 스택·설치·실행)는 `README.md`에 있다.

## 프로젝트 한 줄 요약

NestJS 10 + TypeScript + Prisma 7 + PostgreSQL(Supabase) 기반의 할 일(todo) 관리 백엔드다.

## 반드시 지킬 명령어

```bash
npm run verify     # lint → prettier → typecheck. 각 커밋 시점에 통과해야 한다
npm test           # 단위 테스트. verify에 테스트는 들어 있지 않다 — 별도로 돌린다
npm run test:e2e   # jest rootDir이 src라 `npm test`는 test/를 돌지 않는다
```

pre-commit 훅은 `verify`만 돌린다. **테스트를 깨뜨린 커밋을 막는 자동 관문은 이 저장소에 없다** — 커밋 전에 세 명령을 모두 직접 돌린다. `--no-verify` 우회는 금지다.

## 작업 규약의 위치

상세 규약은 `.claude/rules/` 아래에 있고, Claude Code에서는 세션 시작 시 자동으로 컨텍스트에 들어온다. 다른 에이전트라면 작업 전에 직접 읽는다.

| 문서 | 내용 |
|---|---|
| `.claude/rules/core.md` | 개발 루프 전체 — 작업 크기별 절차(티어), 브랜치·커밋·PR 규칙, 오케스트레이터 규약 |
| `.claude/rules/nestjs.md` | NestJS 코드 규약 — 폴더 배치, 계층 책임, 의존성 주입, 검증, 예외, 로깅 |
| `.claude/rules/testing.md` | 테스트 규약 — TDD(Test-Driven Development, 실패하는 테스트를 먼저 쓰는 개발 순서), 무엇을 테스트하는지, 파일 배치 |
| `.claude/rules/CONTEXT.md` | 폴더별 `CONTEXT.md` 관리 규칙 |

막혔을 때만 읽는 참조 문서는 `.claude/ref/` 아래에 있다 — `troubleshooting.md`(명령 실패), `testing-traps.md`(테스트가 예상과 다를 때), `incidents.md`(규약의 근거).

## 핵심 규칙 요약

다른 에이전트를 위해 가장 자주 걸리는 것만 추린다. 충돌하면 `.claude/rules/`가 우선한다.

- **기준 브랜치는 `develop`이다.** 브랜치는 `feature/{케밥케이스}`, PR(Pull Request)도 `develop`으로 보낸다. `develop`에 직접 커밋·푸시하지 않는다. `main`은 릴리스 절차 밖에서 손대지 않는다
- **TDD로 개발한다.** 실패하는 테스트를 먼저 쓰고 실패를 실제로 확인한 뒤 통과시킨다. 버그 수정은 재현 테스트부터
- **테스트 파일은 `*.spec.ts`이고 대상 파일 옆에 둔다.** `.test.ts`로 쓰면 jest `testRegex`에 걸리지 않아 실행되지 않는다. DB에 실제로 붙는 테스트만 `test/` 아래(e2e)
- **`src/` 하위 폴더를 건드리기 전에 그 폴더의 `CONTEXT.md`를 읽고, 작업이 끝나면 갱신한다**
- **주석·문서·커밋 메시지는 한국어로 쓴다.** 주석에는 왜를 적고, 축약어를 쓰지 않는다
- **커밋은 의미 단위로 나누고 파일을 경로로 지정한다.** `git add -A`를 습관으로 쓰지 않는다 — `docs/plan/`·`docs/dev-loop/`의 계획서와 기록은 커밋 대상이 아니다

## 아키텍처에서 먼저 알아야 할 것

- **도메인 하나가 폴더 하나다.** `src/todos/`, `src/users/`처럼 도메인으로 자르고, 계층(`controllers/`, `services/`)으로 자르지 않는다
- **할 일은 두 테이블로 나뉜다.** `todoTemplate`(정의 — 제목·목표치·알림 시각)과 `todoHistory`(완료 기록 — 언제 얼마나 했는지). 정의가 바뀌어도 지나간 기록이 흔들리지 않게 하기 위한 분리다. 상세는 `docs/todo-schema.md`와 `src/todos/CONTEXT.md`
- **Service·Repository 함수 명세는 `docs/todo-service-spec.md`에 있다.** 계층마다 실패를 알리는 방식이 다르다 — Repository는 `null`을 돌려주고, Service는 `NotFoundException` 같은 HTTP 예외로 바꾼다
- **기본키가 BIGSERIAL이라 식별자는 `bigint`다.** 테스트 픽스처에 숫자 리터럴을 넣으면 타입이 어긋난다(`1`이 아니라 `1n`). `BigInt`는 `JSON.stringify`가 거부하므로 직렬화는 `src/common/bigint-json.ts`가 처리한다
- **Prisma 7은 6과 다르다.** 드라이버 어댑터가 필수이고, `datasource` 블록에 접속 URL이 없으며(환경변수 `DATABASE_URL`·`DIRECT_URL`로 주입), `migrate dev`가 클라이언트를 재생성하지 않는다. 스키마·마이그레이션을 건드리기 전에 `src/prisma/CONTEXT.md`를 읽는다
- **`src/generated/prisma/`는 산출물이다.** `prisma generate`가 다시 만들고 `.gitignore`에 들어 있다 — 손으로 고치거나 문서를 두지 않는다
- **날짜는 사용자 타임존 기준이다.** 매일 반복 할 일의 "오늘" 경계 계산이 `src/todos/todo-local-date.ts`에 모여 있고, 유저 타임존은 `src/users/`가 조회한다. 날짜 경계를 건드리는 작업은 횡단 관심사라 독립 검토가 필요하다
