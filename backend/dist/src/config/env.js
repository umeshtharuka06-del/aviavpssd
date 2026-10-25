import { DEFAULT_DEVICE_LIMIT, MAX_DEVICE_LIMIT, SiteIdSchema, siteKeyForConfiguredDomain } from '@aviator/contracts';
import { z } from 'zod';
/**
 * Server-only configuration. Every value comes from the environment of the VPS process
 * (docker compose `env_file`, never baked into images or committed). Nothing here is ever
 * returned by the API.
 */
const secret = (name) => z
    .string({ error: `${name} is required` })
    .min(32, `${name} must be at least 32 characters`)
    .refine((v) => !/^(change-?me|placeholder|x+)/i.test(v), `${name} still has a placeholder value`);
const EnvSchema = z
    .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Fastify trustProxy: "false", "true", a hop count, or comma-separated IPs/CIDRs of the reverse proxy. */
    TRUST_PROXY: z.string().default('false'),
    DATABASE_URL: z.string().url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
    CODE_PEPPER: secret('CODE_PEPPER'),
    DEVICE_PEPPER: secret('DEVICE_PEPPER'),
    IP_HASH_PEPPER: secret('IP_HASH_PEPPER'),
    ADMIN_SERVICE_KEY: secret('ADMIN_SERVICE_KEY'),
    /** Device limit for NEW codes when the admin does not choose one (1–5, default 5). */
    DEFAULT_DEVICE_LIMIT: z.coerce.number().int().min(1).max(MAX_DEVICE_LIMIT).default(DEFAULT_DEVICE_LIMIT),
    CUSTOMER_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
    ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
    /**
     * Site keys the API accepts history for. "*" accepts any well-formed key (sites found by the
     * extension's generic detection); in production "devfixture" is always refused.
     */
    ACCEPTED_SITE_IDS: z
        .string()
        .default('onexbet,melbet,starz888')
        .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    /**
     * Websites (plain hostnames, e.g. "1xlite-2781.pro") the API accepts history for. Each is
     * turned into its site key with the SAME canonical function the extension uses, so the
     * administrator lists the domain shown in the browser instead of hand-deriving a key.
     * No wildcards: every website is added explicitly.
     */
    ACCEPTED_SITE_DOMAINS: z
        .string()
        .default('')
        .transform((v) => v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)),
    /** Which analysis provider to use: "mock" (test data) or "statistical" (real descriptive stats). */
    ANALYSIS_PROVIDER: z.enum(['mock', 'statistical']).default('mock'),
    RETENTION_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(90),
})
    .superRefine((env, ctx) => {
    const secrets = [env.CODE_PEPPER, env.DEVICE_PEPPER, env.IP_HASH_PEPPER, env.ADMIN_SERVICE_KEY];
    if (new Set(secrets).size !== secrets.length) {
        ctx.addIssue({ code: 'custom', message: 'CODE_PEPPER, DEVICE_PEPPER, IP_HASH_PEPPER and ADMIN_SERVICE_KEY must all differ' });
    }
    for (const id of env.ACCEPTED_SITE_IDS) {
        if (id !== '*' && !SiteIdSchema.safeParse(id).success) {
            ctx.addIssue({ code: 'custom', path: ['ACCEPTED_SITE_IDS'], message: `"${id}" is not a valid site key (lowercase a-z, 0-9, _ or -, at most 32)` });
        }
    }
    for (const domain of env.ACCEPTED_SITE_DOMAINS) {
        if (!siteKeyForConfiguredDomain(domain)) {
            ctx.addIssue({ code: 'custom', path: ['ACCEPTED_SITE_DOMAINS'], message: `"${domain}" is not a plain hostname (no scheme, port, path or wildcard)` });
        }
    }
    if (env.NODE_ENV === 'production' && env.ACCEPTED_SITE_IDS.includes('devfixture')) {
        ctx.addIssue({ code: 'custom', message: 'the devfixture site must not be accepted in production' });
    }
});
/** Site keys accepted by server policy: ACCEPTED_SITE_IDS plus the keys of ACCEPTED_SITE_DOMAINS. */
export function acceptedSiteKeys(env) {
    const keys = new Set(env.ACCEPTED_SITE_IDS);
    for (const d of env.ACCEPTED_SITE_DOMAINS ?? []) {
        const key = siteKeyForConfiguredDomain(d);
        if (key)
            keys.add(key);
    }
    return keys;
}
/**
 * Is history/analysis accepted for this site key? The key comes from the browser, so it is only
 * a claim: it is accepted solely when the server's own policy lists it.
 */
export function isSiteAccepted(env, siteId) {
    if (!SiteIdSchema.safeParse(siteId).success)
        return false;
    if (env.NODE_ENV === 'production' && siteId === 'devfixture')
        return false;
    const keys = acceptedSiteKeys(env);
    return keys.has(siteId) || keys.has('*');
}
export function loadEnv(source = process.env) {
    const parsed = EnvSchema.safeParse(source);
    if (!parsed.success) {
        // Report variable names and rules only — never the values.
        const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
        throw new Error(`Invalid backend configuration:\n${problems.join('\n')}`);
    }
    return parsed.data;
}
export function parseTrustProxy(value) {
    if (value === 'true')
        return true;
    if (value === 'false' || value === '')
        return false;
    if (/^\d+$/.test(value))
        return Number(value);
    return value.split(',').map((s) => s.trim());
}
