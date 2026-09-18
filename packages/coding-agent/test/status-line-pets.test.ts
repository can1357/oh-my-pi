import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { CollabSessionState } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { StatusLineTestComponents } from "./helpers/status-line";

let settingsState: SettingsTestState | undefined;
const components = new StatusLineTestComponents();

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	settings.set("git.enabled", false);
	await initTheme();
});

afterEach(() => {
	components.dispose();
	vi.useRealTimers();
	// Shared cleanup restores all spies, including Date.now, before resetting settings.
	restoreSettingsTestState(settingsState);
});

function fixture(createdAt = "2020-01-01T00:00:00Z", sessionId = "pet-session") {
	const state = { tokens: 0, isStreaming: false, contextUsageRevision: 0 };
	const session = {
		state: {},
		get isStreaming() {
			return state.isStreaming;
		},
		get contextUsageRevision() {
			return state.contextUsageRevision;
		},
		settings,
		model: { contextWindow: 100_000 },
		sessionManager: {
			getSessionId: () => sessionId,
			getHeader: () => ({ timestamp: createdAt }),
		},
		getContextUsage: () => ({ tokens: state.tokens, contextWindow: 100_000 }),
	} as unknown as AgentSession;
	const component = components.track(new StatusLineComponent(session, statusLineHost));
	component.updateSettings({ preset: "custom", leftSegments: [], rightSegments: [], showHookStatus: true });
	const render = (width = 120) => component.render(width).map(stripVTControlCharacters);
	const showWarning = vi.fn();
	const showStatus = vi.fn();
	const runtime = {
		ctx: {
			settings,
			statusLine: component,
			ui: { requestRender: () => render() },
			editor: { setText: () => {} },
			showStatus,
			showWarning,
		} as unknown as InteractiveModeContext,
		handleBackgroundCommand: () => {},
	};
	return { state, session, component, render, runtime, showWarning, showStatus };
}

