import { Type } from 'class-transformer';
import { IsDate, IsOptional } from 'class-validator';

/**
 * `GET /todo` 쿼리. `at`은 목록의 기준 순간이고 **생략하면 Controller가 서버 현재
 * 시각으로 채운다**(확정된 라우트 서명). DTO 기본값(`at: Date = new Date()`)으로
 * 두지 않는 이유는 그 `new Date()`가 어느 시점의 것인지가 변환 라이브러리의 구현에
 * 묻히기 때문이다 — 채우는 자리가 Controller면 "요청 처리 시점"이 코드에 드러난다.
 */
export class ListTodosQueryDto {
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  at?: Date;
}
