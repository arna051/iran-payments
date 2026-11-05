import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts', 'src/providers/index.ts', 'src/express.ts', 'src/nextjs.ts', 'src/nestjs.ts'],
  format: ['esm', 'cjs'], dts: true, sourcemap: true, clean: true, splitting: false,
  external: ['mongoose', 'express', 'next', 'server-only', '@nestjs/common', 'reflect-metadata'],
});
