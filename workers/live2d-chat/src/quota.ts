import { DurableObject } from "cloudflare:workers";
import { POLICY, type ChatReply } from "./policy";

type Denied = { ok: false; retryAfter: number };
type Decision = { ok: true } | Denied;
type Reservation = { ok: true; lease: string; day: number } | Denied;
const DAY_MS = 86_400_000;

// Separate objects per daily IP hash and per global day. Only counters and
// expiring leases cross RPC; conversations and model fetches stay in the Worker.
export class ChatQuota extends DurableObject<Env> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.initialize();
  }

  private initialize(): void {
    if (this.initialized) return;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS attempts (at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS daily (day INTEGER PRIMARY KEY, used INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, expires INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS summary (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL, expires INTEGER NOT NULL)");
    this.initialized = true;
  }

  private async expire(): Promise<void> {
    if (await this.ctx.storage.getAlarm() === null) {
      await this.ctx.storage.setAlarm(Date.now() + 2 * DAY_MS);
    }
  }

  async attempt(): Promise<Decision> {
    this.initialize();
    const now = Date.now();
    const decision = this.ctx.storage.transactionSync<Decision>(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM attempts WHERE at <= ?", now - 60_000);
      const row = sql.exec<{ count: number; oldest: number | null }>(
        "SELECT COUNT(*) AS count, MIN(at) AS oldest FROM attempts",
      ).one();
      if (row.count >= POLICY.perMinute) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil(((row.oldest ?? now) + 60_000 - now) / 1000)) };
      }
      sql.exec("INSERT INTO attempts (at) VALUES (?)", now);
      return { ok: true };
    });
    await this.expire();
    return decision;
  }

  async reserve(dailyLimit: number, concurrentLimit: number): Promise<Reservation> {
    this.initialize();
    const now = Date.now();
    const day = Math.floor(now / DAY_MS);
    const decision = this.ctx.storage.transactionSync<Reservation>(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM leases WHERE expires <= ?", now);
      sql.exec("DELETE FROM daily WHERE day < ?", day);
      const used = sql.exec<{ used: number }>("SELECT used FROM daily WHERE day = ?", day).toArray()[0]?.used ?? 0;
      if (used >= dailyLimit) return { ok: false, retryAfter: Math.ceil(((day + 1) * DAY_MS - now) / 1000) };
      const active = sql.exec<{ count: number; earliest: number | null }>(
        "SELECT COUNT(*) AS count, MIN(expires) AS earliest FROM leases",
      ).one();
      if (active.count >= concurrentLimit) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil(((active.earliest ?? now) - now) / 1000)) };
      }
      const lease = crypto.randomUUID();
      sql.exec("INSERT INTO daily (day, used) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET used = used + 1", day);
      sql.exec("INSERT INTO leases (id, expires) VALUES (?, ?)", lease, now + POLICY.leaseMs);
      return { ok: true, lease, day };
    });
    await this.expire();
    return decision;
  }

  async release(lease: string): Promise<void> {
    if (this.initialized) this.ctx.storage.sql.exec("DELETE FROM leases WHERE id = ?", lease);
    // Do not refund daily usage: even a timed-out generation may be billable.
  }

  async cancel(lease: string, day: number): Promise<void> {
    if (!this.initialized) return;
    // Only cancel when the Worker has not started a model call. Removing the
    // lease and refunding together makes repeated cancellation harmless.
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (sql.exec("DELETE FROM leases WHERE id = ?", lease).rowsWritten > 0) {
        sql.exec("UPDATE daily SET used = MAX(0, used - 1) WHERE day = ?", day);
      }
    });
  }

  async readSummary(): Promise<ChatReply | null> {
    this.initialize();
    await this.expire();
    const row = this.ctx.storage.sql.exec<{ value: string; expires: number }>("SELECT value, expires FROM summary WHERE id = 1").toArray()[0];
    return row && row.expires > Date.now() ? JSON.parse(row.value) : null;
  }

  async writeSummary(reply: ChatReply): Promise<void> {
    this.initialize();
    const expires = Date.now() + POLICY.summaryCacheMs;
    // Store only the short public summary; no article body or conversation.
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO summary (id, value, expires) VALUES (1, ?, ?)", JSON.stringify(reply), expires);
    await this.ctx.storage.setAlarm(expires);
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();
      this.initialized = false;
    });
  }
}
