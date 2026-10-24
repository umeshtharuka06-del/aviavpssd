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
    CUSTOMER_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
    ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
    /** Site adapter ids the API accepts history for. */
    ACCEPTED_SITE_IDS: z
        .string()
        .default('onexbet,melbet,starz888')
        .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    /** Only the clearly labelled mock provider exists in this phase. */
    ANALYSIS_PROVIDER: z.literal('mock').default('mock'),
    RETENTION_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),
    SECURITY_EVENT_RETENTION_DAYS: z.coerce.number().int().min(7).max(365).default(90),
})
    .superRefine((env, ctx) => {
    const secrets = [env.CODE_PEPPER, env.DEVICE_PEPPER, env.IP_HASH_PEPPER, env.ADMIN_SERVICE_KEY];
    if (new Set(secrets).size !== secrets.length) {
        ctx.addIssue({ code: 'custom', message: 'CODE_PEPPER, DEVICE_PEPPER, IP_HASH_PEPPER and ADMIN_SERVICE_KEY must all differ' });
    }
    if (env.NODE_ENV === 'production' && env.ACCEPTED_SITE_IDS.includes('devfixture')) {
        ctx.addIssue({ code: 'custom', message: 'the devfixture site must not be accepted in production' });
    }
});
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
