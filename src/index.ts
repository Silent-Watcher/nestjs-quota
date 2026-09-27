/**
 * @module nestjs-quota
 *
 * Framework-agnostic core: policies, the quota engine, errors, windows and
 * the in-memory store. Import `nestjs-quota/nestjs` for the NestJS
 * integration and `nestjs-quota/redis` for the Redis store.
 */
export * from './core/index.js';
export { MemoryQuotaStore } from './stores/memory/memory-store.js';
export type { MemoryQuotaStoreOptions } from './stores/memory/memory-store.js';
