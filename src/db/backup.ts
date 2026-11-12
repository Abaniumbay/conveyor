// Consistent database copies for release backups.

import { Database } from "bun:sqlite";

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Writes a consistent copy of an open database to `target` (VACUUM INTO, safe while it is in use). */
export function vacuumInto(database: Database, target: string): void {
  database.exec(`VACUUM INTO ${sqlString(target)}`);
}

/** Writes a consistent copy of the database file `filename` to `target`, opening it read-only for the copy. */
export function copyDatabaseFile(filename: string, target: string): void {
  const database = new Database(filename, { readonly: true });
  try {
    vacuumInto(database, target);
  } finally {
    database.close();
  }
}
