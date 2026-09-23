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
export interface Lookup {
  sql: string;
  index?: string;
}
// Hot lookups read only matching rows. A partial index is usable only when the query repeats
// its predicate verbatim, so indexes and queries share these fragments. Without ANALYZE the
// planner prefers a rowid scan for ORDER BY rowid, so lookups name their index explicitly;
// SQLite then fails loudly instead of silently scanning if the index ever becomes unusable.
export const where = {
  openJob: {
    sql: "(json_extract(value, '$.snapshot.terminal') = 0 OR json_extract(value, '$.snapshot.remote_may_continue') = 1)",
    index: 'job_open',
  },
  jobSession: { sql: "json_extract(value, '$.snapshot.session_id') = ?", index: 'job_session' },
  jobRequest: { sql: "json_extract(value, '$.snapshot.request_id') = ?", index: 'job_request' },
  manualSession: {
    sql: "json_extract(value, '$.control_owner') = 'manual'",
    index: 'session_manual',
  },
  copyingExport: {
    sql: "json_extract(value, '$.snapshot.state') = 'copying'",
    index: 'export_copying',
  },
  exportTemps: { sql: "json_extract(value, '$.temps') != '{}'", index: 'export_temps' },
  // Exports are few and small; this only avoids parsing every record in JavaScript.
  exportTarget: {
    sql: "EXISTS (SELECT 1 FROM json_each(value, '$.targets') WHERE json_each.value = ?)",
  },
} satisfies Record<string, Lookup>;
const source = (table: Table, lookup?: Lookup) =>
  `${table}${lookup?.index ? ` INDEXED BY ${lookup.index}` : ''} WHERE ${lookup?.sql ?? '1'}`;
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
        CREATE INDEX IF NOT EXISTS job_open ON jobs(id) WHERE ${where.openJob.sql};
        CREATE INDEX IF NOT EXISTS job_session ON jobs(json_extract(value, '$.snapshot.session_id'));
        CREATE INDEX IF NOT EXISTS session_manual ON sessions(id) WHERE ${where.manualSession.sql};
        CREATE INDEX IF NOT EXISTS export_copying ON exports(id) WHERE ${where.copyingExport.sql};
        CREATE INDEX IF NOT EXISTS export_temps ON exports(id) WHERE ${where.exportTemps.sql};
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
  select<T>(table: Table, lookup: Lookup, ...params: string[]): T[] {
    return this.db
      .prepare(`SELECT value FROM ${source(table, lookup)} ORDER BY rowid`)
      .all(...params)
      .map((row) => JSON.parse(row['value'] as string) as T);
  }
  // Newest first.
  latest<T>(table: Table, count: number, lookup?: Lookup, ...params: string[]): T[] {
    return this.db
      .prepare(`SELECT value FROM ${source(table, lookup)} ORDER BY rowid DESC LIMIT ?`)
      .all(...params, count)
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
