# CONTEXT

> 마지막 업데이트: 2026-07-31

## 역할

todo 도메인. 사용자가 만든 todo의 "정의"(`TodoTemplate`)와 날짜별 "수행 내역"(`TodoHistory`)의 영속화 접근, 그리고 두 테이블이 공유하는 **날짜 키 계산**을 담당한다. Service·Controller·DTO는 아직 없다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `todo-local-date.ts` | `@db.Date` 컬럼에 넣을 날짜 키를 만드는 함수 셋. **이 폴더 밖에서 `Date`를 손으로 만들지 않게 하는 것이 목적이다** |
| `todo-local-date.spec.ts` | 자정 경계(KST·NY DST/표준시), ONCE 키의 불변성, 날짜 문자열 형식·달력 검증 |
| `todo-templates.repository.ts` | `todo_template` 접근. CRUD + ONCE·DAILY 목록 조회 |
| `todo-histories.repository.ts` | `todo_history` 접근. lazy 생성이라 쓰기 경로가 upsert 하나다 |
| `todos.module.ts` | 위 둘을 등록·export한다. `PrismaModule`을 직접 import한다 |

Repository의 검증은 `test/todos.e2e-spec.ts`가 실제 DB에 붙어서 한다. **단위 `.spec.ts`를 만들지 않는다** — `PrismaService`를 mock하면 호출 인자만 보게 되고 그건 구현 세부사항 테스트다.

## 조회 규칙 (확정된 요구사항)

**둘 다 진입점이 `todoTemplate`이다.** 히스토리는 완료·수정 시에만 생기므로 히스토리를 기준으로 조회하면 **미완료 항목이 전부 빠진다.**

| | 메서드 | 조건 |
|---|---|---|
| ONCE | `findOnceWithoutCompletedHistory(userId)` | 완료 히스토리가 없는 것 전부. **날짜로 필터하지 않고 `suspendedAt`도 보지 않는다** — 예정일이 지나도 사라지지 않고, 완료하면 사라진다 |
| DAILY | `findDailyActiveOn(userId, historiedOn)` | 그날 활성(`activeFrom`~`activeUntil`) + 중단 안 됨. 그날 히스토리를 붙여 준다 |

**어제 것이 오늘로 밀려오지 않는다.** DAILY 조건은 "그날 활성인가"이고 히스토리 유무는 조건이 아니다 — 어제 완료하지 않았으면 어제는 그대로 미완료로 남고 오늘은 히스토리 없이 다시 나온다. 활성 기간은 **양 끝을 포함**한다(`lte`/`gte`), `activeFrom`·`activeUntil`이 `null`이면 그쪽 제한이 없다.

**`suspendedAt`은 DAILY 전용이다.** 일시 중지는 반복을 멈추는 개념이라 ONCE에는 무의미하고, `findOnceWithoutCompletedHistory`는 이 컬럼을 보지 않는다 — ONCE template에 값을 넣어도 목록에서 빠지지 않는다. ONCE에 중지 개념을 두는 것은 확정된 요구사항에 없어 **현재 동작을 테스트로 고정**했다.

**완료 여부 판정은 Repository가 하지 않는다.** `findDailyActiveOn`은 `histories`를 0개 또는 1개 붙여 주기만 하고, `completedAt`을 읽어 완료로 판정하는 것은 Service다. 반면 `findOnceWithoutCompletedHistory`는 "완료 히스토리 없음"이 **쿼리 조건 자체**라서 `completedAt: { not: null }`이 `where`에 들어간다 — 그 차이가 두 계층의 경계다.

## 날짜 키

| 함수 | 언제 쓰는가 | 타임존 | 대상 컬럼 |
|---|---|---|---|
| `toHistoriedOn({ completeType, createdAt, performedAt, timeZone })` | **히스토리 키의 유일한 진입점** | 내부에서 갈린다 | `todo_history.historied_on` |
| `toLocalDateKey(instant, tz)` | 조회에 넘길 "오늘" 계산 | 유저 타임존 | (`findDailyActiveOn`의 인자) |
| `parseLocalDateKey('2026-08-01')` | 사용자가 **고른 날짜** — 순간이 없을 때 | 무관 | `active_from`, `active_until` |

**`toHistoriedOn`이 진입점 하나인 이유.** `completeType`에 따라 규칙이 완전히 다른데 그 선택을 호출자에게 맡기면 ONCE에 DAILY 규칙을 쓰는 코드가 타입체크·lint·테스트를 전부 통과한다. 그래서 ONCE용 내부 함수는 **export하지 않는다.**

