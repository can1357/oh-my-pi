import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

const sourceDir = path.join(import.meta.dir, "..", "src", "session");

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
		env: { ...process.env, PI_TEST_RUNTIME: "", PI_CODING_AGENT_DIR: stateDir, XDG_STATE_HOME: "" },
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

	it("skips balance and structured quota failures across processes without changing the chain", async () => {
		await runProcess(
			stateDir.path(),
			`
exhaustion.recordProviderFailure("deepseek", { status: 402 });
exhaustion.recordProviderFailure("kimi-code", { status: 403, code: "quota_exceeded" });
return null;`,
		);
		const picked = await runProcess(stateDir.path(), "return { ...pick(), configured: context.chains.default };");
		expect(picked).toMatchObject({
			order: ["codex-lb"],
			exclusions: [
				{ provider: "deepseek", reason: "provider unavailable (balance)" },
				{ provider: "kimi-code", reason: "provider unavailable (quota)" },
			],
			configured: ["deepseek/deepseek-v4-pro", "kimi-code/kimi-for-coding", "codex-lb/gpt-5.5"],
		});
	});

	it("restores a probed provider at its original fallback position", async () => {
		await runProcess(
			stateDir.path(),
			`
exhaustion.recordProviderFailure("deepseek", { status: 402 }, Date.now() - 400000);
exhaustion.recordProviderFailure("kimi-code", { code: "quota_exceeded" });
await exhaustion.probeUnavailableProviders(async record => ({ available: record.provider === "deepseek" }));
return null;`,
		);
		expect(await runProcess(stateDir.path(), "return pick();")).toMatchObject({
			order: ["deepseek", "codex-lb"],
			exclusions: [{ provider: "kimi-code" }],
		});
	});

	it("retains every provider when different processes record failures concurrently", async () => {
		const providers = ["p1", "p2", "p3", "p4", "p5", "p6"];
		await Promise.all(
			providers.map(provider =>
				runProcess(
					stateDir.path(),
					`exhaustion.recordProviderFailure(${JSON.stringify(provider)}, { status: 402 }); return null;`,
				),
			),
		);
		const unavailable = await runProcess(
			stateDir.path(),
			`return ${JSON.stringify(providers)}.filter(provider => exhaustion.isProviderExhausted(provider));`,
		);
		expect(unavailable).toEqual(providers);
	});

	it("keeps an unwritable store from masking the original provider failure", async () => {
		const blocker = path.join(stateDir.path(), "not-a-directory");
		await Bun.write(blocker, "file");
		const result = await runProcess(
			path.join(blocker, "state"),
			`
const persisted = exhaustion.recordProviderFailure("deepseek", { status: 402 });
return { persisted, unavailable: exhaustion.isProviderExhausted("deepseek") };`,
		);
		expect(result).toEqual({ persisted: false, unavailable: false });
	});
});
