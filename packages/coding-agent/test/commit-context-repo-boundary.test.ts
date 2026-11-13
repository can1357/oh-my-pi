import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runAgenticCommit } from "@oh-my-pi/pi-coding-agent/commit/agentic";
import * as commitAgent from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as modelSelection from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/discovery";
import * as sdk from "@oh-my-pi/pi-coding-agent/sdk";
import { cfgContextStopAtRepoRoot } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import * as utils from "@oh-my-pi/pi-utils";

let temp: utils.TempDir | undefined;
let authStorage: AuthStorage | undefined;

afterEach(async () => {
	authStorage?.close();
	authStorage = undefined;
	vi.restoreAllMocks();
	resetCapabilityForTests();
	await temp?.remove();
	temp = undefined;
});

describe("agentic commit context repository boundary", () => {
	it("honors local settings without initializing the capability registry", async () => {
		temp = await utils.TempDir.create("@omp-commit-context-boundary-");
		const home = temp.join("home");
		const workspace = path.join(home, "workspace");
		const repoRoot = path.join(workspace, "repo");
		const cwd = path.join(repoRoot, "src");
		const repoAgents = path.join(repoRoot, "AGENTS.md");
		const workspaceClaude = path.join(workspace, "CLAUDE.md");
		await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(repoAgents, "commit-repository-instructions");
		await Bun.write(workspaceClaude, "commit-workspace-instructions");
		vi.spyOn(os, "homedir").mockReturnValue(home);
		vi.spyOn(utils, "getProjectDir").mockReturnValue(cwd);
		const settings = Settings.isolated({ context: { stopAtRepoRoot: true } });
		vi.spyOn(Settings, "init").mockResolvedValue(settings);
		authStorage = await AuthStorage.create(temp.join("auth.db"));
		vi.spyOn(sdk, "discoverAuthStorage").mockResolvedValue(authStorage);
		vi.spyOn(sdk, "loadCliExtensionProviders").mockResolvedValue(undefined);
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({
			model: getBundledModel("openai", "gpt-4o-mini"),
			apiKey: "fixture-key",
		});
		vi.spyOn(vcs, "requireGit").mockReturnValue({
			changedFiles: async () => ["src/feature.ts"],
			numstat: async () => [{ path: "src/feature.ts", added: 1, removed: 0 }],
			diffText: async () => "diff --git a/src/feature.ts b/src/feature.ts\n+export const feature = true;\n",
		} as unknown as VcsGitRepo);
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const observedContext: string[][] = [];
		vi.spyOn(commitAgent, "runCommitAgentSession").mockImplementation(async input => {
			observedContext.push((input.contextFiles ?? []).map(file => file.path));
			return {};
		});

		resetCapabilityForTests();
		await runAgenticCommit({ noChangelog: true, push: false, dryRun: true });
		expect(observedContext[0]).toContain(repoAgents);
		expect(observedContext[0]).not.toContain(workspaceClaude);

		cfgContextStopAtRepoRoot.override(settings, false);
		await runAgenticCommit({ noChangelog: true, push: false, dryRun: true });
		expect(observedContext[1]).toContain(repoAgents);
		expect(observedContext[1]).toContain(workspaceClaude);
	});
});
