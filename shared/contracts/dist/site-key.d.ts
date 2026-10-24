/**
 * Names for a few operators, by exact registrable domain. Mirror domains get their own key.
 * Keys match the server's historical ACCEPTED_SITE_IDS so existing configs keep working.
 */
export declare const KNOWN_SITES: Readonly<Record<string, {
    siteKey: string;
    label: string;
}>>;
/** Approximate registrable domain ("www.games.1xbet.co.uk" → "1xbet.co.uk"). */
export declare function registrableDomain(hostname: string): string;
export interface CanonicalSite {
    /** ^[a-z0-9_-]{1,32}$ — the siteId sent to and accepted by the server. */
    siteKey: string;
    label: string;
    /** A name we recognise. Only a label — it does NOT mean the site is verified. */
    known: boolean;
}
/** Canonical key of a hostname ("www.1xlite-2781.pro" → "1xlite-2781-pro"). */
export declare function canonicalSite(hostname: string): CanonicalSite;
/**
 * Site key for a domain an administrator typed into server configuration. Accepts a bare
 * hostname only (no scheme, port, path or wildcard) so a config typo cannot widen the policy.
 * Returns null when the value is not a plain hostname.
 */
export declare function siteKeyForConfiguredDomain(domain: string): string | null;
