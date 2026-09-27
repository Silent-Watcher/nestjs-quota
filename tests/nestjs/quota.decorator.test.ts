import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import { Quota, SkipQuota } from '../../src/nestjs/decorators/quota.decorator.js';
import { QUOTA_METADATA_KEY, SKIP_QUOTA_METADATA_KEY } from '../../src/nestjs/tokens/tokens.js';

class SampleController {
  @Quota('user-minute')
  singlePolicy() {
    return null;
  }

  @Quota({ policies: ['tenant-monthly', 'user-minute'] })
  multiPolicy() {
    return null;
  }

  @Quota({ policies: ['user-minute'], mode: 'reserve', reservationLeaseMs: 5000 })
  reserving() {
    return null;
  }

  plainRoute() {
    return null;
  }

  @SkipQuota()
  @Quota('user-minute')
  exempt() {
    return null;
  }
}

describe('@Quota() decorator', () => {
  const reflector = new Reflector();

  it('attaches a single-policy shorthand as metadata', () => {
    const metadata = reflector.get(QUOTA_METADATA_KEY, SampleController.prototype.singlePolicy);
    expect(metadata).toEqual({ policies: ['user-minute'] });
  });

  it('attaches multi-policy options as-is', () => {
    const metadata = reflector.get(QUOTA_METADATA_KEY, SampleController.prototype.multiPolicy);
    expect(metadata).toEqual({ policies: ['tenant-monthly', 'user-minute'] });
  });

  it('preserves mode and reservationLeaseMs options', () => {
    const metadata = reflector.get(QUOTA_METADATA_KEY, SampleController.prototype.reserving);
    expect(metadata).toMatchObject({ mode: 'reserve', reservationLeaseMs: 5000 });
  });

  it('does not attach metadata to routes without the decorator', () => {
    const metadata = reflector.get(QUOTA_METADATA_KEY, SampleController.prototype.plainRoute);
    expect(metadata).toBeUndefined();
  });

  it('throws synchronously when given an empty policies array', () => {
    expect(() => Quota({ policies: [] })).toThrow();
  });
});

describe('@SkipQuota() decorator', () => {
  const reflector = new Reflector();

  it('attaches skip metadata independently of @Quota()', () => {
    const skip = reflector.get(SKIP_QUOTA_METADATA_KEY, SampleController.prototype.exempt);
    const quota = reflector.get(QUOTA_METADATA_KEY, SampleController.prototype.exempt);
    expect(skip).toBe(true);
    expect(quota).toEqual({ policies: ['user-minute'] });
  });
});
