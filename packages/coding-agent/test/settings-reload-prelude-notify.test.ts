/**
 * A persisted-layer re-read (`reloadFromDisk`, and so `/refresh settings`) must
 * notify `onEffectiveChange` listeners for `browser.enabled` / `computer.enabled`.
 *
 * The `set`/`override` mutators notify per-path already, but `reloadFromDisk`
 * replaces whole layers at once and emitted only a hard-coded pair of paths
 * (`modelRoles`, `statusLine.sessionAccent`) plus the `SETTING_HOOKS` registry.
 * Neither prelude setting is in either, so the listener in `AgentSession` that
 * rebuilds the system prompt (which states which eval preludes are callable)
 * and reconciles the browser-MCP server filter never ran on a persisted config
 * edit — the refresh reported success while the session kept the old preludes.
 *
 * These settings are deliberately NOT `SETTING_HOOKS` entries: those are
 * process-global side effects (theme, symbols, credential redaction), while
 * these need the per-session instance. So the fix routes both paths through the
 * per-instance effective-change registry the reload already consults.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("Settings.reloadFromDisk: eval-prelude enable settings notify their listeners", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-settings-prelude-notify-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.close();
		// Disarms every constructed instance's debounced saves, so no background
		// write can race the temp-dir removal below — no wall-clock wait needed.
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir?.remove();
	});

	const writeSettings = async (values: Record<string, unknown>) => {
		await Bun.write(path.join(agentDir, "config.yml"), YAML.stringify(values, null, 2));
	};

	/** Records every effective-change notification the reload emits. */
	const observe = (settings: Settings) => {
		const seen: Array<{ path: SettingPath; value: unknown; previous: unknown }> = [];
		const unsubscribe = settings.onEffectiveChange((path, value, previous) => {
			seen.push({ path, value, previous });
		});
		return { seen, unsubscribe };
	};

	it("notifies the browser.enabled listener when a persisted edit turns it off", async () => {
		// `browser.enabled` defaults true, so stage the explicit value first and
		// observe a real on-disk transition.
		await writeSettings({ browser: { enabled: true } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			// A no-op reload notifies nobody, so prompt caching keeps hitting.
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ browser: { enabled: false } });
			await settings.reloadFromDisk();

			expect(settings.get("browser.enabled")).toBe(false);
			// Pre-fix: `reloadFromDisk` emitted only `modelRoles` /
			// `statusLine.sessionAccent` and the `SETTING_HOOKS` keys, none of which
			// is `browser.enabled` — so the AgentSession listener that rebuilds the
			// prompt and reconciles browser MCP filtering never fired.
			expect(seen).toEqual([{ path: "browser.enabled", value: false, previous: true }]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the browser.enabled listener when a persisted edit turns it back on", async () => {
		await writeSettings({ browser: { enabled: false } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await writeSettings({ browser: { enabled: true } });
			await settings.reloadFromDisk();

			expect(settings.get("browser.enabled")).toBe(true);
			expect(seen).toEqual([{ path: "browser.enabled", value: true, previous: false }]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the computer.enabled listener on a persisted edit", async () => {
		// The sibling prelude setting: same listener, same omission.
		await writeSettings({ computer: { enabled: false } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ computer: { enabled: true } });
			await settings.reloadFromDisk();

			expect(settings.get("computer.enabled")).toBe(true);
			expect(seen).toEqual([{ path: "computer.enabled", value: true, previous: false }]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies both prelude settings when one reload moves each", async () => {
		await writeSettings({ browser: { enabled: true }, computer: { enabled: false } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await writeSettings({ browser: { enabled: false }, computer: { enabled: true } });
			await settings.reloadFromDisk();

			expect(seen.map(entry => entry.path).sort()).toEqual(["browser.enabled", "computer.enabled"]);
		} finally {
			unsubscribe();
		}
	});

	it("still notifies modelRoles from a persisted reload", async () => {
		// Positive control on the paths the reload already emitted: the registry
		// refactor must not drop them.
		await writeSettings({ modelRoles: { default: "openai/original" } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await writeSettings({ modelRoles: { default: "openai/updated" } });
			await settings.reloadFromDisk();

			expect(settings.getModelRole("default")).toBe("openai/updated");
			expect(seen.map(entry => entry.path)).toEqual(["modelRoles"]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the browser.idleCloseSec listener when a persisted edit disables idle close", async () => {
		// Same omission, different consequence: this setting's listener cancels
		// and re-arms the per-owner idle-close deadline, which is state ALREADY
		// ARMED on live tabs rather than read at next use. Unnotified, a
		// persisted edit updated the merged value while armed timers kept the old
		// schedule — most visibly on a change to `0`, where a tab still closed
		// after idle closing was switched off.
		await writeSettings({ browser: { idleCloseSec: 300 } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ browser: { idleCloseSec: 0 } });
			await settings.reloadFromDisk();

			expect(settings.get("browser.idleCloseSec")).toBe(0);
			expect(seen).toEqual([{ path: "browser.idleCloseSec", value: 0, previous: 300 }]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the workspace.additionalDirectories listener when a persisted edit adds a root", async () => {
		// Startup copies these roots OUT of settings into `SessionManager`, which
		// owns them afterwards: tool access and `rebuildSystemPrompt` both read
		// `sessionManager.getAdditionalDirectories()`. Unnotified, the merged value
		// gained the root while the live session kept the launch-time list, so the
		// new root stayed unusable and unadvertised until `/new` or a restart.
		await writeSettings({ workspace: { additionalDirectories: [] } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			const added = tempDir.join("extra-root");
			fs.mkdirSync(added, { recursive: true });
			await writeSettings({ workspace: { additionalDirectories: [added] } });
			await settings.reloadFromDisk();

			expect(seen).toEqual([{ path: "workspace.additionalDirectories", value: [added], previous: [] }]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the async.maxJobs listener when a persisted edit changes the cap", async () => {
		// `AsyncJobManager` takes this value at construction; `atCapacity` and
		// `register()` enforce the stored field. Unnotified, a refresh reported the
		// new configuration while background-job admission kept the launch value.
		await writeSettings({ async: { maxJobs: 4 } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ async: { maxJobs: 9 } });
			await settings.reloadFromDisk();

			expect(seen).toEqual([{ path: "async.maxJobs", value: 9, previous: 4 }]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the image URL listeners when a persisted edit changes serving", async () => {
		// Same shape as the snapcompact transformer: the request path closes over
		// an `ImageUrlService` built at construction. Unnotified, an enable never
		// started serving, and a backend or credential change kept publishing
		// through the retired remote configuration while the refresh reported the
		// new settings.
		await writeSettings({ images: { urls: { enabled: false, ttlHours: 4 } } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ images: { urls: { enabled: true, ttlHours: 9 } } });
			await settings.reloadFromDisk();

			// Every key of the group feeds the service's construction, so a change
			// to a non-enablement key has to notify too.
			expect(seen.map(entry => entry.path).sort()).toEqual(["images.urls.enabled", "images.urls.ttlHours"]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the snapcompact listeners when a persisted edit changes rendering", async () => {
		// The request path closes over a `SnapcompactInlineTransformer` built at
		// construction. Unnotified, a refresh updated the merged value (so
		// `/context` estimates moved) while the live session kept rendering under
		// the launch-time configuration.
		await writeSettings({ snapcompact: { toolResults: false, shape: "5x8-sent" } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ snapcompact: { toolResults: true, shape: "8on16-bw" } });
			await settings.reloadFromDisk();

			expect(seen).toEqual([
				{ path: "snapcompact.toolResults", value: true, previous: false },
				{ path: "snapcompact.shape", value: "8on16-bw", previous: "5x8-sent" },
			]);
		} finally {
			unsubscribe();
		}
	});

	it("notifies the snapcompact.systemPrompt listener when a persisted edit changes the mode", async () => {
		await writeSettings({ snapcompact: { systemPrompt: "none" } });
		const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		const { seen, unsubscribe } = observe(settings);

		try {
			await settings.reloadFromDisk();
			expect(seen).toEqual([]);

			await writeSettings({ snapcompact: { systemPrompt: "all" } });
			await settings.reloadFromDisk();

			expect(seen).toEqual([{ path: "snapcompact.systemPrompt", value: "all", previous: "none" }]);
		} finally {
			unsubscribe();
		}
	});
});
