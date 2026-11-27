import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import * as startupCache from "../src/modes/interactive/startup-cache";
import {
	beginStartupComposer,
	stopPendingStartupComposer,
	takeStartupComposerLease,
} from "../src/modes/startup-composer";
import { getCurrentThemeName, initTheme } from "../src/ui/theme/service";
import { StartupCache } from "../src/modes/interactive/startup-cache";
import { predictedStatusLine, type StatusPrediction } from "../src/modes/interactive/status-prediction";
import { effectiveStatusSettings, segmentView } from "../src/ui/status/segments";
import { createModeTerminal } from "./helpers/mode-terminal";

const prediction: StatusPrediction = {
	settings: { preset: "custom", leftSegments: ["pi", "model"], rightSegments: ["context_pct"] },
	facts: {
		model: { id: "prophet-9", name: "Prophet 9", thinking: true, contextWindow: 200_000 },
		thinkingLevel: "high",
		usingSubscription: true,
		autoCompact: true,
		fastMode: false,
		context: { tokens: 6_000, window: 200_000, percent: 3 },
	},
};

describe("startup cache status prediction", () => {
	let dir: TempDir | undefined;
	let cache: StartupCache | undefined;

	afterEach(() => {
		cache?.close();
		dir?.removeSync();
	});

	function open(): StartupCache {
		dir ??= TempDir.createSync("@pi-startup-cache-status-");
		cache = StartupCache.open(path.join(dir.path(), "composer.db"));
		return cache;
	}

	it("predicts the bar for the project it was written in and for projects that never ran", () => {
		open().writeStatus("/work/alpha", prediction);
		cache!.close();
		const reopened = open();
		expect(reopened.read("/work/alpha").status).toEqual(prediction);
		expect(reopened.read("/work/never-ran").status).toEqual(prediction);
	});

	it("keeps a project's own prediction over the newest one from elsewhere", () => {
		const store = open();
		store.writeStatus("/work/alpha", prediction);
		const beta = { ...prediction, facts: { ...prediction.facts, thinkingLevel: "low" } };
		store.writeStatus("/work/beta", beta);
		expect(store.read("/work/alpha").status?.facts.thinkingLevel).toBe("high");
		expect(store.read("/work/gamma").status?.facts.thinkingLevel).toBe("low");
	});

	it("remembers the screen mode for the next first frame; older entries start inline", () => {
		const store = open();
		const preferences: startupCache.StartupPreferences = {
			quiet: false,
			composerShape: "box",
			resizeScrollback: "rebuild",
			autocompleteMaxVisible: 5,
			vim: false,
			imeSafeCursor: false,
			screen: "fullscreen",
		};
		store.write("/work/alpha", preferences, {});
		expect(store.read("/work/alpha").preferences?.screen).toBe("fullscreen");
		// An entry written before the setting existed carries no screen field.
		const { screen: _screen, ...older } = preferences;
		store.write("/work/gamma", JSON.parse(JSON.stringify(older)), {});
		expect(store.read("/work/gamma").preferences?.screen).toBe("inline");
	});

	it("ignores a stored prediction that names segments the bar does not have", () => {
		const store = open();
		store.writeStatus("/work/alpha", {
			...prediction,
			settings: JSON.parse('{"leftSegments":["pi","retired_segment"]}'),
		});
		expect(store.read("/work/alpha").status).toBeUndefined();
	});
});

describe("interactive mode status prediction", () => {
	let dir: TempDir | undefined;
	let cache: StartupCache | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		cache?.close();
		dir?.removeSync();
		resetSettingsForTest();
	});

	it("caches what a fresh session's bar shows for the next launch", async () => {
		resetSettingsForTest();
		dir = TempDir.createSync("@pi-status-prediction-");
		cache = StartupCache.open(path.join(dir.path(), "composer.db"));
		vi.spyOn(startupCache, "sharedStartupCache").mockReturnValue(cache);
		await Settings.init({
			inMemory: true,
			cwd: dir.path(),
			overrides: { "statusLine.segmentOptions": { model: { showProvider: true } } },
		});
		authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(dir.path(), dir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		const term = createModeTerminal();
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, term.frame);
		await mode.init();

		const predicted = cache.read(getProjectDir()).status;
		expect(predicted?.facts.model?.id).toBe("claude-sonnet-4-5");
		expect(predicted?.facts.model?.contextWindow).toBe(model.contextWindow ?? undefined);
		// The cached bar carries the session's provider, not just the fixture-supplied one.
		const bar = predictedStatusLine(predicted!, dir.path());
		const label = segmentView("model", bar.facts(), effectiveStatusSettings(bar.settings()))
			?.spans.map(part => part.t)
			.join("");
		expect(label).toContain("anthropic/");
	});
});

describe("startup frame appearance", () => {
	let dir: TempDir | undefined;
	let cache: StartupCache | undefined;

	afterEach(async () => {
		stopPendingStartupComposer();
		vi.restoreAllMocks();
		cache?.close();
		dir?.removeSync();
		initTheme();
	});

	/** Start a startup frame on a fresh memory terminal against the temporary cache. */
	async function startFrame(cwd: string) {
		const term = createModeTerminal({ columns: 80, rows: 24 });
		beginStartupComposer({ driver: term.memory.options, version: "test", cwd, exit: () => {} });
		const lease = takeStartupComposerLease();
		if (!lease) throw new Error("no startup frame");
		await lease.ready;
		return { term, lease };
	}

	it("paints the next launch for the background the terminal reported", async () => {
		dir = TempDir.createSync("@pi-startup-appearance-");
		cache = StartupCache.open(path.join(dir.path(), "composer.db"));
		vi.spyOn(startupCache, "sharedStartupCache").mockReturnValue(cache);
		const cwd = dir.path();

		const first = await startFrame(cwd);
		expect(getCurrentThemeName()).toBe("dark");
		first.term.feed("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
		await first.term.settle();
		expect(cache.read(cwd).appearance).toBe("light");
		await first.lease.frame.shell.stop();
		first.term.dispose();

		const second = await startFrame(cwd);
		expect(getCurrentThemeName()).toBe("light");
		await second.lease.frame.shell.stop();
		second.term.dispose();
	});
});
