import { Module } from '@nestjs/common';
import { ShutdownModule } from '../shutdown/shutdown.module';
import { PrismaService } from './prisma.service';

/**
 * `@Global()`을 붙이지 않는다. DB에 붙는 모듈이 어디인지 `imports`에 드러나야
 * 하고, 전역으로 열면 모듈 경계가 이름만 남는다(`.claude/rules/nestjs.md`).
 * 도메인 모듈에서 `imports: [PrismaModule]`로 명시해 가져간다.
 *
 * `ConfigService`는 `AppModule`이 `ConfigModule.forRoot({ isGlobal: true })`로
 * 걸어 두므로 여기서 다시 import하지 않는다.
 */
@Module({
  // ShutdownModule — 커넥션 해제를 자체 훅 대신 ShutdownRegistry 등록으로 한다
  imports: [ShutdownModule],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
