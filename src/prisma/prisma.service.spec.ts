import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ShutdownRegistry } from '../shutdown/shutdown-registry.service';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  const VALID_URL = 'postgresql://postgres:pw@localhost:5432/postgres';

  let registerMock: jest.Mock;

  beforeEach(() => {
    registerMock = jest.fn();
  });

  /**
   * 대상 Service만 실제 Provider로 두고 ConfigService·ShutdownRegistry는
   * 대역으로 바꾼다. `.compile()`은 라이프사이클 훅을 부르지 않으므로 이
   * 시점에 DB로 붙지 않는다.
   */
  async function createModule(
    env: Record<string, string | undefined> = { DATABASE_URL: VALID_URL },
  ): Promise<TestingModule> {
    return Test.createTestingModule({
      providers: [
        PrismaService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
        {
          provide: ShutdownRegistry,
          useValue: { register: registerMock },
        },
      ],
    }).compile();
  }

  it('DATABASE_URL로 커넥션을 구성한다', async () => {
    // 어댑터에 넘어간 접속 문자열은 렌더 결과처럼 관찰할 수 없다 — 실제로
    // 연결해 봐야 드러나고 그것은 e2e의 일이다. 그래서 ConfigService가 어떤
    // 키로 조회됐는지를 단정한다. 잘못된 키를 읽으면 어댑터가 조용히
    // libpq 기본값(localhost)으로 붙어 "데이터가 없음"으로 위장하기 때문이다.
    const get = jest.fn().mockReturnValue(VALID_URL);
    const moduleRef = await Test.createTestingModule({
      providers: [
        PrismaService,
        { provide: ConfigService, useValue: { get } },
        { provide: ShutdownRegistry, useValue: { register: registerMock } },
      ],
    }).compile();

    moduleRef.get(PrismaService);

    expect(get).toHaveBeenCalledWith('DATABASE_URL');
  });

  it.each([
    ['없으면', { DATABASE_URL: undefined }],
    ['빈 문자열이면', { DATABASE_URL: '' }],
  ])('DATABASE_URL이 %s 생성 시점에 던진다', async (_설명, env) => {
    // ConfigModule의 validate를 우회해 이 Provider만 따로 쓰는 경로가
    // 생겨도 localhost로 조용히 붙지 않게 한 겹 더 막는다
    await expect(createModule(env)).rejects.toThrow(/DATABASE_URL/);
  });

  it('onModuleInit에서 연결하고 해제 콜백을 등록한다', async () => {
    const moduleRef = await createModule();
    const service = moduleRef.get(PrismaService);
    const connect = jest
      .spyOn(service, '$connect')
      .mockResolvedValue(undefined);
    const disconnect = jest
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);

    await service.onModuleInit();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledTimes(1);

    // 등록 인자 — 이름과, 실행하면 실제로 커넥션을 닫는 콜백
    const [name, dispose] = registerMock.mock.calls[0] as [
      string,
      () => Promise<void>,
    ];
    expect(name).toBe('postgres');
    await dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('연결에 실패하면 해제 콜백을 등록하지 않는다', async () => {
    // 열지 못한 자원을 해제 대상에 넣으면 종료 때 닫힌 적 없는 커넥션을
    // 닫으려는 오류가 하나 더 쌓인다
    const moduleRef = await createModule();
    const service = moduleRef.get(PrismaService);
    jest.spyOn(service, '$connect').mockRejectedValue(new Error('연결 실패'));

    await expect(service.onModuleInit()).rejects.toThrow('연결 실패');

    expect(registerMock).not.toHaveBeenCalled();
  });

  it('자체 종료 훅(onModuleDestroy·onApplicationShutdown)을 갖지 않는다', async () => {
    // 종료는 ShutdownRegistry가 조율한다 — 자체 훅이 되살아나면 해제가 두
    // 경로로 갈라지고, onModuleDestroy라면 HTTP 서버가 닫히기 전에 커넥션이
    // 끊기는 회귀다(시그널 수신 시 Nest는 onModuleDestroy → HTTP close →
    // onApplicationShutdown 순서). 존재 자체를 실패로 고정한다.
    const moduleRef = await createModule();
    const service = moduleRef.get(PrismaService);

    expect(
      (service as { onModuleDestroy?: unknown }).onModuleDestroy,
    ).toBeUndefined();
    expect(
      (service as { onApplicationShutdown?: unknown }).onApplicationShutdown,
    ).toBeUndefined();
  });
});
