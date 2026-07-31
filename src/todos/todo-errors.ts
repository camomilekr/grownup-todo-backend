/**
 * 할 일 도메인에서 Repository가 던지는 오류.
 *
 * **왜 따로 만드는가.** NestJS의 기본 오류 처리기는 `HttpException`이 아닌 오류를 전부
 * 500 Internal Server Error로 바꾼다. 사용자의 정상적인 조작으로 도달하는 거절을 그냥
 * `Error`로 던지면 화면에 "서버 오류"가 뜬다.
 *
 * 그렇다고 Repository에서 HTTP 예외를 던지지는 않는다 — 이 계층은 HTTP를 몰라야 한다
 * (`.claude/rules/nestjs.md`). 대신 **타입으로 구분할 수 있는 도메인 오류**를 던지고,
 * 위 계층(Service)이 `instanceof`로 잡아 알맞은 HTTP 예외로 바꾼다.
 *
 * 메시지 문자열로 구분하게 두지 않는 이유는, 문구를 다듬는 순간 그 구분이 **조용히**
 * 깨지기 때문이다. 이 저장소의 다른 실패 경로는 Prisma가 오류 코드를 붙여 주므로 같은
 * 문제가 없다(삭제된 행 수정은 `P2025`, 소유자가 어긋난 삽입은 `P2003`).
 */

/**
 * 완료 기록을 남기려는 할 일이 **아예 없을 때.**
 *
 * "지워졌다"와 따로 두는 이유는 장애를 추적할 때다. 둘을 한 오류로 뭉치면 오타로
 * 잘못된 번호를 보낸 요청이 로그에 "지워진 할 일"로 남고, 원인을 찾는 사람이 지워진
 * 행을 뒤지는데 그런 행이 없어서 헤맨다.
 *
 * Service는 이것을 잡아 `NotFoundException`으로 바꾸면 된다.
 */
export class TodoTemplateNotFoundError extends Error {
  constructor(readonly todoId: bigint) {
    super(`그런 할 일이 없다 (todoId=${todoId})`);
    this.name = 'TodoTemplateNotFoundError';
  }
}

/**
 * 할 일이 **있지만 지워졌을 때.**
 *
 * 사용자에게 보이는 결과는 위와 같을 수 있지만(둘 다 "찾을 수 없음"으로 처리하면 된다)
 * 로그에 남는 사실이 다르다. 이쪽은 실제로 지워진 행이 DB에 있다.
 *
 * Service는 이것을 잡아 `NotFoundException`이나 `ConflictException`으로 바꾸면 된다.
 */
export class TodoTemplateDeletedError extends Error {
  constructor(readonly todoId: bigint) {
    super(`지워진 할 일에는 기록을 남길 수 없다 (todoId=${todoId})`);
    this.name = 'TodoTemplateDeletedError';
  }
}
