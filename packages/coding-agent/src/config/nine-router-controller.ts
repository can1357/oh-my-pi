/**
 * 9router Controller — dynamic model-role routing through the local 9router gateway.
 *
 * 9router exposes a large pool of model combos (subscription, cheap, free). This
 * controller picks a concrete working combo for each oh-my-pi model role and
 * writes it into `Settings.modelRoles`, so the existing resolver uses it as a
 * runtime override.
 *
 * Design goals:
 *   - Simple: role -> ordered candidate list. Pick first available.
 *   - Subscription first, then cheap, then free.
 *   - Health-check via 9router `/v1/models` (presence) or a tiny chat probe.
 *   - No AI decision-making; declarative tiers.
 */

import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { getImplicit9RouterBaseUrl } from "./model-discovery";
import type { ModelRole } from "./model-roles";
import type { Settings } from "./settings";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_MAX_TOKENS = 8;

/** One slot: a model role and the ordered 9router combo candidates to try. */
export interface NineRouterSlot {
	role: ModelRole;
	candidates: string[];
}

/** A role route result: which candidate was selected and why. */
export interface NineRouterRouteResult {
	role: ModelRole;
	selected: string | null;
	candidates: string[];
	available: string[];
	probed: string[];
}

export interface NineRouterRoutingResult {
	routes: NineRouterRouteResult[];
	errors: string[];
}

export interface NineRouterControllerOptions {
	settings: Settings;
	/** 9router base URL, e.g. `http://127.0.0.1:20128/v1`. */
	baseUrl?: string;
	/** Optional API key for 9router (usually omitted for local instances). */
	apiKey?: string;
	/** Optional fetch override for tests. */
	fetch?: FetchImpl;
	/** Optional override for the default role->candidate mapping. */
	slots?: NineRouterSlot[];
}

export interface NineRouterApplyOptions {
	/**
	 * How aggressively to verify a candidate.
	 * - `list`: candidate must be present in 9router `/v1/models`.
	 * - `probe`: candidate must also answer a tiny chat completion.
	 */
	mode?: "list" | "probe";
	probeTimeoutMs?: number;
	probeMaxTokens?: number;
	/**
	 * Only route these roles. Defaults to all built-in roles.
	 */
	roles?: ModelRole[];
}

