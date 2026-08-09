import { Type } from 'class-transformer';
import { IsDate, IsNumber, Max, Min } from 'class-validator';
import { DECIMAL_12_2_MAX } from './create-todo.dto';

/**
 * `PUT /todo/:todoId/progress` 본문. 검증을 통과하면 `SaveProgressInput`에 그대로
 * 대입된다.
 *
 * **완료 여부는 여기 없다.** 진행값이 목표치를 넘겨도 서버가 완료를 찍지 않고
 * (사용자 확정 — 저장 하나가 두 사실을 동시에 바꾸지 않는다), 완료는
 * `PUT /todo/:todoId/completion`이 따로 받는다.
 */
export class SaveProgressDto {
  /** 그날 달성한 값. **`0`도 유효한 입력이다** — 저장하지 않은 것과 다른 상태다 */
  @IsNumber()
  @Max(DECIMAL_12_2_MAX)
  @Min(-DECIMAL_12_2_MAX)
  progressValue: number;

  /** 어느 날짜의 기록인지 정하는 순간. 매일 반복만 이 값을 날짜 키로 쓴다 */
  @Type(() => Date)
  @IsDate()
  performedAt: Date;
}
