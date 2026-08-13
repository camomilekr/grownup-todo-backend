import { ServiceUnavailableException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ShutdownRegistry } from '../shutdown/shutdown-registry.service';
import { ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  let service: ReadinessService;
  let shuttingDown: boolean;

  beforeEach(async () => {
    shuttingDown = false;

    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ReadinessService,
        {
          provide: ShutdownRegistry,
          useValue: { isShuttingDown: () => shuttingDown },
        },
      ],
    }).compile();

    service = moduleRef.get(ReadinessService);
  });

  it('평시에는 준비 상태를 돌려준다', () => {
    expect(service.check()).toBe('ready');
  });

  it('종료가 시작되면 503으로 거절한다', () => {
    // k8s가 이 응답을 보고 파드를 서비스 엔드포인트에서 뺀다. 여기서 예외를
    // 던지지 않고 문자열만 바꾸면 프로브가 계속 성공으로 읽혀 드레인이 없다
    shuttingDown = true;

    expect(() => service.check()).toThrow(ServiceUnavailableException);
  });
});
