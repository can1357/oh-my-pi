import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MailboxService, type MailboxPeer, type MailboxTargetState } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { cfgIrcCrossProcess } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

afterEach(() => {
	vi.restoreAllMocks();
});

function harness(options: { enabled?: boolean; receiving?: boolean; error?: string; peers?: MailboxPeer[] } = {}) {
	const settings = Settings.isolated();
	if (options.enabled) cfgIrcCrossProcess.set(settings, true);
	const whenSettled = vi.fn(async () => {});
	const state = vi.fn((agentId: string): MailboxTargetState => {
		expect(agentId).toBe("acp:conversation");
		if (!cfgIrcCrossProcess.get(settings)) return { enabled: false };
		if (options.error) {
			return { enabled: true, address: "work-1234abcd.abcdef12", receiving: false, error: options.error };
		}
		return { enabled: true, address: "work-1234abcd.abcdef12", receiving: options.receiving ?? true };
	});
	const listPeers = vi.fn(async () => options.peers ?? []);
	vi.spyOn(MailboxService, "global").mockReturnValue({ whenSettled, state, listPeers } as unknown as MailboxService);
	const output = vi.fn();
	const runtime = {
		settings,
		session: { getAgentId: () => "acp:conversation" },
		output,
	} as unknown as SlashCommandRuntime;
	return { settings, runtime, output, whenSettled, state, listPeers };
}

describe("/peers headless command", () => {
	it("enables peers for this session and then reports the same status without persisting", async () => {
		const h = harness();
		expect(await executeAcpBuiltinSlashCommand("/peers on", h.runtime)).toEqual({ consumed: true });
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(true);
		expect(h.settings.getGlobalSettings()).toEqual({});
		expect(h.output).toHaveBeenLastCalledWith("Peers: on — this session is work-1234abcd.abcdef12");
		await executeAcpBuiltinSlashCommand("/peers status", h.runtime);
		expect(h.output).toHaveBeenLastCalledWith("Peers: on — this session is work-1234abcd.abcdef12");
		expect(h.whenSettled).toHaveBeenCalledTimes(2);
	});

	it("overrides a persisted on value without changing it or another session", async () => {
		const h = harness({ enabled: true });
		const other = Settings.isolated();
		cfgIrcCrossProcess.set(other, true);
		await executeAcpBuiltinSlashCommand("/peers off", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Peers: off");
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(false);
		expect(h.settings.getGlobalSettings()).toEqual({ irc: { crossProcess: true } });
		expect(cfgIrcCrossProcess.get(other)).toBe(true);
		cfgIrcCrossProcess.set(h.settings, false);
		cfgIrcCrossProcess.set(h.settings, true);
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(false);
	});

	it("treats bare peers as status rather than a toggle", async () => {
		const h = harness();
		await executeAcpBuiltinSlashCommand("/peers", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Peers: off");
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(false);
		expect(h.settings.getGlobalSettings()).toEqual({});
	});

	it("resolves a root session without an explicit agent id as Main", async () => {
		const h = harness();
		vi.spyOn(h.runtime.session, "getAgentId").mockReturnValue(undefined);
		h.state.mockReturnValue({ enabled: false });
		await executeAcpBuiltinSlashCommand("/peers status", h.runtime);
		expect(h.state).toHaveBeenCalledWith("Main");
		expect(h.output).toHaveBeenCalledWith("Peers: off");
	});

	it("trims arguments and accepts case-insensitive subcommands", async () => {
		const h = harness();
		await executeAcpBuiltinSlashCommand("/peers   ON  ", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Peers: on — this session is work-1234abcd.abcdef12");
	});

	it("does not read or output state until publication settles", async () => {
		const h = harness();
		const settled = Promise.withResolvers<void>();
		h.whenSettled.mockImplementation(() => settled.promise);
		const command = executeAcpBuiltinSlashCommand("/peers on", h.runtime);
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(true);
		expect(h.state).not.toHaveBeenCalled();
		expect(h.output).not.toHaveBeenCalled();
		settled.resolve();
		await command;
		expect(h.output).toHaveBeenCalledWith("Peers: on — this session is work-1234abcd.abcdef12");
	});

	it("reports send-only mode", async () => {
		const h = harness({ enabled: true, receiving: false });
		await executeAcpBuiltinSlashCommand("/peers status", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Peers: on (send-only) — this session is work-1234abcd.abcdef12");
	});

	it("reports receiving failures after enabling", async () => {
		const h = harness({ error: "permission denied" });
		await executeAcpBuiltinSlashCommand("/peers on", h.runtime);
		expect(h.output).toHaveBeenCalledWith("Peers: on, but receiving failed — permission denied");
	});

	it("prints one row per peer with optional titles and activity", async () => {
		const h = harness({
			peers: [
				{
					address: "project-1234abcd",
					id: "first",
					pid: 1,
					cwd: "D:/project",
					conversation: null,
					title: "A session",
					busy: true,
				},
				{
					address: "other-87654321.abcdef12",
					id: "second",
					pid: 2,
					cwd: "/tmp/other",
					conversation: "abcdef12",
					title: null,
					busy: false,
				},
			],
		});
		await executeAcpBuiltinSlashCommand("/peers list", h.runtime);
		expect(h.output).toHaveBeenCalledWith(
			'project-1234abcd  D:/project  "A session"  busy\nother-87654321.abcdef12  /tmp/other  idle',
		);
		expect(h.state).not.toHaveBeenCalled();
	});

	it("reports an empty peer list", async () => {
		const h = harness();
		await executeAcpBuiltinSlashCommand("/peers list", h.runtime);
		expect(h.output).toHaveBeenCalledWith("No other omp processes have peers on.");
	});

	it("rejects unknown commands and extra arguments without mutating settings", async () => {
		const h = harness();
		for (const arg of ["toggle", "bogus", "on off", "status extra", "list extra"]) {
			expect(await executeAcpBuiltinSlashCommand(`/peers ${arg}`, h.runtime)).toEqual({ consumed: true });
		}
		expect(h.output).toHaveBeenCalledTimes(5);
		for (const call of h.output.mock.calls) expect(call).toEqual(["Usage: /peers [on|off|status|list]"]);
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(false);
		expect(h.whenSettled).not.toHaveBeenCalled();
		expect(h.listPeers).not.toHaveBeenCalled();
	});
});
