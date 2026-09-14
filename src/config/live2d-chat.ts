// Public configuration only. API keys belong in the Worker.
export const live2dChatConfig = {
	endpoint: import.meta.env.PUBLIC_LIVE2D_CHAT_ENDPOINT ??
		(import.meta.env.DEV ? "http://127.0.0.1:8787/chat" : "https://arisaka-live2d-chat.454565615.workers.dev/chat"),
	autoSummary: true,
};
