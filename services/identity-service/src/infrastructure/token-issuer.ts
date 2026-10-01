import {
  createLocalJWKSet,
  exportJWK,
  importPKCS8,
  SignJWT,
  type JWK,
  type JSONWebKeySet,
} from 'jose';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { createJwtVerifier, uuidv7, type AccessTokenVerifier } from '@dorkar/kernel';
import type { AccessTokenClaimsInput, Clock, TokenIssuer } from '../application/ports';

export interface SigningKeyConfig {
  privateKeyPem: string;
  keyId: string;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  /** Public JWKs of keys being rotated out, still accepted for verification. */
  previousPublicJwks: JWK[];
}

/**
 * Ed25519 (EdDSA) access tokens. Other services verify them offline with the JWKS this service
 * publishes; rotation = add new key, keep the old one in `previousPublicJwks` for one TTL.
 */
export class JoseTokenService implements TokenIssuer {
  private constructor(
    private readonly cfg: SigningKeyConfig,
    private readonly clock: Clock,
    private readonly privateKey: Awaited<ReturnType<typeof importPKCS8>>,
    readonly jwks: JSONWebKeySet,
  ) {}

  static async create(cfg: SigningKeyConfig, clock: Clock): Promise<JoseTokenService> {
    const privateKey = await importPKCS8(cfg.privateKeyPem, 'EdDSA', { extractable: false });
    const publicKey: KeyObject = createPublicKey(cfg.privateKeyPem);
    const current = { ...(await exportJWK(publicKey)), kid: cfg.keyId, alg: 'EdDSA', use: 'sig' };
    return new JoseTokenService(cfg, clock, privateKey, {
      keys: [current, ...cfg.previousPublicJwks],
    });
  }

  async issueAccessToken(c: AccessTokenClaimsInput): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(this.clock.now().getTime() / 1000);
    const exp = iat + this.cfg.accessTokenTtlSeconds;
    const token = await new SignJWT({ sid: c.sessionId, did: c.deviceId, roles: c.roles })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.cfg.keyId, typ: 'at+jwt' })
      .setSubject(c.accountId)
      .setIssuer(this.cfg.issuer)
      .setAudience(this.cfg.audience)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .setJti(uuidv7())
      .sign(this.privateKey);
    return { token, expiresAt: new Date(exp * 1000) };
  }

  verifier(): AccessTokenVerifier {
    return createJwtVerifier({
      key: createLocalJWKSet(this.jwks),
      issuer: this.cfg.issuer,
      audience: this.cfg.audience,
    });
  }
}
