import { Type } from 'class-transformer';
import {
  IsDate,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CompleteType, TodoType } from '../../generated/prisma/enums';

/**
 * `HH:mm` 24시간 표기. 컬럼이 `VarChar(5)`라 이 형식 밖은 저장 자체가 어긋난다 —
 * 형식 검증은 값을 받는 경계(여기)의 책임이다(`src/todos/CONTEXT.md`).
 */
export const REMIND_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** `REMIND_AT_PATTERN`에 어긋났을 때의 안내. 갱신 DTO가 같은 문구를 쓴다 */
export const REMIND_AT_MESSAGE =
  'remindAt은 HH:mm 형식(00:00~23:59)이어야 한다';

/**
 * `Decimal(12, 2)` 컬럼(`targetValue`·`progressValue`)이 담을 수 있는 최댓값.
 * 유효자리 12에 소수점 이하 2라 정수부가 최대 10자리다. 이 밖의 값은 저장 자체가
 * 불가능한데 걸러지지 않으면 DB까지 흘러가 클라이언트 입력 문제가 500으로 나간다 —
 * `title` 200자·`remindAt` 형식과 같은 근거(컬럼 형식)의 경계 검증이다.
 *
 * **하한은 이 값의 부호 반전(`-DECIMAL_12_2_MAX`)이다** — `numeric(12, 2)`는 음수도
 * 같은 자릿수까지 담으므로 `@Max`와 `@Min`을 쌍으로 걸어야 양쪽이 닫힌다. 음수
 * 자체를 거절하는 검증(`@Min(0)`)은 두지 않는다 — 저장 가능한 음수를 거절할 확정
 * 근거가 없고, 여기의 근거는 컬럼 형식 하나다.
 */
export const DECIMAL_12_2_MAX = 9999999999.99;

/** 단위 컬럼(`targetUnit`)의 길이 상한. `VarChar(16)`이다 */
export const TARGET_UNIT_MAX_LENGTH = 16;

/**
 * `POST /todo` 본문. 검증을 통과하면 `CreateTodoInput`에 그대로 대입된다.
 *
 * **날짜 필드는 `@Type(() => Date)`와 `@IsDate()`를 함께 건다.** 변환만 걸면
 * 해석할 수 없는 문자열이 Invalid Date가 되어 Service로 흘러 자리에 따라 500이
 * 된다(`docs/todo-service-spec.md` 6절) — `@IsDate()`가 Invalid Date를 거절한다.
 *
 * **목표치 쌍·활성 기간·예정일의 조합 규칙은 여기서 검증하지 않는다.** 그 규칙은
 * 만들기와 고치기가 함께 지나는 `TodosService.assertShape` 한 곳에 있다 — 경계가
 * 맡는 것은 필드 하나하나의 형식까지다.
 */
export class CreateTodoDto {
  @IsString()
  @Length(1, 200, { message: 'title은 1자 이상 200자 이하여야 한다' })
  title: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  /** **만든 뒤에는 바꿀 수 없다** — 갱신 DTO에는 이 필드가 없다 */
  @IsEnum(TodoType)
  todoType: TodoType;

  /** **만든 뒤에는 바꿀 수 없다** — 갱신 DTO에는 이 필드가 없다 */
  @IsEnum(CompleteType)
  completeType: CompleteType;

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
