/**
 * GitHub Copilot "auto model selection" — the session/intent protocol that
 * unlocks gated models for Free/Student tiers and provides task-optimized
 * routing for all tiers.
 *
 * omp/opencode do not implement this natively; it is a first-party Copilot
 * flow (VS Code Copilot Chat, Copilot CLI). The protocol was reverse-
 * engineered by probing `api.githubcopilot.com` and confirmed against the
 * Copilot Chat VSIX bundle (`dist/extension.js`), which builds the URLs as:
 *
 *   capiAutoModelURL  = /models/session        (mint session)
 *   capiModelRouterURL = /models/session/intent (per-prompt task router)
 *
 * Flow:
 *  1. `mintSession` — POST /models/session {"auto_mode":{"model_hints":["auto"]}}
 *     → { session_token (JWT, 1h TTL), expires_at, selected_model,
 *         available_models[], discounted_costs{} }
 *  2. `classifyIntent` (optional) — POST /models/session/intent
 *     { available_models, prompt } → { chosen_model, scores, routing_method }
 *     VS Code caps this at 2500ms; skip it for the lower-latency
 *     "reliability" mode (use `selected_model` directly).
 *  3. Chat to the chosen model's normal endpoint (/responses for gpt-5.x,
 *     /v1/messages for Claude) carrying `Copilot-Session-Token: <jwt>`.
 *     Without the token, gated models return `model_not_supported` on
 *     Free/Student; with it, they return 200.
 */

const COPILOT_API_VERSION = "2026-06-01";
/** Refresh a little before the reported expiry to avoid a window of 401s. */
const SESSION_REFRESH_LEAD_MS = 5 * 60 * 1000;
/** Match VS Code's router abort budget so classification never stalls a turn. */
const INTENT_TIMEOUT_MS = 2500;
/** Minimum gap between consecutive (failed) session-mint attempts. */
const MINT_BACKOFF_MS = 30 * 1000;

export interface CopilotAutoSession {
	sessionToken: string;
	expiresAt: number; // epoch ms
	selectedModel: string;
	availableModels: string[];
	discountedCosts: Record<string, number>;
}

interface SessionCacheEntry {
	session: CopilotAutoSession;
	/** Monotonic guard against tight retry loops when the capi is unreachable. */
	lastMintAt: number;
}

/**
 * Per-access-token session cache. The session JWT is scoped to the access
 * token, so keying on a hash of the token keeps multiple accounts separate
 * and invalidates automatically when the short-lived Copilot token rotates.
 */
const sessionCache = new Map<string, SessionCacheEntry>();

async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map(b => b.toString(16).padStart(2, "0"))
		.join("");
}

function baseHeaders(accessToken: string): Record<string, string> {
	return {
		Authorization: `Bearer ${accessToken}`,
		"Content-Type": "application/json",
		"X-GitHub-Api-Version": COPILOT_API_VERSION,
	};
}

/**
 * Mint (or reuse) an auto-selection session for the given Copilot access
 * token. Cached until ~5 min before expiry. Returns null only if the capi
 * endpoint is unreachable or rejects the request — callers fall back to the
 * session's last `selected_model` when the router is skipped.
 */
export async function ensureCopilotAutoSession(
	accessToken: string,
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<CopilotAutoSession | null> {
	const key = await sha256Hex(accessToken);
	const now = Date.now();
	const cached = sessionCache.get(key);
	if (cached && cached.session.expiresAt - now > SESSION_REFRESH_LEAD_MS) {
		return cached.session;
	}
	// Avoid hammering the capi if the previous mint just failed.
	if (cached && now - cached.lastMintAt < MINT_BACKOFF_MS) {
		return cached.session ?? null;
	}
	try {
		const response = await fetchImpl(`${baseUrl}/models/session`, {
			method: "POST",
			headers: baseHeaders(accessToken),
			body: JSON.stringify({ auto_mode: { model_hints: ["auto"] } }),
		});
		if (!response.ok) return cached?.session ?? null;
		const data = (await response.json()) as {
			session_token: string;
			expires_at: number;
			selected_model: string;
			available_models: string[];
			discounted_costs?: Record<string, number>;
		};
		if (!data.session_token || !data.selected_model) return cached?.session ?? null;
		const session: CopilotAutoSession = {
			sessionToken: data.session_token,
			// `expires_at` is an epoch second (JWT `exp`).
			expiresAt: data.expires_at * 1000,
			selectedModel: data.selected_model,
			availableModels: data.available_models ?? [],
			discountedCosts: data.discounted_costs ?? {},
		};
		sessionCache.set(key, { session, lastMintAt: now });
		return session;
	} catch {
		return cached?.session ?? null;
	}
}

export interface CopilotIntentResult {
	chosenModel: string;
	routingMethod?: string;
	reasoningBucket?: string;
}

/**
 * Classify a prompt to pick the optimal pool model (task-optimization mode).
 * Returns null on timeout/error so the caller falls back to the session's
 * `selected_model` (reliability mode) — never blocks a turn.
 */
export async function classifyCopilotIntent(
	accessToken: string,
	session: CopilotAutoSession,
	prompt: string,
	baseUrl: string,
	fetchImpl: typeof fetch,
): Promise<CopilotIntentResult | null> {
	if (!session.availableModels.length || !prompt) return null;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), INTENT_TIMEOUT_MS);
	try {
		const response = await fetchImpl(`${baseUrl}/models/session/intent`, {
			method: "POST",
			headers: { ...baseHeaders(accessToken), "Copilot-Session-Token": session.sessionToken },
			body: JSON.stringify({ available_models: session.availableModels, prompt }),
			signal: controller.signal,
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { chosen_model?: string; routing_method?: string; reasoning_bucket?: string };
		if (!data.chosen_model) return null;
		return {
			chosenModel: data.chosen_model,
			routingMethod: data.routing_method,
			reasoningBucket: data.reasoning_bucket,
		};
	} catch {
		return null;
	} finally {
		clearTimeout(timeout);
	}
}

/** Extract the last user-turn text from a message list, for intent routing. */
export function lastUserPrompt(messages: ReadonlyArray<{ role?: string; content?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "user") continue;
		const c = m.content;
		if (typeof c === "string") return c.slice(0, 2000);
		if (Array.isArray(c)) {
			// OpenAI-style content parts.
			const text = c
				.map(part => (typeof part === "string" ? part : part?.text ?? ""))
				.filter(Boolean)
				.join(" ");
			if (text) return text.slice(0, 2000);
		}
	}
	return "";
}
