import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport } from "../usage";

const OLLAMA_PROVIDER = "ollama";
const OLLAMA_CLOUD_PROVIDER = "ollama-cloud";

/**
 * Undocumented but live since at least 2026-08: ollama.com exposes account
 * usage for Cloud keys. Response shape (observed 2026-08-27):
 * {
 *   "activity": { "cost": "...", "period": { "type": "last_4_weeks", ... } },
 *   "limits": {
 *     "session": { "usage": 0.03, "models": [{ "name": "...", "request_count": 54 }] },
 *     "weekly":  { "usage": 0.005, "models": [...] }
 *   }
 * }
 * `usage` is a normalized 0..1 fraction of the session (5h) / weekly (7d)
 * allowance, not a token count.
 */
const OLLAMA_COM_API_USAGE = "https://ollama.com/api/usage";

const OLLAMA_WINDOWS: ReadonlyArray<{
	key: "session" | "weekly";
	windowId: string;
	label: string;
	durationMs: number;
}> = [
	{ key: "session", windowId: "5h", label: "5 Hour", durationMs: 5 * 60 * 60 * 1000 },
	{ key: "weekly", windowId: "7d", label: "7 Day", durationMs: 7 * 24 * 60 * 60 * 1000 },
];

async function fetchOllamaUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
	if (params.provider !== OLLAMA_PROVIDER && params.provider !== OLLAMA_CLOUD_PROVIDER) {
		return null;
	}

	const metadata: Record<string, unknown> = {};
	if (params.credential.email) metadata.email = params.credential.email;
	if (params.credential.accountId) metadata.accountId = params.credential.accountId;
	if (params.credential.projectId) metadata.projectId = params.credential.projectId;

	// Local Ollama has no quota at all; Cloud needs an API-key credential to
	// query the usage endpoint.
	const apiKey = params.credential.type === "api_key" ? params.credential.apiKey : undefined;
	if (params.provider !== OLLAMA_CLOUD_PROVIDER || !apiKey) {
		return {
			provider: params.provider,
			fetchedAt: Date.now(),
			limits: [],
			notes: [
				params.provider === OLLAMA_CLOUD_PROVIDER
					? "Ollama Cloud usage requires an API-key credential."
					: "Local Ollama has no quota; per-response token usage is reported during requests.",
			],
			metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
		};
	}

	try {
		const response = await ctx.fetch(OLLAMA_COM_API_USAGE, {
			headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
			signal: params.signal,
		});
		if (!response.ok) {
			ctx.logger?.warn("Ollama usage fetch failed", { provider: params.provider, status: response.status });
			return null;
		}
		const payload = (await response.json()) as {
			limits?: Partial<
				Record<
					"session" | "weekly",
					{
						usage?: number;
						models?: ReadonlyArray<{ name?: string; request_count?: number }>;
					}
				>
			>;
		} | null;
		const limits = payload?.limits;
		if (!limits) return null;

		const out: UsageLimit[] = [];
		for (const win of OLLAMA_WINDOWS) {
			const seg = limits[win.key];
			if (!seg || typeof seg.usage !== "number" || !Number.isFinite(seg.usage)) continue;
			const used = Math.min(1, Math.max(0, seg.usage));
			const topConsumers = (seg.models ?? [])
				.filter(m => typeof m?.name === "string")
				.slice(0, 4)
				.map(m => `${m.name} x${m.request_count ?? 0}`)
				.join(", ");
			out.push({
				id: `ollama-account:${win.windowId}`,
				label: `Ollama ${win.label}`,
				scope: {
					provider: params.provider,
					...(typeof metadata.accountId === "string" ? { accountId: metadata.accountId } : {}),
					shared: true,
					windowId: win.windowId,
				},
				window: { id: win.windowId, label: win.label, durationMs: win.durationMs },
				amount: {
					used: used * 100,
					usedFraction: used,
					remaining: 100 - used * 100,
					remainingFraction: 1 - used,
					unit: "percent",
				},
				status: used >= 1 ? "exhausted" : used >= 0.9 ? "warning" : "ok",
				...(topConsumers ? { notes: [`Top consumers: ${topConsumers}`] } : {}),
			});
		}
		return {
			provider: params.provider,
			fetchedAt: Date.now(),
			limits: out,
			metadata: { ...metadata, source: "ollama-api-usage" },
			raw: payload,
		};
	} catch (err) {
		ctx.logger?.warn("Ollama usage request failed", {
			provider: params.provider,
			error: err instanceof Error ? err.name : "unknown",
		});
		return null;
	}
}

/** Registers Ollama accounts with usage views (local ollama reports no quota). */
export const ollamaUsageProvider: UsageProvider = {
	id: OLLAMA_PROVIDER,
	fetchUsage: fetchOllamaUsage,
	supports: params => params.provider === OLLAMA_PROVIDER,
	validatesCredentials: false,
};

/** Registers Ollama Cloud accounts and queries the account usage endpoint. */
export const ollamaCloudUsageProvider: UsageProvider = {
	id: OLLAMA_CLOUD_PROVIDER,
	fetchUsage: fetchOllamaUsage,
	supports: params => params.provider === OLLAMA_CLOUD_PROVIDER,
	validatesCredentials: false,
};
