import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const temporary = mkdtempSync(join(tmpdir(), 'iran-payments-consumer-'));
let tarball;
try {
  tarball = execFileSync('npm', ['pack', '--ignore-scripts', '--silent'], {
    cwd: repository,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .at(-1);
  const absoluteTarball = join(repository, tarball);
  execFileSync('npm', ['init', '-y'], { cwd: temporary, stdio: 'ignore' });
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      absoluteTarball,
      '@nestjs/common@^11',
      'express@^5',
      'next@^15',
      'reflect-metadata@^0.2',
      'rxjs@^7',
    ],
    { cwd: temporary, stdio: 'ignore' },
  );
  writeFileSync(
    join(temporary, 'esm.mjs'),
    "import { createPaymentGateways, createBuiltInAdapters } from 'iran-payments';\nimport * as providers from 'iran-payments/providers';\nimport * as express from 'iran-payments/express';\nimport * as nextjs from 'iran-payments/nextjs';\nimport * as nestjs from 'iran-payments/nestjs';\nif (typeof createPaymentGateways !== 'function' || createBuiltInAdapters().length !== 6 || typeof providers.ZarinpalAdapter !== 'function' || typeof express.paymentCallbackHandler !== 'function' || typeof nextjs.createNextCallbackHandler !== 'function' || typeof nestjs.PaymentGatewaysModule !== 'function') process.exit(1);\n",
  );
  writeFileSync(
    join(temporary, 'cjs.cjs'),
    "const pkg = require('iran-payments');\nconst providers = require('iran-payments/providers');\nconst express = require('iran-payments/express');\nconst nextjs = require('iran-payments/nextjs');\nconst nestjs = require('iran-payments/nestjs');\nif (typeof pkg.createPaymentGateways !== 'function' || pkg.createBuiltInAdapters().length !== 6 || typeof providers.ZarinpalAdapter !== 'function' || typeof express.paymentCallbackHandler !== 'function' || typeof nextjs.createNextCallbackHandler !== 'function' || typeof nestjs.PaymentGatewaysModule !== 'function') process.exit(1);\n",
  );
  writeFileSync(
    join(temporary, 'types.ts'),
    "import type { AvailableGateway, GatewayPresentation } from 'iran-payments';\nimport type { NestPaymentGatewaysOptions } from 'iran-payments/nestjs';\nconst presentation: GatewayPresentation = { title: 'پرداخت', sortOrder: 1 };\nconst available = {} as AvailableGateway;\nconst options = {} as NestPaymentGatewaysOptions;\nvoid [presentation, available, options];\n",
  );
  writeFileSync(
    join(temporary, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        skipLibCheck: true,
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        noEmit: true,
      },
      include: ['types.ts'],
    }),
  );
  execFileSync(process.execPath, ['esm.mjs'], { cwd: temporary, stdio: 'inherit' });
  execFileSync(process.execPath, ['cjs.cjs'], { cwd: temporary, stdio: 'inherit' });
  execFileSync(
    process.execPath,
    [join(repository, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: temporary, stdio: 'inherit' },
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
  if (tarball) rmSync(join(repository, tarball), { force: true });
}
