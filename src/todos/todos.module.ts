import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import { TodoHistoriesRepository } from './todo-histories.repository';
import { TodoTemplatesRepository } from './todo-templates.repository';
import { TodosController } from './todos.controller';
import { TodosService } from './todos.service';

/**
 * todo 도메인 모듈.
 *
 * `PrismaModule`이 `@Global()`이 아니므로 여기서 직접 import한다. `UsersModule`은 매일
 * 반복의 날짜 키를 만들 유저 타임존 때문에 가져온다.
 *
 * **`exports`에 `TodosService`만 둔다.** Repository를 함께 내보내면 다른 도메인이 그것을
 * 직접 불러 소유자 검사와 상태 계산을 건너뛴다. `test/todos.e2e-spec.ts`는 여전히
 * Repository를 꺼내 쓰는데, `app.get`이 비엄격 조회가 기본이라 `exports`에서 빠진
 * Provider도 찾기 때문이다 — 그 테스트는 이 모듈의 경계가 아니라 쿼리 자체를 검증하는
 * 자리라서 그대로 둔다.
 */
@Module({
  imports: [PrismaModule, UsersModule],
  controllers: [TodosController],
  providers: [TodoTemplatesRepository, TodoHistoriesRepository, TodosService],
  exports: [TodosService],
})
export class TodosModule {}
