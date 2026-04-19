import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { PriceFeedService } from './price-feed.service';
import { RatesResponseDto } from './dto/rates-response.dto';

@ApiTags('rates')
@Controller('rates')
export class PriceFeedController {
  constructor(private readonly price_feed_service: PriceFeedService) {}

  @Get()
  @ApiOperation({ summary: 'Get current exchange rates — public, no auth required' })
  @ApiResponse({ status: 200, description: 'Current rates for SAT/NGN, BTC/NGN, USDT/NGN', type: RatesResponseDto })
  @ApiResponse({ status: 422, description: 'Price feed is stale (last update > 2 minutes ago)' })
  async getRates(): Promise<RatesResponseDto> {
    return this.price_feed_service.getRates();
  }
}
