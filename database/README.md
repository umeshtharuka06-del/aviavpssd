# Database (PostgreSQL)

* `migrations/` holds ordered SQL files and is the **source of truth**. They are applied by `npm run db -w @aviator/backend -- migrate` (locally) or by the `migrate` container (VPS). Applied files are checksummed: if one is edited after it ran, the runner refuses to continue, so add a new file instead.
* `schema/` has the table overview.
* `retention/` has the retention rules for each table.

All timestamps are `timestamptz` in UTC, and every session runs with `TimeZone=UTC`.
