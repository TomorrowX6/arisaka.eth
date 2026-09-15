import { DurableObject } from "cloudflare:workers";
import { sessionId } from "./crypto";
import type { Failure } from "./session";

type Profile = { id: string; ready: boolean; previous?: string; deleting?: boolean };
type Desktop = { expiresAt: number; profiles: Record<string, Profile> };
export type Authority = { profile: string; id: string };
const fail = (status: number, error: string): Failure => ({ ok: false, status, error });

// One stable owner survives default-profile restarts. Slots and pending cleanup
// are persisted before contacting game objects; failed operations can be retried.
export class DesktopProfiles extends DurableObject<Env> {
  private busy = new Set<string>();

  private desktop() {
    const value = this.ctx.storage.kv.get<Desktop>("desktop");
    return value && value.expiresAt > Date.now() ? value : undefined;
  }

  authorizes({ profile, id }: Authority, pending = false): boolean {
    const slot = this.desktop()?.profiles[profile];
    return Boolean(slot && ((slot.ready && slot.id === id) || (pending && !slot.deleting && slot.previous === id)));
  }

  async initialize(id: string, expiresAt: number) {
    const desktop: Desktop = { expiresAt, profiles: { default: { id, ready: false } } };
    this.ctx.storage.kv.put("desktop", desktop);
    await this.ctx.storage.setAlarm(expiresAt);
    await this.env.GAME_SESSIONS.getByName(id).initialize(expiresAt);
    desktop.profiles.default.ready = true;
    this.ctx.storage.kv.put("desktop", desktop);
  }

  async open(profile: string, restart: boolean, authority: Authority) {
    if (!this.authorizes(authority) && !(authority.profile === profile && this.authorizes(authority, true))) return fail(401, "会话已失效");
    if (this.busy.has(profile)) return fail(409, "存档正在更新，请重试");
    this.busy.add(profile);
    try {
      const desktop = this.desktop()!;
      let slot = desktop.profiles[profile];
      if (slot?.deleting) return fail(409, "存档正在删除，请重试删除");
      if (slot?.ready && (!restart || (authority.profile === profile && authority.id === slot.previous))) {
        return { ok: true as const, id: slot.id, expiresAt: desktop.expiresAt };
      }
      if (!slot) {
        if (Object.keys(desktop.profiles).length >= 8) return fail(429, "最多 8 个用户，请先删除不再使用的用户");
        slot = { id: sessionId(), ready: false };
      } else if (slot.ready) {
        slot = { id: sessionId(), previous: slot.id, ready: false };
      }
      desktop.profiles[profile] = slot;
      this.ctx.storage.kv.put("desktop", desktop);
      if (slot.previous) await this.env.GAME_SESSIONS.getByName(slot.previous).retire();
      await this.env.GAME_SESSIONS.getByName(slot.id).initialize(desktop.expiresAt);
      const current = this.desktop();
      if (!current) {
        await this.env.GAME_SESSIONS.getByName(slot.id).retire();
        return fail(401, "会话已失效");
      }
      // Retain one predecessor only for recovering a lost replacement cookie.
      // It cannot read the retired game or authorize any other profile.
      current.profiles[profile] = { ...slot, ready: true };
      this.ctx.storage.kv.put("desktop", current);
      return { ok: true as const, id: slot.id, expiresAt: current.expiresAt };
    } finally {
      this.busy.delete(profile);
    }
  }

  async remove(profile: string, authority: Authority) {
    if (!this.authorizes(authority)) return fail(401, "会话已失效");
    if (profile === authority.profile) return fail(409, "无法删除当前用户");
    if (this.busy.has(profile)) return fail(409, "存档正在更新，请重试");
    this.busy.add(profile);
    try {
      const desktop = this.desktop()!;
      const slot = desktop.profiles[profile];
      if (!slot) return { ok: true as const };
      desktop.profiles[profile] = { ...slot, ready: false, deleting: true };
      this.ctx.storage.kv.put("desktop", desktop);
      if (slot.previous) await this.env.GAME_SESSIONS.getByName(slot.previous).retire();
      await this.env.GAME_SESSIONS.getByName(slot.id).retire();
      const current = this.desktop();
      if (current) {
        delete current.profiles[profile];
        this.ctx.storage.kv.put("desktop", current);
      }
      return { ok: true as const };
    } finally {
      this.busy.delete(profile);
    }
  }

  async alarm() {
    const desktop = this.ctx.storage.kv.get<Desktop>("desktop");
    if (desktop && desktop.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(desktop.expiresAt);
      return;
    }
    for (const slot of Object.values(desktop?.profiles ?? {})) {
      if (slot.previous) await this.env.GAME_SESSIONS.getByName(slot.previous).retire();
      await this.env.GAME_SESSIONS.getByName(slot.id).retire();
    }
    await this.ctx.storage.deleteAll();
  }
}
