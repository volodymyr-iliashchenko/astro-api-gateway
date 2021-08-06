import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DaoService } from './dao.service';
import { Dao } from './entities/dao.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Dao])
  ],
  providers: [DaoService],
  exports: [DaoService]
})
export class DaoSlimModule {}
