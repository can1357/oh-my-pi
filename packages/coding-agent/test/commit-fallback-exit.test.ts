/**
 * The fallback commit path (agent failed / no proposal) must be signalled to
 * callers so a degraded numstat commit is distinguishable from a legitimate
 * single-commit decision (issue #7835).
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runAgenticCommit } from "@oh-my-pi/pi-coding-agent/commit/agentic";
import * as agentModule from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as modelSelection from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const NUMSTAT = [{ path: "src/a.ts", added: 1, removed: 0 }];
let authStorage: AuthStorage | undefined;

function mockModelResolution() {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
	vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({
		model: { name: "test-primary", provider: "test", id: "test" } as never,
		apiKey: "test-key",
	});
	vi.spyOn(modelSelection, "resolveSmolModel").mockResolvedValue({
		model: { name: "test-smol", provider: "test", id: "test" } as never,
		apiKey: "test-key",
		thinkingLevel: undefined,
	});
	return model;
}

async function setupRepoMocks() {
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	await authStorage.reload();
	vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());
	vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
	vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
	vi.spyOn(sdkModule, "discoverContextFiles").mockResolvedValue([]);
	const commitCreateSpy = vi.fn(async () => "0123456789abcdef0123456789abcdef01234567");
	vi.spyOn(vcs, "requireGit").mockReturnValue({
		changedFiles: async () => ["src/a.ts"],
		commitCreate: commitCreateSpy,
		diffText: async () => "",
		numstat: async () => NUMSTAT,
	} as unknown as VcsGitRepo);
	return commitCreateSpy;
}

afterEach(() => {
	authStorage?.close();
	authStorage = undefined;
	vi.restoreAllMocks();
	delete process.env.PI_COMMIT_TEST_FALLBACK;
});

describe("runAgenticCommit fallback signalling (issue #7835)", () => {
	it("reports usedFallback when the fallback commit path is forced", async () => {
		mockModelResolution();
		const commitCreateSpy = await setupRepoMocks();
		process.env.PI_COMMIT_TEST_FALLBACK = "true";

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(commitCreateSpy).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: true });
	});

	it("reports usedFallback when the commit agent throws before completing", async () => {
		mockModelResolution();
		const commitCreateSpy = await setupRepoMocks();
		vi.spyOn(agentModule, "runCommitAgentSession").mockRejectedValue(new Error("model unreachable"));

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(commitCreateSpy).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: true });
	});

	it("reports usedFallback when the agent completes without a proposal", async () => {
		mockModelResolution();
		const commitCreateSpy = await setupRepoMocks();
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({} as never);
		}) as never);

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(commitCreateSpy).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: true });
	});

	it("reports a clean run when the agent produces a proposal", async () => {
		mockModelResolution();
		const commitCreateSpy = await setupRepoMocks();
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({
				proposal: {
					analysis: { type: "fix", scope: "test", details: [], issueRefs: [] },
					summary: "fixed the thing",
					warnings: [],
				},
			} as never);
		}) as never);

		const result = await runAgenticCommit({ noChangelog: true, push: false, dryRun: false });

		expect(commitCreateSpy).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ usedFallback: false });
	});
});
