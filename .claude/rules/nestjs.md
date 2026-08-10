# NestJS 코드 규약

이 저장소는 NestJS 10 + TypeScript 백엔드다. 프레임워크가 구조를 강하게 정해 주는 대신, **그 구조를 우회했을 때 대가가 늦게 나타난다** — 아래는 우회하지 않기 위한 규약이다.

## 폴더와 파일 배치

**도메인 하나가 폴더 하나다.** 계층(`controllers/`, `services/`)으로 자르지 않는다. 기능을 고칠 때 폴더 하나만 열면 끝나야 한다.

```
src/
  main.ts              # 부트스트랩. 전역 파이프·필터·prefix를 여기서 건다
  app.module.ts        # 루트 모듈. 조립만 한다. 여기에 Provider를 늘리지 않는다
  todos/
    todos.module.ts
    todos.controller.ts
    todos.service.ts
    todos.repository.ts
    dto/create-todo.dto.ts
    todos.service.spec.ts
    CONTEXT.md
```

| 접미사 | 담는 것 |
|---|---|
| `*.controller.ts` | HTTP 경계 하나 |
| `*.service.ts` | 비즈니스 로직 |
| `*.repository.ts` | 영속화 접근 |
| `*.dto.ts` | 요청·응답 형태. 클래스로 쓴다 (`interface`는 런타임에 사라져 검증이 걸리지 않는다) |
| `*.spec.ts` | 테스트 |

**`*.entity.ts` 파일을 만들지 않는다.** 영속화 스키마는 `prisma/schema.prisma` 한 곳이고, 모델 타입은 `prisma generate`가 `src/generated/prisma`에 만들어 준다. 그것과 별도로 엔티티 클래스를 두면 같은 구조가 두 곳에 살면서 한쪽만 고쳐지는 날이 오고, 그때 어느 쪽이 진짜인지 판단할 근거가 없다. 도메인 타입이 필요하면 생성된 모델 타입을 가져와 좁혀 쓴다(`src/todos/todo-histories.repository.ts`의 `TodoHistorySnapshot`이 그 예다).

**파일명은 케밥케이스, 클래스명은 파스칼케이스다.** `create-todo.dto.ts` → `CreateTodoDto`.

**배럴 파일(`index.ts`)을 만들지 않는다.** 모듈 간 순환 의존성의 가장 흔한 출처이고, NestJS에서 순환 의존성은 컴파일이 아니라 런타임 주입 실패로 나타난다 — 원인을 찾는 데 드는 시간이 배럴로 아낀 import 줄 수보다 비싸다.

## 계층의 책임

**Controller는 HTTP를 안다. Service는 모른다.**

- **Controller**: 라우팅·DTO 수신·Service 호출·응답 반환. **여기에 조건 분기나 계산이 생기면 Service로 내린다.** `@Req()`·`@Res()`로 Express 객체를 꺼내지 않는다 — 꺼내는 순간 그 핸들러는 인터셉터와 직렬화를 우회한다
- **Service**: 비즈니스 로직 전부. `Request`, 상태 코드, 헤더를 모른다
- **Repository**: 쿼리와 매핑. 비즈니스 판단을 하지 않는다

**Service가 다른 Service를 부르는 것은 정상이다.** 단 방향이 한쪽이어야 한다. `forwardRef()`를 쓰고 싶어졌다면 그것은 해결책이 아니라 **경계가 잘못 그려졌다는 신호**다 — 공유 로직을 제3의 모듈로 빼라.

## 의존성 주입

**생성자 주입만 쓴다.** `private readonly`로 받는다.

```ts
constructor(private readonly todosRepository: TodosRepository) {}
```

- **`new`로 Service를 만들지 않는다.** 컨테이너 밖에서 만든 인스턴스는 주입받은 것과 다른 객체이고, 테스트에서 교체할 수 없다
- **Provider는 그것을 쓰는 모듈에 등록하고, 밖에 쓸 것만 `exports`에 넣는다.** 전부 `exports`하면 모듈 경계가 이름만 남는다
- 클래스가 아닌 것(설정 객체, 외부 클라이언트)을 주입할 때는 **문자열 대신 상수 토큰**을 쓴다

## 입력 검증

**`main.ts`에 `ValidationPipe`를 전역으로 건다.** 컨트롤러마다 붙이면 빠뜨린 곳이 검증 없이 열린다.

```ts
app.useGlobalPipes(
  new ValidationPipe({
    whitelist: true,              // DTO에 없는 필드는 버린다
    forbidNonWhitelisted: true,   // 버리는 대신 400으로 거절한다
    transform: true,              // 쿼리·파라미터를 DTO 타입으로 변환한다
  }),
);
```

