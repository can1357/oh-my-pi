import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { StatusLineSegmentContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { StatusLineComponent } from "@oh-my-pi/pi-coding-agent/modes/components/status-line";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { VcsGitRepo, VcsGitRepoInfo, VcsHeadState, VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectAgentDir, getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession(extensionRunner?: { getStatusLineSegment: (id: string) => unknown }) {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		extensionRunner,
		sessionManager: {
			getSessionName: () => "extension segments test",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

describe("extension-registered status line segments", () => {
	it("renders an extension-registered segment id", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "my_widget" ? () => ({ content: "MY-WIDGET", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["my_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		expect(component.getTopBorder(80).content).toContain("MY-WIDGET");
	});

	it("omits an unregistered segment id while keeping registered siblings", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "my_widget" ? () => ({ content: "MY-WIDGET", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["not_a_real_segment", "my_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const content = component.getTopBorder(80).content;
		expect(content).toContain("MY-WIDGET");
		expect(content).not.toContain("not_a_real_segment");
	});

	it("does not consult the extension registry for a built-in id", () => {
		let calledWith: string | undefined;
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id => {
					calledWith = id;
					return () => ({ content: "SHOULD-NOT-APPEAR", visible: true });
				},
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const content = component.getTopBorder(80).content;
		expect(content).not.toContain("SHOULD-NOT-APPEAR");
		expect(calledWith).toBeUndefined();
	});

	it("treats a throwing extension segment as invisible while keeping registered siblings", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id => {
					if (id === "broken_widget")
						return () => {
							throw new Error("boom");
						};
					if (id === "my_widget") return () => ({ content: "MY-WIDGET", visible: true });
					return undefined;
				},
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["broken_widget", "my_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const content = component.getTopBorder(80).content;
		expect(content).toContain("MY-WIDGET");
		expect(content).not.toContain("boom");
	});

	it("does not dispatch an inherited Object.prototype key as a built-in segment", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "my_widget" ? () => ({ content: "MY-WIDGET", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			// "toString"/"constructor" resolve inherited members on a plain object;
			// they must be treated as unregistered, not dispatched as fake segments.
			leftSegments: ["toString", "constructor", "my_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const content = component.getTopBorder(80).content;
		expect(content).toContain("MY-WIDGET");
		expect(content).not.toContain("function");
		expect(content).not.toContain("[object");
	});

	it("renders an extension segment registered under a prototype-named id", () => {
		// An own-key built-in check must still let an extension claim an id that
		// collides with an Object.prototype member name.
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "toString" ? () => ({ content: "PROTO-WIDGET", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["toString"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		expect(component.getTopBorder(80).content).toContain("PROTO-WIDGET");
	});

	it("sanitizes row-breaking control characters from extension content", () => {
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "nl_widget" ? () => ({ content: "LINE1\nLINE2\tTAB", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["nl_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		const content = component.getTopBorder(80).content;
		expect(content).toContain("LINE1 LINE2 TAB");
		expect(content).not.toContain("\n");
		expect(content).not.toContain("\t");
	});
});

describe("extension status line segment context", () => {
	it("maps the internal render context onto the public StatusLineSegmentContext shape", () => {
		// No repository → deterministic null branch regardless of the host checkout.
		vi.spyOn(vcs, "repo").mockReturnValue(null);
		let captured: StatusLineSegmentContext | undefined;
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "probe"
						? (ctx: StatusLineSegmentContext) => {
								captured = ctx;
								return { content: "PROBE", visible: true };
							}
						: undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["probe"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.getTopBorder(80);
		expect(captured).toBeDefined();
		expect(captured?.width).toBe(80);
		// Mirrors the zeroed usage stats the mock session reports.
		expect(captured?.usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			cost: 0,
			tokensPerSecond: null,
		});
		expect(captured?.git).toEqual({ branch: null });
		expect(typeof captured?.activeMs).toBe("number");
	});
});

const fakeRefHead: VcsHeadState = {
	kind: "ref",
	branch: "feature/x",
	refName: "refs/heads/feature/x",
	commit: undefined,
};
const fakeRepoInfo: VcsGitRepoInfo = {
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	isReftable: false,
};
const fakeGitRepo = {
	headSync: () => fakeRefHead,
	linkedWorktree: () => null,
} as unknown as VcsGitRepo;
const fakeVcsRepo = {
	kind: () => "git",
	asGit: () => fakeGitRepo,
	asJj: () => null,
	root: () => fakeRepoInfo.repoRoot,
	watchTarget: () => fakeRepoInfo.headPath,
} as unknown as VcsRepo;

describe("git branch resolution for extension segments", () => {
	it("resolves the branch for a custom-only extension layout with no built-in git/pr segment", () => {
		vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
		vi.spyOn(vcs, "repo").mockReturnValue(fakeVcsRepo);
		let captured: StatusLineSegmentContext | undefined;
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "branch_probe"
						? (ctx: StatusLineSegmentContext) => {
								captured = ctx;
								return { content: "BRANCH", visible: true };
							}
						: undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["branch_probe"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.getTopBorder(80);
		expect(captured?.git).toEqual({ branch: "feature/x" });
	});

	it("does not resolve git for an unregistered id, avoiding work for stale config", () => {
		const repoSpy = vi.spyOn(vcs, "repo").mockReturnValue(fakeVcsRepo);
		const component = new StatusLineComponent(makeSession());
		component.updateSettings({
			preset: "custom",
			leftSegments: ["not_registered"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		component.getTopBorder(80);
		expect(repoSpy).not.toHaveBeenCalled();
	});

	it("installs a HEAD watcher so an extension branch segment refreshes on HEAD change", () => {
		vi.spyOn(vcs, "gitInfo").mockReturnValue(fakeRepoInfo);
		vi.spyOn(vcs, "repo").mockReturnValue(fakeVcsRepo);
		let watchCallback: (() => void) | undefined;
		const watchSpy = vi.spyOn(vcs, "watch").mockImplementation((_repo, onChange) => {
			watchCallback = onChange;
			return () => {};
		});
		const component = new StatusLineComponent(
			makeSession({
				getStatusLineSegment: id =>
					id === "branch_probe" ? () => ({ content: "BRANCH", visible: true }) : undefined,
			}),
		);
		component.updateSettings({
			preset: "custom",
			leftSegments: ["branch_probe"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		let repaints = 0;
		component.watchBranch(() => {
			repaints += 1;
		});
		// A custom-only registered extension layout must still install the watcher
		// so a later HEAD change invalidates the cached branch and repaints.
		expect(watchSpy).toHaveBeenCalled();
		expect(watchCallback).toBeDefined();
		watchCallback?.();
		expect(repaints).toBe(1);
	});
});

describe("registerStatusLineSegment end-to-end render", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-statusline-e2e-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	it("renders a segment registered by a real extension through a real ExtensionRunner", async () => {
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "seg.ts");
		fs.writeFileSync(
			extensionPath,
			`export default function(pi) {
				pi.registerStatusLineSegment("e2e_widget", () => ({ content: "E2E-WIDGET", visible: true }));
			}`,
		);

		const loaded = await loadExtensions([extensionPath], tempDir.path());
		expect(loaded.errors).toEqual([]);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		expect(runner.getStatusLineSegment("e2e_widget")).toBeDefined();

		const component = new StatusLineComponent(makeSession(runner));
		component.updateSettings({
			preset: "custom",
			leftSegments: ["e2e_widget"],
			rightSegments: [],
			separator: "powerline-thin",
		});

		expect(component.getTopBorder(80).content).toContain("E2E-WIDGET");
	});
});
