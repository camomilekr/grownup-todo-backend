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

  // SIGTERM·SIGINT에서 종료 훅(onModuleDestroy → HTTP 서버 close →
  // onApplicationShutdown)을 순서대로 부르게 한다. 이것이 없으면 커넥션 풀이
  // 닫히지 못하고, Supabase 풀러 쪽에 커넥션이 타임아웃까지 남는다 — 재배포를
  // 반복하면 풀이 마른다. HTTP close가 처리 중 요청의 완료를 기다리고, 자원
  // 해제는 그 뒤 ShutdownRegistry의 onApplicationShutdown이 등록 역순으로
  // 조율한다(k8s 정상 종료의 핵심 — `src/shutdown/CONTEXT.md`).
  app.enableShutdownHooks();

  // 리슨 포트는 환경변수 PORT다. 기본값(4080)과 형식 검증은 여기가 아니라
  // `src/config/env.validation.ts`에 있다 — 값이 틀렸을 때 리슨 시점이 아니라
  // 부팅 시점에 세우기 위해서다. 검증을 지난 값은 이미 number이므로
  // `getOrThrow`가 반드시 값을 돌려준다(없으면 부팅이 여기 오지 못한다).
  const port = app.get(ConfigService).getOrThrow<number>('PORT');
  await app.listen(port);
}
bootstrap();
