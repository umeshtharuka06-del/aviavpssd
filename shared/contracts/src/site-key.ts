import { SiteIdSchema } from './common.js';

/*
 * Canonical site key: the ONE definition of how a website becomes a `siteId`.
 * The extension derives the key of the top-level page with it; the server derives the keys of
 * administrator-listed domains (ACCEPTED_SITE_DOMAINS) with it. Both sides therefore agree on
 * the key without the server having to trust how a browser built it — the server still only
 * accepts keys its own policy lists.
 */

/**
 * Names for a few operators, by exact registrable domain. Mirror domains get their own key.
 * Keys match the server's historical ACCEPTED_SITE_IDS so existing configs keep working.
 */
export const KNOWN_SITES: Readonly<Record<string, { siteKey: string; label: string }>> = {
  '1xbet.com': { siteKey: 'onexbet', label: '1xBet' },
  'melbet.com': { siteKey: 'melbet', label: 'MelBet' },
  '888starz.bet': { siteKey: 'starz888', label: '888starz' },
};

const SECOND_LEVEL = /^(co|com|net|org|gov|edu|ac|or|ne)\.[a-z]{2}$/;

/** Approximate registrable domain ("www.games.1xbet.co.uk" → "1xbet.co.uk"). */
export function registrableDomain(hostname: string): string {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host; // IP address
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return SECOND_LEVEL.test(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

export interface CanonicalSite {
  /** ^[a-z0-9_-]{1,32}$ — the siteId sent to and accepted by the server. */
  siteKey: string;
  label: string;
  /** A name we recognise. Only a label — it does NOT mean the site is verified. */
  known: boolean;
}

/** Canonical key of a hostname ("www.1xlite-2781.pro" → "1xlite-2781-pro"). */
export function canonicalSite(hostname: string): CanonicalSite {
  const reg = registrableDomain(hostname);
  const known = KNOWN_SITES[reg];
  if (known) return { ...known, known: true };
  const key = reg.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'unknown';
  return { siteKey: key, label: reg, known: false };
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/**
 * Site key for a domain an administrator typed into server configuration. Accepts a bare
 * hostname only (no scheme, port, path or wildcard) so a config typo cannot widen the policy.
 * Returns null when the value is not a plain hostname.
 */
export function siteKeyForConfiguredDomain(domain: string): string | null {
  const host = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!HOSTNAME.test(host)) return null;
  const { siteKey } = canonicalSite(host);
  return SiteIdSchema.safeParse(siteKey).success && siteKey !== 'unknown' ? siteKey : null;
}
