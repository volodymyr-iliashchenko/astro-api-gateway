import { NestFactory, Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { config as awsConfig } from 'aws-sdk';
import { SputnikDaoService } from './sputnikdao/sputnik.service';
import { AggregatorService } from './aggregator/aggregator.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
  app.setGlobalPrefix("/api/v1");

  if (process.env.NODE_ENV === 'development') {
    (app as any).httpAdapter.instance.set('json spaces', 2);
  }

  const config = new DocumentBuilder()
    .setTitle('Sputnik v1 API')
    .setDescription('The Sputnik v1 API description')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      disableErrorMessages: false,
      validationError: { target: false },
      transformOptions: {
        enableImplicitConversion: true
      }
    }),
  );

  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const configService = app.get(ConfigService);

  awsConfig.update({
    accessKeyId: configService.get('AWS_ACCESS_KEY_ID'),
    secretAccessKey: configService.get('AWS_SECRET_ACCESS_KEY'),
    region: configService.get('AWS_REGION'),
  });

  await app.get(SputnikDaoService).init();

  await app.get(AggregatorService).aggregate();

  const port = configService.get('port');

  await app.listen(port);
}
bootstrap();
