import { Module } from '@nestjs/common';
import { NameMatchService } from './name-match.service';

@Module({
  providers: [NameMatchService],
  exports: [NameMatchService],
})
export class NameMatchModule {}
