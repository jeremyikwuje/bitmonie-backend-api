import 'reflect-metadata';

// Serialize BigInt as a JSON string everywhere. sats and other satoshi-denominated
// values are bigint at the domain layer; without this, Express res.json() throws
// "Do not know how to serialize a BigInt" on any response carrying one.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function (): string {
  return this.toString();
};

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';
import type { AppConfig } from '@/config/app.config';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bufferLogs: false,
  });

  const config = app.get(ConfigService);
  const app_config = config.get<AppConfig>('app');
  const port = app_config?.port ?? 3000;
  const allowed_origin = app_config?.allowed_origin ?? '*';

  app.setGlobalPrefix('v1');

  app.use(helmet());
  app.use(cookieParser());

  // ALLOWED_ORIGIN accepts a comma-separated list of explicit origins so
  // production, preview, and local-dev frontends can all be allowed at once
  // (e.g. "https://web.bitmonie.co,http://localhost:5173"). The browser
  // refuses ACAO=* on credentialed requests, so a literal '*' is mapped to
  // the cors library's reflect-the-request-origin mode (`origin: true`),
  // keeping the no-env dev fallback usable. Production should always set an
  // explicit list.
  const allowed_origins = allowed_origin
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const cors_origin: true | string[] =
    allowed_origins.length === 1 && allowed_origins[0] === '*' ? true : allowed_origins;
  app.enableCors({ credentials: true, origin: cors_origin });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  app.useGlobalFilters(new GlobalExceptionFilter());

  const swagger_config = new DocumentBuilder()
    .setTitle('Bitmonie API')
    .setDescription('Crypto-backed instant Naira credit — v1.1 (accrual-based pricing, partial repayments, add-collateral, permanent per-user PalmPay VA)')
    .setVersion('1.1')
    .addCookieAuth('session')
    .addCookieAuth('ops_session')
    .build();
  SwaggerModule.setup('v1/docs', app, SwaggerModule.createDocument(app, swagger_config));

  await app.listen(port, '0.0.0.0');
  Logger.log(`Bitmonie API listening on http://localhost:${port}/v1`, 'Bootstrap');
  Logger.log(`Swagger UI available at http://localhost:${port}/v1/docs`, 'Bootstrap');
}

void bootstrap();
