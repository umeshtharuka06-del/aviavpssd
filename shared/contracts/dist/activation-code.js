/**
 * Public activation-code format (not secret — security comes from 100 bits of randomness
 * and server-side hashing, not from hiding the format).
 *
 *   AVX-XXXX-XXXX-XXXX-XXXX-XXXX   (20 Crockford base32 characters = 100 bits)
 */
export const CODE_PREFIX = 'AVX';
export const CODE_BODY_LENGTH = 20;
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY_RE = /^[0-9A-HJKMNP-TV-Z]{20}$/;
/**
 * Normalizes user input to the 20-character body, or returns null if it cannot be a code.
 * Accepts lower case, spaces, dashes, the optional AVX prefix, and Crockford look-alikes
 * (O→0, I/L→1).
 */
export function normalizeActivationCode(input) {
    let s = input.toUpperCase().replace(/[\s-]/g, '');
    if (s.startsWith(CODE_PREFIX) && s.length === CODE_PREFIX.length + CODE_BODY_LENGTH) {
        s = s.slice(CODE_PREFIX.length);
    }
    s = s.replace(/O/g, '0').replace(/[IL]/g, '1');
    return BODY_RE.test(s) ? s : null;
}
/** Formats a normalized 20-char body as AVX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export function formatActivationCode(body) {
    const groups = body.match(/.{1,4}/g) ?? [];
    return [CODE_PREFIX, ...groups].join('-');
}
