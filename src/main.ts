import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { setupApp } from './app-setup';
import { AppModule } from './app.module';
import { PinoLoggerService } from './logging/pino-logger.service';
import { registerProcessErrorHandlers } from './logging/process-error-handlers';

async function bootstrap() {
  // BigInt JSON 직렬화 가드를 여기서 부르지 않는다. `AppModule`이 import하는
  // `BigIntJsonModule`이 켠다 — 이 함수는 테스트가 실행하지 않으므로, 여기 두면
  // 지워도 아무 테스트가 깨지지 않고 테스트와 프로덕션의 직렬화 동작이 갈린다.
  //
  // `bufferLogs: true` — pino 로거가 DI 컨테이너에서 나오기 전의 부팅 로그를
  // 버렸다가 `useLogger` 시점에 pino로 흘려보낸다. 없으면 부팅 로그만 Nest
  // 기본 포맷으로 갈라진다.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // 앱 로거를 pino로 바꾼다. 이후 도메인 코드의 `new Logger(X.name)` 출력까지
  // 전부 pino JSON으로 나간다.
  app.useLogger(app.get(PinoLoggerService));

  // 잡히지 않은 예외·거절을 fatal로 남기고 프로세스를 살려 둔다. Node 기본
  // 동작(즉시 종료)을 의도적으로 막는 선택이다 — 근거는
  // `src/logging/process-error-handlers.ts` 주석에 있다.
  registerProcessErrorHandlers(app.get(PinoLoggerService));

  // HTTP 공통 설정(전역 prefix). e2e와 같은 함수를 부른다 — 여기 직접 쓰면
  // 테스트가 보는 경로와 실제 경로가 갈린다(`src/app-setup.ts`).
  setupApp(app);

  // SIGTERM·SIGINT에서 종료 훅(onModuleDestroy → beforeApplicationShutdown →
  // HTTP 서버 close → onApplicationShutdown)을 순서대로 부르게 한다. 이것이
  // 없으면 커넥션 풀이 닫히지 못하고, Supabase 풀러 쪽에 커넥션이 타임아웃까지
  // 남는다 — 재배포를 반복하면 풀이 마른다.
  //
  // **k8s 무중단 종료의 핵심은 네 국면 중 앞의 둘이다.** ShutdownRegistry의
  // beforeApplicationShutdown이 종료 플래그를 세워 readiness를 즉시 503으로
  // 만들고 시그널 종료면 드레인 대기를 하며(HTTP는 아직 열려 있어 그동안 도착한
  // 요청은 정상 처리된다), 이어지는 HTTP close가 처리 중 요청의 완료를
  // 기다린다. 자원 해제는 그 뒤 같은 클래스의 onApplicationShutdown이 등록
  // 역순으로 조율한다(`src/shutdown/CONTEXT.md`).
  app.enableShutdownHooks();

  // 리슨 포트는 환경변수 PORT다. 기본값(4080)과 형식 검증은 여기가 아니라
  // `src/config/env.validation.ts`에 있다 — 값이 틀렸을 때 리슨 시점이 아니라
  // 부팅 시점에 세우기 위해서다. 검증을 지난 값은 이미 number이므로
  // `getOrThrow`가 반드시 값을 돌려준다(없으면 부팅이 여기 오지 못한다).
  const port = app.get(ConfigService).getOrThrow<number>('PORT');

  try {
    await app.listen(port);
  } catch (error) {
    // 리슨이 실패하면 버퍼에 갇힌 로그를 여기서 내보낸다. `bufferLogs: true`의
    // 버퍼를 Nest가 비우는 지점은 **리슨 성공 시점 하나뿐이라**
    // (`nest-application.js`의 `listen()`이 `flushLogs()`를 부른다 — 10.4.22
    // 소스 확인), 이것이 없으면 부팅 로그와 아래 `bootstrap().catch()`의 fatal
    // 로그가 통째로 유실된다(실측 2026-08-12: 로그 파일이 0바이트였다).
    // 부팅 실패는 로그가 유일한 단서라 그 유실이 가장 비싸다.
    app.flushLogs();
    throw error;
  }
}

// 부팅 실패 중 **컨테이너 생성 이후**(리슨 실패 등)를 종료 코드 1로 끝낸다.
// `NestFactory.create()` 단계의 실패는 이 catch에 **닿지 않는다** —
// `ConfigModule.forRoot`가 async라 환경변수 검증 실패가 거절된 Promise가 되고,
// Nest의 `ExceptionsZone`이 `exceptionHandler.handle` → `Logger.flush()` →
// `teardown`(기본값 `() => process.exit(1)`, `abortOnError` 기본 true)까지 스스로
// 끝내기 때문이다(@nestjs/core 10.4.22 `errors/exceptions-zone.js`).
// `SHUTDOWN_DRAIN_DELAY_MS=60001`로 띄우면 종료 코드는 1이지만 아래 fatal 줄이
// 남지 않는 것으로 확인했다(실측 2026-08-12) — 그 경로에서도 종료 코드 1과 근본
// 원인 로그는 Nest가 대신 보장하므로, 아래 catch가 맡는 것은 나머지 구간이다.
//
// 잡지 않으면 `bootstrap()`이 거절한
// Promise가 unhandledRejection으로 흘러 우리 핸들러
// (`registerProcessErrorHandlers`)의 "프로세스를 살려 둔다" 정책에 걸리고,
// 리슨을 못 해 이벤트 루프에 남은 일이 없으므로 **종료 코드 0으로 조용히
// 끝난다** — 포트 충돌로 실측했다(2026-08-12, `bootstrap()`만 부르던 상태에서
// `echo $?`가 0). k8s는 종료 코드로 재시작을 판단하므로 배포 실패가 성공으로
// 위장하고, 열지도 못한 서버가 "정상 종료"로 기록된다.
//
// **런타임 정책과 구분된다.** 여기는 부팅 단계뿐이고, 기동 후의
// `uncaughtException`·`unhandledRejection`에서 프로세스를 살려 두는 정책
// (사용자 명시 요청)은 그대로다 — 근거는 `src/logging/CONTEXT.md`.
bootstrap().catch((error) => {
  // Nest 기본 Logger로 남기는 이유는 `app` 인스턴스가 `bootstrap()`의 지역
  // 변수라 이 스코프에서 pino 어댑터를 꺼낼 수 없기 때문이다. 출력 자체는
  // 유실되지 않는다 — `app.useLogger()`가 이미 지났고, 리슨 실패 경로에서
  // 아래 fatal 줄이 실제로 남는 것을 확인했다(실측 2026-08-12).
  new Logger('Bootstrap').fatal(
    '부팅에 실패해 프로세스를 종료한다',
    error instanceof Error ? error.stack : String(error),
  );
  process.exit(1);
});
