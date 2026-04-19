import { Test, TestingModule } from '@nestjs/testing';
import { PriceFeedService } from './price-feed.service';

describe('PriceFeedService', () => {
  let service: PriceFeedService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PriceFeedService],
    }).compile();

    service = module.get<PriceFeedService>(PriceFeedService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
