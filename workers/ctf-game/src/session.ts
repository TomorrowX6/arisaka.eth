import { DurableObject } from "cloudflare:workers";
import manifest from "./generated/manifest.json";
import { digest } from "./crypto";
import { caseCount } from "./cases";
import { createGcmState, runGcm, type GcmConfig, type GcmState } from "./labs/gcm";
import { createPaddingState, runPadding, type PaddingConfig, type PaddingState } from "./labs/padding";
import { createCurveState, runCurve, type CurveConfig, type CurveState } from "./labs/curve";
import { createWotsState, runWots, type WotsConfig, type WotsState } from "./labs/wots";
import { LabError } from "./labs/common";

type GameRow = { version: string; stage: number; started_at: number; completed_at: number | null };
type StageRow = { stage: number; attempts: number; solved_at: number | null; failures: number; retry_at: number; last_failure: number };
type ShopRow = { cards: number; stands: number; redeemed: number };
type QuoteRow = { id: string; quantity: number; cost: number; expires: number; used: number };
type CompletionMilestone = { edition: string; cases: number; completedAt: number; attempts: number };
export type Failure = { ok: false; status: number; error: string; retryAt?: number };
const fail = (status: number, error: string): Failure => ({ ok: false, status, error });

export class GameSession extends DurableObject<Env> {
  async initialize(expiresAt: number) {
    if (expiresAt <= Date.now()) return;
    if (this.ctx.storage.kv.get<number>("expiresAt")) return;
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS game (id INTEGER PRIMARY KEY CHECK(id = 1), version TEXT NOT NULL, stage INTEGER NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS stages (stage INTEGER PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, solved_at INTEGER, failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, last_failure INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE TABLE IF NOT EXISTS shop (id INTEGER PRIMARY KEY CHECK(id = 1), cards INTEGER NOT NULL, stands INTEGER NOT NULL, redeemed INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE TABLE IF NOT EXISTS quotes (id TEXT PRIMARY KEY, quantity INTEGER NOT NULL, cost INTEGER NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0)");
    sql.exec("CREATE TABLE IF NOT EXISTS labs (stage INTEGER PRIMARY KEY, state TEXT NOT NULL)");
    sql.exec("INSERT OR IGNORE INTO game (id, version, stage, started_at) VALUES (1, ?, 1, ?)", manifest.version, Date.now());
    sql.exec("INSERT OR IGNORE INTO shop (id, cards, stands) VALUES (1, 1, 0)");
    for (let stage = 1; stage <= caseCount; stage++) sql.exec("INSERT OR IGNORE INTO stages (stage) VALUES (?)", stage);
    this.ctx.storage.kv.put("expiresAt", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async retire() {
    // With our compatibility date, deleteAll also removes the alarm. Keeping the
    // constructor read-only prevents old cookies/RPCs from recreating storage.
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    const expiresAt = this.ctx.storage.kv.get<number>("expiresAt");
    if (expiresAt && expiresAt > Date.now()) await this.ctx.storage.setAlarm(expiresAt);
    else await this.retire();
  }

  private active(): boolean {
    return (this.ctx.storage.kv.get<number>("expiresAt") ?? 0) > Date.now();
  }

  private game(): GameRow {
    return this.ctx.storage.sql.exec<GameRow>("SELECT version, stage, started_at, completed_at FROM game WHERE id = 1").one();
  }

  private migrate() {
    if (!this.active()) return;
    const saved = this.game();
    if (saved.version === manifest.version) return;
    const predecessor = manifest.compatibleEditions.find(edition => edition.version === saved.version);
    if (!predecessor || saved.stage < 1 || saved.stage > predecessor.cases + 1) return;
    this.ctx.storage.transactionSync(() => {
      const game = this.game();
      if (game.version !== predecessor.version) return;
      if (game.completed_at !== null && game.stage === predecessor.cases + 1) {
        const history = this.ctx.storage.kv.get<CompletionMilestone[]>("completionMilestones") ?? [];
        if (!history.some(item => item.edition === game.version)) {
          const attempts = this.ctx.storage.sql.exec<{ total: number }>("SELECT COALESCE(SUM(attempts), 0) AS total FROM stages WHERE stage <= ?", predecessor.cases).one().total;
          history.push({ edition: game.version, cases: predecessor.cases, completedAt: game.completed_at, attempts });
          this.ctx.storage.kv.put("completionMilestones", history);
        }
      }
      for (let stage = predecessor.cases + 1; stage <= caseCount; stage++) {
        this.ctx.storage.sql.exec("INSERT OR IGNORE INTO stages (stage) VALUES (?)", stage);
      }
      this.ctx.storage.sql.exec("UPDATE game SET version = ?, completed_at = NULL WHERE id = 1", manifest.version);
    });
  }

  private gate(stage: number): Failure | null {
    if (!this.active()) return fail(401, "会话已失效");
    const game = this.game();
    if (game.version !== manifest.version) return fail(409, "存档版本已失效");
    if (stage < 1 || stage > caseCount || !Number.isInteger(stage)) return fail(404, "不存在");
    if (game.stage < stage) return fail(403, "未解锁");
    return null;
  }

  state() {
    if (!this.active()) return { started: false as const };
    this.migrate();
    const game = this.game();
    const stages = this.ctx.storage.sql.exec<StageRow>("SELECT * FROM stages ORDER BY stage").toArray();
    return {
      started: true as const,
      edition: game.version,
      outdated: game.version !== manifest.version,
      stage: game.stage,
      total: caseCount,
      startedAt: game.started_at,
      completedAt: game.completed_at,
      milestones: this.ctx.storage.kv.get<CompletionMilestone[]>("completionMilestones") ?? [],
      attempts: stages.reduce((sum, row) => sum + row.attempts, 0),
      stages: stages.map((row) => ({
        id: row.stage, attempts: row.attempts,
        solvedAt: row.solved_at, retryAt: row.retry_at,
      })),
    };
  }

  access(stage: number) {
    this.migrate();
    const blocked = this.gate(stage);
    if (blocked) return blocked;
    const record = this.ctx.storage.sql.exec<StageRow>("SELECT * FROM stages WHERE stage = ?", stage).one();
    return { ok: true as const, solved: record.solved_at !== null };
  }

  async lab(stage: number, action: string, data: Record<string, unknown>) {
    this.migrate();
    const blocked = this.gate(stage);
    if (blocked) return blocked;
    const config = (manifest.labs as Record<string, GcmConfig | PaddingConfig | CurveConfig | WotsConfig>)[stage];
    if (!config) return fail(404, "不存在");
    const state = this.ctx.storage.transactionSync(() => {
      const saved = this.ctx.storage.sql.exec<{ state: string }>("SELECT state FROM labs WHERE stage = ?", stage).toArray()[0];
      if (saved) return JSON.parse(saved.state) as GcmState | PaddingState | CurveState | WotsState;
      const value = config.kind === "gcm" ? createGcmState() : config.kind === "curve" ? createCurveState(config) : config.kind === "wots" ? createWotsState() : createPaddingState();
      this.ctx.storage.sql.exec("INSERT INTO labs (stage, state) VALUES (?, ?)", stage, JSON.stringify(value));
      return value;
    });
    try {
      const result = config.kind === "gcm"
        ? await runGcm(config, state as GcmState, action, data)
        : config.kind === "curve" ? await runCurve(config, state as CurveState, action, data)
        : config.kind === "wots" ? await runWots(config, state as WotsState, action, data)
        : await runPadding(config, state as PaddingState, action, data);
      return { ok: true as const, ...result };
    } catch (error) {
      if (error instanceof LabError) return fail(error.status, error.message);
      throw error;
    }
  }

  async answer(stage: number, code: string) {
    if (!Number.isInteger(stage) || stage < 1 || stage > caseCount || !/^[a-z0-9]{20}$/.test(code)) {
      return fail(400, "通行码应为 20 位小写字母或数字。");
    }
    this.migrate();
    // Hash before entering the synchronous transaction. Recheck progress inside it.
    const submitted = await digest("afterglow:" + manifest.version + ":" + stage + ":" + code);
    return this.ctx.storage.transactionSync(() => {
      const blocked = this.gate(stage);
      if (blocked) return blocked;
      const game = this.game();
      if (stage < game.stage) return { ok: true as const, result: "already-solved" as const, state: this.state() };
      const row = this.ctx.storage.sql.exec<StageRow>("SELECT * FROM stages WHERE stage = ?", stage).one();
      const now = Date.now();
      if (row.retry_at > now) return { ...fail(429, "请稍后重试"), retryAt: row.retry_at };
      const correct = submitted === manifest.digests[stage - 1];
      const failures = now - row.last_failure > 30_000 ? 1 : row.failures + 1;
      this.ctx.storage.sql.exec(
        "UPDATE stages SET attempts = attempts + 1, failures = ?, retry_at = ?, last_failure = ? WHERE stage = ?",
        correct ? 0 : failures, !correct && failures >= 5 ? now + 5000 : 0, correct ? 0 : now, stage,
      );
      if (!correct) return { ok: true as const, result: "incorrect" as const, state: this.state() };
      this.ctx.storage.sql.exec("UPDATE stages SET solved_at = ? WHERE stage = ?", now, stage);
      this.ctx.storage.sql.exec("UPDATE game SET stage = ?, completed_at = ? WHERE id = 1", stage + 1, stage === caseCount ? now : null);
      return { ok: true as const, result: "correct" as const, state: this.state() };
    });
  }

  shop() {
    this.migrate();
    const blocked = this.gate(4);
    if (blocked) return blocked;
    const row = this.ctx.storage.sql.exec<ShopRow>("SELECT cards, stands, redeemed FROM shop WHERE id = 1").one();
    return { ok: true as const, cards: row.cards, stands: row.stands, redeemed: Boolean(row.redeemed), code: row.redeemed ? manifest.shopCode : null };
  }

  quote(item: string, quantity: number) {
    this.migrate();
    const blocked = this.gate(4);
    if (blocked) return blocked;
    if (item !== "stand" || !Number.isInteger(quantity) || quantity === 0 || Math.abs(quantity) > 9) {
      return fail(400, "物品或数量无效");
    }
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM quotes WHERE used = 1 OR expires < ?", now);
    const count = this.ctx.storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM quotes").one().total;
    if (count >= 12) return fail(429, "未结算报价已满");
    const id = crypto.randomUUID();
    // Intentional CTF defect: signed accounting versus absolute warehouse quantity.
    // This ledger is isolated in the player's DO and cannot move real assets.
    const cost = quantity;
    const expires = now + 300_000;
    this.ctx.storage.sql.exec("INSERT INTO quotes (id, quantity, cost, expires) VALUES (?, ?, ?, ?)", id, quantity, cost, expires);
    return { ok: true as const, quoteId: id, item: "stand", quantity, cost, expires };
  }

  checkout(id: string) {
    this.migrate();
    return this.ctx.storage.transactionSync(() => {
      const blocked = this.gate(4);
      if (blocked) return blocked;
      const quote = this.ctx.storage.sql.exec<QuoteRow>("SELECT * FROM quotes WHERE id = ?", id).toArray()[0];
      if (!quote || quote.used || quote.expires < Date.now()) return fail(409, "报价已失效");
      const wallet = this.ctx.storage.sql.exec<ShopRow>("SELECT cards, stands, redeemed FROM shop WHERE id = 1").one();
      if (wallet.cards < quote.cost) return fail(409, "余额不足");
      const cards = wallet.cards - quote.cost;
      const stands = wallet.stands + Math.abs(quote.quantity);
      if (cards > 999 || stands > 999) return fail(409, "账本已满");
      this.ctx.storage.sql.exec("UPDATE quotes SET used = 1 WHERE id = ?", id);
      this.ctx.storage.sql.exec("UPDATE shop SET cards = ?, stands = ? WHERE id = 1", cards, stands);
      return this.shop();
    });
  }

  redeem() {
    this.migrate();
    return this.ctx.storage.transactionSync(() => {
      const blocked = this.gate(4);
      if (blocked) return blocked;
      const wallet = this.ctx.storage.sql.exec<ShopRow>("SELECT cards, stands, redeemed FROM shop WHERE id = 1").one();
      if (wallet.redeemed) return this.shop();
      if (wallet.cards < 4 || wallet.stands < 1) return fail(409, "兑换需要 4 张卡片和至少 1 个立牌。");
      this.ctx.storage.sql.exec("UPDATE shop SET cards = cards - 4, stands = stands - 1, redeemed = 1 WHERE id = 1");
      return this.shop();
    });
  }

  resetShop() {
    this.migrate();
    const blocked = this.gate(4);
    if (blocked) return blocked;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM quotes");
      this.ctx.storage.sql.exec("UPDATE shop SET cards = 1, stands = 0, redeemed = 0 WHERE id = 1");
    });
    return this.shop();
  }
}