function normalizeBaseUrl(url: string): string {
	const trimmed = url.trim().replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * Convert a 9router combo id into the model selector stored in settings.
 *
 * Bare provider-looking ids such as `openrouter/qwen3-32b:nitro`, `ag/foo`,
 * and `gc/foo` are still 9router combo ids in this controller. Direct provider
 * selectors must bypass NineRouterController and be written as normal model
 * roles elsewhere.
 */
function toNineRouterSelector(comboId: string): string {
	return comboId.startsWith("9router/") ? comboId : `9router/${comboId}`;
}

/** Strip the selector prefix before matching ids returned by 9router /models. */
function toNineRouterComboId(candidate: string): string {
	return candidate.startsWith("9router/") ? candidate.slice("9router/".length) : candidate;
}

/** Default slot mapping: subscription first, then cheap, then free. */
export function defaultNineRouterSlots(): NineRouterSlot[] {
	return [
		{
			role: "default",
			candidates: [
				"ompk",
				"oh-my-pi-fork",
				"omp-default",
				"cx/gpt-5.5",
				"cc/claude-opus-4-8",
				"ag/claude-sonnet-4-6",
				"ag/gemini-pro-agent",
				"gc/gemini-3.1-pro-preview",
				"clinepass-deepseek-v4-flash",
				"fast-fallback",
				"deepseek-v4-flash-fallback",
				"openrouter-free-fallback",
			],
		},
		{
			role: "max-intelligence",
			candidates: [
				"ompk",
				"oh-my-pi-fork",
				"omp-default",
				"cx/gpt-5.5",
				"cc/claude-opus-4-8",
				"ag/claude-opus-4-6-thinking",
				"ag/claude-sonnet-4-6",
				"gc/gemini-3.1-pro-preview",
			],
		},
		{
			role: "slow",
			candidates: [
				"ompk",
				"oh-my-pi-fork",
				"deepseek-v4-pro-rr",
				"deepseek-v4-pro-fallback",
				"cc/claude-opus-4-8",
				"cx/gpt-5.5",
			],
		},
		{
			role: "balanced",
			candidates: [
				"fast-fallback",
				"clinepass-deepseek-v4-flash",
				"deepseek-v4-flash-rr",
				"deepseek-v4-flash-fallback",
				"gemini-3-5-flash-medium-round-robin",
				"claude-sonnet-4-6-fallback",
				"gemini-3.5-flash-fallback",
				"ag/gemini-3.5-flash-low",
				"ag/gpt-oss-120b-medium",
				"9router/openrouter/qwen3-32b:nitro",
				"9router/openai/gpt-oss-120b:nitro",
				"9router/openrouter/qwen/qwen3.6-35b-a3b:nitro",
				"gc/gemini-3-flash-preview",
			],
		},
		{
			role: "smol",
			candidates: [
				"fast",
				"fast-fallback",
				"fast-gpt-oss-120b",
				"free-fast-rr",
				"gpt-oss-120b-fast-tier-rr",
				"groq-gpt-oss-20b",
				"gemini-3-5-flash-low",
				"gemini-3.1-flash-lite",
				"ag/gemini-3.5-flash-extra-low",
				"ag/gemini-3-flash-agent",
				"gc/gemini-3.1-flash-lite-preview",
			],
		},
		{
			role: "free",
			candidates: [
				"openrouter-free-fallback",
				"free-fast-rr",
				"gemini-vx-only-rr",
				"gemini-3.1-flash-lite",
				"gpt-oss-120b-rr",
				"gpt-oss-20b-rr",
			],
		},
		{
			role: "vision",
			candidates: [
				"gemini-3-5-flash-medium-round-robin",
				"gemini-3.5-flash-fallback",
				"ag/gemini-3.5-flash-low",
				"ag/gemini-3-flash",
				"gc/gemini-3-flash-preview",
				"gemini-vx-only-rr",
				"gemini-3-5-flash-low",
			],
		},
		{
			role: "plan",
			candidates: ["ompk", "oh-my-pi-fork", "omp-default", "cx/gpt-5.5", "cc/claude-opus-4-8"],
		},
		{
			role: "designer",
			candidates: [
				"gemini-3-5-flash-medium-round-robin",
				"gemini-3.5-flash-fallback",
				"gemini-3.1-flash-lite",
				"ag/gemini-3.5-flash-low",
				"ag/gemini-3-flash",
				"gc/gemini-3-flash-preview",
				"gemini-vx-only-rr",
				"gemini-3-5-flash-low",
				"glm-5.2",
			],
		},
		{
			role: "commit",
			candidates: ["fast-fallback", "gpt-oss-120b-rr", "free-fast-rr", "groq-gpt-oss-20b"],
		},
		{
			role: "title",
			candidates: ["fast-fallback", "gpt-oss-20b-rr", "free-fast-rr", "groq-gpt-oss-20b"],
		},
		{
			role: "task",
			candidates: [
				"fast-fallback",
				"clinepass-deepseek-v4-flash",
				"deepseek-v4-flash-rr",
				"deepseek-v4-flash-fallback",
				"balanced",
				"gemini-3-5-flash-medium-round-robin",
				"9router/openrouter/qwen3-32b:nitro",
				"9router/openai/gpt-oss-120b:nitro",
				"9router/openrouter/qwen/qwen3.6-35b-a3b:nitro",
			],
		},
		{
			role: "browser-control",
			candidates: ["minimax/MiniMax-M3", "minimax-m3-rr", "minimax-m3-fallback", "minimax-code/MiniMax-M3"],
		},
		{
			role: "route-predictor",
			candidates: ["local-fast", "free-fast", "cheap-fast", "minimax-m3-rr"],
		},
		{
			role: "browser-operation",
			candidates: ["minimax/MiniMax-M3", "minimax-m3-rr", "minimax-m3-fallback", "minimax-code/MiniMax-M3"],
		},
		{
			role: "advisor",
			candidates: ["ompk", "oh-my-pi-fork", "omp-default", "cx/gpt-5.5", "cc/claude-opus-4-8"],
		},
		{
			role: "fast-context",
			candidates: ["fast", "fast-fallback", "free-fast-rr", "gpt-oss-120b-fast-tier-rr"],
		},
		{
			role: "budget",
			candidates: [
				"clinepass-deepseek-v4-flash",
				"deepseek-v4-flash-rr",
				"deepseek-v4-flash-fallback",
				"claude-sonnet-4-6-fallback",
				"openrouter-free-fallback",
				"free-fast-rr",
			],
		},
	];
}

/** Controller that picks working 9router combos for oh-my-pi model roles. */
export class NineRouterController {
	readonly #settings: Settings;
	readonly #baseUrl: string;
	readonly #apiKey: string | undefined;
	readonly #fetch: FetchImpl;
	readonly #slots: Map<ModelRole, string[]>;

	constructor(options: NineRouterControllerOptions) {
		this.#settings = options.settings;
		this.#baseUrl = normalizeBaseUrl(options.baseUrl ?? getImplicit9RouterBaseUrl());
		this.#apiKey = options.apiKey ?? Bun.env["9ROUTER_API_KEY"]?.trim() ?? Bun.env.NINEROUTER_API_KEY?.trim();
		this.#fetch = options.fetch ?? (fetch as FetchImpl);
		this.#slots = new Map();
		for (const slot of options.slots ?? defaultNineRouterSlots()) {
			this.#slots.set(slot.role, slot.candidates.map(toNineRouterComboId));
		}
	}

	/** Return the current ordered candidates for a role. */
	getCandidates(role: ModelRole): string[] {
		return [...(this.#slots.get(role) ?? [])];
	}

	async apply(options: NineRouterApplyOptions = {}): Promise<NineRouterRoutingResult> {
		const mode = options.mode ?? "list";
		const roles = options.roles?.length ? options.roles : defaultNineRouterSlots().map(({ role }) => role);
		const errors: string[] = [];

		let availableIds: Set<string>;
		try {
			availableIds = await this.#fetchAvailableIds();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			logger.error("9router controller: failed to fetch available models", {
				baseUrl: this.#baseUrl,
				error: message,
			});
			errors.push(`Failed to fetch 9router models: ${message}`);
			availableIds = new Set();
		}

		const routes: NineRouterRouteResult[] = [];
		for (const role of roles) {
			const candidates = this.getCandidates(role);
			if (candidates.length === 0) continue;

			const available = candidates.filter(id => availableIds.has(id));
			let selected: string | null = null;
			const probed: string[] = [];

			if (mode === "probe" && available.length > 0) {
				const timeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
				const maxTokens = options.probeMaxTokens ?? DEFAULT_PROBE_MAX_TOKENS;
				for (const id of available) {
					probed.push(id);
					const ok = await this.#probeOne(id, timeoutMs, maxTokens);
					if (ok) {
						selected = id;
						break;
					}
				}
			} else {
				selected = available[0] ?? null;
			}

			if (selected) {
				this.#settings.setModelRole(role, toNineRouterSelector(selected));
				logger.debug("9router controller: routed role", { role, selected });
			} else {
				logger.warn("9router controller: no working candidate for role", { role, mode });
			}

			routes.push({ role, selected, candidates, available, probed });
		}

		return { routes, errors };
	}

	async #fetchAvailableIds(): Promise<Set<string>> {
		const url = `${this.#baseUrl}/models`;
		const headers: Record<string, string> = { Accept: "application/json" };
		if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

		const response = await this.#fetch(url, {
			headers,
			signal: AbortSignal.timeout(15_000),
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${url}`);
		}
		const payload = (await response.json()) as { data?: Array<{ id?: string }> };
		const ids = new Set<string>();
		for (const item of payload.data ?? []) {
			if (item.id) ids.add(item.id);
		}
		return ids;
	}

	async #probeOne(id: string, timeoutMs: number, maxTokens: number): Promise<boolean> {
		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

			const response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
				method: "POST",
				headers,
				body: JSON.stringify({
					model: id,
					messages: [{ role: "user", content: "ping" }],
					max_tokens: maxTokens,
					stream: false,
				}),
				signal: AbortSignal.timeout(timeoutMs),
			});
			return response.ok;
		} catch (err) {
			logger.debug("9router controller: probe failed", { id, error: String(err) });
			return false;
		}
	}
}

/** Convenience helper: create a controller and apply the default routing. */
export async function applyNineRouterRouting(
	settings: Settings,
	options?: Omit<NineRouterControllerOptions, "settings"> & NineRouterApplyOptions,
): Promise<NineRouterRoutingResult> {
	const { mode, probeTimeoutMs, probeMaxTokens, roles, ...rest } = options ?? {};
	const controller = new NineRouterController({ settings, ...rest });
	return controller.apply({ mode, probeTimeoutMs, probeMaxTokens, roles });
}
