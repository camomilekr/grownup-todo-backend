import { Module } from '@nestjs/common';
import { PinoLoggerService } from './pino-logger.service';

@Module({
  providers: [PinoLoggerService],
  // `AppModule.configure`가 거는 `RequestLoggingMiddleware`는 configure를 가진
  // 모듈(AppModule) 컨텍스트에서 인스턴스화되므로, 그 의존성 PinoLoggerService가
  // export되어 있어야 해석된다 — 빼면 부팅이 "Nest can't resolve dependencies of
  // the RequestLoggingMiddleware"로 실패한다(실측). `main.ts`의 `app.get()`은
  // 기본이 strict: false라 캡슐화를 무시하므로 export를 요구하지 않는다.
  exports: [PinoLoggerService],
})
export class LoggingModule {}
