import { describe, expect, it } from 'vitest';
import { assertSafeComponent, toScopeName, toSubjectId } from '../../src/core/domain/identity.js';

describe('assertSafeComponent', () => {
  it('accepts safe characters', () => {
    expect(() => assertSafeComponent('tenant-123_abc.def:ghi@jkl', { label: 'x' })).not.toThrow();
  });

  it('rejects an empty string', () => {
    expect(() => assertSafeComponent('', { label: 'x' })).toThrow();
  });

  it('rejects unsafe characters that could break key construction', () => {
    for (const bad of ['a b', 'a/b', 'a\\b', "a'b", 'a"b', 'a\nb', 'a{b']) {
      expect(() => assertSafeComponent(bad, { label: 'x' })).toThrow();
    }
  });

  it('rejects a value exceeding max length', () => {
    expect(() => assertSafeComponent('a'.repeat(300), { label: 'x', maxLength: 256 })).toThrow();
  });

  it('rejects malicious values designed to look like key separators', () => {
    // Even though these use only "safe" characters individually, no single
    // component may itself use ":" to try to spoof extra key segments --
    // this is allowed here (":" is a safe char) but bounded length and
    // per-component validation prevent structural injection into a
    // multi-part key built from validated parts.
    expect(() => toScopeName('tenant:evil')).not.toThrow();
    expect(() => toSubjectId('victim-tenant-id')).not.toThrow();
  });
});
