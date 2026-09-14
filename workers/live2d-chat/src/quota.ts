import { DurableObject } from "cloudflare:workers";
import { isRecord } from "./http";
import { POLICY, type ChatReply } from "./policy";
import { validateCorpus } from "./validation";

type Denied = { ok: false; retryAfter: number };
type Reservation = { ok: true; lease: string; day: number } | Denied;
type Corpus = { topics: ChatReply[]; remaining: number[]; last: number };
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

  async reserve(dailyLimit: number, concurrentLimit?: number): Promise<Reservation> {
    this.initialize();
    const now = Date.now();
    const day = Math.floor(now / DAY_MS);
    const decision = this.ctx.storage.transactionSync<Reservation>(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM leases WHERE expires <= ?", now);
      sql.exec("DELETE FROM daily WHERE day < ?", day);
      const used = sql.exec<{ used: number }>("SELECT used FROM daily WHERE day = ?", day).toArray()[0]?.used ?? 0;
      if (used >= dailyLimit) return { ok: false, retryAfter: Math.ceil(((day + 1) * DAY_MS - now) / 1000) };
      if (concurrentLimit !== undefined) {
        const active = sql.exec<{ count: number; earliest: number | null }>(
          "SELECT COUNT(*) AS count, MIN(expires) AS earliest FROM leases",
        ).one();
        if (active.count >= concurrentLimit) {
          return { ok: false, retryAfter: Math.max(1, Math.ceil(((active.earliest ?? now) - now) / 1000)) };
        }
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

  private parseCorpus(value: string, expires: number): Corpus | null {
    if (expires <= Date.now()) return null;
    try {
      const stored: unknown = JSON.parse(value);
      if (!isRecord(stored)) return null;
      const topics = validateCorpus({ topics: stored.topics });
      const validIndex = (index: unknown): index is number => typeof index === "number" && Number.isInteger(index) && index >= 0 && index < topics.length;
      const last = validIndex(stored.last) ? stored.last : -1;
      const remaining = Array.isArray(stored.remaining) && stored.remaining.every(validIndex)
        ? [...new Set(stored.remaining)] : topics.map((_, index) => index).filter((index) => index !== last);
      return { topics, remaining, last };
    } catch { return null; }
  }

  async readCorpus(): Promise<ChatReply[] | null> {
    this.initialize();
    await this.expire();
    const row = this.ctx.storage.sql.exec<{ value: string; expires: number }>("SELECT value, expires FROM summary WHERE id = 1").toArray()[0];
    return row ? this.parseCorpus(row.value, row.expires)?.topics ?? null : null;
  }

  // Draw without replacement. A visitor's last opener is also excluded when
  // other visitors have advanced the shared corpus in the meantime.
  async pickCorpus(previousTopic?: string): Promise<ChatReply | null> {
    this.initialize();
    await this.expire();
    return this.ctx.storage.transactionSync<ChatReply | null>(() => {
      const row = this.ctx.storage.sql.exec<{ value: string; expires: number }>("SELECT value, expires FROM summary WHERE id = 1").toArray()[0];
      const corpus = row ? this.parseCorpus(row.value, row.expires) : null;
      if (!corpus) return null;
      const eligible = (index: number) => index !== corpus.last && corpus.topics[index].text !== previousTopic;
      let choices = corpus.remaining.filter(eligible);
      if (!choices.length) {
        corpus.remaining = corpus.topics.map((_, index) => index);
        choices = corpus.remaining.filter(eligible);
      }
      const index = choices[crypto.getRandomValues(new Uint32Array(1))[0] % choices.length];
      corpus.remaining = corpus.remaining.filter((remaining) => remaining !== index);
      corpus.last = index;
      this.ctx.storage.sql.exec("UPDATE summary SET value = ? WHERE id = 1", JSON.stringify(corpus));
      return corpus.topics[index];
    });
  }

  async writeCorpus(topics: ChatReply[]): Promise<void> {
    this.initialize();
    const validated = validateCorpus({ topics });
    const row = this.ctx.storage.sql.exec<{ value: string; expires: number }>("SELECT value, expires FROM summary WHERE id = 1").toArray()[0];
    // Concurrent first visits must keep one shared corpus and its draw order.
    if (row && this.parseCorpus(row.value, row.expires)) return;
    const expires = Date.now() + POLICY.corpusCacheMs;
    const corpus: Corpus = { topics: validated, remaining: validated.map((_, index) => index), last: -1 };
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO summary (id, value, expires) VALUES (1, ?, ?)", JSON.stringify(corpus), expires);
    await this.ctx.storage.setAlarm(expires);
  }

  async alarm(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.ctx.storage.deleteAll();
      this.initialized = false;
    });
  }
}
