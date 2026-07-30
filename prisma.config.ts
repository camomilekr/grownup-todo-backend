import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI 설정. `migrate`, `db pull`, `studio`, `generate`가 이 파일을 읽는다.
 *
 * 여기서 `process.env`를 직접 읽는 것은 `.claude/rules/nestjs.md`의 예외다 —
 * 이 파일은 Nest DI 컨테이너 밖에서 CLI가 실행하므로 `ConfigService`가 없다.
 * 애플리케이션 코드에서는 그대로 금지다.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',

  migrations: {
    path: 'prisma/migrations',
  },

  datasource: {
    // 마이그레이션은 **세션 모드** 풀러(5432)로 붙는다. 트랜잭션 모드(6543)는
    // 커넥션을 트랜잭션 단위로 회수해서 DDL과 advisory lock이 깨진다.
    //
    // Prisma 6까지 있던 `directUrl`은 7에서 없어졌다. 그 역할을 이 `url`이
    // 대신하고, 런타임용 DATABASE_URL과는 완전히 분리된다.
    url: process.env['DIRECT_URL'],

    // shadowDatabaseUrl은 지정하지 않는다. Supabase의 `postgres` 역할은
    // rolcreatedb 권한이 있어 Prisma가 임시 shadow DB를 직접 만든다.
  },
});
