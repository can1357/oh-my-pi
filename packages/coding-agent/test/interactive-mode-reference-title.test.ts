/**
 * The `#N` card asks its editor for a title on every frame. This drives the editor that a real `InteractiveMode`
 * builds, so it fails when the host wiring (not just the helpers) stops delivering a title for a number that was
 * never cached: the repository is unknown at start, the cache is empty, and only the two GitHub CLI calls are
 * replaced.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { DEFAULT_REPO_RESOLVED } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import * as ghView from "@oh-my-pi/pi-coding-agent/tools/gh-view";
import { resetForTests as resetCacheForTests } from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import {
	resetReferenceRepoAttempts,
	resetReferenceTitleFetches,
} from "@oh-my-pi/pi-coding-agent/tools/github-reference-title";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const ENV_KEYS = ["OMP_GITHUB_CACHE_DB", "GH_TOKEN", "GH_CONFIG_DIR"];

describe("InteractiveMode #N card title wiring", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let savedEnv: Record<string, string | undefined>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-reference-title-");
		process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir.path(), "github-cache.db");
		process.env.GH_CONFIG_DIR = path.join(tempDir.path(), "gh-config");
		process.env.GH_TOKEN = "token-one";
		resetCacheForTests();
		DEFAULT_REPO_RESOLVED.clear();
		resetReferenceRepoAttempts();
		resetReferenceTitleFetches();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetReferenceTitleFetches();
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		DEFAULT_REPO_RESOLVED.clear();
		resetCacheForTests();
		for (const key of ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("delivers the title of a number that was never cached, and repaints when it arrives", async () => {
		vi.spyOn(github, "text").mockResolvedValue("https://github.com/owner/example");
		vi.spyOn(ghView, "fetchPrViewFresh").mockImplementation(
			async () =>
				({
					rendered: "pr",
					sourceUrl: undefined,
					payload: { number: 11207, title: "Scoped advisor controls" },
				}) as never,
		);
		const repaint = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const resolve = mode.editor.referenceTitle;
		expect(resolve).toBeDefined();

		// First frame: nothing cached, repository unknown.
		expect(resolve!("pr", "11207")).toBeUndefined();
		const deadline = Date.now() + 5000;
		let title: string | undefined;
		while (title === undefined && Date.now() < deadline) {
			await Bun.sleep(50);
			title = resolve!("pr", "11207");
		}

		expect(title).toBe("Scoped advisor controls");
		expect(repaint).toHaveBeenCalled();
	});
});
