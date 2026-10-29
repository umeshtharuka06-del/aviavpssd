/**
 * The parts of a thrown error that are safe to write to the server log: the error class, the
 * PostgreSQL SQLSTATE and the schema object it names (table, column, constraint), and a short
 * message. Never SQL parameters, row values (`detail`), request bodies, headers or tokens. URLs
 * (which could carry credentials) are masked in the message.
 */
export function errorFacts(err: unknown): Record<string, string> {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; code?: unknown; table?: unknown; column?: unknown; constraint?: unknown; routine?: unknown };
  const facts: Record<string, string> = {};
  const put = (key: string, v: unknown, max = 120) => {
    if (typeof v === 'string' && v) facts[key] = v.slice(0, max);
  };
  put('name', e.name);
  put('code', e.code, 16);
  put('table', e.table);
  put('column', e.column);
  put('constraint', e.constraint);
  put('routine', e.routine);
  if (typeof e.message === 'string') facts.message = e.message.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').slice(0, 300);
  return facts;
}

/**
 * Why a request failed, as a fixed category that is safe to return to the client (it names no
 * table, column, value or host). The panel turns it into an exact explanation instead of the
 * generic "temporarily unavailable".
 *   database_schema_outdated  the code uses a table/column the database lacks (a migration has not run)
 *   database_unavailable      PostgreSQL could not be reached or refused the connection
 *   timeout                   the calculation did not finish within the time limit
 *   internal                  anything else (details only in the server log)
 */
export type FailureCause = 'database_schema_outdated' | 'database_unavailable' | 'timeout' | 'internal';

export function failureCause(err: unknown): FailureCause {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  // 42P01 undefined_table, 42703 undefined_column, 42883 undefined_function
  if (code === '42P01' || code === '42703' || code === '42883') return 'database_schema_outdated';
  // class 08 connection exceptions, 57P0x shutdown/cannot connect now, and Node socket errors
  if (code.startsWith('08') || code.startsWith('57P') || ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) return 'database_unavailable';
  if (e.message === 'timeout') return 'timeout';
  return 'internal';
}

export const FAILURE_MESSAGE: Record<FailureCause, string> = {
  database_schema_outdated: "The server's database is missing a required migration, so this request cannot be completed. The operator must run the migrate service.",
  database_unavailable: "The server cannot reach its database right now.",
  timeout: 'The calculation took longer than the server allows.',
  internal: 'An internal error occurred.',
};