- `DAILY` → 수행 시각을 **유저 타임존** 기준 날짜로. 이 값이 곧 유저에게 보여 주는 날짜다
- `ONCE` → template `createdAt`의 **UTC 날짜**

**ONCE가 `createdAt`만 쓰는 이유.** ONCE 히스토리는 한 건만 생겨야 하는데 DB 제약은 `@@unique([todoId, historiedOn])` 하나다. 그래서 키가 움직이지 않는 것이 단건성의 유일한 근거이고, 움직일 수 있는 입력을 **전부** 배제해야 한다. `createdAt`은 `@default(now())`이고 `@updatedAt`이 아니라 절대 변하지 않는다 — 반면 `shouldDoAt`은 수정 가능하고 `timeZone`은 유저가 언제든 바꾸는 설정이다(여행, 기기 설정 반영). **결과적으로 ONCE 키에는 가변 입력이 하나도 없다.**

**대가**: ONCE의 `historied_on`은 유저가 보는 날짜와 무관한 식별자다. 실질 비용은 없다 — ONCE 목록은 날짜로 필터하지 않고, 예정일은 `shouldDoAt`이, 완료 시점은 `completedAt`이 답한다. 다만 **ONCE를 날짜별로 묶어 보여 주는 데 이 컬럼을 쓰지 마라.**

**반환값은 전부 UTC 자정 `Date`다.** `@prisma/adapter-pg`가 `@db.Date`에 넘길 값을 `getUTCFullYear`/`getUTCMonth`/`getUTCDate`로 직렬화하므로, 로컬 타임존 자정으로 만들면 하루가 밀린다. KST에서 `new Date(2026, 7, 1).toISOString()`은 `2026-07-31T15:00:00.000Z`이고 저장되는 값은 `2026-07-31`이다 — **예외가 나지 않아서** DAILY todo가 하루 일찍 활성화되고 어떤 테스트도 잡지 못한다.

`parseLocalDateKey`는 `new Date('2026-08-01')`이 마침 UTC 자정으로 파싱되는 것에 기대지 않는다. 그 동작은 형식에 따라 갈리고(`'2026-8-1'`은 구현 정의 동작으로 로컬 시각이 된다), **달력에 없는 날짜를 조용히 넘긴다**(`2026-02-30` → `03-02`).

**파일명이 `todo-local-date.ts`인 것은 컬럼명(`historied_on`)과 어긋나 보이지만 의도한 것이다.** 이 파일의 주제는 특정 컬럼이 아니라 "유저 타임존 기준 날짜(local date)"라는 개념이고, `toLocalDateKey`·`parseLocalDateKey`는 `historied_on` 밖(`active_from`/`active_until`, 조회 인자)에도 쓰인다. 컬럼 값을 만드는 함수만 컬럼 이름을 따라 `toHistoriedOn`이다.

## 두 테이블이 나뉜 이유

todo를 만들면 `todo_template` 행 하나가 생기고, 실제로 수행한 내역은 `todo_history`가 날짜별로 따로 보관한다. history는 **완료하거나 진행값을 기록할 때 비로소 생긴다**(lazy) — "행이 없다"가 곧 "그날 아무것도 하지 않았다"다. 그래서 쓰기 경로가 create/update로 갈리지 않고 `upsertForHistoriedOn` 하나다.

history의 값 컬럼은 template을 가리키지 않고 **복제한다.** template을 나중에 수정해도 지나간 날의 기록이 소급해 바뀌지 않아야 하기 때문이다. **복제 자체는 Service의 일이다** — 어떤 필드를 어떻게 옮길지가 비즈니스 판단이라서 Repository는 완성된 스냅샷을 인자로 받는다.

**`userId`는 반드시 template에서 복제한다.** 요청 컨텍스트(로그인 유저)에서 채우면 남의 `todoId`에 자기 기록을 붙이는 요청이 된다. `(todoId, userId)` 복합 FK가 DB에서 막지만 결과는 FK 위반이라 원인이 드러나지 않는다. 이 방어는 `test/todos.e2e-spec.ts`가 고정한다.

### 타입으로 막아 둔 것

**`todoType`·`completeType`은 생성 후 수정할 수 없다**(사용자 확정 요구). template은 `UpdateTodoTemplateInput`의 `Omit`이, history는 `TodoHistoryChanges`의 화이트리스트가 막는다. **DB 제약이 아니라 타입 방어이므로**, 그것이 사라지면 `verify`만 깨지고 런타임은 조용히 허용한다 — `test/todos.e2e-spec.ts`가 `@ts-expect-error`로 그 컴파일 오류의 존재를 고정한다(`Omit`에서 필드를 빼면 "Unused '@ts-expect-error' directive"로 typecheck가 깨진다).

