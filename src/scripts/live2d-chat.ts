import { readPublicPage, type PageSnapshot, type PublicPageContext } from "../utils/live2d-page-context";

type Message = { role: "user" | "model"; text: string };
type Reply = { text: string; emotion: string };
type PageSession = {
	key: string;
	page: PublicPageContext | null;
	history: Message[];
	transcript: Message[];
	summary?: Reply;
	draft: string;
	touched: number;
};
const panel = document.getElementById("live2d-chat")!;
const form = document.getElementById("live2d-chat-form") as HTMLFormElement;
const input = document.getElementById("live2d-chat-input") as HTMLTextAreaElement;
const send = document.getElementById("live2d-chat-send") as HTMLButtonElement;
const close = document.getElementById("live2d-chat-close") as HTMLButtonElement;
const messages = document.getElementById("live2d-chat-messages")!;
const autoSummary = panel.dataset.autoSummary === "true";
const speech = document.getElementById("live2d-speech")!;
const speechText = document.getElementById("live2d-speech-text")!;
const endpoint = panel.dataset.endpoint!;
const emotions = new Set(["idle", "happy", "sad", "celebrate", "proud", "down"]);
const sessions = new Map<string, PageSession>();
const CACHE_TTL = 30 * 60_000;
let snapshot: PageSnapshot = readPublicPage();
let current = sessionFor(snapshot);
let busy = false;
let composing = false;
let modelReady = false;
let summaryPending = false;
let attemptedSummary = "";
let positionFrame = 0;

function sessionFor(value: PageSnapshot): PageSession {
	const now = Date.now();
	for (const [key, session] of sessions) if (now - session.touched > CACHE_TTL) sessions.delete(key);
	const session = sessions.get(value.key) ?? { key: value.key, page: value.page, history: [], transcript: [], draft: "", touched: now };
	session.touched = now;
	sessions.delete(value.key);
	sessions.set(value.key, session);
	while (sessions.size > 10) sessions.delete(sessions.keys().next().value!);
	return session;
}

function trigger(): HTMLButtonElement | null { return document.querySelector('button[title="聊天"]'); }
function canvas(): HTMLCanvasElement | null { return document.querySelector("canvas[data-live2d-canvas]"); }

function positionPanels() {
	if (positionFrame) return;
	positionFrame = requestAnimationFrame(() => {
		positionFrame = 0;
		const model = canvas();
		const anchor = model?.getBoundingClientRect();
		const gap = 12;
		const awake = modelReady && anchor && anchor.top < innerHeight - 30 && model?.style.pointerEvents !== "none";
		speech.hidden = !awake || innerWidth < 1024;
		if (!speech.hidden && anchor) {
			speech.style.setProperty("--speech-max-height", `${Math.max(64, anchor.top - gap - 16)}px`);
			const left = Math.max(gap, Math.min(anchor.left + anchor.width / 2 - speech.offsetWidth / 2, innerWidth - speech.offsetWidth - gap));
			speech.style.left = `${left}px`;
			speech.style.top = `${Math.max(gap, anchor.top - speech.offsetHeight - 16)}px`;
			speech.style.setProperty("--speech-tail", `${Math.max(12, Math.min(speech.offsetWidth - 12, anchor.left + anchor.width / 2 - left))}px`);
		}
		if (panel.matches(":popover-open")) {
			let left = Math.max((anchor?.right ?? 280) + gap, speech.hidden ? 0 : speech.getBoundingClientRect().right + gap);
			if (left + panel.offsetWidth > innerWidth - gap) left = (anchor?.left ?? innerWidth) - panel.offsetWidth - gap;
			panel.style.left = `${Math.max(gap, Math.min(left, innerWidth - panel.offsetWidth - gap))}px`;
			panel.style.top = `${Math.max(gap, innerHeight - panel.offsetHeight - gap)}px`;
		}
	});
}

function say(text: string) {
	speechText.textContent = text;
	positionPanels();
}

