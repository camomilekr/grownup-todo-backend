import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter } from 'node:events';
import { Request, Response } from 'express';
import { PinoLoggerService } from './pino-logger.service';
import { RequestLoggingMiddleware } from './request-logging.middleware';

describe('RequestLoggingMiddleware', () => {
  let middleware: RequestLoggingMiddleware;
  let logCalls: unknown[][];

  beforeEach(async () => {
    logCalls = [];
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        RequestLoggingMiddleware,
        {
          provide: PinoLoggerService,
          useValue: {
            log: (...args: unknown[]) => {
              logCalls.push(args);
            },
          },
        },
      ],
    }).compile();

    middleware = moduleRef.get(RequestLoggingMiddleware);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 응답 완료는 Express `res`의 `finish` 이벤트다 — EventEmitter로 흉내 낸다.
  // 미들웨어가 `json`·`send`를 래핑해 응답 본문을 캡처하므로 둘 다 둔다.
  function createFakeRes(statusCode = 200): Response {
    const res = new EventEmitter() as unknown as Response;
    (res as { statusCode: number }).statusCode = statusCode;
    (res as { json: (body: unknown) => Response }).json = () => res;
    (res as { send: (body: unknown) => Response }).send = () => res;
    return res;
  }

  function createFakeReq(overrides: Partial<Request> = {}): Request {
    return {
      method: 'POST',
      originalUrl: '/todos?page=2',
      query: { page: '2' },
      body: { title: '우유 사기' },
      ...overrides,
    } as Request;
  }

  it('요청 수신 시 info 로그 1건을 남긴다', () => {
    middleware.use(createFakeReq(), createFakeRes(), () => undefined);

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0][0]).toMatchObject({
      event: 'request',
      method: 'POST',
      url: '/todos',
      query: { page: '2' },
      body: { title: '우유 사기' },
    });
  });

  it('url에서 쿼리 문자열을 떼고 경로만 남긴다', () => {
    // 쿼리 문자열의 민감값(`?token=…`)은 redact가 부분 문자열을 가리지
    // 못해 url 원문에 그대로 남는다(실측) — url은 경로만 남기고, 쿼리는
    // redact가 적용되는 구조화된 query 필드가 담당한다
    middleware.use(
      createFakeReq({
        originalUrl: '/password-reset?token=SECRET123',
        query: { token: 'SECRET123' },
      }),
      createFakeRes(),
      () => undefined,
    );

    expect(logCalls[0][0]).toMatchObject({ url: '/password-reset' });
    expect(JSON.stringify(logCalls[0][0])).not.toContain('token=SECRET123');
  });

  it('응답 완료(finish) 시 상태 코드를 담은 info 로그를 남긴다', () => {
    const res = createFakeRes(201);
    middleware.use(createFakeReq(), res, () => undefined);

    res.emit('finish');

    expect(logCalls).toHaveLength(2);
    expect(logCalls[1][0]).toMatchObject({
      event: 'response',
      method: 'POST',
      url: '/todos',
      statusCode: 201,
    });
  });

  it('수신·응답 시각과 소요 시간(ms)을 남긴다', () => {
    // 실행 시점에 결과가 흔들리지 않게 시계를 고정한다
    const RECEIVED_AT = new Date('2026-08-10T03:00:00.000Z').getTime();
    const DURATION_MS = 125;
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(RECEIVED_AT)
      .mockReturnValueOnce(RECEIVED_AT + DURATION_MS);

    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);
    res.emit('finish');

    expect(now).toHaveBeenCalledTimes(2);
    expect(logCalls[0][0]).toMatchObject({
      receivedAt: '2026-08-10T03:00:00.000Z',
    });
    expect(logCalls[1][0]).toMatchObject({
      receivedAt: '2026-08-10T03:00:00.000Z',
      respondedAt: '2026-08-10T03:00:00.125Z',
      durationMs: DURATION_MS,
    });
  });

  it('json 응답 본문을 responseBody로 응답 로그에 남긴다', () => {
    const res = createFakeRes(201);
    middleware.use(createFakeReq(), res, () => undefined);

    res.json({ id: '1', title: '우유 사기' });
    res.emit('finish');

    expect(logCalls[1][0]).toMatchObject({
      event: 'response',
      responseBody: { id: '1', title: '우유 사기' },
    });
  });

  it('문자열 응답 본문도 responseBody로 남긴다', () => {
    // 컨트롤러가 문자열을 반환하면 Nest는 json이 아니라 send로 내보낸다
    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);

    res.send('pong');
    res.emit('finish');

    expect(logCalls[1][0]).toMatchObject({ responseBody: 'pong' });
  });

  it('json 뒤에 오는 send가 구조화된 본문을 덮지 않는다', () => {
    // Express `res.json`은 내부에서 직렬화된 문자열로 `res.send`를 다시
    // 부른다 — 그때 문자열로 덮이면 redact가 키 단위로 작동하지 못한다
    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);

    res.json({ accessToken: '비밀값' });
    res.send('{"accessToken":"비밀값"}');
    res.emit('finish');

    expect(logCalls[1][0]).toMatchObject({
      responseBody: { accessToken: '비밀값' },
    });
  });

  it('상한을 넘는 응답 본문은 생략 표기로 대체한다', () => {
    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);

    res.send('가'.repeat(20000));
    res.emit('finish');

    const responseBody = (logCalls[1][0] as Record<string, unknown>)
      .responseBody;
    expect(typeof responseBody).toBe('string');
    expect((responseBody as string).length).toBeLessThan(200);
    expect(responseBody).toContain('생략');
  });

  it('버퍼 응답 본문은 크기 표기로 대체한다', () => {
    // 바이너리는 로그에 원문으로 담을 수 없다
    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);

    res.send(Buffer.from([1, 2, 3]));
    res.emit('finish');

    const responseBody = (logCalls[1][0] as Record<string, unknown>)
      .responseBody;
    expect(typeof responseBody).toBe('string');
    expect(responseBody).toContain('3');
  });

  it('직렬화 결과가 undefined인 본문도 응답 로그를 유실하지 않는다', () => {
    // `JSON.stringify({ toJSON: () => undefined })`는 던지지 않고 undefined를
    // 반환한다 — 그 값이 바이트 계산에 들어가면 TypeError로 응답 로그가
    // 유실된다(리뷰 3라운드에서 실측된 구멍)
    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);

    res.json({ toJSON: () => undefined });
    res.emit('finish');

    expect(logCalls).toHaveLength(2);
    const responseBody = (logCalls[1][0] as Record<string, unknown>)
      .responseBody;
    expect(typeof responseBody).toBe('string');
    expect(responseBody).toContain('직렬화');
  });

  it('본문 없이 끝난 응답에는 responseBody 필드를 넣지 않는다', () => {
    const res = createFakeRes(204);
    middleware.use(createFakeReq(), res, () => undefined);

    res.emit('finish');

    expect(logCalls[1][0]).not.toHaveProperty('responseBody');
  });

  it('next를 호출해 다음 핸들러로 넘긴다', () => {
    const next = jest.fn();

    middleware.use(createFakeReq(), createFakeRes(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('컨텍스트 이름을 함께 남긴다', () => {
    const res = createFakeRes();
    middleware.use(createFakeReq(), res, () => undefined);
    res.emit('finish');

    expect(logCalls[0][1]).toBe(RequestLoggingMiddleware.name);
    expect(logCalls[1][1]).toBe(RequestLoggingMiddleware.name);
  });
});
