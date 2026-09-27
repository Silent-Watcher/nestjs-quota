import { describe, expect, it } from 'vitest';
import { definePolicy, resolveLimit } from '../../src/core/policies/policy.js';
import { InvalidQuotaPolicyError } from '../../src/core/errors/errors.js';

describe('definePolicy', () => {
  it('accepts a valid static policy', () => {
    const policy = definePolicy({
      name: 'tenant-monthly-api',
      scope: 'tenant',
      window: { type: 'fixed', unit: 'month' },
      limit: 100_000,
    });
    expect(policy.name).toBe('tenant-monthly-api');
    expect(policy.defaultCost).toBe(1);
  });

  it('rejects an empty policy name', () => {
    expect(() =>
      definePolicy({ name: '', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: 10 }),
    ).toThrow(InvalidQuotaPolicyError);
  });

  it('rejects a malformed scope', () => {
    expect(() =>
      definePolicy({
        name: 'x',
        scope: 'has spaces!',
        window: { type: 'fixed', unit: 'day' },
        limit: 10,
      }),
    ).toThrow(InvalidQuotaPolicyError);
  });

  it('requires either limit or limitResolver', () => {
    expect(() =>
      definePolicy({ name: 'x', scope: 'tenant', window: { type: 'fixed', unit: 'day' } }),
    ).toThrow(InvalidQuotaPolicyError);
  });

  it('rejects a negative limit', () => {
    expect(() =>
      definePolicy({ name: 'x', scope: 'tenant', window: { type: 'fixed', unit: 'day' }, limit: -1 }),
    ).toThrow(InvalidQuotaPolicyError);
  });

  it('accepts limit = 0 (a valid, always-exceeded quota)', () => {
    const policy = definePolicy({
      name: 'blocked',
      scope: 'tenant',
      window: { type: 'fixed', unit: 'day' },
      limit: 0,
    });
    expect(policy.limit).toBe(0);
  });

  it('rejects a non-integer or non-positive defaultCost', () => {
    expect(() =>
      definePolicy({
        name: 'x',
        scope: 'tenant',
        window: { type: 'fixed', unit: 'day' },
        limit: 10,
        defaultCost: 0,
      }),
    ).toThrow(InvalidQuotaPolicyError);
    expect(() =>
      definePolicy({
        name: 'x',
        scope: 'tenant',
        window: { type: 'fixed', unit: 'day' },
        limit: 10,
        defaultCost: 1.5,
      }),
    ).toThrow(InvalidQuotaPolicyError);
  });

  it('supports plan-based dynamic limits via limitResolver', async () => {
    const policy = definePolicy<{ plan: 'free' | 'pro' }>({
      name: 'plan-based',
      scope: 'tenant',
      window: { type: 'fixed', unit: 'month' },
      limitResolver: (ctx) => (ctx.plan === 'pro' ? 1_000_000 : 10_000),
    });
    expect(await resolveLimit(policy, { plan: 'free' })).toBe(10_000);
    expect(await resolveLimit(policy, { plan: 'pro' })).toBe(1_000_000);
  });

  it('rejects a limitResolver that returns an invalid limit', async () => {
    const policy = definePolicy({
      name: 'bad-resolver',
      scope: 'tenant',
      window: { type: 'fixed', unit: 'month' },
      limitResolver: () => -5,
    });
    await expect(resolveLimit(policy, undefined)).rejects.toThrow(InvalidQuotaPolicyError);
  });
});
