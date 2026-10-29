/**
 * Public activation-code format (not secret — security comes from 100 bits of randomness
 * and server-side hashing, not from hiding the format).
 *
 *   AVX-XXXX-XXXX-XXXX-XXXX-XXXX   (20 Crockford base32 characters = 100 bits)
 */
export declare const CODE_PREFIX = "AVX";
export declare const CODE_BODY_LENGTH = 20;
export declare const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/**
 * Normalizes user input to the 20-character body, or returns null if it cannot be a code.
 * Accepts lower case, spaces, dashes, the optional AVX prefix, and Crockford look-alikes
 * (O→0, I/L→1).
 */
export declare function normalizeActivationCode(input: string): string | null;
/** Formats a normalized 20-char body as AVX-XXXX-XXXX-XXXX-XXXX-XXXX. */
export declare function formatActivationCode(body: string): string;
