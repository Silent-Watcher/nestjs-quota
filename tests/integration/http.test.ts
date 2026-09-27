import { Controller, Get, INestApplication, Module, UseGuards } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QuotaModule, QuotaGuard, Quota, SkipQuota, QuotaService } from '../../src/nestjs/index.js';
import { MemoryQuotaStore } from '../../src/index.js';

@Controller('api')
class ApiController {
  constructor(private readonly quota: QuotaService) {}

  @Get('limited')
  @UseGuards(QuotaGuard)
  @Quota('ip-minute')
  limited() {
    return { ok: true };
  }

  @Get('unlimited')
  @UseGuards(QuotaGuard)
  @SkipQuota()
  unlimited() {
    return { ok: true };
  }

  @Get('usage')
  async usage() {
    return this.quota.getUsage('ip-minute', 'test-ip');
  }
}

@Module({
  imports: [
    QuotaModule.forRoot({
      store: new MemoryQuotaStore(),
      policies: [{ name: 'ip-minute', scope: 'global', window: { type: 'fixed', unit: 'minute' }, limit: 2 }],
      identityResolver: async () => 'test-ip',
    }),
  ],
  controllers: [ApiController],
})
class TestAppModule {}

describe('HTTP integration: QuotaModule + QuotaGuard end to end', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TestAppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('allows requests under the limit and returns 429 once exceeded', async () => {
    await request(app.getHttpServer()).get('/api/limited').expect(200);
    await request(app.getHttpServer()).get('/api/limited').expect(200);
    const res = await request(app.getHttpServer()).get('/api/limited').expect(429);
    expect(res.body.error).toBe('QUOTA_EXCEEDED');
  });

  it('sets rate-limit response headers on allowed requests', async () => {
    const res = await request(app.getHttpServer()).get('/api/limited').expect(200);
    expect(res.headers['x-ratelimit-limit']).toBe('2');
    expect(res.headers['x-ratelimit-remaining']).toBe('1');
  });

  it('sets Retry-After on a rejected request', async () => {
    await request(app.getHttpServer()).get('/api/limited');
    await request(app.getHttpServer()).get('/api/limited');
    const res = await request(app.getHttpServer()).get('/api/limited').expect(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('never charges a route marked @SkipQuota()', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer()).get('/api/unlimited').expect(200);
    }
    // the shared 'ip-minute' policy limit is 2; ten skipped calls must not have touched it
    const usageRes = await request(app.getHttpServer()).get('/api/usage').expect(200);
    expect(usageRes.body.used).toBe(0);
  });
});
