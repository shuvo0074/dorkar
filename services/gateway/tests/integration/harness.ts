import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { exportJWK, SignJWT } from 'jose';
import { captureLogger, TEST_REDIS_URL } from '@dorkar/kernel/testing';
import { buildGateway, type GatewayOverrides, type GatewayService } from '../../src/app';
import { loadGatewayConfig, type GatewayConfig } from '../../src/config/env';

export const ORIGIN = 'https://app.dorkar.test';

export interface Upstream {
  app: FastifyInstance;
  url: string;
  calls: Array<{ method: string; url: string; headers: Record<string, unknown> }>;
  sign(
    claims?: Partial<{ sub: string; sid: string; did: string; iat: number; roles: string[] }>,
  ): Promise<string>;
}

/** A fake identity service: echoes what it receives and serves a JWKS for test tokens. */
export async function startUpstream(): Promise<Upstream> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'EdDSA', use: 'sig' };
  const calls: Upstream['calls'] = [];
  const app = Fastify();
  app.get('/.well-known/jwks.json', async () => ({ keys: [jwk] }));
  app.get('/api/v1/me/sessions', async () => {
    await new Promise((r) => setTimeout(r, 1_000)); // slower than the gateway timeout
    return { data: [] };
  });
  app.all('/api/v1/*', async (req, reply) => {
    calls.push({ method: req.method, url: req.url, headers: req.headers });
    void reply.header('access-control-allow-origin', '*').header('x-upstream', 'identity');
    return { data: { url: req.url, headers: req.headers } };
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  return {
    app,
    url,
    calls,
    async sign(c = {}) {
      return new SignJWT({
        sid: c.sid ?? randomUUID(),
        did: c.did ?? randomUUID(),
        roles: c.roles ?? ['MEMBER'],
      })
        .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
        .setSubject(c.sub ?? randomUUID())
        .setIssuer('dorkar-identity')
        .setAudience('dorkar-api')
        .setIssuedAt(c.iat ?? Math.floor(Date.now() / 1000))
        .setExpirationTime('10m')
        .sign(privateKey);
    },
  };
}

export interface Harness {
  gw: GatewayService;
  config: GatewayConfig;
  logLines: string[];
  close(): Promise<void>;
}

export async function createGateway(
  upstreamUrl: string,
  env: Record<string, string> = {},
  overrides: GatewayOverrides = {},
): Promise<Harness> {
  const config = loadGatewayConfig({
    NODE_ENV: 'test',
    REDIS_URL: TEST_REDIS_URL,
    UPSTREAM_IDENTITY_URL: upstreamUrl,
    PII_HASH_KEY: randomBytes(32).toString('hex'),
    CORS_ORIGINS: ORIGIN,
    TRUST_PROXY: '1',
    UPSTREAM_TIMEOUT_MS: '300',
    EVENTS_CONSUMER_ENABLED: 'false',
    EVENTS_GROUP: `gw-test-${randomBytes(4).toString('hex')}`,
    ...env,
  });
  const { logger, lines } = captureLogger('info');
  const gw = await buildGateway(config, logger, overrides);
  await gw.app.ready();
  return {
    gw,
    config,
    logLines: lines,
    async close() {
      await gw.close();
    },
  };
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
