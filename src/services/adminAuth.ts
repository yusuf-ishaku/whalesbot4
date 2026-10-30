import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type pg from "pg";

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(password, salt, 64, (e, k) => (e ? rej(e) : res(k))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scryptAsync(password, salt)).toString("hex")}`;
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltHex, hashHex] = stored.split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function createAdmin(pool: pg.Pool, email: string, password: string): Promise<void> {
  if (password.length < 10) throw new Error("Password must be at least 10 characters.");
  await pool.query(
    "INSERT INTO admin_accounts (email, password_hash) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash",
    [email.toLowerCase(), await hashPassword(password)],
  );
}

/** Stateless signed session: `email.expiry.hmac`. */
export function signSession(secret: string, email: string, ttlMs = 12 * 3_600_000, now = Date.now()): string {
  const body = `${Buffer.from(email).toString("base64url")}.${now + ttlMs}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function readSession(secret: string, token: string | undefined, now = Date.now()): string | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [b64, exp, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${b64}.${exp}`).digest("base64url");
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  if (Number(exp) < now) return null;
  return Buffer.from(b64, "base64url").toString();
}

/** Small in-memory limiter for login attempts. */
export class AttemptLimiter {
  private hits = new Map<string, number[]>();
  constructor(private max = 10, private windowMs = 15 * 60_000) {}
  tooMany(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, recent);
    return recent.length >= this.max;
  }
  record(key: string, now = Date.now()): void {
    this.hits.set(key, [...(this.hits.get(key) ?? []), now]);
  }
}
