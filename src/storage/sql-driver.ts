/**
 * SQLite driver abstraction.
 *
 * opencode's bundled Bun runtime does NOT implement `node:sqlite`
 * (verified empirically on 1.18.18: "No such built-in module"), but it does
 * ship `bun:sqlite`. The Node CLI has stable `node:sqlite` (>= 23.4).
 *
 * Both are wrapped behind one small interface; the correct driver is selected
 * at module load:
 *   - inside opencode (Bun)   -> bun:sqlite
 *   - CLI (Node)              -> node:sqlite
 *
 * Notes verified empirically against opencode 1.18.18's bundled Bun:
 *  - `new Database(path, { readonly: true })` throws
 *    ("flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE")
 *  - the string flag form `"r"` / `"rw"` works, but `"r"` does NOT enforce
 *    read-only semantics — so read-only is enforced in-process here.
 */

export interface SqlStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
  get(...params: unknown[]): Record<string, unknown> | undefined
  all(...params: unknown[]): Record<string, unknown>[]
}

export interface SqlDatabase {
  readonly isOpen: boolean
  /** Enforced in-process when the underlying driver cannot enforce it. */
  readonly readOnly: boolean
  exec(sql: string): void
  prepare(sql: string): SqlStatement
  close(): void
}

let bunDatabase: (typeof import("bun:sqlite"))["Database"] | null = null
let nodeDatabase: (typeof import("node:sqlite"))["DatabaseSync"] | null = null

const isBun = typeof Bun !== "undefined"

if (isBun) {
  const mod = await import("bun:sqlite")
  bunDatabase = mod.Database
} else {
  const mod = await import("node:sqlite")
  nodeDatabase = mod.DatabaseSync
}

function makeStatement(
  db: { prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] } },
  sql: string,
  readOnly: boolean,
): SqlStatement {
  const stmt = db.prepare(sql)
  const guard = (): void => {
    if (readOnly) {
      const trimmed = sql.trim().toUpperCase()
      if (!trimmed.startsWith("PRAGMA") && !trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
        throw new Error(`opencode-usage: attempted write on read-only database: ${sql.slice(0, 60)}`)
      }
    }
  }
  return {
    run: (...params) => {
      guard()
      const result = stmt.run(...params)
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
    },
    get: (...params) => {
      const row = stmt.get(...params)
      return row === null || row === undefined ? undefined : (row as Record<string, unknown>)
    },
    all: (...params) => stmt.all(...params) as Record<string, unknown>[],
  }
}

export function openSqlDatabase(
  path: string,
  options: { readOnly?: boolean } = {},
): SqlDatabase {
  const readOnly = options.readOnly === true

  if (bunDatabase) {
    const db = new bunDatabase(path, readOnly ? "r" : "rw")
    let open = true
    return {
      get isOpen() {
        return open
      },
      get readOnly() {
        return readOnly
      },
      exec(sql: string) {
        if (readOnly) {
          const trimmed = sql.trim().toUpperCase()
          if (!trimmed.startsWith("PRAGMA") && !trimmed.startsWith("SELECT") && !trimmed.startsWith("WITH")) {
            throw new Error(`opencode-usage: attempted write on read-only database: ${sql.slice(0, 60)}`)
          }
        }
        db.exec(sql)
      },
      prepare(sql: string) {
        return makeStatement(db, sql, readOnly)
      },
      close() {
        if (open) {
          db.close()
          open = false
        }
      },
    }
  }

  if (nodeDatabase) {
    const raw = new nodeDatabase(path, { readOnly })
    return {
      get isOpen() {
        return raw.isOpen
      },
      get readOnly() {
        return readOnly
      },
      exec(sql: string) {
        raw.exec(sql)
      },
      prepare(sql: string) {
        const stmt = raw.prepare(sql)
        return {
          run: (...params) => {
            const result = stmt.run(...(params as never[]))
            return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid }
          },
          get: (...params) => {
            const row = stmt.get(...(params as never[]))
            return row === null || row === undefined ? undefined : (row as Record<string, unknown>)
          },
          all: (...params) => stmt.all(...(params as never[])) as Record<string, unknown>[],
        }
      },
      close() {
        raw.close()
      },
    }
  }

  throw new Error("No SQLite driver available (expected bun:sqlite or node:sqlite)")
}
