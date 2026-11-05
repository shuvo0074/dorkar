// Signs in as a demo seller through the API and offers on the need with this title.
// Prints the offer id. Usage: node e2e/seller-offer.mjs "<title>" <sms log>
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const [title, log] = process.argv.slice(2);
const API = 'http://localhost:4000/api/v1';
const call = async (path, { token, key, ...opts } = {}) => {
  const res = await fetch(API + path, {
    headers: {
      'content-type': 'application/json',
      'x-client': 'mobile',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...opts,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`);
  return body.data;
};
const phone = '01799000002';
const deviceKey = randomBytes(32).toString('base64url');
const { challengeId } = await call('/auth/request-otp', {
  method: 'POST',
  body: JSON.stringify({ phone, deviceKey }),
});
const line = readFileSync(log, 'utf8').trim().split('\n').filter((l) => l.includes(phone.slice(1))).at(-1);
const code = JSON.parse(line).text.match(/\d{6}/)[0];
const { accessToken: token } = await call('/auth/verify-otp', {
  method: 'POST',
  body: JSON.stringify({ challengeId, code, device: { key: deviceKey, platform: 'android', label: 'e2e' } }),
});
const needs = await call(`/needs?q=${encodeURIComponent(title)}&limit=5`);
const need = needs.find((n) => n.title === title);
if (!need) throw new Error(`no need titled ${title}`);
const offer = await call(`/needs/${need.id}/offers`, {
  token,
  key: randomUUID(),
  method: 'POST',
  body: JSON.stringify({
    price: { amount: 7500000, currency: 'BDT' },
    quantity: 1,
    deliveryTerms: { method: 'SELLER_DELIVERY', etaDays: 1 },
    description: 'Box and bill included',
  }),
});
console.log(offer.id);
