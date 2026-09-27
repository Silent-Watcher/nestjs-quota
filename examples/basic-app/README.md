# Example: multi-tenant API with quota enforcement

A minimal NestJS app demonstrating the real public API of
`nestjs-quota`:

- tenant + user + API-key identity, resolved from an (fake, in-memory)
  auth layer
- a free plan (10 requests/minute) and a pro plan (100 requests/minute),
  resolved dynamically per tenant
- a separate tenant-wide daily quota, enforced together with the per-user
  minute quota on the same route
- usage inspection endpoint
- a route that deliberately demonstrates a 429 once the quota is exhausted
- an environment variable to switch from the in-memory store to Redis

## Run it

```bash
# from the repo root
npm install
npm run build

cd examples/basic-app
npm install
npm run start
```

By default it uses `MemoryQuotaStore`. To use Redis instead:

```bash
docker run --rm -p 6379:6379 redis:7
REDIS_URL=redis://localhost:6379 npm run start
```

## Try it

```bash
# Simulate the "free" tenant (10 req/min limit) - api key selects the tenant/plan
for i in $(seq 1 12); do
  curl -s -H "x-api-key: free-tenant-key" http://localhost:3000/widgets | python3 -m json.tool
done
# The 11th and 12th requests return 429.

# Check usage without consuming it
curl -s -H "x-api-key: free-tenant-key" http://localhost:3000/widgets/usage | python3 -m json.tool

# The "pro" tenant has a much higher limit
for i in $(seq 1 12); do
  curl -s -H "x-api-key: pro-tenant-key" http://localhost:3000/widgets
done
# All 12 succeed (pro limit is 100/min).
```
