import { describe, expect, it } from 'vitest';
import { resolveFixedWindow } from '../../src/core/windows/window.js';

describe('resolveFixedWindow', () => {
  it('resolves a minute window as [start, end)', () => {
    const atMs = Date.UTC(2026, 0, 1, 12, 30, 45, 500);
    const w = resolveFixedWindow({ type: 'fixed', unit: 'minute' }, atMs);
    expect(w.startMs).toBe(Date.UTC(2026, 0, 1, 12, 30, 0, 0));
    expect(w.endMs).toBe(Date.UTC(2026, 0, 1, 12, 31, 0, 0));
  });

  it('treats the window end as exclusive', () => {
    const w = resolveFixedWindow({ type: 'fixed', unit: 'second' }, 1_000);
    // exactly at the boundary belongs to the *next* window
    const next = resolveFixedWindow({ type: 'fixed', unit: 'second' }, w.endMs);
    expect(next.startMs).toBe(w.endMs);
  });

  it('handles second -> minute boundary', () => {
    const w = resolveFixedWindow({ type: 'fixed', unit: 'minute' }, 59_999);
    expect(w.startMs).toBe(0);
    expect(w.endMs).toBe(60_000);
  });

  it('handles minute -> hour boundary', () => {
    const w = resolveFixedWindow({ type: 'fixed', unit: 'hour' }, 3_599_999);
    expect(w.startMs).toBe(0);
    expect(w.endMs).toBe(3_600_000);
  });

  it('resolves month windows correctly, including February and leap years', () => {
    const feb2024 = resolveFixedWindow({ type: 'fixed', unit: 'month' }, Date.UTC(2024, 1, 15));
    expect(feb2024.startMs).toBe(Date.UTC(2024, 1, 1));
    expect(feb2024.endMs).toBe(Date.UTC(2024, 2, 1)); // leap year: Feb has 29 days, but boundary is exact month rollover

    const feb2023 = resolveFixedWindow({ type: 'fixed', unit: 'month' }, Date.UTC(2023, 1, 15));
    expect(feb2023.startMs).toBe(Date.UTC(2023, 1, 1));
    expect(feb2023.endMs).toBe(Date.UTC(2023, 2, 1));
  });

  it('handles year rollover for month windows (December -> January)', () => {
    const dec = resolveFixedWindow({ type: 'fixed', unit: 'month' }, Date.UTC(2025, 11, 31, 23, 59, 59));
    expect(dec.startMs).toBe(Date.UTC(2025, 11, 1));
    expect(dec.endMs).toBe(Date.UTC(2026, 0, 1));
  });

  it('handles different month lengths (30 vs 31 vs 28/29 days)', () => {
    const apr = resolveFixedWindow({ type: 'fixed', unit: 'month' }, Date.UTC(2026, 3, 10)); // April, 30 days
    expect(apr.endMs - apr.startMs).toBe(30 * 86_400_000);

    const may = resolveFixedWindow({ type: 'fixed', unit: 'month' }, Date.UTC(2026, 4, 10)); // May, 31 days
    expect(may.endMs - may.startMs).toBe(31 * 86_400_000);
  });

  it('supports multi-unit window sizes (e.g. 5-minute windows)', () => {
    const w = resolveFixedWindow({ type: 'fixed', unit: 'minute', size: 5 }, Date.UTC(2026, 0, 1, 0, 7, 0));
    expect(w.startMs).toBe(Date.UTC(2026, 0, 1, 0, 5, 0));
    expect(w.endMs).toBe(Date.UTC(2026, 0, 1, 0, 10, 0));
  });

  it('rejects a non-positive window size', () => {
    expect(() => resolveFixedWindow({ type: 'fixed', unit: 'minute', size: 0 }, 0)).toThrow();
    expect(() => resolveFixedWindow({ type: 'fixed', unit: 'minute', size: -1 }, 0)).toThrow();
  });
});
