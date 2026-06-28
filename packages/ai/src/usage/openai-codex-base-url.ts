import { CODEX_BASE_URL } from "@pk-nerdsaver-ai/pi-catalog/wire/codex";

export function normalizeCodexBaseUrl(baseUrl?: string): string {
	const fallback = CODEX_BASE_URL;
	const trimmed = baseUrl?.trim() ? baseUrl.trim() : fallback;
	const base = trimmed.replace(/\/+$/, "");
	const lower = base.toLowerCase();
	if (
		(lower.startsWith("https://chatgpt.com") || lower.startsWith("https://chat.openai.com")) &&
		!lower.includes("/backend-api")
	) {
		return `${base}/backend-api`;
	}
	return base;
}
