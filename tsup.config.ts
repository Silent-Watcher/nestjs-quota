import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'nestjs/index': 'src/nestjs/index.ts',
    'redis/index': 'src/stores/redis/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'node18',
  tsconfig: 'tsconfig.build.json',
  // NestJS, ioredis and rxjs are optional peer dependencies: never bundle them.
  external: ['@nestjs/common', '@nestjs/core', 'ioredis', 'reflect-metadata', 'rxjs', 'rxjs/operators'],
  outDir: 'dist',
});
