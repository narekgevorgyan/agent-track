export type Param = string | number | null;

export function stmt(db: D1Database, sql: string, ...params: Param[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

export async function all<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T[]> {
  const { results } = await stmt(db, sql, ...params).all<T>();
  return results;
}

export async function first<T>(db: D1Database, sql: string, ...params: Param[]): Promise<T | null> {
  return stmt(db, sql, ...params).first<T>();
}

export async function run(db: D1Database, sql: string, ...params: Param[]): Promise<void> {
  await stmt(db, sql, ...params).run();
}

/** Runs statements atomically (D1 batch = one implicit transaction). */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<void> {
  if (stmts.length === 0) return;
  await db.batch(stmts);
}
