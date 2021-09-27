import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  REDIS_PUBLISHER_CLIENT,
  REDIS_SUBSCRIBER_CLIENT,
} from './redis.constants';

export type RedisClient = Redis.Redis;

export const redisProviders: Provider[] = [
  {
    useFactory: (configService: ConfigService): RedisClient => {
      const {
        redisHost: host,
        redisPort: port,
        redisDB: db,
      } = configService.get('api');

      return new Redis({ host, port, db });
    },
    inject: [ConfigService],
    provide: REDIS_SUBSCRIBER_CLIENT,
  },
  {
    useFactory: (configService: ConfigService): RedisClient => {
      const {
        redisHost: host,
        redisPort: port,
        redisDB: db,
      } = configService.get('api');

      return new Redis({ host, port, db });
    },
    inject: [ConfigService],
    provide: REDIS_PUBLISHER_CLIENT,
  },
];
