import { SQL } from "bun";

export type Db = {
  sql: SQL;
  /** true when the database answers. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
};

export function connectDb(databaseUrl: string): Db {
  const sql = new SQL(databaseUrl);
  return {
    sql,
    async ping() {
      try {
        await sql`select 1`;
        return true;
      } catch {
        return false;
      }
    },
    close: () => sql.close(),
  };
}

export { migrate } from "./migrate.ts";
