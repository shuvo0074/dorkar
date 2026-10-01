/**
 * Prints a fresh Ed25519 signing key and random secrets as env lines.
 *   pnpm --filter @dorkar/identity-service keys:generate >> services/identity-service/.env
 * In production, store these in the secret manager — never in git.
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const kid = `k-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}`;

console.log(`JWT_KEY_ID=${kid}`);
console.log(`JWT_PRIVATE_KEY=${Buffer.from(pem).toString('base64')}`);
console.log(`OTP_PEPPER=${randomBytes(32).toString('base64url')}`);
console.log(`PII_HASH_KEY=${randomBytes(32).toString('base64url')}`);