- **모든 요청 본문은 DTO 클래스로 받고 `class-validator` 데코레이터를 붙인다.** 타입 애노테이션만으로는 아무것도 검증되지 않는다 — TypeScript 타입은 런타임에 없다
- **Entity를 그대로 응답하지 않는다.** 응답 형태를 DTO로 따로 둔다. Entity를 반환하면 컬럼을 하나 추가한 날 API가 조용히 바뀌고, 그중 하나가 `passwordHash`일 수 있다
- 경로 파라미터도 검증한다. `@Param('id', ParseIntPipe)`

## 설정과 비밀값

- **`process.env`를 코드에서 직접 읽지 않는다.** `@nestjs/config`의 `ConfigService`로만 읽는다. 직접 읽으면 어떤 환경변수가 필요한지가 코드 전체에 흩어져, 빠진 값이 배포 후에 드러난다
- **`.env` 파일은 커밋하지 않는다.** 필요한 키 목록은 값 없이 `.env.example`로 남긴다
- 기동 시점에 필수 환경변수를 검증한다. 없으면 **부팅을 실패시킨다** — 첫 요청에서 `undefined`로 터지는 것보다 낫다

## 예외

- **내장 HTTP 예외를 Service에서 던진다.** `NotFoundException`, `BadRequestException`, `ConflictException`. 상태 코드를 손으로 만들지 않는다
- **예외를 삼키지 않는다.** `catch`에서 아무것도 하지 않거나 `null`을 반환하면, 장애가 "데이터가 없음"으로 위장한다. 다시 던지거나 로깅하고 도메인 예외로 바꿔라
- 응답 형태 통일과 로깅은 **전역 `ExceptionFilter` 한 곳**에서 한다

## 비동기

- **I/O를 하는 메서드는 `async`로 선언하고 `Promise`를 반환한다.** RxJS `Observable`은 HTTP 핸들러의 기본형이 아니다 — 인터셉터·스트리밍처럼 필요한 곳에서만 쓴다
- **`await`를 빠뜨리지 마라.** `async` 함수를 `await` 없이 부르면 예외가 핸들러 밖으로 새어 나가 `unhandledRejection`이 된다. `void`로 의도적으로 버릴 때만 `void`를 명시한다
- 병렬로 돌려도 되는 것은 `Promise.all`로 묶는다. 순차 `await`는 대기 시간을 더한다

## 로깅

**`console.log`를 쓰지 않는다.** NestJS `Logger`를 클래스마다 인스턴스로 둔다 — 컨텍스트 이름이 로그에 함께 남는다.

```ts
private readonly logger = new Logger(TodosService.name);
```

**요청 본문·쿼리는 민감 키를 redact 처리한 뒤에만 로그에 남긴다. 토큰·비밀번호는 어떤 경우에도 남기지 않는다.** redact는 호출 지점이 아니라 로거 출구(`src/logging/pino-logger.service.ts`의 pino `redact` 설정) 한 곳에서 강제한다 — 새 민감 필드가 생기면 그곳의 `SENSITIVE_LOG_KEYS`에 추가한다. redact는 부분 문자열을 가리지 못하므로 **쿼리 문자열이 포함된 URL 원문을 로그 필드에 넣지 마라** — 경로만 남기고 쿼리는 구조화된 필드로 넘긴다.

## 테스트

**테스트 파일은 `*.spec.ts`이고 대상 파일 옆에 둔다.** `package.json`의 jest `testRegex`가 `.*\.spec\.ts$`, `rootDir`이 `src`다 — **`.test.ts`로 쓰면 실행되지 않는다.** e2e만 `test/` 아래에 두고 `npm run test:e2e`로 돌린다.

TDD(실패하는 테스트를 먼저 쓰는 개발 순서)와 무엇을 테스트하는지는 `.claude/rules/testing.md`를 따른다. 프레임워크 때문에 그 문서에 더해지는 것이 둘이다.

- **Service 단위 테스트를 어떻게 세우는가** — `@nestjs/testing`의 `Test.createTestingModule`로 대상 Service만 실제 Provider로 두고 의존성은 대역으로 바꾼다
- **Controller는 단위 테스트보다 `supertest` e2e가 값어치가 크다.** 라우팅·파이프·필터가 함께 걸린 상태를 확인해야 하기 때문이다 — 그것들을 벗겨 낸 Controller는 Service를 한 번 부르는 함수라 검증할 것이 남지 않는다

**DB를 실제로 붙이는 테스트는 e2e로 분류한다.** 단위 테스트에 붙이면 느려지고, 느린 테스트는 결국 실행되지 않는다.
