// Starts every backend service plus the gateway with consistent local config and labelled logs.
//   pnpm dev:backend            (run `pnpm dev:setup` once first)
//   pnpm dev:backend profile demand   → only those services (+ gateway)
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { gatewayEnv, readDevEnv, ROOT, SERVICES, serviceEnv } from './backend-services.mjs';

const dev = readDevEnv();
const only = process.argv.slice(2);
const names = only.length ? only : Object.keys(SERVICES);
const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96, 37];
const children = [];

function start(label, cwd, env, color) {
  const child = spawn('npx', ['tsx', 'watch', 'src/main.ts'], {
    cwd: resolve(ROOT, cwd),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = `\x1b[${color}m${label.padEnd(12)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = '';
    stream.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) out.write(tag + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code) => process.stderr.write(`${tag}exited (${code})\n`));
  children.push(child);
}

names.forEach((name, i) => {
  if (!SERVICES[name]) throw new Error(`unknown service ${name}`);
  start(name, SERVICES[name].dir, serviceEnv(name, dev), colors[i % colors.length]);
});
start('gateway', 'services/gateway', gatewayEnv(dev), 97);

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
