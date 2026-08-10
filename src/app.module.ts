import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BigIntJsonModule } from './common/bigint-json.module';
import { validateEnv } from './config/env.validation';
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
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 요청·응답 로깅을 전역으로 건다. `/api/ping`만 제외한다 — k8s 프로브가
    // 수 초마다 때려서, 남기면 로그가 프로브 기록에 잠긴다.
    consumer
      .apply(RequestLoggingMiddleware)
      .exclude({ path: 'api/ping', method: RequestMethod.GET })
      .forRoutes('*');
  }
}
