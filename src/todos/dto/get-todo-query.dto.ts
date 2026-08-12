import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

/**
 * `GET /todo/:todoId` 쿼리. **둘 다 필수다** — Service의 `assertRange`가 값 없는
 * 범위를 400으로 거절하는데, 경계에서 먼저 거절해야 "어느 쿼리 파라미터가
 * 빠졌는지"가 응답에 담긴다.
 *
 * 두 값은 순간이고 매일 반복 갈래가 유저 타임존 기준 날짜로 잘라 쓴다
 * (`TodoHistoryRange`). 뒤집힘(from > until) 검사는 Service의 몫이다 — 여기서
 * 반복하면 같은 규칙이 두 곳에 살게 된다.
 */
export class GetTodoQueryDto {
  /** 이력 조회 범위의 시작 순간 */
  @Type(() => Date)
  @IsDate()
  from: Date;

  /** 이력 조회 범위의 종료 순간. 잘린 날짜 기준 양 끝 포함이다 */
  @Type(() => Date)
  @IsDate()
  until: Date;
}
