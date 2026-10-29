import { Database } from "bun:sqlite";
import type {
  KeyValueStore,
  StoredSession,
} from "@opencoredev/loginwithchatgpt-server";

export class SessionStore implements KeyValueStore<StoredSession> {
  private readonly database: Database;
  constructor(path: string) {
    this.database = new Database(path, { create: true });
    this.database.run(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER)",
    );
  }
  get(key: string): StoredSession | undefined {
    const row = this.database
      .query("SELECT value, expires FROM sessions WHERE id = ?")
      .get(key) as { value: string; expires: number | null } | null;
    if (!row) return;
    if (row.expires !== null && row.expires <= Date.now()) {
      this.delete(key);
      return;
    }
    return JSON.parse(row.value);
  }
  set(key: string, value: StoredSession, options?: { ttlMs?: number }): void {
    this.database.run(
      "INSERT OR REPLACE INTO sessions (id, value, expires) VALUES (?, ?, ?)",
      [
        key,
        JSON.stringify(value),
        options?.ttlMs === undefined ? null : Date.now() + options.ttlMs,
      ],
    );
  }
  delete(key: string): void {
    this.database.run("DELETE FROM sessions WHERE id = ?", [key]);
  }
  close(): void {
    this.database.close();
  }
}
