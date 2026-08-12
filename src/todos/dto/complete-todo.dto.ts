import { Type } from 'class-transformer';
import { IsDate } from 'class-validator';

/**
 * `PUT /todo/:todoId/completion` 본문. 완료는 이 값 하나만 받는다 — 진행값을 함께
 * 실으면 전역 `forbidNonWhitelisted`가 400으로 거절한다. 저장 하나가 두 사실을
 * 동시에 바꾸지 않는다는 확정(`docs/todo-service-spec.md`)이 이 형태의 근거다.
 */
export class CompleteTodoDto {
  /**
   * 완료한 순간. 매일 반복이 어느 날짜의 기록인지 정하는 값이고, 그대로 완료
   * 시각으로 저장된다(`TodosService.completeTodo`).
   */
  @Type(() => Date)
  @IsDate()
  performedAt: Date;
}
