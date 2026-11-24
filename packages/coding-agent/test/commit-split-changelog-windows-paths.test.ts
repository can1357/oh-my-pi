/**
 * A split commit plan that carries changelog entries must validate on Windows,
 * where `path.relative` returns backslash paths while git reports `/` paths
 * (issue #17446). The relative computation runs under win32 semantics here.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { runAgenticCommit } from "@oh-my-pi/pi-coding-agent/commit/agentic";
import * as agentModule from "@oh-my-pi/pi-coding-agent/commit/agentic/agent";
import * as modelSelection from "@oh-my-pi/pi-coding-agent/commit/model-selection";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const CHANGELOG = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n## [1.0.0]\n\n### Fixed\n\n- old\n";

let authStorage: AuthStorage | undefined;
let workspace: string | undefined;
let originalProjectDir: string | undefined;

function makeWorkspace(): string {
	const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "omp-commit-changelog-paths-")));
	for (const pkg of ["a", "b"]) {
		fs.mkdirSync(nodePath.join(dir, "packages", pkg, "src"), { recursive: true });
		fs.writeFileSync(nodePath.join(dir, "packages", pkg, "CHANGELOG.md"), CHANGELOG);
	}
	return dir;
}

afterEach(() => {
	authStorage?.close();
	authStorage = undefined;
	vi.restoreAllMocks();
	if (originalProjectDir) setProjectDir(originalProjectDir);
	originalProjectDir = undefined;
	if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
	workspace = undefined;
});

describe("runAgenticCommit split plan with changelog entries (issue #17446)", () => {
	it("validates a split plan whose changelog paths are on Windows", async () => {
		workspace = makeWorkspace();
		originalProjectDir = getProjectDir();
		setProjectDir(workspace);

		// Windows path semantics for the relative computation in completeAgentCommitState.
		vi.spyOn(nodePath, "relative").mockImplementation(nodePath.win32.relative);

		// git reports repo-relative paths with `/` on every platform.
		const stagedFiles = [
			"packages/a/CHANGELOG.md",
			"packages/a/src/a.ts",
			"packages/b/CHANGELOG.md",
			"packages/b/src/b.ts",
		];
		authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		await authStorage.credentials.reload();
		vi.spyOn(Settings, "init").mockResolvedValue(Settings.isolated());
		vi.spyOn(ModelRegistry.prototype, "refresh").mockResolvedValue(undefined);
		vi.spyOn(sdkModule, "discoverAuthStorage").mockResolvedValue(authStorage);
		vi.spyOn(sdkModule, "discoverContextFiles").mockResolvedValue([]);
		vi.spyOn(sdkModule, "loadCliExtensionProviders").mockResolvedValue(undefined);
		vi.spyOn(modelSelection, "resolvePrimaryModel").mockResolvedValue({
			model: { name: "test-primary", provider: "test", id: "test" } as never,
			apiKey: "test-key",
		});
		vi.spyOn(vcs, "requireGit").mockReturnValue({
			changedFiles: async () => stagedFiles,
			diffText: async () => "",
			numstat: async () => [],
		} as unknown as VcsGitRepo);

		const changelogEntry = (pkg: string) => ({
			path: nodePath.join(workspace as string, "packages", pkg, "CHANGELOG.md"),
			entries: { Fixed: [`fixed the ${pkg} package`] },
		});
		vi.spyOn(agentModule, "runCommitAgentSession").mockImplementation((async (input: never) => {
			const { onComplete } = input as { onComplete: (state: never) => Promise<void> };
			await onComplete({
				splitProposal: {
					commits: [
						{
							changes: [{ path: "packages/a/src/a.ts", kind: "all" }],
							type: "fix",
							scope: "a",
							summary: "fix package a",
							details: [],
							issueRefs: [],
							dependencies: [],
						},
						{
							changes: [{ path: "packages/b/src/b.ts", kind: "all" }],
							type: "fix",
							scope: "b",
							summary: "fix package b",
							details: [],
							issueRefs: [],
							dependencies: [],
						},
					],
					warnings: [],
				},
				changelogProposal: { entries: [changelogEntry("a"), changelogEntry("b")] },
			} as never);
		}) as never);

		const result = await runAgenticCommit({ noChangelog: false, push: false, dryRun: true });

		expect(result).toEqual({ usedFallback: false });
	});
});
