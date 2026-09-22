import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export type Table =
  | 'metadata'
  | 'sessions'
  | 'jobs'
  | 'receipts'
  | 'admissions'
  | 'attempts'
  | 'artifacts'
  | 'exports';
export class Database {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get()!['user_version'];
    if (version !== 0 && version !== 1) {
      this.db.close();
      throw Error('Unsupported database version');
    }
    this.transaction(() => {
      for (const name of [
        'metadata',
        'sessions',
        'jobs',
        'receipts',
        'admissions',
        'attempts',
        'artifacts',
        'exports',
      ]) {
        this.db.exec(
          `CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)))`,
        );
      }
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS events (job_id TEXT NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(job_id, revision));
        CREATE UNIQUE INDEX IF NOT EXISTS job_request ON jobs(json_extract(value, '$.snapshot.request_id'));
        PRAGMA user_version=1;`);
    });
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  get<T>(table: Table, id: string): T | undefined {
    const row = this.db.prepare(`SELECT value FROM ${table} WHERE id=?`).get(id);
    return row ? (JSON.parse(row['value'] as string) as T) : undefined;
  }
  all<T>(table: Table): T[] {
    return this.db
      .prepare(`SELECT value FROM ${table} ORDER BY rowid`)
      .all()
      .map((row) => JSON.parse(row['value'] as string) as T);
  }
  put(table: Table, id: string, value: unknown) {
    this.db
      .prepare(
        `INSERT INTO ${table}(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
      )
      .run(id, JSON.stringify(value));
  }
  insert(table: Table, id: string, value: unknown) {
    this.db.prepare(`INSERT INTO ${table}(id,value) VALUES (?,?)`).run(id, JSON.stringify(value));
  }
  event(job: string, revision: number, value: unknown) {
    this.db.prepare('INSERT INTO events VALUES (?,?,?)').run(job, revision, JSON.stringify(value));
  }
  events<T>(job: string, after: number): T[] {
    return this.db
      .prepare('SELECT value FROM events WHERE job_id=? AND revision>? ORDER BY revision LIMIT 101')
      .all(job, after)
      .map((row) => JSON.parse(row['value'] as string) as T);
  }
  close() {
    this.db.close();
  }
}
