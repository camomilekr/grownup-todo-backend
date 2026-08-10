import { Test, TestingModule } from '@nestjs/testing';
import { PINO_DESTINATION, PinoLoggerService } from './pino-logger.service';

describe('PinoLoggerService', () => {
  // sink에 쌓인 원시 줄을 파싱해 pino가 실제로 내보낸 JSON을 단정한다.
  // pino 내부 상태가 아니라 출력이 관찰 가능한 동작이다.
  let lines: string[];
  let service: PinoLoggerService;

  beforeEach(async () => {
    lines = [];
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        PinoLoggerService,
        {
          provide: PINO_DESTINATION,
          useValue: {
            write: (chunk: string) => {
              lines.push(chunk);
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get(PinoLoggerService);
  });

  function lastLog(): Record<string, unknown> {
    expect(lines.length).toBeGreaterThan(0);
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  }

  // pino 표준 레벨 숫자다 — trace 10, debug 20, info 30, warn 40, error 50, fatal 60
  it.each([
    ['log', 30],
    ['warn', 40],
    ['error', 50],
    ['debug', 20],
    ['verbose', 10],
    ['fatal', 60],
  ] as const)('%s는 pino 레벨 %i로 남긴다', (method, expectedLevel) => {
    service[method]('메시지');

    expect(lastLog()).toMatchObject({ level: expectedLevel, msg: '메시지' });
  });

  it('마지막 문자열 인자를 context 필드로 남긴다', () => {
    // NestJS Logger 관례 — `new Logger(TodosService.name)`가 마지막 인자로
    // 컨텍스트 이름을 넘긴다
    service.log('메시지', 'TodosService');

    expect(lastLog()).toMatchObject({
      msg: '메시지',
      context: 'TodosService',
    });
  });

  it('객체 메시지는 필드로 병합해 남긴다', () => {
    service.log({ method: 'GET', url: '/todos' }, 'RequestLoggingMiddleware');

    expect(lastLog()).toMatchObject({
      method: 'GET',
      url: '/todos',
      context: 'RequestLoggingMiddleware',
    });
  });

  it('error에서 남은 문자열 인자를 stack 필드로 남긴다', () => {
    // NestJS 관례 — `logger.error(message, stack, context)`
    service.error('터졌다', 'Error: 터졌다\n    at x.ts:1:1', 'TodosService');

    expect(lastLog()).toMatchObject({
      msg: '터졌다',
      stack: 'Error: 터졌다\n    at x.ts:1:1',
      context: 'TodosService',
    });
  });

  it('Error 객체는 err 필드로 직렬화해 남긴다', () => {
    service.fatal(new Error('죽을 뻔했다'));

    const entry = lastLog();
    expect(entry.msg).toBe('죽을 뻔했다');
    expect(entry.err).toMatchObject({ message: '죽을 뻔했다' });
  });

  it.each([
    'password',
    'passwordHash',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'secret',
    'cookie',
  ])('body의 민감 키 %s를 가리고 남긴다', (key) => {
    service.log({ body: { [key]: '비밀값', title: '평범한 값' } });

    const entry = lastLog();
    expect((entry.body as Record<string, unknown>)[key]).toBe('[REDACTED]');
    expect((entry.body as Record<string, unknown>).title).toBe('평범한 값');
  });

  it('body의 한 단계 중첩된 민감 키도 가린다', () => {
    service.log({ body: { credentials: { password: '비밀값' } } });

    const body = lastLog().body as {
      credentials: Record<string, unknown>;
    };
    expect(body.credentials.password).toBe('[REDACTED]');
  });

  it.each([
    'password',
    'passwordHash',
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'secret',
    'cookie',
  ])('query의 민감 키 %s를 가리고 남긴다', (key) => {
    // 민감값은 body로만 오지 않는다 — `/password-reset?token=…`처럼 쿼리
    // 문자열에 실려 오는 토큰이 요청 로그의 query 필드로 흘러 들어온다
    service.log({ query: { [key]: '비밀값', page: '2' } });

    const entry = lastLog();
    expect((entry.query as Record<string, unknown>)[key]).toBe('[REDACTED]');
    expect((entry.query as Record<string, unknown>).page).toBe('2');
  });

  it('query의 한 단계 중첩된 민감 키도 가린다', () => {
    // Express 확장 쿼리 파서는 `?auth[token]=…`을 중첩 객체로 만든다
    service.log({ query: { auth: { token: '비밀값' } } });

    const query = lastLog().query as { auth: Record<string, unknown> };
    expect(query.auth.token).toBe('[REDACTED]');
  });
});
