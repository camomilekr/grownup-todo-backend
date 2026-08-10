import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ShutdownRegistry } from './shutdown-registry.service';

describe('ShutdownRegistry', () => {
  let registry: ShutdownRegistry;

  beforeEach(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [ShutdownRegistry],
    }).compile();

    registry = moduleRef.get(ShutdownRegistry);
    // Nest 내장 Logger가 콘솔을 더럽히지 않게 막는다. Logger.prototype은
    // 전역이므로 afterEach의 restoreAllMocks로 반드시 되돌린다.
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('등록 역순으로 순차 해제한다', async () => {
    // 나중에 연 자원이 먼저 닫혀야 자원 간 의존(나중 자원이 먼저 자원을
    // 쓰는 방향)이 생겨도 안전하다. 순차 검증을 위해 먼저 해제될 콜백을
    // 마이크로태스크 몇 번 뒤에 완료시킨다 — 병렬이면 순서가 뒤집힌다.
    const order: string[] = [];
    registry.register('first', async () => {
      order.push('first');
    });
    registry.register('second', async () => {
      await Promise.resolve();
      await Promise.resolve();
      order.push('second');
    });

    await registry.onApplicationShutdown('SIGTERM');

    expect(order).toEqual(['second', 'first']);
  });

  it('하나가 던져도 나머지 자원을 해제하고 자신은 던지지 않는다', async () => {
    // 시그널 경로에서 훅이 던지면 Nest가 process.exit(1)로 나머지 해제를
    // 전부 건너뛴다 — 오류 격리가 이 구현체의 존재 이유다
    const disposed: string[] = [];
    registry.register('first', () => {
      disposed.push('first');
    });
    registry.register('second', () => {
      throw new Error('해제 실패');
    });

    await expect(
      registry.onApplicationShutdown('SIGTERM'),
    ).resolves.toBeUndefined();
    expect(disposed).toEqual(['first']);
  });

  it('타임아웃을 넘긴 자원은 건너뛰고 다음 자원으로 진행한다', async () => {
    jest.useFakeTimers();
    const disposed: string[] = [];
    registry.register('first', () => {
      disposed.push('first');
    });
    registry.register('never-resolves', () => new Promise(() => undefined));

    const shutdown = registry.onApplicationShutdown('SIGTERM');
    await jest.advanceTimersByTimeAsync(10_000);
    await shutdown;

    expect(disposed).toEqual(['first']);
  });

  it('두 번 불려도 해제는 한 번만 실행한다', async () => {
    // e2e의 app.close()와 시그널이 겹치는 등 훅은 여러 경로로 들어온다 —
    // 이중 해제는 이미 닫힌 커넥션에 대한 오류를 만든다
    const dispose = jest.fn();
    registry.register('once', dispose);

    await registry.onApplicationShutdown('SIGTERM');
    await registry.onApplicationShutdown('SIGTERM');

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('등록된 자원이 없으면 아무것도 하지 않는다', async () => {
    await expect(
      registry.onApplicationShutdown('SIGINT'),
    ).resolves.toBeUndefined();
  });

  it('해제 로그에 자원 이름과 signal 이름을 남긴다', async () => {
    // 어떤 시그널로 어떤 자원이 닫혔는지가 없으면 재배포 로그에서 종료
    // 원인을 추적할 수 없다
    const log = jest.spyOn(Logger.prototype, 'log');
    registry.register('postgres', () => undefined);

    await registry.onApplicationShutdown('SIGTERM');

    const messages = log.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('postgres'))).toBe(true);
    expect(messages.some((m) => m.includes('SIGTERM'))).toBe(true);
  });
});
