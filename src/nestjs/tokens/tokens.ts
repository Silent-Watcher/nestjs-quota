/** Injection token for the resolved `QuotaModuleOptions`. */
export const QUOTA_MODULE_OPTIONS = Symbol('QUOTA_MODULE_OPTIONS');

/** Injection token for the shared `QuotaEngine` instance. */
export const QUOTA_ENGINE = Symbol('QUOTA_ENGINE');

/** Reflector metadata key describing the quota policies applied to a route. */
export const QUOTA_METADATA_KEY = Symbol('QUOTA_METADATA_KEY');

/** Reflector metadata key marking a route as exempt from quota enforcement. */
export const SKIP_QUOTA_METADATA_KEY = Symbol('SKIP_QUOTA_METADATA_KEY');
