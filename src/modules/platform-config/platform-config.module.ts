import { Module } from '@nestjs/common';
import { PlatformConfigController } from './platform-config.controller';

@Module({
  controllers: [PlatformConfigController],
})
export class PlatformConfigModule {}
