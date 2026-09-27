import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`nest-quota example app listening on http://localhost:${port}`);
  // eslint-disable-next-line no-console
  console.log(`store: ${process.env.REDIS_URL ? `Redis (${process.env.REDIS_URL})` : 'in-memory'}`);
}

void bootstrap();
