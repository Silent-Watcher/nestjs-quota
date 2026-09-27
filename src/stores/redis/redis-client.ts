/**
 * The minimal subset of a Redis client this store depends on. Deliberately
 * shaped to match `ioredis`'s `eval`/`get`/`del` signatures structurally, so
 * an `ioredis` instance satisfies this interface without any adapter code,
 * while the core store code never imports `ioredis` itself (it stays an
 * optional peer dependency).
 */
export interface RedisLikeClient {
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: Array<string | number>
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}
