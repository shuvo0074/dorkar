import { randomUUID } from 'node:crypto';
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PushMessage, PushTarget } from '../../src/domain/push';
import {
  FcmPushProvider,
  parseServiceAccount,
  type ServiceAccount,
} from '../../src/infrastructure/push/fcm-push-provider';

const TOKEN_URI = 'https://oauth2.example.test/token';
let sa: ServiceAccount;
let publicPem: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  sa = {
    project_id: 'dorkar-test',
    client_email: 'push@dorkar-test.iam.gserviceaccount.com',
    private_key: await exportPKCS8(privateKey),
    token_uri: TOKEN_URI,
  };
  publicPem = await exportSPKI(publicKey);
});

interface Call {
  url: string;
  init: RequestInit;
}

/** Scripted fetch: token endpoint and FCM send replies. */
function fakeFetch(opts: { send?: () => Response; token?: () => Response } = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url instanceof Request ? url.url : url.toString();
    calls.push({ url: u, init: init ?? {} });
    if (u === TOKEN_URI) {
      tokens++;
      return (
        opts.token?.() ??
        Response.json({ access_token: `access-${tokens}`, expires_in: 3600, token_type: 'Bearer' })
      );
    }
    return opts.send?.() ?? Response.json({ name: 'projects/dorkar-test/messages/1' });
  }) as typeof fetch;
  return {
    fn,
    calls,
    tokenCalls: () => calls.filter((c) => c.url === TOKEN_URI),
    sendCalls: () => calls.filter((c) => c.url !== TOKEN_URI),
  };
}

const fcmError = (status: number, code: string, errorCode?: string) =>
  Response.json(
    {
      error: {
        code: status,
        message: 'x',
        status: code,
        details: errorCode
          ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }]
          : [],
      },
    },
    { status },
  );

const device = (platform: PushTarget['platform'] = 'ANDROID'): PushTarget => ({
  id: randomUUID(),
  platform,
  token: `tok-${randomUUID()}`,
});
const message: PushMessage = {
  notificationId: randomUUID(),
  type: 'BID_PLACED',
  title: 'New bid on your auction',
  body: 'Someone placed a new bid on your auction.',
  path: `/auctions/${randomUUID()}`,
};

const provider = (f: ReturnType<typeof fakeFetch>, now: () => number = Date.now) =>
  new FcmPushProvider({
    serviceAccount: sa,
    publicBaseUrl: 'https://dorkar.com.bd',
    fetch: f.fn,
    now,
  });

