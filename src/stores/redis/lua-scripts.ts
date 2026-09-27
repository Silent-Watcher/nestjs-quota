/**
 * Atomic multi-bucket check-and-consume, with optional idempotency.
 *
 * Kept as a TS string (rather than read from disk) so it survives bundling
 * unchanged. The human-readable, commented source lives at
 * `src/stores/redis/scripts/check-and-consume.lua` and must be kept in sync.
 */
export const CHECK_AND_CONSUME_SCRIPT = `
local idemKey = ARGV[1]
local idemTtlMs = tonumber(ARGV[2])
local idemRequestHash = ARGV[3]
local nowMs = tonumber(ARGV[4])
local n = tonumber(ARGV[5])

local hasIdem = idemKey ~= ""

if hasIdem then
  local existingHash = redis.call('HGET', idemKey, 'hash')
  if existingHash then
    if existingHash ~= idemRequestHash then
      return { -1 }
    end
    local payload = redis.call('HGET', idemKey, 'payload')
    return { 2, payload }
  end
end

local used = {}
local limits = {}
local costs = {}
local ttls = {}
local allowed = true

for i = 1, n do
  local base = 6 + (i - 1) * 3
  limits[i] = tonumber(ARGV[base])
  costs[i] = tonumber(ARGV[base + 1])
  ttls[i] = tonumber(ARGV[base + 2])

  local key = KEYS[i]
  local current = tonumber(redis.call('GET', key))
  if current == nil then
    current = 0
  end
  used[i] = current
  if costs[i] > limits[i] or (current + costs[i]) > limits[i] then
    allowed = false
  end
end

if allowed then
  for i = 1, n do
    local key = KEYS[i]
    local newVal = redis.call('INCRBY', key, costs[i])
    if tonumber(newVal) == costs[i] then
      redis.call('PEXPIRE', key, ttls[i])
    end
    used[i] = newVal
  end
end

if hasIdem then
  local payloadParts = {}
  for i = 1, n do
    payloadParts[i] = tostring(used[i])
  end
  local payload = table.concat(payloadParts, ',')
  redis.call('HSET', idemKey, 'hash', idemRequestHash, 'payload', payload)
  redis.call('PEXPIRE', idemKey, idemTtlMs)
end

local result = {}
if allowed then
  result[1] = 1
else
  result[1] = 0
end
result[2] = 0
for i = 1, n do
  result[2 + i] = used[i]
end
return result
`;

/**
 * Reservation: hold capacity in a bucket and record a reservation hash
 * entry with a lease TTL, atomically.
 */
export const RESERVE_SCRIPT = `
local bucketKey = KEYS[1]
local reservationKey = KEYS[2]
local limit = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local bucketTtlMs = tonumber(ARGV[3])
local leaseMs = tonumber(ARGV[4])
local reservationId = ARGV[5]
local nowMs = tonumber(ARGV[6])
local policy = ARGV[7]
local scope = ARGV[8]
local subject = ARGV[9]
local resetAtMs = ARGV[10]

local current = tonumber(redis.call('GET', bucketKey))
if current == nil then current = 0 end

if cost > limit or (current + cost) > limit then
  return { 0, current }
end

local newVal = redis.call('INCRBY', bucketKey, cost)
if tonumber(newVal) == cost then
  redis.call('PEXPIRE', bucketKey, bucketTtlMs)
end

redis.call('HSET', reservationKey,
  'bucketKey', bucketKey, 'cost', cost, 'status', 'pending', 'expiresAtMs', nowMs + leaseMs,
  'policy', policy, 'scope', scope, 'subject', subject, 'limit', limit, 'resetAtMs', resetAtMs)
redis.call('PEXPIRE', reservationKey, leaseMs)

return { 1, newVal }
`;

/**
 * Record post-hoc usage, clamped to `limit`, atomically.
 */
export const RECORD_USAGE_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local ttlMs = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key))
if current == nil then current = 0 end

local newVal = current + cost
if newVal > limit then newVal = limit end

local written = redis.call('SET', key, newVal, 'KEEPTTL')
-- KEEPTTL fails silently if key had no TTL (new key); ensure TTL is set.
local ttl = redis.call('PTTL', key)
if ttl == -1 then
  redis.call('PEXPIRE', key, ttlMs)
end

return { newVal }
`;

/**
 * Commit a pending reservation: mark it committed. The held capacity was
 * already applied at reserve-time, so commit does not touch the bucket.
 */
export const COMMIT_RESERVATION_SCRIPT = `
local reservationKey = KEYS[1]
local nowMs = tonumber(ARGV[1])

local status = redis.call('HGET', reservationKey, 'status')
if not status then
  return { -1 }
end
local expiresAtMs = tonumber(redis.call('HGET', reservationKey, 'expiresAtMs'))
if status == 'pending' and expiresAtMs <= nowMs then
  return { -2 }
end
if status ~= 'pending' then
  return { -1 }
end

redis.call('HSET', reservationKey, 'status', 'committed')
local bucketKey = redis.call('HGET', reservationKey, 'bucketKey')
local used = tonumber(redis.call('GET', bucketKey))
if used == nil then used = 0 end
local policy = redis.call('HGET', reservationKey, 'policy')
local scope = redis.call('HGET', reservationKey, 'scope')
local subject = redis.call('HGET', reservationKey, 'subject')
local limit = redis.call('HGET', reservationKey, 'limit')
local resetAtMs = redis.call('HGET', reservationKey, 'resetAtMs')
return { 1, used, policy, scope, subject, limit, resetAtMs }
`;

/**
 * Release a pending reservation: return its held capacity to the bucket
 * and mark it released.
 */
export const RELEASE_RESERVATION_SCRIPT = `
local reservationKey = KEYS[1]
local nowMs = tonumber(ARGV[1])

local status = redis.call('HGET', reservationKey, 'status')
if not status then
  return { -1 }
end
if status ~= 'pending' then
  return { -1 }
end

local bucketKey = redis.call('HGET', reservationKey, 'bucketKey')
local cost = tonumber(redis.call('HGET', reservationKey, 'cost'))
redis.call('HSET', reservationKey, 'status', 'released')
if bucketKey and cost then
  local newVal = redis.call('DECRBY', bucketKey, cost)
  if newVal < 0 then
    redis.call('SET', bucketKey, 0, 'KEEPTTL')
  end
end
return { 1 }
`;
