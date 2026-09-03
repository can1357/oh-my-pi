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

function snapshot(mode: "write" | "view"): CollabHostSnapshot {
	return {
		sessionId: "sess-tui",
		sessionName: "TUI Session",
		cwd: "/tmp/work/tui",
		pid: 42,
		startedAt: 1_700_000_000_000,
		participants: 2,
		mode,
		url: mode === "view" ? "https://collab.test/#view-fixture" : "https://collab.test/#write-fixture",
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
	it("requests write-mode hosts and renders their write URL and pid", async () => {
		const listSpy = vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot("write")]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list", harness.runtime);

		expect(handled).toBe(true);
		expect(listSpy).toHaveBeenCalledWith({ mode: "write" });
		const text = Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("collab.test/#write-fixture");
		expect(text).toContain("pid 42");
		expect(text).toContain("TUI Session (sess-tui)");
	});

	it("requests view-mode hosts and renders the view URL only", async () => {
		const listSpy = vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot("view")]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list view", harness.runtime);

		expect(handled).toBe(true);
		expect(listSpy).toHaveBeenCalledWith({ mode: "view" });
		const text = Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""));
		expect(text).toContain("collab.test/#view-fixture");
		expect(text).not.toContain("collab.test/#write-fixture");
	});

	it("accepts the CLI-spelled --view as an alias for list view", async () => {
		const listSpy = vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot("view")]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list --view", harness.runtime);

		expect(handled).toBe(true);
		expect(listSpy).toHaveBeenCalledWith({ mode: "view" });
		expect(Bun.stripANSI(String(harness.showStatus.mock.calls.at(-1)?.[0] ?? ""))).toContain(
			"collab.test/#view-fixture",
		);
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

	it("rejects unknown list arguments instead of silently listing write URLs", async () => {
		const listSpy = vi.spyOn(registry, "listCollabHosts").mockResolvedValue([snapshot("write")]);
		const harness = createHarness();

		const handled = await executeBuiltinSlashCommand("/collab list --json", harness.runtime);

		expect(handled).toBe(true);
		expect(listSpy).not.toHaveBeenCalled();
		const error = Bun.stripANSI(String(harness.showError.mock.calls.at(-1)?.[0] ?? ""));
		expect(error).toContain("Usage: /collab list [view]");
		expect(error).toContain("collab list --json");
		expect(harness.showStatus).not.toHaveBeenCalled();
	});
});
