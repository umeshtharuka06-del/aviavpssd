import { formatActivationCode, normalizeActivationCode } from '@aviator/contracts';
import { describe, expect, it } from 'vitest';
import { generateCode, hashCode, hashCodeInput } from '../src/activation/codes.js';
import { computeExpiry } from '../src/subscriptions/subscription.js';

const PEPPER = 'unit-test-pepper-0123456789abcdef0123456789';

describe('activation code generation', () => {
  it('produces AVX-XXXX-XXXX-XXXX-XXXX-XXXX with a Crockford base32 body', () => {
    const c = generateCode(PEPPER);
    expect(c.plaintext).toMatch(/^AVX(-[0-9A-HJKMNP-TV-Z]{4}){5}$/);
    expect(c.publicId).toMatch(/^ac_[0-9A-Z]{16}$/);
    expect(c.hint).toBe(c.plaintext.slice(-4));
  });

  it('does not repeat across many generations (CSPRNG, 100-bit codes)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(generateCode(PEPPER).plaintext);
    expect(seen.size).toBe(5000);
  });

  it('uses every alphabet symbol (no stuck bits)', () => {
    const chars = new Set<string>();
    for (let i = 0; i < 300; i++) for (const ch of generateCode(PEPPER).plaintext.slice(4).replace(/-/g, '')) chars.add(ch);
    expect(chars.size).toBe(32);
  });
});

describe('activation code hashing', () => {
  it('stores a 32-byte HMAC that is not the plaintext and depends on the pepper', () => {
    const c = generateCode(PEPPER);
    expect(c.hash).toHaveLength(32);
    expect(c.hash.toString('utf8')).not.toContain(c.plaintext);
    const body = normalizeActivationCode(c.plaintext)!;
    expect(hashCode(PEPPER, body).equals(c.hash)).toBe(true);
    expect(hashCode(PEPPER + 'x', body).equals(c.hash)).toBe(false);
  });

  it('hashes equivalent user input identically (case, spaces, dashes, look-alikes, prefix)', () => {
    const c = generateCode(PEPPER);
    const body = normalizeActivationCode(c.plaintext)!;
    const variants = [c.plaintext, c.plaintext.toLowerCase(), body, ` ${body.match(/.{4}/g)!.join(' ')} `];
    for (const v of variants) expect(hashCodeInput(PEPPER, v)!.equals(c.hash)).toBe(true);
    expect(normalizeActivationCode('AVX-0000-1111-2222-3333-4444')).toBe('00001111222233334444');
    expect(normalizeActivationCode('avx-oooo-iiii-llll-3333-4444')).toBe('00001111111133334444');
  });

  it('rejects malformed input without hashing', () => {
    expect(hashCodeInput(PEPPER, 'not a code')).toBeNull();
    expect(hashCodeInput(PEPPER, 'AVX-0000-1111-2222-3333-444')).toBeNull(); // 19 chars
    expect(hashCodeInput(PEPPER, 'AVX-0000-1111-2222-3333-444U')).toBeNull(); // U not in alphabet
    expect(formatActivationCode('00001111222233334444')).toBe('AVX-0000-1111-2222-3333-4444');
  });
});

describe('subscription expiry', () => {
  const t0 = new Date('2026-03-28T22:15:00.000Z'); // spans a European DST change: must not matter (UTC)
  it('30-day plan ends exactly 30×24 h after activation', () => {
    expect(computeExpiry('30d', t0).toISOString()).toBe('2026-04-27T22:15:00.000Z');
  });
  it('365-day plan ends exactly 365×24 h after activation', () => {
    expect(computeExpiry('365d', t0).toISOString()).toBe('2027-03-28T22:15:00.000Z');
  });
});
