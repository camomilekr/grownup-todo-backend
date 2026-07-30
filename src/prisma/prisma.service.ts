import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Prisma 클라이언트를 Nest 라이프사이클에 붙인다.
 *
 * `PrismaClient`를 상속하므로 주입받은 쪽은 `prisma.todo.findMany()`처럼
 * 그대로 쓴다. 별도 래퍼 메서드를 만들지 않는다 — 만들면 Prisma가 주는
 * 타입 추론이 한 겹 아래로 숨는다.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // `private readonly`로 받지 않는다. 파라미터 프로퍼티로 만들면 TypeScript가
  // `super()`를 생성자의 첫 문장으로 요구하는데, 접속 문자열을 먼저 검증해서
  // `super()`에 넘겨야 하므로 순서가 맞지 않는다. 보관할 이유도 없다.
  constructor(configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL');

    if (!connectionString) {
      // ConfigModule의 validate를 우회해 이 Provider만 따로 쓰는 경로가
      // 생겼을 때를 막는다. 비면 node-postgres가 libpq 기본값(localhost)으로
      // 조용히 붙어서, 장애가 "데이터가 없음"으로 위장한다.
      throw new Error(
        'PrismaService를 만들 수 없다: DATABASE_URL이 비어 있다.',
      );
    }

    // Prisma 7은 Rust 쿼리 엔진 대신 쿼리 컴파일러 + 드라이버 어댑터로 붙는다.
    // 어댑터가 필수이고, 6까지 쓰던 `datasourceUrl` 옵션은 제거됐다.
    super({ adapter: new PrismaPg({ connectionString }) });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Postgres 커넥션 풀을 열었다');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    this.logger.log('Postgres 커넥션 풀을 닫았다');
  }
}
