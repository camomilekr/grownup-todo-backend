# CONTEXT

> 마지막 업데이트: 2026-07-31

## 역할

유저(`app_user` 테이블) 도메인이다. **지금 담고 있는 것은 타임존 조회 하나뿐이다** — 매일 반복 할 일의 "오늘"을 계산하려면 그 값이 필요한데, 이 폴더가 생기기 전에는 저장소에 `AppUser`에 접근하는 코드가 하나도 없었다.

## 주요 파일

| 파일명 | 역할 |
|--------|------|
| `users.repository.ts` | `app_user` 접근. 현재 `findTimeZone` 하나 |
| `users.module.ts` | `UsersRepository`를 등록하고 내보낸다 |

Repository의 검증은 `test/users.e2e-spec.ts`가 실제 DB에 붙어서 한다. **단위 테스트를 따로 만들지 않는다** — `PrismaService`를 대역으로 바꾸면 쿼리가 무엇을 돌려주는지가 아니라 "어떤 인자로 불렸는가"만 확인하게 되고, 그것은 동작이 아니라 구현 방식을 검사하는 것이다. 그래서 **단위 커버리지에는 이 폴더가 0으로 나온다**(`npm test`의 `rootDir`이 `src`라 `test/` 아래를 돌지 않는다). 숫자만 보고 테스트가 없다고 판단하지 마라.

## 핵심 로직

### 타임존이 무엇을 정하는가

`AppUser.timeZone`은 `Asia/Seoul` 같은 IANA 이름이고, **매일 반복(DAILY) 할 일의 하루가 언제 바뀌는지**를 이 값이 정한다. 유저마다 그 순간이 다르므로 이 값 없이는 완료 기록의 날짜 키를 만들 수 없다(`src/todos/todo-local-date.ts`).

**형식이 올바른지 DB가 검사하지 않는다.** 잘못된 이름이 한 번 저장되면 날짜 계산 함수가 `RangeError`를 던지도록 되어 있어서(조용히 UTC로 떨어뜨리면 그 유저의 날짜가 전부 하루씩 어긋난 채 쌓인다) **그 유저의 모든 날짜 계산이 계속 실패한다.** `Intl.supportedValuesOf('timeZone')`에 들어 있는 이름인지 확인하는 것은 값을 받는 경계(요청 DTO)의 책임이고, 아직 그 계층이 없다.

### 없는 유저와 탈퇴한 유저를 같게 다룬다

`findTimeZone`은 둘 다 `null`을 돌려준다. 탈퇴는 행을 지우지 않고 `deletedAt`에 시각을 적는 방식이라 조건을 빼면 탈퇴한 행이 그대로 잡히고, 그러면 탈퇴한 유저의 할 일에 계속 날짜 키가 만들어져 기록이 쌓인다.

단건 조회(`findUnique`)가 아니라 `findFirst`를 쓰는 것도 그 조건 때문이다. 기본키에 `deletedAt`이 들어 있지 않아서 단건 조회로는 그 조건을 걸 수 없다.

**`null`을 어떤 오류로 바꿀지는 이 계층이 정하지 않는다.** Repository는 조회 조건만 담고, 없는 유저를 `NotFoundException`으로 바꾸는 것은 그 값을 쓰는 Service의 판단이다.

### `select`로 한 컬럼만 읽는다

이메일은 이 경로에 필요 없다. 필요하지 않은 개인정보를 메모리와 로그에 올리지 않기 위해서다.

## Service가 없는 이유

**판단할 것이 없다.** 이 모듈이 하는 일은 한 컬럼을 읽어 주는 것뿐이고, 없는 유저를 어떤 오류로 바꿀지는 값을 쓰는 쪽이 정한다. 그런 자리에 Service를 한 겹 두면 Repository를 그대로 대신 부르는 껍데기가 된다.

그래서 `users.module.ts`가 **Repository를 그대로 `exports`한다.** 가입·탈퇴·프로필 수정처럼 판단이 붙는 경로가 생기면 그때 Service를 만들고 Repository를 `exports`에서 뺀다.

가입 경로를 만들 때 미리 알아야 할 것이 둘 있다(`src/prisma/CONTEXT.md`에 근거가 있다).

- **이메일 중복 검사는 탈퇴한 행까지 포함해서 해야 한다.** `email`이 유일 컬럼이라 탈퇴 후 같은 이메일로 다시 가입하면 `P2002`(고유 제약 위반)가 나는데, 일반 조회는 `deletedAt: null`을 걸어 그 행이 코드에서 보이지 않는다 — 화면에는 그 유저가 존재하지 않는 것처럼 보인다
- **이메일은 저장 전에 소문자로 정규화해야 한다.** `varchar` 비교가 대소문자를 구분하므로 `Foo@x.com`과 `foo@x.com`이 별개 계정이 된다

## 아직 없는 것

- **Service·Controller·DTO.** 인증 수단이 정해질 때 가입·탈퇴와 함께 만든다
- **이 모듈을 import하는 곳.** 타임존을 읽는 쪽(`TodosService`)이 생기는 라운드에서 `TodosModule`이 물게 된다. 그래서 `test/users.e2e-spec.ts`는 `AppModule`과 `UsersModule`을 함께 `imports`에 넣는다 — `PrismaModule`은 같은 클래스를 두 모듈이 import하므로 인스턴스가 하나로 공유된다

## 의존성

- `@nestjs/common` — `Injectable`, `Module`
- `src/prisma/prisma.service.ts` — Repository가 생성자로 주입받는다
- `src/prisma/prisma.module.ts` — `PrismaModule`이 `@Global()`이 아니므로 직접 import한다
