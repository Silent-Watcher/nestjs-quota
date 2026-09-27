import type { PolicyName, ScopeName, SubjectId } from './identity.js';
import type { WindowInstance } from '../windows/window.js';

const MAX_KEY_LENGTH = 512;
/** Subject ids longer than this are hashed rather than embedded verbatim, to bound key length and cardinality risk. */
const SUBJECT_HASH_THRESHOLD = 128;

/** Small, dependency-free non-cryptographic hash (FNV-1a), hex-encoded. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function canonicalSubject(subject: SubjectId): string {
  if (subject.length <= SUBJECT_HASH_THRESHOLD) return subject;
  return `h${fnv1a(subject)}`;
}

export interface BucketKeyParams {
  readonly namespace: string;
  readonly policy: PolicyName;
  readonly scope: ScopeName;
  readonly subject: SubjectId;
  readonly window: WindowInstance;
}

/**
 * Deterministic, namespaced, bounded-length key for a quota bucket.
 *
 * Shape: `<namespace>:quota:<policy>:<scope>:<subject>:<windowStartMs>`
 *
 * The window's `startMs` alone is a sufficient and stable discriminator for
 * a given policy's window spec (policy name is already part of the key, and
 * a policy's window spec does not change between calls), so it is embedded
 * directly rather than re-deriving a window-unit label here.
 *
 * All components are pre-validated as "safe" (see domain/identity.ts) so no
 * further escaping is required; subjects beyond a length threshold are
 * hashed to bound key size and avoid unbounded high-cardinality growth.
 */
export function buildBucketKey(params: BucketKeyParams): string {
  const key = [
    params.namespace,
    'quota',
    params.policy,
    params.scope,
    canonicalSubject(params.subject),
    String(params.window.startMs),
  ].join(':');
  if (key.length > MAX_KEY_LENGTH) {
    return `${params.namespace}:quota:h${fnv1a(key)}`;
  }
  return key;
}

export function buildIdempotencyKey(namespace: string, key: string): string {
  const canonical = key.length <= SUBJECT_HASH_THRESHOLD ? key : `h${fnv1a(key)}`;
  return `${namespace}:idem:${canonical}`;
}

export function buildReservationKey(namespace: string, reservationId: string): string {
  return `${namespace}:resv:${reservationId}`;
}