function updateControls() {
	send.disabled = busy || !input.value.trim();
	send.textContent = busy ? "…" : "发送 ♡";
	send.setAttribute("aria-label", busy ? "等待回复" : "发送消息");
	input.readOnly = busy;
	form.setAttribute("aria-busy", String(busy));
}

function renderTranscript() {
	messages.replaceChildren();
	const transcript = current.transcript.length ? current.transcript : [{ role: "model", text: "主人，Roro 来陪你啦 (｡･ω･｡)" }];
	for (const entry of transcript) {
		const message = document.createElement("p");
		message.className = "chat-message";
		message.dataset.role = entry.role;
		message.textContent = entry.text;
		messages.append(message);
	}
	messages.scrollTop = messages.scrollHeight;
}

function addMessage(session: PageSession, message: Message) {
	session.transcript.push(message);
	if (session.transcript.length > 40) session.transcript.splice(0, session.transcript.length - 40);
	session.touched = Date.now();
	if (current === session) renderTranscript();
}

function trimHistory(session: PageSession) {
	while (session.history.length > 6 || session.history.reduce((total, entry) => total + entry.text.length, 0) > 4000) session.history.splice(0, 2);
}

function errorMessage(code: unknown, retryAfter: string | null): string {
	const seconds = Number(retryAfter);
	if (code === "rate_limited") return `主人，聊得有点快，${Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60} 秒后再找 Roro 吧～`;
	if (code === "visitor_limit" || code === "site_limit") return seconds > 60 ? "主人，今天的聊天额度用完啦，明天再来找 Roro 吧。" : "主人，Roro 正忙，稍后再试一下吧。";
	if (code === "origin_forbidden") return "主人，请从 arisaka.eth.limo 打开聊天，本地预览需要启动聊天服务哦。";
	if (["invalid_message", "invalid_history", "body_too_large"].includes(String(code))) return "主人，消息有点长，缩短一点再告诉 Roro 吧。";
	if (code === "invalid_page") return "主人，这页暂时没法整理，换一页试试喵";
	if (code === "upstream_timeout") return "主人，Roro 刚刚走神了，稍后再试一次吧。";
	return "主人，聊天服务暂时不可用，稍后再来找 Roro 吧。";
}

async function submit(intent: "chat" | "summary", automatic = false) {
	const target = current;
	if (busy) return;
	if (intent === "summary" && target.summary) { say(target.summary.text); return; }
	if (intent === "summary" && !target.page) return;
	const message = intent === "summary" ? "请总结当前页面的公开内容。" : input.value.trim();
	if (!message || message.length > 1000) return;
	if (intent === "summary") attemptedSummary = target.key;
	busy = true;
	summaryPending = false;
	updateControls();
	const pending: Message = { role: "user", text: message };
	if (intent === "chat") addMessage(target, pending);
	try {
		const payload = intent === "summary" ? { intent, message, history: [], page: target.page } : {
			intent, message, history: target.history,
			...(target.page && target.summary ? { context: { title: target.page.title, path: target.page.path, summary: target.summary.text } } : {}),
		};
		const response = await fetch(endpoint, {
			method: "POST", credentials: "omit", redirect: "error", cache: "no-store",
			headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(45_000),
		});
		const data = await response.json();
		if (!response.ok) throw new Error(errorMessage(data?.error, response.headers.get("Retry-After")));
		if (!data || typeof data.text !== "string" || !data.text.trim() || data.text.length > 1000) throw new Error("主人，回复有点乱，我们重新试一次吧。");
		const reply: Reply = { text: data.text, emotion: emotions.has(data.emotion) ? data.emotion : "idle" };
		if (intent === "summary") target.summary = reply;
		else {
			target.history.push({ role: "user", text: message }, { role: "model", text: reply.text });
			trimHistory(target);
			target.draft = "";
			if (current === target) input.value = "";
		}
		addMessage(target, { role: "model", text: reply.text });
		if (current === target) {
			say(reply.text);
			window.dispatchEvent(new CustomEvent("live2d:emotion", { detail: reply.emotion }));
		}
	} catch (error) {
		const index = target.transcript.indexOf(pending);
		if (index >= 0) target.transcript.splice(index, 1);
		if (current === target) {
			renderTranscript();
			if (!automatic) {
				const errorText = error instanceof Error && error.name === "Error" ? error.message : "主人，连接中断了，消息已经帮你保留，稍后再试吧。";
				addMessage(target, { role: "model", text: errorText });
				say(errorText);
			}
		}
	} finally {
		busy = false;
		updateControls();
		if (!automatic && panel.matches(":popover-open")) input.focus({ preventScroll: true });
		tryAutomaticSummary();
	}
}

