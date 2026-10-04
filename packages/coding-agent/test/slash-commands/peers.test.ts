import { afterEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MailboxService, type MailboxPeer, type MailboxTargetState } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { cfgIrcCrossProcess, cfgIrcPeerAlias } from "@oh-my-pi/pi-coding-agent/irc/settings";
import { normalizePeerAlias } from "@oh-my-pi/pi-coding-agent/mailbox/protocol";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";

afterEach(() => {
	vi.restoreAllMocks();
});

function harness(options: { enabled?: boolean; peers?: MailboxPeer[] } = {}) {
	const settings = Settings.isolated();
	if (options.enabled) cfgIrcCrossProcess.set(settings, true);
	const whenSettled = vi.fn(async () => {});
	const state = vi.fn((agentId: string): MailboxTargetState => {
		expect(agentId).toBe("acp:conversation");
		if (!cfgIrcCrossProcess.get(settings)) return { enabled: false };
		const alias = normalizePeerAlias(cfgIrcPeerAlias.get(settings));
		return { enabled: true, address: "work-1234abcd.abcdef12", alias, receiving: true };
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
		expect(await executeAcpBuiltinSlashCommand("/peers   ON  ", h.runtime)).toEqual({ consumed: true });
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
					alias: "Worker",
					busy: true,
				},
				{
					address: "other-87654321.abcdef12",
					id: "second",
					pid: 2,
					cwd: "/tmp/other",
					conversation: "abcdef12",
					title: null,
					alias: null,
					busy: false,
				},
			],
		});
		await executeAcpBuiltinSlashCommand("/peers list", h.runtime);
		expect(h.output).toHaveBeenCalledWith(
			'project-1234abcd (Worker)  D:/project  "A session"  busy\nother-87654321.abcdef12  /tmp/other  idle',
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
		for (const call of h.output.mock.calls) expect(call).toEqual(["Usage: /peers [on|off|status|list|name [alias]]"]);
		expect(cfgIrcCrossProcess.get(h.settings)).toBe(false);
		expect(h.whenSettled).not.toHaveBeenCalled();
		expect(h.listPeers).not.toHaveBeenCalled();
	});

	it("sanitizes peer cwd and title without allowing terminal controls or extra rows", async () => {
		const peer: MailboxPeer = {
			address: "project-1234abcd",
			id: "first",
			pid: 1,
			cwd: "D:/project\u001b]52;c;cGF5bG9hZA==\u0007\nnext",
			conversation: null,
			title: "A\nsession\u001b[31m",
			alias: "Worker",
			busy: false,
		};
		const h = harness({ peers: [peer] });
		await executeAcpBuiltinSlashCommand("/peers list", h.runtime);
		expect(h.output).toHaveBeenCalledWith('project-1234abcd (Worker)  D:/project next  "A session"  idle');
	});

	it("sets a case-preserving runtime alias, waits for publication, and clears it without persisting", async () => {
		const h = harness({ enabled: true });
		const settled = Promise.withResolvers<void>();
		h.whenSettled.mockImplementationOnce(() => settled.promise);
		const command = executeAcpBuiltinSlashCommand("/peers NAME Worker_2", h.runtime);
		expect(cfgIrcPeerAlias.get(h.settings)).toBe("Worker_2");
		expect(h.output).not.toHaveBeenCalled();
		settled.resolve();
		await command;
		expect(h.output).toHaveBeenLastCalledWith("Peers: on — this session is work-1234abcd.abcdef12 (alias Worker_2)");
		await executeAcpBuiltinSlashCommand("/peers name", h.runtime);
		expect(cfgIrcPeerAlias.get(h.settings)).toBe("");
		expect(h.output).toHaveBeenLastCalledWith("Peers: on — this session is work-1234abcd.abcdef12");
		expect(h.settings.getGlobalSettings()).toEqual({ irc: { crossProcess: true } });
	});

	it("rejects aliases that would be stripped, truncated, emptied, or mistaken for an address", async () => {
		const h = harness({ enabled: true });
		cfgIrcPeerAlias.override(h.settings, "Existing");
		for (const raw of ["Worker!", "two words", "x".repeat(49), "!!!", "project-1234abcd"]) {
			await executeAcpBuiltinSlashCommand(`/peers name ${raw}`, h.runtime);
			expect(h.output).toHaveBeenLastCalledWith(
				`Invalid alias "${raw}": use letters, digits, - or _ (max 48), not an address.`,
			);
			expect(cfgIrcPeerAlias.get(h.settings)).toBe("Existing");
		}
		expect(h.whenSettled).not.toHaveBeenCalled();
	});
});
