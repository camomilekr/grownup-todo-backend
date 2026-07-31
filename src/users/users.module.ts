import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersRepository } from './users.repository';

/**
 * 유저 도메인 모듈.
 *
 * `PrismaModule`이 `@Global()`이 아니므로 여기서 직접 import한다.
 *
 * **Service 없이 Repository를 내보낸다.** 지금 이 모듈이 하는 일은 타임존 한 컬럼을
 * 읽어 주는 것뿐이고 거기에 비즈니스 판단이 없다 — 없는 유저를 어떤 오류로 바꿀지는
 * 그 값을 쓰는 `TodosService`가 정한다. 판단할 것이 없는 자리에 Service를 한 겹 두면
 * Repository를 그대로 대신 부르는 껍데기가 된다. 가입·탈퇴처럼 판단이 붙는 경로가
 * 생기면 그때 Service를 만들고 Repository를 `exports`에서 뺀다.
 */
@Module({
  imports: [PrismaModule],
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
