import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // SIGTERM·SIGINT에서 onModuleDestroy를 부르게 한다. 이것이 없으면
  // PrismaService가 커넥션 풀을 닫지 못하고, Supabase 풀러 쪽에 커넥션이
  // 타임아웃까지 남는다 — 재배포를 반복하면 풀이 마른다.
  app.enableShutdownHooks();

  await app.listen(3000);
}
bootstrap();
