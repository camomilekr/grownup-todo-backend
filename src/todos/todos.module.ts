import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { TodoHistoriesRepository } from './todo-histories.repository';
import { TodoTemplatesRepository } from './todo-templates.repository';

/**
 * todo 도메인 모듈.
 *
 * 아직 Service·Controller가 없어 Repository 둘만 담는다. `PrismaModule`이
 * `@Global()`이 아니므로 여기서 직접 import한다.
 *
 * 두 Repository를 `exports`에 넣는 것은 Service가 생길 때까지 **이 모듈 밖에서
 * 쓸 것이 그것뿐**이기 때문이다. Service가 들어오면 그때 Repository를 `exports`에서
 * 빼고 Service만 남긴다 — 그렇지 않으면 다른 도메인이 Repository를 직접 불러
 * 비즈니스 규칙을 우회한다.
 */
@Module({
  imports: [PrismaModule],
  providers: [TodoTemplatesRepository, TodoHistoriesRepository],
  exports: [TodoTemplatesRepository, TodoHistoriesRepository],
})
export class TodosModule {}
