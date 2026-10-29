/**
 * The parts of a thrown error that are safe to write to the server log: the error class, the
 * PostgreSQL SQLSTATE and the schema object it names (table, column, constraint), and a short
 * message. Never SQL parameters, row values (`detail`), request bodies, headers or tokens. URLs
 * (which could carry credentials) are masked in the message.
 */
export function errorFacts(err) {
    const e = (err ?? {});
    const facts = {};
    const put = (key, v, max = 120) => {
        if (typeof v === 'string' && v)
            facts[key] = v.slice(0, max);
    };
    put('name', e.name);
    put('code', e.code, 16);
    put('table', e.table);
    put('column', e.column);
    put('constraint', e.constraint);
    put('routine', e.routine);
    if (typeof e.message === 'string')
        facts.message = e.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, 300);
    return facts;
}
export function failureCause(err) {
    const e = (err ?? {});
    const code = typeof e.code === 'string' ? e.code : '';
    // 42P01 undefined_table, 42703 undefined_column, 42883 undefined_function
    if (code === '42P01' || code === '42703' || code === '42883')
        return 'database_schema_outdated';
    // class 08 connection exceptions, 57P0x shutdown/cannot connect now, and Node socket errors
    if (code.startsWith('08') || code.startsWith('57P') || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code))
        return 'database_unavailable';
    if (e.message === 'timeout')
        return 'timeout';
    return 'internal';
}
export const FAILURE_MESSAGE = {
    database_schema_outdated: "The server's database is missing a required migration, so this request cannot be completed. The operator must run the migrate service.",
    database_unavailable: "The server cannot reach its database right now.",
    timeout: 'The calculation took longer than the server allows.',
    internal: 'An internal error occurred.',
};
