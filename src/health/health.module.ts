import { Module } from '@nestjs/common';
import { ShutdownModule } from '../shutdown/shutdown.module';
import { HealthController } from './health.controller';
import { ReadinessService } from './readiness.service';

@Module({
  // readiness 판정의 근거가 종료 코디네이터의 상태다. 방향은 health → shutdown
  // 한쪽이고, shutdown은 health를 모른다
  imports: [ShutdownModule],
  controllers: [HealthController],
  providers: [ReadinessService],
})
export class HealthModule {}
