/**
 * Ambient types for the Bun runtime surface used by opencode-usage when it
 * runs inside opencode (which is a Bun-compiled binary).
 */

declare const Bun: unknown

declare module "bun:sqlite" {
  export interface BunStatement {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
    get(...params: unknown[]): Record<string, unknown> | null | undefined
    all(...params: unknown[]): Record<string, unknown>[]
  }

  export class Database {
    constructor(path: string, flags?: "r" | "rw" | "w" | "c" | { readonly?: boolean; create?: boolean })
    close(): void
    exec(sql: string): void
    prepare(sql: string): BunStatement
  }
}
