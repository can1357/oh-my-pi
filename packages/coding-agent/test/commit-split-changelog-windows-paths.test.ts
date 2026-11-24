/**
 * A split commit plan that carries changelog entries must validate on Windows,
 * where `path.relative` returns backslash paths while git reports `/` paths
 * (issue #17446). The Windows case runs on a Windows host, where path.relative and
 * path.sep are win32's. The POSIX case uses a literal backslash in a directory name,
 * which git reports as-is.
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

function makeWorkspace(pkgs: string[]): string {
	const dir = fs.realpathSync(fs.mkdtempSync(nodePath.join(os.tmpdir(), "omp-commit-changelog-paths-")));
	for (const pkg of pkgs) {
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

/** Runs a split plan with one commit and one changelog entry per package, and expects it to validate. */
async function expectSplitPlanValidates(pkgs: string[]): Promise<void> {
	workspace = makeWorkspace(pkgs);
	originalProjectDir = getProjectDir();
	setProjectDir(workspace);

	// git reports repo-relative paths with `/` on every platform.
	const stagedFiles = pkgs.flatMap(pkg => [`packages/${pkg}/CHANGELOG.md`, `packages/${pkg}/src/main.ts`]);
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
				commits: pkgs.map(pkg => ({
					changes: [{ path: `packages/${pkg}/src/main.ts`, kind: "all" }],
					type: "fix",
					scope: pkg,
					summary: `fix package ${pkg}`,
					details: [],
					issueRefs: [],
					dependencies: [],
				})),
				warnings: [],
			},
			changelogProposal: { entries: pkgs.map(pkg => changelogEntry(pkg)) },
		} as never);
	}) as never);

	const result = await runAgenticCommit({ noChangelog: false, push: false, dryRun: true });

	expect(result).toEqual({ usedFallback: false });
}

describe("runAgenticCommit split plan with changelog entries (issue #17446)", () => {
	// node:path's sep cannot be swapped on a POSIX host without mock.module, which leaks across
	// test files (AGENTS.md), so this case runs only where path.sep and path.relative are win32's.
	it.skipIf(process.platform !== "win32")("validates a split plan whose changelog paths are on Windows", async () => {
		await expectSplitPlanValidates(["a", "b"]);
	});

	it("validates a split plan whose changelog path has a literal backslash in a POSIX directory name", async () => {
		// POSIX allows a backslash in a directory name, and git reports that name as-is.
		await expectSplitPlanValidates(["c\\d"]);
	});
});
