import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // BigInt JSON 직렬화 가드를 여기서 부르지 않는다. `AppModule`이 import하는
  // `BigIntJsonModule`이 켠다 — 이 함수는 테스트가 실행하지 않으므로, 여기 두면
  // 지워도 아무 테스트가 깨지지 않고 테스트와 프로덕션의 직렬화 동작이 갈린다.
  const app = await NestFactory.create(AppModule);

  // SIGTERM·SIGINT에서 onModuleDestroy를 부르게 한다. 이것이 없으면
  // PrismaService가 커넥션 풀을 닫지 못하고, Supabase 풀러 쪽에 커넥션이
  // 타임아웃까지 남는다 — 재배포를 반복하면 풀이 마른다.
  app.enableShutdownHooks();

  await app.listen(3000);
}
bootstrap();
