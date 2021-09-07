import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import configuration, {
  TypeOrmConfigService,
  notifierValidationSchema as validationSchema,
} from '../config';
import { Subscription } from 'src/subscriptions/entities/subscription.entity';
import { NotificationsController } from './notifications.controller';
import { SubscriptionSlimModule } from 'src/subscriptions/subscription-slim.module';
import { NotificationService } from './notifications.service';
import { AccountSlimModule } from 'src/account/account-slim.module';
import { DaoSlimModule } from 'src/daos/dao-slim.module';
import { Account } from 'src/account/entities/Account.entity';
import { Dao } from 'src/daos/entities/dao.entity';

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
    TypeOrmModule.forFeature([Subscription, Account, Dao]),
    SubscriptionSlimModule,
    AccountSlimModule,
    DaoSlimModule,
  ],
  controllers: [NotificationsController],
  providers: [NotificationService],
})
export class NotificationsModule {}