function tryAutomaticSummary() {
	if (summaryPending && !busy && current.page && !current.summary &&
		autoSummary && !input.value.trim()) void submit("summary", true);
}

function refreshPage() {
	const next = readPublicPage();
	if (next.key !== snapshot.key || Date.now() - current.touched > CACHE_TTL) {
		current.draft = input.value;
		snapshot = next;
		current = sessionFor(next);
		input.value = current.draft;
		attemptedSummary = "";
		renderTranscript();
	}
	updateControls();
	if (!modelReady) return;
	summaryPending = autoSummary && !!current.page && !current.summary && attemptedSummary !== current.key;
	const latest = current.transcript.findLast((message) => message.role === "model");
	say(latest?.text ?? "主人，Roro 来陪你啦 (｡･ω･｡)");
	tryAutomaticSummary();
}

function openPanel() {
	if (!panel.matches(":popover-open")) panel.showPopover();
	positionPanels();
	input.focus({ preventScroll: true });
}
function closePanel() { panel.hidePopover(); trigger()?.focus({ preventScroll: true }); }

form.addEventListener("submit", (event) => { event.preventDefault(); void submit("chat"); });
input.addEventListener("input", () => { current.draft = input.value; current.touched = Date.now(); updateControls(); tryAutomaticSummary(); });
input.addEventListener("compositionstart", () => { composing = true; });
input.addEventListener("compositionend", () => { setTimeout(() => { composing = false; }, 0); });
input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !composing) {
		event.preventDefault();
		if (!send.disabled) form.requestSubmit();
	}
});
close.addEventListener("click", closePanel);
speech.addEventListener("click", openPanel);
panel.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closePanel(); } });
window.addEventListener("live2d:chat-toggle", () => { if (panel.matches(":popover-open")) closePanel(); else openPanel(); });
window.addEventListener("live2d:sleep", () => { speech.hidden = true; panel.hidePopover(); summaryPending = false; });
panel.addEventListener("toggle", () => {
	const open = panel.matches(":popover-open");
	trigger()?.setAttribute("aria-expanded", String(open));
	speechText.setAttribute("aria-live", open ? "off" : "polite");
});
document.addEventListener("pointerdown", (event) => {
	if (!(event.target instanceof Node) || !panel.matches(":popover-open")) return;
	if (!panel.contains(event.target) && !speech.contains(event.target) && !trigger()?.contains(event.target)) panel.hidePopover();
});
window.addEventListener("resize", positionPanels);
new ResizeObserver(positionPanels).observe(speechText);

function onModelReady() {
	if (modelReady) return;
	modelReady = true;
	const model = canvas();
	model?.parentElement?.addEventListener("transitionend", positionPanels);
	if (model) new MutationObserver(positionPanels).observe(model, { attributes: true, attributeFilter: ["style"] });
	positionPanels();
	// Let the existing entrance animation bring Roro into view first.
	setTimeout(refreshPage, 1600);
}
window.addEventListener("live2d:ready", onModelReady);
if (canvas()?.dataset.live2dReady === "true") onModelReady();
const setupNavigation = () => { window.swup?.hooks.on("page:view", refreshPage); };
document.addEventListener("astro:page-load", refreshPage);
if (window.swup?.hooks) setupNavigation();
else document.addEventListener("swup:enable", setupNavigation, { once: true });
renderTranscript();
updateControls();
