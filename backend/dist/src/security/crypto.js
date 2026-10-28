import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { CROCKFORD_ALPHABET } from '@aviator/contracts';
/** Keyed hash for values that must be looked up but never stored in plaintext. */
export function hmacSha256(pepper, value) {
    return createHmac('sha256', pepper).update(value, 'utf8').digest();
}
/** Plain SHA-256 for high-entropy random tokens (sessions). */
export function sha256(value) {
    return createHash('sha256').update(value, 'utf8').digest();
}
/** Opaque bearer token: 32 random bytes, base64url (43 chars). */
export function newToken() {
    return randomBytes(32).toString('base64url');
}
/**
 * Uniform random Crockford base32 string from a CSPRNG.
 * 256 is a multiple of 32, so `byte & 31` has no modulo bias.
 */
export function randomBase32(length) {
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++)
        out += CROCKFORD_ALPHABET[bytes[i] & 31];
    return out;
}
export function constantTimeEquals(a, b) {
    // Compare fixed-length digests so the comparison time does not leak the length.
    return timingSafeEqual(sha256(a), sha256(b));
}
