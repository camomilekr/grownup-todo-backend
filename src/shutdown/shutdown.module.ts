import { Module } from '@nestjs/common';
import { ShutdownRegistry } from './shutdown-registry.service';

@Module({
  providers: [ShutdownRegistry],
  // 자원 모듈(PrismaModule 등)이 import해 해제 콜백을 등록한다
  exports: [ShutdownRegistry],
})
export class ShutdownModule {}
