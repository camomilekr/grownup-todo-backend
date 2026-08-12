import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BigIntJsonModule } from './common/bigint-json.module';
import { validateEnv } from './config/env.validation';
import { HEALTH_PING_PATH } from './health/health.controller';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { RequestLoggingMiddleware } from './logging/request-logging.middleware';
import { PrismaModule } from './prisma/prisma.module';
import { TodosModule } from './todos/todos.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      // 전역으로 연다. 이렇게 하지 않으면 DB에 붙는 모듈마다 ConfigModule을
      // 다시 import해야 하고, 빠뜨린 곳은 주입 실패로 런타임에 드러난다.
      isGlobal: true,
      // 필수 환경변수가 없으면 여기서 부팅을 세운다
      validate: validateEnv,
      cache: true,
    }),
    // BigInt PK가 JSON 응답에서 터지는 것을 막는다. 부트스트랩이 아니라 모듈에
    // 두는 이유는 테스트가 `main.ts`를 거치지 않기 때문이다 —
    // `src/common/bigint-json.module.ts` 주석에 근거가 있다.
    BigIntJsonModule,
    HealthModule,
    LoggingModule,
    PrismaModule,
    TodosModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // 전역 ValidationPipe. `main.ts`의 `useGlobalPipes`가 아니라 모듈 제공
    // (`APP_PIPE`)으로 거는 이유는 e2e가 `main.ts`를 거치지 않기 때문이다 —
    // 부트스트랩에만 두면 테스트는 검증 없는 앱을 보고, 검증이 빠진 채 배포돼도
    // 어떤 테스트도 잡지 못한다(`BigIntJsonModule`을 모듈에 둔 것과 같은 근거).
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        // DTO에 없는 필드는 버리는 대신 400으로 거절한다. 조용히 버리면
        // 클라이언트가 오타 난 필드를 보냈다는 사실을 알 수 없다.
        whitelist: true,
        forbidNonWhitelisted: true,
        // 쿼리·본문을 DTO 클래스 인스턴스로 변환한다. `@Type(() => Date)` 같은
        // 변환 데코레이터가 이 옵션 없이는 동작하지 않는다.
        transform: true,
      }),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 요청·응답 로깅을 전역으로 건다. 헬스 프로브 경로만 제외한다 — k8s가
    // 수 초마다 때려서, 남기면 로그가 프로브 기록에 잠긴다.
    //
    // **exclude 경로에 전역 prefix(`api/v1`)를 직접 쓰지 마라.** Nest가
    // 알아서 앞에 붙인다(`MiddlewareBuilder.ConfigProxy.exclude` →
    // `RouteInfoPathExtractor.extractPathFrom`, @nestjs/core 10.4.22).
    // `'api/v1/ping'`이라고 쓰면 `/api/v1/api/v1/ping`이 되어 어떤 요청과도
    // 맞지 않고, 제외가 조용히 풀려 프로브 로그가 그대로 쌓인다 —
    // 2026-08-12 최소 앱을 띄워 실측했다.
    consumer
      .apply(RequestLoggingMiddleware)
      .exclude({ path: HEALTH_PING_PATH, method: RequestMethod.GET })
      .forRoutes('*');
  }
}
