const encoder = new TextEncoder();
const COOKIE = "afterglow_session";
const MAX_AGE = 180 * 24 * 60 * 60;

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("Invalid encoding");
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) => char.charCodeAt(0));
}

async function key(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("Session secret is not configured");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function matchesDigest(text: string, expected: string): Promise<boolean> {
  const actual = await digest(text);
  return crypto.subtle.timingSafeEqual(encoder.encode(actual), encoder.encode(expected));
}

async function sign(secret: string, message: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(message))));
}

async function verify(secret: string, message: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify("HMAC", await key(secret), unbase64url(signature), encoder.encode(message));
  } catch {
    return false;
  }
}

export function profileCookie(profile = "default"): string {
  if (profile === "default") return COOKIE;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profile)) throw new Error("Invalid profile");
  return COOKIE + "_" + profile;
}
function sessionMessage(profile: string, id: string, owner: string, expires: string): string {
  return "afterglow/session/v3/" + profile + "/" + id + "/" + owner + "/" + expires;
}

export type SessionIdentity = { id: string; owner: string; expiresAt: number };

export function sessionId(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readSession(request: Request, secret: string, profile = "default"): Promise<SessionIdentity | null> {
  const cookie = profileCookie(profile);
  const value = (request.headers.get("Cookie") || "").split(";").map((v) => v.trim())
    .find((v) => v.startsWith(cookie + "="))?.slice(cookie.length + 1);
  if (!value || value.length > 200) return null;
  const match = /^([a-f0-9]{64})\.([a-f0-9]{64})\.([a-z0-9]{1,12})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return null;
  const [, id, owner, expires, signature] = match;
  const expiry = parseInt(expires, 36);
  const now = Math.floor(Date.now() / 1000);
  if (expiry <= now || expiry > now + MAX_AGE + 60) return null;
  return await verify(secret, sessionMessage(profile, id, owner, expires), signature)
    ? { id, owner, expiresAt: expiry * 1000 } : null;
}

export async function createSession(secret: string, secure: boolean, profile = "default", identity?: SessionIdentity): Promise<SessionIdentity & { cookie: string }> {
  const name = profileCookie(profile);
  const now = Math.floor(Date.now() / 1000);
  const id = identity?.id ?? sessionId();
  const owner = identity?.owner ?? id;
  const expiry = identity ? Math.floor(identity.expiresAt / 1000) : now + MAX_AGE;
  const expires = expiry.toString(36);
  const signature = await sign(secret, sessionMessage(profile, id, owner, expires));
  return {
    id, owner, expiresAt: expiry * 1000,
    cookie: name + "=" + id + "." + owner + "." + expires + "." + signature + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + Math.max(0, expiry - now) + (secure ? "; Secure" : ""),
  };
}

export type Completion = {
  format: "afterglow-completion-v1";
  edition: string;
  player: string;
  completedAt: number;
  elapsedMs: number;
  attempts: number;
  cases: number;
};

export async function createProof(secret: string, value: Completion): Promise<string> {
  const payload = base64url(encoder.encode(JSON.stringify(value)));
  return payload + "." + await sign(secret, "afterglow/proof/v1/" + payload);
}

export async function verifyProof(secret: string, proof: string): Promise<Completion | null> {
  if (proof.length > 2048) return null;
  const parts = proof.split(".");
  if (parts.length !== 2 || !await verify(secret, "afterglow/proof/v1/" + parts[0], parts[1])) return null;
  try {
    const value = JSON.parse(new TextDecoder().decode(unbase64url(parts[0]))) as Completion;
    if (value.format !== "afterglow-completion-v1" || !Number.isSafeInteger(value.cases) || value.cases < 1 || value.cases > 999
      || !/^[a-f0-9]{16}$/.test(value.edition) || !/^[a-f0-9]{12}$/.test(value.player)
      || ![value.completedAt, value.elapsedMs, value.attempts].every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    return value;
  } catch {
    return null;
  }
}