막는 이유가 둘 다르다.

- `todoType` — 히스토리가 생성 시 이 값을 복제하고 이후 수정하지 않는다. template의 타입을 바꾸면 **그 뒤에 생기는 히스토리만 새 타입이 되어 같은 todo의 기록이 타입별로 갈린다.** 지나간 통계가 어긋나고 `targetValue`·`targetUnit`의 의미도 달라진다
- `completeType` — 이미 쌓인 히스토리의 `historiedOn` **파생 규칙이 소급해 달라진다**(ONCE는 `createdAt`, DAILY는 수행일). 유니크 키의 의미가 바뀐다

그 밖에 `UpdateTodoTemplateInput`에서 `userId`를(소유자 변경은 이 계층의 일이 아니다), `TodoHistoryChanges`에서 `historiedOn`을(유니크 키이고, 바꾸는 것은 "다른 날 기록으로 옮기는 것"이라 upsert의 일이 아니다) 뺐다.

### soft delete

**조회와 쓰기 모두 `deletedAt: null`을 건다.** 조회에서 보이지 않는 행이 쓰기에서는 수정되는 비대칭을 두지 않는다 — soft delete된 행에 `update`/`softDelete`를 부르면 `P2025`가 난다. 특히 `softDelete`를 두 번 부르면 두 번째가 거절된다. 조건이 없으면 **복구·감사에 쓰이는 최초 삭제 시각이 조용히 덮어써진다.**

`findById`·`findByTodoIdAndHistoriedOn`이 `findUnique`가 아니라 `findFirst`인 이유도 같다 — 유니크 키에 `deletedAt`이 없어서 `findUnique`로는 걸러낼 수 없다. 쓰기 쪽은 Prisma의 extendedWhereUnique로 `where: { todoId, deletedAt: null }`을 쓴다.

**히스토리 복구는 `softDelete`의 반대가 아니라 `upsertForHistoriedOn`이 한다** — 그쪽 `update` 분기가 `deletedAt: null`을 걸어 같은 행을 되살린다. 없으면 완료 취소 후 재완료에서 `P2002`가 난다.

**`upsertForHistoriedOn`의 `update` 분기는 `snapshot`을 전부 무시한다.** 들어가는 것은 `changes`와 `deletedAt: null`뿐이다(실제 SQL의 `DO UPDATE SET`에 스냅샷 컬럼이 없다). 지나간 기록을 소급 변경하지 않는다는 의도이지만, **기존 히스토리에 반영하고 싶은 값은 `changes`에 담아야 한다** — `snapshot`에 넣으면 조용히 아무 일도 일어나지 않는다.

**리마인드 시각(`remindAt`)의 진실은 history가 있으면 history, 없으면 template이다.** history 쪽은 복제 후에도 수정할 수 있어("오늘만 다른 시각") 오버라이드가 된다. 형식 `"HH:mm"`은 DB가 보장하지 않는다 — 검증은 DTO의 몫이고 아직 없다(`src/prisma/CONTEXT.md`의 "입력 경계에서 검증·정규화해야 하는 것").

## 아직 없는 것

- **Service·Controller·DTO.** `TodosModule`이 Repository를 `exports`하는 것은 그때까지의 임시 상태다. Service가 들어오면 Repository를 `exports`에서 빼야 한다 — 그렇지 않으면 다른 도메인이 Repository를 직접 불러 비즈니스 규칙을 우회한다
- **알림 스캔용 인덱스가 template·history 양쪽에 없다.** history는 `@@index([historiedOn, remindAt])`, template은 `@@index([completeType, remindAt])` 자리다. 읽는 코드가 없는 인덱스는 쓰기 비용만 내므로 스캔 코드와 함께 넣는다
- **ONCE `shouldDoAt` 수정 시 처리.** 예정일을 바꿔도 `historiedOn`은 움직이지 않으므로 히스토리를 옮길 필요가 없다. 다만 "예정일이 지난 ONCE"를 어떻게 보여 줄지는 Service가 정한다

## 의존성

- `@nestjs/common` — `Injectable`, `Module`
- `src/prisma/prisma.service.ts` — Repository가 생성자 주입으로 받는다
- `src/generated/prisma` — 모델·enum 타입. `todo-local-date.ts`는 `CompleteType`을 **타입으로만** 가져와 런타임 의존이 없다
