import { Type } from 'class-transformer';
import {
  IsDate,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  DECIMAL_12_2_MAX,
  REMIND_AT_MESSAGE,
  REMIND_AT_PATTERN,
  TARGET_UNIT_MAX_LENGTH,
} from './create-todo.dto';

/**
 * `PUT /todo/:todoId` 본문. 메서드는 `PUT`이지만 동작은 부분 갱신이다(사용자 확정) —
 * **키 생략(`undefined`)은 "그대로 두라", `null`은 "비우라"다.** 그 구분은
 * `TodosService.updateTodo`가 해석하고, 이 경계는 각 값의 형식만 본다.
 *
 * **`todoType`·`completeType` 필드가 없다.** 만든 뒤 바꿀 수 없는 값이라
 * (`UpdateTodoInput`) 여기 두지 않으면 전역 `forbidNonWhitelisted`가 400으로
 * 거절한다 — 조용히 버려지는 것이 아니라 거절되는 것까지가 규칙이다.
 *
 * **`title`만 `null`을 거절한다.** 비울 수 없는 필수 컬럼이라서다. `@IsOptional()`은
 * `null`과 `undefined`를 모두 통과시키므로 그것으로는 이 구분을 만들 수 없고,
 * "`undefined`일 때만 검증을 건너뛴다"를 `@ValidateIf`로 직접 쓴다 — `null`이 오면
 * 검증이 실행되어 `@IsString()`이 거절한다.
 */
export class UpdateTodoDto {
  @ValidateIf((dto: UpdateTodoDto) => dto.title !== undefined)
  @IsString()
  @Length(1, 200, { message: 'title은 1자 이상 200자 이하여야 한다' })
  title?: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @Matches(REMIND_AT_PATTERN, { message: REMIND_AT_MESSAGE })
  remindAt?: string | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  shouldDoAt?: Date | null;

  @IsOptional()
  @IsNumber()
  @Max(DECIMAL_12_2_MAX)
  @Min(-DECIMAL_12_2_MAX)
  targetValue?: number | null;

  @IsOptional()
  @IsString()
  @Length(1, TARGET_UNIT_MAX_LENGTH)
  targetUnit?: string | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  activeFrom?: Date | null;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  activeUntil?: Date | null;
}
