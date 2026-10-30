/** Usage: npm run admin:create -- you@example.com 'a-long-password' */
import { createPool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { createAdmin } from "../services/adminAuth.js";

const [email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: npm run admin:create -- <email> <password>");
  process.exit(1);
}
const pool = createPool(process.env.DATABASE_URL ?? "");
await migrate(pool);
await createAdmin(pool, email, password);
console.log(`admin saved: ${email.toLowerCase()}`);
await pool.end();
