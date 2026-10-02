import { permissionsFor } from '@dorkar/contracts';
import { describe, expect, it } from 'vitest';
import {
  allKeys,
  assertPendingQuota,
  assertTransition,
  assertUploadAllowed,
  canRead,
  canTransition,
  checkSniffedType,
  isServableKey,
  MAX_PENDING_PER_OWNER,
  mediaIdFromUploadKey,
  MediaStatuses,
  MB,
  originalKey,
  uploadKey,
  variantKey,
  visibilityFor,
  type MediaStatus,
} from '../../src/domain/media';

const ID = '0192f0c4-0000-7000-8000-00000000abcd';
const rule = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as { details?: { rule?: string } }).details?.rule;
  }
  return null;
};

describe('upload rules', () => {
  it('accepts images for every purpose and PDFs only for verification', () => {
    for (const p of ['LISTING', 'NEED', 'OFFER', 'AVATAR', 'VERIFICATION'] as const) {
      for (const t of ['image/jpeg', 'image/png', 'image/webp'] as const) {
        expect(() => assertUploadAllowed(p, t, 1000)).not.toThrow();
      }
    }
    expect(() => assertUploadAllowed('VERIFICATION', 'application/pdf', 1000)).not.toThrow();
    expect(rule(() => assertUploadAllowed('LISTING', 'application/pdf', 1000))).toBe(
      'TYPE_NOT_ALLOWED',
    );
  });

  it('caps images at 10 MB and PDFs at 5 MB', () => {
    expect(() => assertUploadAllowed('NEED', 'image/png', 10 * MB)).not.toThrow();
    expect(rule(() => assertUploadAllowed('NEED', 'image/png', 10 * MB + 1))).toBe(
      'FILE_TOO_LARGE',
    );
    expect(() => assertUploadAllowed('VERIFICATION', 'application/pdf', 5 * MB)).not.toThrow();
    expect(rule(() => assertUploadAllowed('VERIFICATION', 'application/pdf', 5 * MB + 1))).toBe(
      'FILE_TOO_LARGE',
    );
  });

  it('limits pending uploads per owner', () => {
    expect(() => assertPendingQuota(MAX_PENDING_PER_OWNER - 1)).not.toThrow();
    expect(rule(() => assertPendingQuota(MAX_PENDING_PER_OWNER))).toBe('UPLOAD_LIMIT');
  });

  it('makes only verification documents private', () => {
    expect(visibilityFor('VERIFICATION')).toBe('PRIVATE');
    for (const p of ['LISTING', 'NEED', 'OFFER', 'AVATAR'] as const) {
      expect(visibilityFor(p)).toBe('PUBLIC');
    }
  });
});

describe('sniffed type check', () => {
  it('requires a known, allowed type equal to the declared one', () => {
    expect(checkSniffedType('LISTING', 'image/jpeg', 'image/jpeg')).toBeNull();
    expect(checkSniffedType('LISTING', 'image/jpeg', null)).toBe('TYPE_MISMATCH');
    expect(checkSniffedType('LISTING', 'image/jpeg', 'image/png')).toBe('TYPE_MISMATCH');
    expect(checkSniffedType('LISTING', 'image/jpeg', 'application/pdf')).toBe('TYPE_MISMATCH');
    expect(checkSniffedType('LISTING', 'image/jpeg', 'image/gif')).toBe('TYPE_MISMATCH');
    expect(checkSniffedType('VERIFICATION', 'application/pdf', 'application/pdf')).toBeNull();
  });
});

describe('state machine', () => {
  const allowed: Record<MediaStatus, MediaStatus[]> = {
    PENDING_UPLOAD: ['READY', 'REJECTED', 'DELETED'],
    READY: ['DELETED'],
    REJECTED: ['DELETED'],
    DELETED: [],
  };
  for (const from of MediaStatuses) {
    for (const to of MediaStatuses) {
      const expected = allowed[from].includes(to);
      it(`${from} → ${to}: ${expected ? 'allowed' : 'refused'}`, () => {
        expect(canTransition(from, to)).toBe(expected);
        if (expected) expect(() => assertTransition(from, to)).not.toThrow();
        else expect(() => assertTransition(from, to)).toThrow(/cannot go/);
      });
    }
  }
});

describe('read policy', () => {
  const owner = { id: 'owner', permissions: permissionsFor(['MEMBER']) };
  const stranger = { id: 'stranger', permissions: permissionsFor(['MEMBER']) };
  const admin = { id: 'admin', permissions: permissionsFor(['ADMIN']) };
  const reviewer = { id: 'reviewer', permissions: permissionsFor(['SUPER_ADMIN']) };
  const m = (status: MediaStatus, visibility: 'PUBLIC' | 'PRIVATE') => ({
    ownerId: 'owner',
    status,
    visibility,
  });

  it('shows public READY media to anyone', () => {
    expect(canRead(m('READY', 'PUBLIC'), null)).toBe(true);
    expect(canRead(m('READY', 'PUBLIC'), stranger)).toBe(true);
  });

  it('shows private media only to the owner and verification reviewers', () => {
    expect(canRead(m('READY', 'PRIVATE'), null)).toBe(false);
    expect(canRead(m('READY', 'PRIVATE'), stranger)).toBe(false);
    expect(canRead(m('READY', 'PRIVATE'), admin)).toBe(false);
    expect(canRead(m('READY', 'PRIVATE'), owner)).toBe(true);
    expect(canRead(m('READY', 'PRIVATE'), reviewer)).toBe(true);
  });

  it('hides unfinished and rejected media from everyone but the owner, and deleted from all', () => {
    for (const s of ['PENDING_UPLOAD', 'REJECTED'] as const) {
      expect(canRead(m(s, 'PUBLIC'), stranger)).toBe(false);
      expect(canRead(m(s, 'PRIVATE'), reviewer)).toBe(false);
      expect(canRead(m(s, 'PUBLIC'), owner)).toBe(true);
    }
    expect(canRead(m('DELETED', 'PUBLIC'), owner)).toBe(false);
  });
});

describe('storage keys', () => {
  it('are server-generated from the id', () => {
    expect(uploadKey(ID)).toBe(`uploads/${ID}`);
    expect(mediaIdFromUploadKey(uploadKey(ID))).toBe(ID);
    expect(mediaIdFromUploadKey(`uploads/${ID}/../x`)).toBeNull();
    expect(allKeys({ id: ID, storageKey: originalKey(ID), variants: {} }).sort()).toEqual(
      [originalKey(ID), uploadKey(ID)].sort(),
    );
  });

  it('serve only processed objects, never raw uploads or anything outside the layout', () => {
    expect(isServableKey(originalKey(ID))).toBe(true);
    expect(isServableKey(variantKey(ID, 'thumb'))).toBe(true);
    expect(isServableKey(variantKey(ID, 'medium'))).toBe(true);
    for (const bad of [
      uploadKey(ID),
      `media/${ID}/../../etc/passwd`,
      `../media/${ID}/original`,
      `media/${ID}/original.meta.json`,
      `/media/${ID}/original`,
      `media/${ID}/original/`,
      'media/x/original',
    ]) {
      expect(isServableKey(bad)).toBe(false);
    }
  });
});
