import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceDir = path.join(import.meta.dir, "..", "src", "session");
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Every step runs in a fresh Bun process so module state cannot carry a ban;
 * only the persisted router state directory connects process A and process B.
 */
async function runProcess(stateDir: string, body: string): Promise<unknown> {
	const script = `
import * as exhaustion from ${JSON.stringify(path.join(sourceDir, "provider-exhaustion.ts"))};
import { findRetryFallbackCandidates } from ${JSON.stringify(path.join(sourceDir, "retry-fallback-chains.ts"))};
const context = {
	chains: { default: ["deepseek/deepseek-v4-pro", "kimi-code/kimi-for-coding", "codex-lb/gpt-5.5"] },
	getModelRole: () => undefined,
	modelLookup: { find: () => ({}), hasProvider: () => true },
};
// Mirrors TurnRecovery: a failed turn cools its provider once rotation found no sibling credential.
function logProviderTurnError(message) {
	if (exhaustion.isProviderExhaustionError(message.errorStatus, message.errorMessage)) {
		exhaustion.coolDownExhaustedProvider(message.provider, {
			reason: ((message.errorStatus ?? "") + " " + (message.errorMessage ?? "provider exhausted")).trim(),
		});
	}
}
function pick() {
	const exclusions = [];
	const candidates = findRetryFallbackCandidates(context, "default", "openai/gpt-4o-mini", undefined, { exclusions });
	return { order: candidates.map(candidate => candidate.provider), exclusions };
}
const result = await (async () => { ${body} })();
console.log(JSON.stringify(result));
`;
	const child = Bun.spawn([process.execPath, "--eval", script], {
		// The cooldown file lives in the agent dir; point it (and any XDG state home) at the fixture.
		env: { ...process.env, PI_CODING_AGENT_DIR: stateDir, XDG_STATE_HOME: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (exitCode !== 0) throw new Error(`child exited ${exitCode}: ${stderr}`);
	const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
	console.log(JSON.stringify(result));
	return result;
}

describe("persisted provider billing cooldown", () => {
	let stateDir: TempDir;

	beforeEach(() => {
		stateDir = TempDir.createSync("@omp-provider-billing-");
	});

	afterEach(() => {
		stateDir.removeSync();
	});

	it("(a) skips deepseek 402 and kimi monthly-limit 403 in a fresh process with the reason", async () => {
		await runProcess(
			stateDir.path(),
			`logProviderTurnError({ stopReason: "error", provider: "deepseek", model: "deepseek-v4-pro", errorStatus: 402, errorMessage: "Insufficient Balance" });
			logProviderTurnError({ stopReason: "error", provider: "kimi-code", model: "kimi-for-coding", errorStatus: 403, errorMessage: "permission_error: You've reached your monthly usage limit for this billing cycle" });
			return true;`,
		);
		const picked = (await runProcess(stateDir.path(), "return pick();")) as {
			order: string[];
			exclusions: Array<{ provider: string; reason: string; until: number }>;
		};

		expect(picked.order).toEqual(["codex-lb"]);
		expect(picked.exclusions).toEqual([
			{
				provider: "deepseek",
				reason: expect.stringMatching(/^billing: 402 Insufficient Balance until \d{4}-\d\d-\d\dT/),
				until: expect.any(Number),
			},
			{
				provider: "kimi-code",
				reason: expect.stringMatching(/^billing: 403 .*monthly usage limit.* until \d{4}-/),
				until: expect.any(Number),
			},
		]);
	});

	it("(b) restores a provider after its cooldown expires", async () => {
		await runProcess(
			stateDir.path(),
			`exhaustion.coolDownExhaustedProvider("deepseek", { reason: "402 Insufficient Balance" });
			exhaustion.coolDownExhaustedProvider("kimi-code", { reason: "403 monthly usage limit", now: Date.now() - ${2 * HOUR_MS} });
			return true;`,
		);
		const picked = (await runProcess(stateDir.path(), "return pick();")) as {
			order: string[];
			exclusions: Array<{ provider: string }>;
		};

		expect(picked.order).toEqual(["kimi-code", "codex-lb"]);
		expect(picked.exclusions.map(exclusion => exclusion.provider)).toEqual(["deepseek"]);
	});

	it("leaves minute-scale token throttles and informative 402s out of the long ban", async () => {
		const result = await runProcess(
			stateDir.path(),
			`return {
				dashscope: exhaustion.isProviderExhaustionError(429, "You exceeded your current quota, please check your plan and billing details. For more information, see https://help.aliyun.com/zh/model-studio/error-code#token-limit"),
				subscription: exhaustion.isProviderExhaustionError(402, "A subscription is required for this endpoint"),
				balance: exhaustion.isProviderExhaustionError(402, "Insufficient Balance"),
			};`,
		);

		expect(result).toEqual({ dashscope: false, subscription: false, balance: true });
	});

	it("does not lose a concurrent process's cooldown", async () => {
		const providers = ["p1", "p2", "p3", "p4", "p5", "p6"];
		await Promise.all(
			providers.map(provider =>
				runProcess(
					stateDir.path(),
					`exhaustion.coolDownExhaustedProvider(${JSON.stringify(provider)}, { reason: "402 Insufficient Balance" }); return true;`,
				),
			),
		);
		const cooled = (await runProcess(
			stateDir.path(),
			`return ${JSON.stringify(providers)}.filter(provider => exhaustion.isProviderExhausted(provider));`,
		)) as string[];

		expect(cooled).toEqual(providers);
	});

	it("treats an unwritable state directory as best effort", async () => {
		const blocker = path.join(stateDir.path(), "not-a-directory");
		await Bun.write(blocker, "file");
		const result = await runProcess(
			path.join(blocker, "state"),
			`let threw = false;
			try { exhaustion.coolDownExhaustedProvider("deepseek", { reason: "402 Insufficient Balance" }); } catch { threw = true; }
			return { threw, cooled: exhaustion.isProviderExhausted("deepseek") };`,
		);

		expect(result).toEqual({ threw: false, cooled: false });
	});

	it("(c) keeps rate limits short and plain 403 authentication errors unbanned", async () => {
		const result = await runProcess(
			stateDir.path(),
			`logProviderTurnError({ stopReason: "error", provider: "codex-lb", model: "gpt-5.5", errorStatus: 429, errorMessage: "429 rate_limit_error retry-after-ms=1000" });
			logProviderTurnError({ stopReason: "error", provider: "kimi-code", model: "kimi-for-coding", errorStatus: 403, errorMessage: "permission_error: invalid api key" });
			return { billing429: exhaustion.isProviderExhaustionError(429, "429 rate_limit_error"), auth403: exhaustion.isProviderExhaustionError(403, "permission_error: invalid api key"), ...pick() };`,
		);

		expect(result).toEqual({
			billing429: false,
			auth403: false,
			order: ["deepseek", "kimi-code", "codex-lb"],
			exclusions: [],
		});
	});

	it("classifies a daily-quota 429 present only in the message", () => {
		const message = "429 Rate limit exceeded: free-models-per-day-high-balance. retry-after-ms=17354298";
		return runProcess(
			stateDir.path(),
			`return { embedded: exhaustion.isProviderExhaustionError(undefined, ${JSON.stringify(message)}), plain: exhaustion.isProviderExhaustionError(undefined, "429 rate_limit_error") };`,
		).then(result => expect(result).toEqual({ embedded: true, plain: false }));
	});

	it("cools daily-quota 429 until retry-after and skips it in the next process", async () => {
		const message = "429 Rate limit exceeded: free-models-per-day-high-balance. retry-after-ms=17354298";
		const recorded = (await runProcess(
			stateDir.path(),
			`const now = Date.now();
			logProviderTurnError({ stopReason: "error", provider: "openrouter", model: "dots-studio/dots-3-note-preview:free", errorStatus: 429, errorMessage: ${JSON.stringify(message)} });
			return { now, classified: exhaustion.isProviderExhaustionError(429, ${JSON.stringify(message)}), record: exhaustion.providerExhaustionRecord("openrouter") };`,
		)) as { now: number; classified: boolean; record?: { until: number; recordedAt: number } };
		expect(recorded.classified).toBe(true);
		expect(recorded.record).toBeDefined();
		// Measure from recordedAt so slow logging/persistence cannot flake the bound.
		expect(recorded.record!.until - recorded.record!.recordedAt).toBe(17_354_298);
		const picked = await runProcess(
			stateDir.path(),
			`context.chains.default = ["openrouter/dots-studio/dots-3-note-preview:free", "codex-lb/gpt-5.5"]; return pick();`,
		);
		expect(picked).toEqual({
			order: ["codex-lb"],
			exclusions: [expect.objectContaining({ provider: "openrouter", until: recorded.record!.until })],
		});
	});

	it("classifies long retry windows and quota messages but leaves two-second 429 unbanned", async () => {
		const result = await runProcess(
			stateDir.path(),
			`logProviderTurnError({ stopReason: "error", provider: "deepseek", model: "deepseek-v4-pro", errorStatus: 429, errorMessage: "429 Rate limit exceeded retry-after-ms=2000" });
			logProviderTurnError({ stopReason: "error", provider: "openrouter", model: "free", errorStatus: 429, errorMessage: "daily quota exceeded" });
			const record = exhaustion.providerExhaustionRecord("openrouter");
			return { long: exhaustion.isProviderExhaustionError(429, "rate limited retry-after-ms=600000"), short: exhaustion.isProviderExhaustionError(429, "rate limited retry-after-ms=2000"), fallback: record ? record.until - record.recordedAt : null, ...pick() };`,
		);
		expect(result).toEqual({
			long: true,
			short: false,
			fallback: HOUR_MS,
			order: ["deepseek", "kimi-code", "codex-lb"],
			exclusions: [],
		});
	});
});
