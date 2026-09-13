import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { CollabHostSnapshot } from "@oh-my-pi/pi-coding-agent/collab/registry";
import * as registry from "@oh-my-pi/pi-coding-agent/collab/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type BuiltinSlashCommandRuntime,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function snapshot(over: Partial<CollabHostSnapshot> = {}): CollabHostSnapshot {
	return {
		instanceId: "0123456789abcdef",
		generation: 2,
		pid: 42,
		sessionId: "sess-tui",
		sessionName: "TUI Session",
		cwd: "/tmp/work/tui",
		model: { provider: "test", id: "model-1" },
		startedAt: 1_700_000_000_000,
		participants: 2,
		relayConnected: true,
		inputRequired: false,
		access: "control",
		...over,
	};
}

function createHarness() {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showError = vi.fn();
	const ctx = {
		editor: { setText },
		showStatus,
		showError,
		settings: { get: () => "" },
	} as unknown as InteractiveModeContext;
	return { ctx, setText, showStatus, showError, runtime: { ctx } as BuiltinSlashCommandRuntime };
}

describe("/collab list slash command", () => {
	it("reports a bounded safe error and accepts another command after listing fails", async () => {
		vi.spyOn(registry, "listCollabHosts").mockRejectedValue(new Error(`denied\n\x1b[2J${"x".repeat(1000)}`));
		const harness = createHarness();
		await executeBuiltinSlashCommand("/collab list", harness.runtime);
		const error = String(harness.showError.mock.calls.at(-1)?.[0] ?? "");
		expect(error).toContain("denied");
		expect(error).not.toMatch(/[\r\n\x1b]/);
		expect(error.length).toBeLessThanOrEqual(200);
		await executeBuiltinSlashCommand("/collab status", harness.runtime);
		expect(harness.showStatus).toHaveBeenCalled();
	});

	it("renders host identity and state without any link", async () => {
		const listSpy = vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot({ inputRequired: true })]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list", harness.runtime);

		expect(handled).toBe(true);
		expect(listSpy).toHaveBeenCalledTimes(1);
		const text = Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("TUI Session (sess-tui)");
		expect(text).toContain("gen 2");
		expect(text).toContain("test/model-1");
		expect(text).toMatch(/started \S+/);
		expect(text).toContain("pid 42");
		expect(text).toContain("1 guest");
		expect(text).toContain("input required");
		// The way to a link is the explicit CLI command, never an inline URL.
		expect(text).toContain("collab link 0123456789abcdef");
		expect(text).not.toMatch(/https?:\/\//);
	});

	it("points view-only hosts at the --view link command", async () => {
		vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot({ access: "view", relayConnected: false })]);
		const harness = createHarness();

		await executeBuiltinSlashCommand("/collab list", harness.runtime);

		const text = Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("collab link 0123456789abcdef --view");
		expect(text).toContain("relay reconnecting");
	});

	it("shows an empty-state message when no hosts are active", async () => {
		vi.spyOn(registry, "listCollabHosts").mockResolvedValue([]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list", harness.runtime);

		expect(handled).toBe(true);
		expect(Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""))).toContain(
			"No active Collab hosts",
		);
	});

	it("rejects list arguments instead of guessing at a link mode", async () => {
		const listSpy = vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot()]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list view", harness.runtime);

		expect(handled).toBe(true);
		expect(listSpy).not.toHaveBeenCalled();
		const error = Bun.stripANSI(String(harness.showError.mock.calls.at(-1)?.[0] ?? ""));
		expect(error).toContain("Usage: /collab list");
		expect(error).toContain("collab link");
		expect(harness.showStatus).not.toHaveBeenCalled();
	});
});