describe('FcmPushProvider', () => {
  it('exchanges a signed RS256 assertion for an access token and sends via HTTP v1', async () => {
    const f = fakeFetch();
    const d = device();
    expect(await provider(f).send(d, message)).toEqual({ ok: true });

    const [tokenCall] = f.tokenCalls();
    const form = new URLSearchParams(tokenCall!.init.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const { payload, protectedHeader } = await jwtVerify(
      form.get('assertion')!,
      await importSPKI(publicPem, 'RS256'),
      { issuer: sa.client_email, audience: TOKEN_URI },
    );
    expect(protectedHeader.alg).toBe('RS256');
    expect(payload['scope']).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(payload.exp! - payload.iat!).toBe(3600);

    const [send] = f.sendCalls();
    expect(send!.url).toBe('https://fcm.googleapis.com/v1/projects/dorkar-test/messages:send');
    expect((send!.init.headers as Record<string, string>)['authorization']).toBe('Bearer access-1');
    const body = JSON.parse(send!.init.body as string);
    expect(body.message).toMatchObject({
      token: d.token,
      notification: { title: message.title, body: message.body },
      data: { notificationId: message.notificationId, type: 'BID_PLACED', path: message.path },
      android: { notification: { tag: message.notificationId } },
    });
  });

  it('caches the access token until shortly before expiry, then refreshes', async () => {
    let now = Date.now();
    const f = fakeFetch();
    const p = provider(f, () => now);
    await p.send(device(), message);
    await p.send(device(), message);
    await Promise.all([p.send(device(), message), p.send(device(), message)]);
    expect(f.tokenCalls()).toHaveLength(1);

    now += 3_600_000 - 30_000; // inside the refresh margin
    await p.send(device(), message);
    expect(f.tokenCalls()).toHaveLength(2);
    const last = f.sendCalls().at(-1)!;
    expect((last.init.headers as Record<string, string>)['authorization']).toBe('Bearer access-2');
  });

  it('single-flights concurrent token exchanges', async () => {
    const f = fakeFetch();
    const p = provider(f);
    await Promise.all(Array.from({ length: 5 }, () => p.send(device(), message)));
    expect(f.tokenCalls()).toHaveLength(1);
    expect(f.sendCalls()).toHaveLength(5);
  });

  it('reports UNREGISTERED and INVALID_ARGUMENT tokens as invalid (device gets deactivated)', async () => {
    expect(
      await provider(fakeFetch({ send: () => fcmError(404, 'NOT_FOUND', 'UNREGISTERED') })).send(
        device(),
        message,
      ),
    ).toEqual({ invalidToken: true });
    expect(
      await provider(
        fakeFetch({ send: () => fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT') }),
      ).send(device(), message),
    ).toEqual({ invalidToken: true });
    expect(
      await provider(fakeFetch({ send: () => fcmError(400, 'INVALID_ARGUMENT') })).send(
        device(),
        message,
      ),
    ).toEqual({ invalidToken: true });
  });

  it('treats quota, server and network errors as retryable', async () => {
    expect(
      await provider(
        fakeFetch({ send: () => fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED') }),
      ).send(device(), message),
    ).toMatchObject({ retryable: true, error: 'FCM_429_QUOTA_EXCEEDED' });
    expect(
      await provider(fakeFetch({ send: () => new Response('oops', { status: 503 }) })).send(
        device(),
        message,
      ),
    ).toMatchObject({ retryable: true, error: 'FCM_503' });
    const down = fakeFetch({
      send: () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(await provider(down).send(device(), message)).toMatchObject({ retryable: true });
  });

  it('re-authenticates after a 401 and is retryable when the token exchange fails', async () => {
    let first = true;
    const f = fakeFetch({
      send: () => {
        if (first) {
          first = false;
          return fcmError(401, 'UNAUTHENTICATED');
        }
        return Response.json({ name: 'ok' });
      },
    });
    const p = provider(f);
    expect(await p.send(device(), message)).toMatchObject({ retryable: true });
    expect(await p.send(device(), message)).toEqual({ ok: true });
    expect(f.tokenCalls()).toHaveLength(2);

    const noToken = fakeFetch({ token: () => new Response('denied', { status: 400 }) });
    expect(await provider(noToken).send(device(), message)).toMatchObject({ retryable: true });
    expect(noToken.sendCalls()).toHaveLength(0);
  });

  it('shapes iOS and web messages for their platforms', async () => {
    const f = fakeFetch();
    const p = provider(f);
    await p.send(device('IOS'), message);
    await p.send(device('WEB'), message);
    const [ios, web] = f.sendCalls().map((c) => JSON.parse(c.init.body as string).message);
    expect(ios.apns.headers['apns-collapse-id']).toBe(message.notificationId);
    expect(web.webpush.fcm_options.link).toBe(`https://dorkar.com.bd${message.path}`);
  });

  it('parses the base64 service-account JSON and rejects malformed ones', () => {
    const b64 = Buffer.from(JSON.stringify({ ...sa, type: 'service_account' })).toString('base64');
    expect(parseServiceAccount(b64)).toMatchObject({
      project_id: 'dorkar-test',
      token_uri: TOKEN_URI,
    });
    expect(() => parseServiceAccount('not-base64-json')).toThrow();
    expect(() =>
      parseServiceAccount(Buffer.from(JSON.stringify({ project_id: 'x' })).toString('base64')),
    ).toThrow();
  });
});
