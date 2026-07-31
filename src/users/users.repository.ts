import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * `app_user` 테이블 접근.
 *
 * **지금은 타임존 조회 하나만 담는다.** 가입·탈퇴·프로필 수정은 인증 수단이 정해질 때
 * 함께 만든다 — 그쪽은 이메일 정규화와 탈퇴한 행의 재가입 처리 같은 판단이 붙으므로
 * Service가 먼저 필요하다.
 *
 * **판단하지 않고 조회 조건만 담는다.** "타임존이 유효한 IANA 이름인가"는 값을 받는
 * 경계의 책임이고, 없는 유저를 어떤 오류로 바꿀지는 위 계층(Service)이 정한다.
 */
@Injectable()
export class UsersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 그 유저의 타임존(`Asia/Seoul` 같은 IANA 이름). 없으면 `null`이다.
   *
   * 매일 반복 할 일의 "오늘"이 이 값으로 정해진다. 유저마다 하루가 바뀌는 순간이 달라서,
   * 이 값 없이는 날짜 키를 만들 수 없다(`src/todos/todo-local-date.ts`).
   *
   * **탈퇴한 유저는 `null`이다.** 탈퇴는 행을 지우지 않고 `deletedAt`에 시각을 적는
   * 방식이라 조건을 빼면 행이 그대로 잡힌다. 그러면 탈퇴한 유저의 할 일에 계속 날짜
   * 키가 만들어져 기록이 쌓인다 — 없는 유저와 같게 다루는 것이 옳다.
   *
   * 단건 조회(`findUnique`)가 아니라 `findFirst`를 쓴다. 기본키에 `deletedAt`이 들어
   * 있지 않아서 단건 조회로는 그 조건을 걸 수 없다.
   *
   * `select`로 한 컬럼만 읽는다. 이메일은 이 경로에 필요 없고, 필요하지 않은 개인정보를
   * 메모리와 로그에 올리지 않는다.
   */
  async findTimeZone(userId: bigint): Promise<string | null> {
    const user = await this.prisma.appUser.findFirst({
      where: { userId, deletedAt: null },
      select: { timeZone: true },
    });

    return user?.timeZone ?? null;
  }
}
