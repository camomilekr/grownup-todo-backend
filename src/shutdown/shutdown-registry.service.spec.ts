import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ShutdownRegistry } from './shutdown-registry.service';

/** 이 spec에서 쓰는 드레인 대기 시간. 기본값과 다른 값이라야 설정이 실제로 읽히는지 보인다 */
const DRAIN_DELAY_MS = 3_000;

describe('ShutdownRegistry', () => {
  let registry: ShutdownRegistry;

  /**
   * `ConfigService.getOrThrow`의 동작을 지정해 레지스트리를 만든다. 값을
   * 돌려주는 경우와 던지는 경우를 같은 자리에서 바꿔 끼우기 위한 형태다.
   */
  async function createRegistryWith(
    getOrThrow: () => number,
  ): Promise<ShutdownRegistry> {
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ShutdownRegistry,
        {
          provide: ConfigService,
          useValue: { getOrThrow },
        },
      ],
    }).compile();

    return moduleRef.get(ShutdownRegistry);
  }

  function createRegistry(drainDelayMs: number): Promise<ShutdownRegistry> {
    // 검증(`validateEnv`)을 지난 값은 언제나 number다
    return createRegistryWith(() => drainDelayMs);
  }

  beforeEach(async () => {
    registry = await createRegistry(DRAIN_DELAY_MS);
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

  describe('드레인 국면 (beforeApplicationShutdown)', () => {
    it('평시에는 종료 중이 아니다', () => {
      expect(registry.isShuttingDown()).toBe(false);
    });

    it('드레인 국면에 들어가면 종료 중이 된다', async () => {
      jest.useFakeTimers();

      const draining = registry.beforeApplicationShutdown('SIGTERM');
      // 대기가 끝나기 **전에** readiness가 이미 503이어야 한다. 대기가 끝난
      // 뒤에 플래그를 세우면 드레인하는 동안 k8s가 파드를 계속 준비된 것으로
      // 보고 새 요청을 보낸다 — 이 순서가 이 기능의 전부다
      expect(registry.isShuttingDown()).toBe(true);

      await jest.advanceTimersByTimeAsync(DRAIN_DELAY_MS);
      await draining;
    });

    it('시그널로 들어오면 설정된 시간만큼 기다린다', async () => {
      jest.useFakeTimers();
      let settled = false;

      const draining = registry
        .beforeApplicationShutdown('SIGTERM')
        .then(() => {
          settled = true;
        });

      await jest.advanceTimersByTimeAsync(DRAIN_DELAY_MS - 1);
      expect(settled).toBe(false);

      await jest.advanceTimersByTimeAsync(1);
      await draining;
      expect(settled).toBe(true);
    });

    it('시그널이 없으면 기다리지 않는다', async () => {
      // e2e `afterEach`의 `app.close()`가 이 경로다. 여기서 대기하면 e2e
      // 7개 파일이 매 테스트마다 대기 시간만큼 느려진다
      jest.useFakeTimers();
      let settled = false;

      const draining = registry.beforeApplicationShutdown().then(() => {
        settled = true;
      });

      // 타이머를 전혀 진행시키지 않고 마이크로태스크만 비운다
      await Promise.resolve();
      await draining;

      expect(settled).toBe(true);
      expect(registry.isShuttingDown()).toBe(true);
    });

    it('대기 시간이 0이면 기다리지 않는다', async () => {
      // 매니페스트가 preStop 훅으로 대기를 대신하는 경우다
      const zeroDelayRegistry = await createRegistry(0);
      jest.useFakeTimers();
      let settled = false;

      const draining = zeroDelayRegistry
        .beforeApplicationShutdown('SIGTERM')
        .then(() => {
          settled = true;
        });

      await Promise.resolve();
      await draining;

      expect(settled).toBe(true);
    });

    it('두 번 불려도 대기는 한 번뿐이다', async () => {
      // 시그널이 연달아 오거나 close가 겹쳐도 종료가 두 배로 늘어지면 안 된다
      jest.useFakeTimers();

      const first = registry.beforeApplicationShutdown('SIGTERM');
      await jest.advanceTimersByTimeAsync(DRAIN_DELAY_MS);
      await first;

      let secondSettled = false;
      const second = registry.beforeApplicationShutdown('SIGTERM').then(() => {
        secondSettled = true;
      });
      await Promise.resolve();
      await second;

      expect(secondSettled).toBe(true);
    });

    it('드레인 로그에 대기 시간과 signal 이름을 남긴다', async () => {
      jest.useFakeTimers();
      const log = jest.spyOn(Logger.prototype, 'log');

      const draining = registry.beforeApplicationShutdown('SIGTERM');
      await jest.advanceTimersByTimeAsync(DRAIN_DELAY_MS);
      await draining;

      const messages = log.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes(String(DRAIN_DELAY_MS)))).toBe(
        true,
      );
      expect(messages.some((m) => m.includes('SIGTERM'))).toBe(true);
    });

    it('시그널 없이 불려도 던지지 않는다', async () => {
      // 시그널 경로에서 훅이 던지면 Nest가 process.exit(1)로 이후 자원 해제를
      // 전부 건너뛴다 — 드레인 국면이 자원 해제를 잘라먹으면 안 된다
      await expect(
        registry.beforeApplicationShutdown(),
      ).resolves.toBeUndefined();
    });

    it('대기 시간 설정을 읽지 못해도 던지지 않는다', async () => {
      // 위 단정은 시그널이 없어 즉시 반환하는 경로만 지난다. 이 국면에서
      // 실제로 던질 수 있는 문장은 설정 조회 하나뿐이라, 그것을 지나게 하는
      // 경우를 따로 세운다 — 여기서 던지면 자원 해제가 통째로 스킵된다
      const brokenRegistry = await createRegistryWith((): number => {
        throw new Error('SHUTDOWN_DRAIN_DELAY_MS 없음');
      });

      await expect(
        brokenRegistry.beforeApplicationShutdown('SIGTERM'),
      ).resolves.toBeUndefined();
    });

    it('대기 시간 설정을 읽지 못하면 error 로그를 남긴다', async () => {
      // 삼킨 예외를 조용히 버리면 드레인이 통째로 건너뛰어진 사실을 알 길이
      // 없다 — 종료 경로라 위로 던질 곳이 없으므로 로그가 유일한 출구다
      const error = jest.spyOn(Logger.prototype, 'error');
      const brokenRegistry = await createRegistryWith((): number => {
        throw new Error('SHUTDOWN_DRAIN_DELAY_MS 없음');
      });

      await brokenRegistry.beforeApplicationShutdown('SIGTERM');

      const messages = error.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('SIGTERM'))).toBe(true);
    });
  });
});