describe("native status-line pets", () => {
	it("turns only the pet on and off through slash commands and rejects invalid arguments", async () => {
		const { component, render, runtime, showWarning } = fixture();
		component.setHookStatus("extension", "Extension is running");
		expect(render()).toEqual(["Extension is running"]);
		await executeBuiltinSlashCommand("/pets on", runtime);
		await executeBuiltinSlashCommand("/pets on", runtime);
		expect(render()).toHaveLength(2);
		expect(render()[1]).toContain("(=^.w.^=)");
		await executeBuiltinSlashCommand("/pets off extra", runtime);
		expect(showWarning).toHaveBeenCalled();
		expect(render()).toHaveLength(2);
		await executeBuiltinSlashCommand("/pets", runtime);
		expect(render()).toHaveLength(2);
		await executeBuiltinSlashCommand("/pets off", runtime);
		await executeBuiltinSlashCommand("/pets off", runtime);
		expect(render()).toEqual(["Extension is running"]);
		component.updateSettings({ showHookStatus: false });
		await executeBuiltinSlashCommand("/pets on", runtime);
		expect(render()).toHaveLength(1);
		expect(render()[0]).toContain("(=^.w.^=)");
	});

	it("lets collaboration guests toggle their local pet through the builtin dispatcher", async () => {
		const { render, runtime } = fixture();
		const guestRuntime = {
			...runtime,
			ctx: { ...runtime.ctx, collabGuest: {} } as unknown as InteractiveModeContext,
		};
		await executeBuiltinSlashCommand("/pets on", guestRuntime);
		expect(render()[0]).toContain("(=^.w.^=)");
		await executeBuiltinSlashCommand("/pets", guestRuntime);
		expect(render()[0]).toContain("(=^.w.^=)");
		await executeBuiltinSlashCommand("/pets off", guestRuntime);
		expect(render()).toEqual([]);
	});

	it("reports when a higher-priority setting prevents a requested switch", async () => {
		settings.override("statusLine.pets", true);
		const { render, runtime, showWarning, showStatus } = fixture();
		await executeBuiltinSlashCommand("/pets off", runtime);
		expect(render()[0]).toContain("(=^.w.^=)");
		expect(showStatus).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("higher-priority setting"));
	});

	it("tracks fresh, running, overloaded, compacted and focused sessions with stable narrow rendering", () => {
		let now = Date.parse("2026-09-16T00:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		settings.set("statusLine.pets", true);
		const { state, component, render } = fixture(new Date(now).toISOString());
		const fresh = render()[0];
		expect(fresh).toContain("(=^-.-^=)zZ");
		now += 10_000;
		expect(render()[0]).toBe(fresh);
		state.isStreaming = true;
		expect(render()[0]).toContain("(=^-.-^=)zZ");
		now += 110_000;
		expect(render()[0]).toContain("(=^-.-^=)c(_)");
		state.tokens = 85_000;
		state.contextUsageRevision++;
		expect(render()[0]).toContain("(=;x.x;=);;");
		state.tokens = 0;
		state.contextUsageRevision++;
		state.isStreaming = false;
		const idle = render()[0];
		expect(idle).toContain("(=^.w.^=)");
		now += 120_000;
		expect(render()[0]).not.toBe(idle);
		for (const width of [1, 8, 24, 80]) {
			expect(visibleWidth(component.render(width)[0]!)).toBeLessThanOrEqual(width);
		}
		const focused = fixture(new Date(now).toISOString(), "other-session");
		focused.state.tokens = 85_000;
		component.setSession(focused.session, "Worker");
		expect(render()[0]).toContain("(=;x.x;=);;");
		focused.state.tokens = 0;
		focused.state.contextUsageRevision++;
		expect(render()[0]).toContain("(=^-.-^=)zZ");
	});

	it("uses host context and activity for guests and falls back when host state is absent", () => {
		settings.set("statusLine.pets", true);
		const { state, component, render } = fixture();
		const host: CollabSessionState = {
			isStreaming: false,
			queuedMessageCount: 0,
			sessionName: "host",
			cwd: "/tmp",
			participants: [{ name: "Host", role: "host" }],
			contextUsage: { tokens: 85_000, contextWindow: 100_000, percent: 85 },
		};
		component.setCollabStatus({ role: "guest", participantCount: 2, stateOverride: host });
		expect(render()[0]).toContain("(=;x.x;=);;");

		// Host compaction wins over a stale, overloaded local replica, including 0%.
		state.tokens = 90_000;
		state.contextUsageRevision++;
		host.contextUsage = { tokens: 0, contextWindow: 100_000, percent: 0 };
		host.isStreaming = true;
		component.setCollabStatus({ role: "guest", participantCount: 2, stateOverride: host });
		expect(render()[0]).toContain("(=^-.-^=)c(_)");

		state.isStreaming = true;
		host.isStreaming = false;
		component.setCollabStatus({ role: "guest", participantCount: 2, stateOverride: host });
		expect(render()[0]).toContain("(=^.w.^=)");

		host.contextUsage = undefined;
		component.setCollabStatus({ role: "guest", participantCount: 2, stateOverride: host });
		expect(render()[0]).toContain("(=;x.x;=);;");

		state.tokens = 0;
		state.contextUsageRevision++;
		component.setCollabStatus(null);
		expect(render()[0]).toContain("(=^-.-^=)c(_)");
		state.isStreaming = false;
		expect(render()[0]).toContain("(=^.w.^=)");
	});

	it("refreshes an idle pet only when its text changes and stops refreshing after off or disposal", async () => {
		vi.useFakeTimers();
		let now = Date.parse("2026-09-16T00:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { component, render, runtime } = fixture(new Date(now).toISOString());
		const paints: string[][] = [];
		component.watchBranch(() => paints.push(render()));
		render();
		now += 15_000;
		vi.advanceTimersByTime(15_000);
		expect(paints).toEqual([]);
		await executeBuiltinSlashCommand("/pets on", runtime);
		now += 15_000;
		vi.advanceTimersByTime(15_000);
		expect(paints).toEqual([]);
		now += 90_000;
		vi.advanceTimersByTime(90_000);
		expect(paints).toHaveLength(1);
		expect(paints[0]?.[0]).toContain("(=^.w.^=)");
		await executeBuiltinSlashCommand("/pets off", runtime);
		now += 120_000;
		vi.advanceTimersByTime(120_000);
		expect(paints).toHaveLength(1);
		expect(render()).toEqual([]);
		await executeBuiltinSlashCommand("/pets on", runtime);
		now += 120_000;
		vi.advanceTimersByTime(120_000);
		expect(paints).toHaveLength(2);
		component.dispose();
		component.invalidate();
		expect(render()).toEqual([]);
		now += 120_000;
		vi.advanceTimersByTime(120_000);
		expect(paints).toHaveLength(2);
	});

	it("does not repaint unchanged text behind a menu and immediately releases the timer on a settings change", () => {
		settings.set("statusLine.pets", true);
		vi.useFakeTimers();
		let now = Date.parse("2026-09-16T00:00:00Z");
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const { component, render } = fixture();
		const repaint = vi.fn();
		const baselineTimers = vi.getTimerCount();
		component.watchBranch(repaint);
		render();
		expect(vi.getTimerCount()).toBe(baselineTimers + 1);
		now += 120_000;
		vi.advanceTimersByTime(120_000);
		expect(repaint).toHaveBeenCalledTimes(1);
		now += 15_000;
		vi.advanceTimersByTime(15_000);
		expect(repaint).toHaveBeenCalledTimes(1);
		// Settings menus update the component but do not render the underlying footer.
		settings.set("statusLine.pets", false);
		component.updateSettings({ showHookStatus: true });
		expect(vi.getTimerCount()).toBe(baselineTimers);
		settings.set("statusLine.pets", true);
		component.updateSettings({ showHookStatus: true });
		expect(vi.getTimerCount()).toBe(baselineTimers + 1);
		component.dispose();
		expect(vi.getTimerCount()).toBe(baselineTimers);
	});
});
