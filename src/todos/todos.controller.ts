import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ParseBigIntPipe } from '../common/parse-bigint.pipe';
import { RequestUserId } from '../common/request-user-id.decorator';
import { CompleteTodoDto } from './dto/complete-todo.dto';
import { CreateTodoDto } from './dto/create-todo.dto';
import { GetTodoQueryDto } from './dto/get-todo-query.dto';
import { ListTodosQueryDto } from './dto/list-todos-query.dto';
import { SaveProgressDto } from './dto/save-progress.dto';
import { UncompleteTodoQueryDto } from './dto/uncomplete-todo-query.dto';
import { UpdateTodoDto } from './dto/update-todo.dto';
import { TodosService } from './todos.service';
import type { TodoDetail, TodoListItem, TodoProgress } from './todo-view';

/**
 * todos 도메인의 HTTP 경계. **여기에는 판단이 없다** — 라우팅·검증(전역
 * `ValidationPipe`와 파이프)·Service 호출·응답 반환까지가 이 계층의 전부이고,
 * 규칙은 전부 `TodosService`에 있다.
 *
 * 경로는 단수형 `/todo`, 수정은 `PUT`이다(사용자 확정 — 복수형 추천이 기각됐다).
 * 요청자 식별은 `X-User-Id` 헤더의 임시 통로다(`RequestUserId`) — 인증이 들어오면
 * 데코레이터 구현만 교체하고 이 파일은 그대로 남는다.
 *
 * 응답 직렬화는 여기서 손대지 않는다 — `bigint` 기본키는 `BigIntJsonModule`이
 * 문자열로, 날짜 문자열(`historiedOn`)은 `todo-view.ts`가 이미 정한 대로 나간다.
 */
@Controller('todo')
export class TodosController {
  constructor(private readonly todosService: TodosService) {}

  /**
   * 완료되지 않은 일회성과 그 순간 활성인 매일 반복의 병합 목록. 마감 순간
   * 오름차순이다(`listTodosOn`).
   */
  @Get()
  listTodos(
    @RequestUserId() userId: bigint,
    @Query() query: ListTodosQueryDto,
  ): Promise<TodoListItem[]> {
    // `at` 생략은 "지금 기준"이라는 뜻이다(확정된 라우트 서명). 기본값을 DTO가
    // 아니라 여기서 채워 "요청 처리 시점"이라는 사실이 코드에 드러나게 한다.
    return this.todosService.listTodosOn(userId, query.at ?? new Date());
  }

  /**
   * 할 일 하나의 상세. 반환 형태가 반복 방식으로 갈린다 — 일회성은 상태 한 건,
   * 매일 반복은 `from`~`until` 순간이 유저 타임존에서 속한 날짜 범위의 이력 배열이다.
   */
  @Get(':todoId')
  getTodo(
    @RequestUserId() userId: bigint,
    @Param('todoId', ParseBigIntPipe) todoId: bigint,
    @Query() query: GetTodoQueryDto,
  ): Promise<TodoDetail> {
    return this.todosService.getTodo(userId, todoId, {
      from: query.from,
      until: query.until,
    });
  }

  /**
   * 할 일을 만든다. POST의 기본 상태 코드(201)를 그대로 쓴다.
   * 응답의 `progress`는 항상 `null`이다 — 방금 만든 정의라 완료 기록이 있을 수 없다.
   */
  @Post()
  createTodo(
    @RequestUserId() userId: bigint,
    @Body() body: CreateTodoDto,
  ): Promise<TodoListItem> {
    return this.todosService.createTodo(userId, body);
  }

  /**
   * 할 일의 내용을 고친다. **메서드는 `PUT`이지만 동작은 부분 갱신이다**(사용자
   * 확정 — 키 생략은 "그대로 두라", `null`은 "비우라").
   *
   * 204를 돌려주는 이유는 Service가 `void`이기 때문이다 — 매일 반복은 날짜마다
   * 상태가 달라 "고친 뒤의 상태" 하나를 고를 수 없고, 필요하면 상세를 다시 부른다.
   */
  @Put(':todoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateTodo(
    @RequestUserId() userId: bigint,
    @Param('todoId', ParseBigIntPipe) todoId: bigint,
    @Body() body: UpdateTodoDto,
  ): Promise<void> {
    return this.todosService.updateTodo(userId, todoId, body);
  }

  /**
   * 할 일을 지운다. soft delete이고 완료 기록도 함께 표시된다 — cascade는
   * `TodoTemplatesRepository.softDelete`의 트랜잭션이 이미 보장하므로 여기서는
   * 호출만 한다.
   */
  @Delete(':todoId')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteTodo(
    @RequestUserId() userId: bigint,
    @Param('todoId', ParseBigIntPipe) todoId: bigint,
  ): Promise<void> {
    return this.todosService.deleteTodo(userId, todoId);
  }

  /**
   * 그날 달성한 진행값을 저장하고 저장된 상태를 돌려준다. `PUT`인 이유는 저장
   * 모델이 `(todoId, 날짜)` upsert 하나라서다 — 같은 요청을 다시 보내면 같은
   * 기록이 덮어써질 뿐 새 자원이 생기지 않는다(확정 결정 1 — historyId 없는 설계).
   *
   * **완료 여부는 바뀌지 않는다.** 목표치를 채워도 완료는 `completion`에 따로
   * 요청해야 한다(사용자 확정 — 저장 하나가 두 사실을 동시에 바꾸지 않는다).
   */
  @Put(':todoId/progress')
  saveProgress(
    @RequestUserId() userId: bigint,
    @Param('todoId', ParseBigIntPipe) todoId: bigint,
    @Body() body: SaveProgressDto,
  ): Promise<TodoProgress> {
    return this.todosService.saveProgress(userId, todoId, body);
  }

  /**
   * 할 일을 완료로 표시한다. 완료를 `completion` 하위 자원의 `PUT`으로 두는 이유는
   * "완료됨"이 만들거나 지우는 자원이 아니라 그날 기록의 상태 하나이기 때문이다 —
   * 같은 요청을 다시 보내도 결과가 같다.
   */
  @Put(':todoId/completion')
  completeTodo(
    @RequestUserId() userId: bigint,
    @Param('todoId', ParseBigIntPipe) todoId: bigint,
    @Body() body: CompleteTodoDto,
  ): Promise<TodoProgress> {
    return this.todosService.completeTodo(userId, todoId, body.performedAt);
  }

  /**
   * 완료 표시를 지운다. 기록 행은 남고 진행값도 그대로다 — 삭제가 아니라 완료
   * 시각을 비우는 수정이다(`TodosService.uncompleteTodo`).
   *
   * `performedAt`이 본문이 아니라 **쿼리인 이유는 DELETE 본문을 중간 장비가 버릴
   * 수 있어서다**(확정된 라우트 서명). 바뀐 상태를 돌려주므로 204가 아니라 200이다.
   */
  @Delete(':todoId/completion')
  uncompleteTodo(
    @RequestUserId() userId: bigint,
    @Param('todoId', ParseBigIntPipe) todoId: bigint,
    @Query() query: UncompleteTodoQueryDto,
  ): Promise<TodoProgress> {
    return this.todosService.uncompleteTodo(userId, todoId, query.performedAt);
  }
}
