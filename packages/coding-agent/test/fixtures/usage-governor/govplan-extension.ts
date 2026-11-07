import type { UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { type } from "@oh-my-pi/omptype";
/**
 * Loaded with `-e` into the child `omp`. Registers two loopback providers whose base URLs,
 * OAuth rows and usage come from the fake in the test process:
 *
 * - `govplan` stands in for a provider the `default` role may use.
 * - `govplan-g` stands in for a provider only the `task` role may use.
 *
 * The fake's base URL arrives as `GOVPLAN_FAKE_URL`. Login and refresh are refused: the seeded
 * OAuth rows never expire, so any refresh is a defect the scenarios would expose.
 */
export default function govplanExtension(pi: ExtensionAPI): void {
	const fake = process.env.GOVPLAN_FAKE_URL;
	if (!fake) throw new Error("GOVPLAN_FAKE_URL is required by the govplan fixture");

	// Warm the fallback in the exercising process, after extension registration
	// invalidates its provider cache. The governor itself remains cache-only.
	pi.on("before_agent_start", async (event, ctx) => {
		if (event.prompt.includes("WARM_CHILD_CHAIN")) {
			for (const provider of ["govplan", "govplan-g", "govplan-h"] as const) {
				await ctx.modelRegistry.authStorage.usage.invalidate(provider);
				await ctx.modelRegistry.authStorage.usage.reports({
					provider,
					baseUrlResolver: candidate => ctx.modelRegistry.getProviderBaseUrl(candidate),
				});
			}
		}
		if (event.prompt.includes("WARM_API_KEY")) {
			await ctx.modelRegistry.authStorage.usage.reports({
				provider: "govplan",
				baseUrlResolver: provider => ctx.modelRegistry.getProviderBaseUrl(provider),
			});
		}
		if (!event.prompt.includes("WARM_FALLBACK")) return;
		for (const provider of ["govplan-g", "govplan-h"] as const) {
			await ctx.modelRegistry.authStorage.usage.reports({
				provider,
				baseUrlResolver: candidate => ctx.modelRegistry.getProviderBaseUrl(candidate),
			});
		}
	});

	pi.registerTool({
		name: "govplan_pin_probe",
		label: "Governor pin probe",
		description: "Record the current session account and invalidate fixture usage.",
		parameters: type({}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			const auth = ctx.modelRegistry.authStorage;
			const identity = auth.oauth.identity("govplan", sessionId);
			await auth.usage.invalidate("govplan");
			return { content: [{ type: "text", text: JSON.stringify({ sessionId, email: identity?.email }) }] };
		},
	});

	for (const provider of ["govplan", "govplan-g", "govplan-h"] as const) {
		const usage: UsageProvider = {
			id: provider,
			governorAllowance: params => {
				const key = params.credential.apiKey;
				if (key?.endsWith("-unknown")) return undefined;
				if (key?.endsWith("-metered")) return ["paid-credits"];
				return ["requests-60s", "requests-7d"];
			},
			async fetchUsage(params, context): Promise<UsageReport | null> {
				const response = await context.fetch(`${fake}/${provider}/usage`, {
					headers: { Authorization: `Bearer ${params.credential.accessToken ?? params.credential.apiKey ?? ""}` },
					signal: params.signal,
				});
				if (!response.ok) throw new Error(`govplan usage endpoint answered ${response.status}`);
				return (await response.json()) as UsageReport;
			},
		};
		pi.registerProvider(provider, {
			baseUrl: `${fake}/${provider}/v1`,
			api: "openai-completions",
			usage,
			oauth: {
				name: `Govplan fixture (${provider})`,
				async login() {
					throw new Error("the govplan fixture has no interactive login");
				},
				async refreshToken() {
					throw new Error("the govplan fixture never refreshes: seeded rows do not expire");
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			},
			models: [
				{
					id: "m",
					name: "Govplan m",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 131072,
					maxTokens: 1024,
				},
				{
					id: "m2",
					name: "Govplan m2",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 131072,
					maxTokens: 1024,
				},
			],
		});
	}
}
