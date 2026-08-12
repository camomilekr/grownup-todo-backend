import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

/**
 * `DELETE /todo/:todoId/completion` 쿼리. `performedAt`이 **쿼리인 이유는 DELETE
 * 본문을 중간 장비가 버릴 수 있어서다**(확정된 라우트 서명) — 완료(`PUT`)와 값의
 * 의미는 같지만 싣는 자리가 다르다.
 */
export class UncompleteTodoQueryDto {
  /** 어느 날짜의 기록을 취소하는지 정하는 순간. 매일 반복만 쓴다 */
  @Type(() => Date)
  @IsDate()
  performedAt: Date;
}
