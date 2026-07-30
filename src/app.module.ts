import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';

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
    PrismaModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
