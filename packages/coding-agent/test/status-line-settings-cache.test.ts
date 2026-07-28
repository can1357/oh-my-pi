import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import {
	StatusLineComponent,
	type StatusLineSettings,
} from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line";
import { STATUS_LINE_PRESETS } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/status-line/presets";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import * as git from "@pk-nerdsaver-ai/pi-coding-agent/utils/git";
import { setProjectDir } from "@pk-nerdsaver-ai/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
let projectDir = "";

beforeEach(async () => {
	settingsState = beginSettingsTest();
	projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-status-line-settings-cache-"));
	setProjectDir(projectDir);
	await Settings.init({ inMemory: true, cwd: projectDir });
	await initTheme();
});

const createdComponents: StatusLineComponent[] = [];

afterEach(async () => {
	// Dispose every component first: a successful render can install an
	// fs.watch on the temp repo's HEAD, and Windows rejects rmSync (EBUSY)
	// while the watcher handle is open.
	for (const component of createdComponents.splice(0)) {
		component.dispose();
	}
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
	if (projectDir) {
		// An in-flight async git-status probe can briefly hold a handle inside
		// the temp dir on Windows; retry, then tolerate the leaked temp dir.
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				fs.rmSync(projectDir, { recursive: true, force: true });
				break;
			} catch {
				await Bun.sleep(50);
			}
		}
	}
	projectDir = "";
});

