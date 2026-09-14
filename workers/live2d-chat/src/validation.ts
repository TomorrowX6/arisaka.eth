import { HttpError, isRecord, onlyKeys } from "./http";
import { EMOTIONS, POLICY, type ChatInput, type ChatReply, type HistoryMessage, type PageContext, type SummaryContext } from "./policy";

export function validateInput(value: unknown): ChatInput {
  if (!isRecord(value) || !onlyKeys(value, ["message", "history", "intent", "page", "context"])) {
    throw new HttpError(400, "invalid_request");
  }
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > POLICY.maxMessageChars) {
    throw new HttpError(400, "invalid_message");
  }
  const history = value.history ?? [];
  if (!Array.isArray(history) || history.length > POLICY.maxHistoryMessages || history.length % 2 !== 0) {
    throw new HttpError(400, "invalid_history");
  }
  let total = 0;
  const validatedHistory: HistoryMessage[] = history.map((entry, index) => {
    if (!isRecord(entry) || !onlyKeys(entry, ["role", "text"]) ||
      entry.role !== (index % 2 === 0 ? "user" : "model") ||
      typeof entry.text !== "string" || !entry.text.trim() || entry.text.length > POLICY.maxMessageChars) {
      throw new HttpError(400, "invalid_history");
    }
    total += entry.text.length;
    return { role: entry.role as HistoryMessage["role"], text: entry.text.trim() };
  });
  if (total > POLICY.maxHistoryChars) throw new HttpError(400, "invalid_history");
  const common = { message: value.message.trim(), history: validatedHistory };
  if (value.intent === "summary") {
    if (history.length !== 0) throw new HttpError(400, "invalid_history");
    if (value.context !== undefined) throw new HttpError(400, "invalid_request");
    return { ...common, intent: "summary", page: validatePage(value.page) };
  }
  if ((value.intent !== undefined && value.intent !== "chat") || value.page !== undefined) throw new HttpError(400, "invalid_request");
  return { ...common, intent: "chat", ...(value.context !== undefined ? { context: validateContext(value.context) } : {}) };
}

function validateContext(value: unknown): SummaryContext {
  if (!isRecord(value) || !onlyKeys(value, ["title", "path", "summary"]) ||
    typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > POLICY.maxReplyChars) {
    throw new HttpError(400, "invalid_page");
  }
  const page = validatePage({ title: value.title, path: value.path, text: value.summary });
  return { title: page.title, path: page.path, summary: page.text };
}

function validatePage(value: unknown): PageContext {
  if (!isRecord(value) || !onlyKeys(value, ["title", "path", "text"]) ||
    typeof value.title !== "string" || !value.title.trim() || value.title.length > 160 ||
    typeof value.path !== "string" || !/^\/(?!\/)[^?#\s]{0,499}$/.test(value.path) ||
    typeof value.text !== "string" || !value.text.trim() || value.text.length > POLICY.maxPageChars) {
    throw new HttpError(400, "invalid_page");
  }
  return { title: value.title.trim(), path: value.path, text: value.text.trim() };
}

export function validateReply(value: unknown): ChatReply {
  if (!isRecord(value) || !onlyKeys(value, ["text", "emotion"]) ||
    typeof value.text !== "string" || !value.text.trim() || value.text.length > POLICY.maxReplyChars) {
    throw new HttpError(502, "invalid_reply");
  }
  // Unknown emotions are inert. They can never become motion IDs or commands.
  const emotion = EMOTIONS.find((emotion) => emotion === value.emotion) ?? "idle";
  const prefix = value.text.includes("主人") ? "" : "主人，";
  const text = (prefix + value.text.trim()).slice(0, POLICY.maxReplyChars).replace(/[\uD800-\uDBFF]$/u, "");
  return { text, emotion };
}
