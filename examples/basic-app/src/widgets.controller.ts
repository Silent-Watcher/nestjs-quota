import { Controller, Get, UseGuards } from '@nestjs/common';
import { Quota, QuotaGuard, QuotaService } from 'nestjs-quota/nestjs';

@Controller('widgets')
@UseGuards(QuotaGuard)
export class WidgetsController {
  constructor(private readonly quota: QuotaService) {}

  /**
   * Enforced against BOTH the per-user-per-minute quota (plan-dependent
   * limit) and the tenant-wide daily quota, atomically -- if either would
   * be exceeded, neither is consumed.
   */
  @Get()
  @Quota({ policies: ['user-minute', 'tenant-day'] })
  list() {
    return { widgets: ['gear', 'sprocket', 'cog'] };
  }

  /**
   * Read-only usage inspection -- does not consume any quota. Note this
   * route has no `@Quota()` metadata, so `QuotaGuard` lets it through
   * without touching the engine at all.
   */
  @Get('usage')
  async usage() {
    // In a real app you'd resolve these subjects from the authenticated
    // request the same way `identityResolver` does; hard-coded here only
    // because this endpoint takes no route param to key off of.
    return {
      note: 'usage for the caller resolved via req.auth in a real handler; this demo reads both example tenants',
      freeTenantUserMinute: await this.quota.getUsage('user-minute', 'user_1'),
      proTenantUserMinute: await this.quota.getUsage('user-minute', 'user_2'),
      freeTenantDaily: await this.quota.getUsage('tenant-day', 'tenant_free'),
      proTenantDaily: await this.quota.getUsage('tenant-day', 'tenant_pro'),
    };
  }
}
