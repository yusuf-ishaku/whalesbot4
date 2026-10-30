import pg from "pg";

// Telegram ids and counts fit in a JS number; return int8 as number instead of string.
pg.types.setTypeParser(20, (v) => Number(v));

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 20 });
}
