// Bundles a service (and its workspace packages) into dist/ with esbuild.
// Third-party dependencies stay external and are installed by `pnpm deploy --prod`.
import { build } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cwd = process.cwd();
const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((d) => !d.startsWith('@dorkar/'));
// Workspace packages' own third-party deps must stay external too.
for (const ws of ['kernel', 'contracts']) {
  const p = JSON.parse(readFileSync(resolve(cwd, `../../packages/${ws}/package.json`), 'utf8'));
  external.push(...Object.keys(p.dependencies ?? {}).filter((d) => !d.startsWith('@dorkar/')));
}

// Bundled code resolves externals from the service's own node_modules (and `pnpm deploy --prod`
// installs only the service's declared deps), so every external must be declared by the service.
const missing = [...new Set(external)].filter((d) => !(d in (pkg.dependencies ?? {})));
if (missing.length) {
  console.error(
    `${pkg.name} must declare these runtime dependencies used by workspace packages:\n  ${missing.join(' ')}`,
  );
  process.exit(1);
}

// main + whichever CLIs the service has, each bundled to dist/<name>.js.
const candidates = {
  main: 'src/main.ts',
  migrate: 'src/cli/migrate.ts',
  'grant-role': 'src/cli/grant-role.ts',
};
const entryPoints = Object.fromEntries(
  Object.entries(candidates).filter(([, path]) => existsSync(resolve(cwd, path))),
);

await build({
  entryPoints,
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: [...new Set(external)],
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});
