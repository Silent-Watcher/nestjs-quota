/**
 * Identity primitives.
 *
 * Scopes and subjects are the "who" of a quota decision (tenant, user,
 * api-key, ...). They are treated as opaque, untrusted strings supplied by
 * the host application's resolvers — never inferred from raw request data
 * by the library itself.
 */

/** Maximum length allowed for any single identity/policy component. */
export const MAX_COMPONENT_LENGTH = 256;

/** Characters that are safe to embed in a serialized storage key. */
const SAFE_COMPONENT_PATTERN = /^[A-Za-z0-9_\-.:@]+$/;

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** The name of a quota scope, e.g. "tenant", "user", "global". */
export type ScopeName = Brand<string, 'ScopeName'>;

/** The concrete identity of a subject within a scope, e.g. a tenant id. */
export type SubjectId = Brand<string, 'SubjectId'>;

/** The name of a quota policy, e.g. "tenant-monthly-api". */
export type PolicyName = Brand<string, 'PolicyName'>;

export interface ComponentValidationOptions {
  readonly maxLength?: number;
  /** Field label used in error messages. */
  readonly label: string;
}

/**
 * Validates and brands a raw string as a safe identity component.
 * Throws a plain `Error`; callers (policy/engine layer) translate this into
 * the appropriate typed domain error.
 */
export function assertSafeComponent(
  value: string,
  options: ComponentValidationOptions,
): string {
  const maxLength = options.maxLength ?? MAX_COMPONENT_LENGTH;

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${options.label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(
      `${options.label} exceeds maximum length of ${maxLength} characters`,
    );
  }
  if (!SAFE_COMPONENT_PATTERN.test(value)) {
    throw new Error(
      `${options.label} contains unsafe characters; allowed: A-Z a-z 0-9 _ - . : @`,
    );
  }
  return value;
}

export function toScopeName(value: string): ScopeName {
  return assertSafeComponent(value, { label: 'scope name' }) as ScopeName;
}

export function toSubjectId(value: string): SubjectId {
  return assertSafeComponent(value, { label: 'subject id', maxLength: 512 }) as SubjectId;
}

export function toPolicyName(value: string): PolicyName {
  return assertSafeComponent(value, { label: 'policy name' }) as PolicyName;
}

/**
 * A resolved identity: one or more scope -> subject pairs that a request
 * belongs to. A single request usually resolves several of these at once
 * (tenant, user, api-key, global).
 */
export interface ResolvedScope {
  readonly scope: ScopeName;
  readonly subject: SubjectId;
}
