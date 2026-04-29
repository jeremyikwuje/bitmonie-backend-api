import { Module } from '@nestjs/common';
import { WebhooksLogService } from './webhooks-log.service';

// PrismaService comes via @Global() DatabaseModule.
@Module({
  providers: [WebhooksLogService],
  exports:   [WebhooksLogService],
})
export class WebhooksLogModule {}
