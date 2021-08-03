import { CacheModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';

import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsModule } from './notifications/notifications.module';

import configuration, {
  CacheConfigService,
  TypeOrmConfigService,
  validationSchema
} from './config';
import { SputnikDaoService } from './sputnikdao/sputnik.service';
import { DaoModule } from './daos/dao.module';
import { AggregatorService } from './aggregator/aggregator.service';
import { ProposalModule } from './proposals/proposal.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: configuration,
      validationSchema,
      envFilePath: ['.env.local', '.env'],
    }),
    TypeOrmModule.forRootAsync({
      useClass: TypeOrmConfigService,
    }),
    CacheModule.registerAsync({
      useClass: CacheConfigService,
    }),
    ScheduleModule.forRoot(),
    DaoModule,
    ProposalModule,
    SearchModule,
    NotificationsModule
  ],
  controllers: [AppController],
  providers: [SputnikDaoService, AggregatorService],
})
export class AppModule {}