function makeSession(sessionName = "Cache Session") {
	const messages: unknown[] = [];
	const model = { id: "test-model", name: "Test Model", contextWindow: 100_000 };
	return {
		state: { messages, model },
		messages,
		model,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeEnabled: () => false,
		isFastModeActive: () => false,
		isAdvisorActive: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		settings: { get: () => false, isConfigured: () => false },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => sessionName,
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		getContextUsage: () => undefined,
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

function makeComponent(statusLineSettings: StatusLineSettings): StatusLineComponent {
	const component = new StatusLineComponent(makeSession());
	createdComponents.push(component);
	component.updateSettings(statusLineSettings);
	return component;
}

describe("StatusLineComponent effective settings cache", () => {
	it("keeps repeated cached renders byte-identical across presets and widths", () => {
		const cases: StatusLineSettings[] = [
			{ preset: "default", sessionAccent: false },
			{ preset: "minimal", sessionAccent: false },
			{
				preset: "custom",
				leftSegments: ["pi", "model"],
				rightSegments: ["session_name", "context_pct"],
				separator: "pipe",
				sessionAccent: false,
				segmentOptions: { model: { showThinkingLevel: false } },
			},
		];

		for (const statusLineSettings of cases) {
			const component = makeComponent(statusLineSettings);
			for (const width of [36, 120]) {
				const first = component.getTopBorder(width);
				const second = component.getTopBorder(width);
				expect(second).toEqual(first);
			}
		}
	});

	it("invalidates on updateSettings and reflects hook visibility changes", () => {
		const component = makeComponent({
			preset: "custom",
			leftSegments: ["pi"],
			rightSegments: [],
			separator: "none",
			showHookStatus: false,
		});
		const firstEffective = component.getEffectiveSettingsForTest();
		component.setHookStatus("lint", "lint running");
		expect(component.render(80)).toEqual([]);

		component.updateSettings({
			preset: "custom",
			leftSegments: ["session_name"],
			rightSegments: [],
			separator: "slash",
			showHookStatus: true,
			sessionAccent: false,
			segmentOptions: { path: { maxLength: 12 } },
		});

		const secondEffective = component.getEffectiveSettingsForTest();
		expect(secondEffective).not.toBe(firstEffective);
		expect(secondEffective.separator).toBe("slash");
		expect(secondEffective.sessionAccent).toBe(false);
		expect(secondEffective.segmentOptions.path?.maxLength).toBe(12);
		expect(stripVTControlCharacters(component.getTopBorder(80).content)).toContain("Cache Session");
		expect(component.render(80)).toEqual(["lint running"]);
	});

	it("preserves preset option siblings while user segment options win", () => {
		const component = makeComponent({
			preset: "default",
			segmentOptions: {
				path: { maxLength: 7 },
				git: { showUntracked: false },
			},
		});

		const effective = component.getEffectiveSettingsForTest();
		expect(effective.segmentOptions.path).toEqual({ abbreviate: true, maxLength: 7, stripWorkPrefix: true });
		expect(effective.segmentOptions.git?.showBranch).toBe(true);
		expect(effective.segmentOptions.git?.showStaged).toBe(true);
		expect(effective.segmentOptions.git?.showUnstaged).toBe(true);
		expect(effective.segmentOptions.git?.showUntracked).toBe(false);
	});

	it("uses custom segment arrays only for the custom preset", () => {
		const defaultComponent = makeComponent({ preset: "default", leftSegments: ["session_name"], rightSegments: [] });
		expect(defaultComponent.getEffectiveSettingsForTest().leftSegments).toEqual(
			STATUS_LINE_PRESETS.default.leftSegments,
		);

		const customComponent = makeComponent({ preset: "custom", leftSegments: [], rightSegments: [] });
		expect(customComponent.getEffectiveSettingsForTest().leftSegments).toEqual([]);
		expect(customComponent.getEffectiveSettingsForTest().rightSegments).toEqual([]);
		expect(customComponent.getTopBorder(120)).toEqual({ content: "", width: 0 });
	});

	it("keeps plan and hook state dynamic without settings invalidation", () => {
		const component = makeComponent({ preset: "custom", leftSegments: ["mode"], rightSegments: [] });
		const effective = component.getEffectiveSettingsForTest();
		expect(component.getTopBorder(80).content).toBe("");

		component.setPlanModeStatus({ enabled: true, paused: false });
		expect(stripVTControlCharacters(component.getTopBorder(80).content)).toContain("Plan");
		expect(component.getEffectiveSettingsForTest()).toBe(effective);

		component.setHookStatus("hook", "hook running");
		expect(component.render(80)).toEqual(["hook running"]);
		component.setHookStatus("hook", "hook done");
		expect(component.render(80)).toEqual(["hook done"]);
		expect(component.getEffectiveSettingsForTest()).toBe(effective);
	});

	it("does not mutate shared preset segment options during narrow renders", () => {
		const before = { ...STATUS_LINE_PRESETS.default.segmentOptions?.path };
		const component = makeComponent({ preset: "default", sessionAccent: false });

		component.getTopBorder(12);
		component.getTopBorder(200);

		expect(STATUS_LINE_PRESETS.default.segmentOptions?.path).toEqual(before);
		expect(component.getEffectiveSettingsForTest().segmentOptions.path).toEqual(before);
	});

	it("reuses the effective-settings object until settings change", () => {
		const component = makeComponent({ preset: "default", sessionAccent: false });
		const effective = component.getEffectiveSettingsForTest();

		for (let i = 0; i < 5; i++) {
			component.getTopBorder(100);
			expect(component.getEffectiveSettingsForTest()).toBe(effective);
		}

		component.updateSettings({ preset: "minimal", sessionAccent: false });
		const nextEffective = component.getEffectiveSettingsForTest();
		expect(nextEffective).not.toBe(effective);
		expect(component.getEffectiveSettingsForTest()).toBe(nextEffective);
	});
	it("skips git probes when git integration is disabled", async () => {
		const headSpy = spyOn(git.head, "resolveSync").mockReturnValue(null);
		const statusSpy = spyOn(git.status, "summary").mockResolvedValue({ staged: 0, unstaged: 0, untracked: 0 });
		const repoSpy = spyOn(git.repo, "resolveSync").mockReturnValue(null);
		try {
			Settings.instance.override("git.enabled", false);
			const component = makeComponent({
				preset: "custom",
				leftSegments: ["git", "pr"],
				rightSegments: [],
				sessionAccent: false,
			});

			component.watchBranch(() => {
				throw new Error("git watcher should not fire while git integration is disabled");
			});
			component.getTopBorder(100);
			await Promise.resolve();

			expect(repoSpy).not.toHaveBeenCalled();
			expect(headSpy).not.toHaveBeenCalled();
			expect(statusSpy).not.toHaveBeenCalled();
		} finally {
			repoSpy.mockRestore();
			statusSpy.mockRestore();
			headSpy.mockRestore();
		}
	});

	it("skips git probes when no git-backed segment is visible and nobody subscribed", async () => {
		const headSpy = spyOn(git.head, "resolveSync").mockReturnValue(null);
		const statusSpy = spyOn(git.status, "summary").mockResolvedValue({ staged: 0, unstaged: 0, untracked: 0 });
		const repoSpy = spyOn(git.repo, "resolveSync").mockReturnValue(null);
		try {
			const component = makeComponent({
				preset: "custom",
				leftSegments: ["pi"],
				rightSegments: ["session_name"],
				sessionAccent: false,
			});

			component.getTopBorder(100);
			await Promise.resolve();

			expect(repoSpy).not.toHaveBeenCalled();
			expect(headSpy).not.toHaveBeenCalled();
			expect(statusSpy).not.toHaveBeenCalled();
		} finally {
			repoSpy.mockRestore();
			statusSpy.mockRestore();
			headSpy.mockRestore();
		}
	});

	it("an explicit branch subscriber forces watching even without git-backed segments", async () => {
		// The composer's branch chip subscribes via watchBranch(); a checkout must
		// repaint the chip even when the status line renders no git segment.
		const repoSpy = spyOn(git.repo, "resolveSync").mockReturnValue(null);
		try {
			const component = makeComponent({
				preset: "custom",
				leftSegments: ["pi"],
				rightSegments: ["session_name"],
				sessionAccent: false,
			});

			component.watchBranch(() => {});
			await Promise.resolve();

			// The watcher setup path resolves the repository to find HEAD.
			expect(repoSpy).toHaveBeenCalled();
		} finally {
			repoSpy.mockRestore();
		}
	});
});
