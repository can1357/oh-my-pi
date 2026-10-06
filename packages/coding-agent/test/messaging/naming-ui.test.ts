import { afterEach, describe, expect, it, vi } from "bun:test";
import { ExtensionUiController } from "../../src/modes/controllers/extension-ui-controller";
import type { InteractiveModeContext } from "../../src/modes/types";
import { generateNameSuffix, generateTaskName, resetTaskNames } from "../../src/task/name-generator";
import type { HeldMessageView } from "../../src/messaging/service";
import { executeBuiltinSlashCommand } from "../../src/slash-commands/builtin-registry";
import type { MessagingService } from "../../src/messaging/service";
import type { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { Settings } from "../../src/config/settings";
import { cfgMessagingList } from "../../src/messaging/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { executeAcpBuiltinSlashCommand } from "../../src/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "../../src/slash-commands/types";
import {
	claimSessionName,
	isReservedAddress,
	RESERVED_SESSION_NAME_ERROR,
	sessionAddress,
} from "../../src/messaging/names";
import { CommandController } from "../../src/modes/controllers/command-controller";
import { executeSend } from "../../src/irc/messaging";

afterEach(() => {
	vi.restoreAllMocks();
	resetTaskNames();
});

describe("cross-session naming UI", () => {
	it("rejects normalized reserved user names before mutating the session", async () => {
		const manager = SessionManager.inMemory();
		await manager.setSessionName("previous", "user");
		const header = structuredClone(manager.getHeader());
		const entries = manager.getEntries();
		const revision = manager.titleRevision;
		const renamed = vi.fn();
		manager.onSessionNameChanged(renamed);
		for (const name of [" all ", "\u0000all\u0007", " @extension "]) {
			await expect(manager.setSessionName(name, "user")).rejects.toThrow(RESERVED_SESSION_NAME_ERROR);
			expect(manager.getSessionName()).toBe("previous");
			expect(manager.titleRevision).toBe(revision);
			expect(manager.getHeader()).toEqual(header);
			expect(manager.getEntries()).toEqual(entries);
		}
		expect(renamed).not.toHaveBeenCalled();
		const autoManager = SessionManager.inMemory();
		await autoManager.setSessionName("all", "auto");
		expect(autoManager.getSessionName()).toBe("all");
	});

	it("keeps reserved persisted titles readable but advertises only safe addresses", () => {
		const title = {
			cwd: "/project",
			sessionId: "legacy-session",
			sessionName: "all",
			titleSource: "user" as const,
			directPrint: false,
		};
		expect(isReservedAddress("all")).toBe(true);
		expect(() => claimSessionName("all", new Set())).toThrow(RESERVED_SESSION_NAME_ERROR);
		expect(() => claimSessionName("@extension", new Set())).toThrow(RESERVED_SESSION_NAME_ERROR);
		expect(sessionAddress(title)).not.toBe("all");
		expect(sessionAddress(title)).toMatch(/^project-[a-f0-9]{2}$/);
		expect(sessionAddress({ ...title, directPrint: true })).toBeNull();
		for (const name of ["All", "ALL", "all-foo", "release@draft"]) {
			expect(claimSessionName(name, new Set())).toBe(name);
			expect(sessionAddress({ ...title, sessionName: name })).toBe(name);
		}
	});

	it("reports the reserved-name error in interactive and headless rename without changing the title", async () => {
		const manager = SessionManager.inMemory();
		await manager.setSessionName("previous", "user");
		const settings = Settings.isolated();
		const session = { titleGenerationSignal: new AbortController().signal } as unknown as AgentSession;
		const showError = vi.fn();
		const controller = new CommandController({
			session,
			sessionManager: manager,
			showError,
		} as unknown as InteractiveModeContext);
		await controller.handleRenameCommand(" all ");
		expect(showError).toHaveBeenCalledWith(RESERVED_SESSION_NAME_ERROR);
		const output: string[] = [];
		await executeAcpBuiltinSlashCommand("/rename all", {
			session,
			sessionManager: manager,
			settings,
			cwd: "/project",
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		});
		expect(output).toEqual([RESERVED_SESSION_NAME_ERROR]);
		expect(manager.getSessionName()).toBe("previous");
	});

	it("retains local broadcast routing for all instead of resolving a session name", async () => {
		const resolve = vi.fn();
		const result = await executeSend(
			{ registry: new AgentRegistry(), senderId: "Main", messaging: { resolve } as unknown as MessagingService },
			{ to: "all", message: "broadcast" },
		);
		expect(result.content).toEqual([{ type: "text", text: "No live peers to broadcast to." }]);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("makes lowercase two-word suffixes without reserving task or session names", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		generateTaskName();
		const suffix = generateNameSuffix();
		expect(suffix).toMatch(/^[a-z]+-[a-z]+$/);
		expect(generateNameSuffix()).toBe(suffix);
	});

	it("lists own address, local agents, and other sessions through both command names, respecting list denial and off", async () => {
		const settings = Settings.isolated();
		const registry = new AgentRegistry();
		registry.register({ id: "Worker", displayName: "Worker", kind: "sub", session: null, status: "running" });
		vi.spyOn(AgentRegistry, "global").mockReturnValue(registry);
		const fakeSession = {
			settings,
			getAgentId: () => "Main",
			messaging: {
				ownAddress: () => "mine",
				ownShortId: () => "12345678",
				listSessions: async () => [
					{
						name: "release notes",
						sessionId: "release-notes-session",
						shortId: "87654321",
						busy: false,
						cwd: "/other",
						title: "Release planning",
					},
				],
			} as unknown as MessagingService | undefined,
		};
		const output: string[] = [];
		const runtime: SlashCommandRuntime = {
			session: fakeSession as unknown as AgentSession,
			sessionManager: SessionManager.inMemory(),
			settings,
			cwd: "/project",
			output: text => {
				output.push(text);
			},
			refreshCommands: () => {},
			reloadPlugins: async () => {},
		};
		await executeAcpBuiltinSlashCommand("/list-agents", runtime);
		expect(output[0]).toBe(
			'This session: mine [12345678]\n\n## Agents\n- Worker running sub\n\n## Other sessions\n- release notes [87654321] idle — /other — "Release planning"',
		);
		await executeAcpBuiltinSlashCommand("/peers", runtime);
		expect(output[1]).toBe(output[0]!);
		cfgMessagingList.override(settings, "deny");
		await executeAcpBuiltinSlashCommand("/list-agents", runtime);
		expect(output[2]).toBe("This session: mine [12345678]\n\n## Agents\n- Worker running sub");
		fakeSession.messaging = undefined;
		await executeAcpBuiltinSlashCommand("/peers", runtime);
		expect(output[3]).toBe(
			'Cross-session messaging is off. Turn on "Cross-session messaging" in /settings or launch with --cross-session.',
		);
	});

	it("lets only a deliberate approval deliver, with service-owned expiry", async () => {
		const controller = new ExtensionUiController({} as InteractiveModeContext);
		const signal = new AbortController();
		const view: HeldMessageView = {
			from: { name: "release notes", address: "release notes", shortId: "12345678", cwd: "/project" },
			body: Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join("\n"),
		};
		const select = vi.spyOn(controller, "showHookSelector").mockResolvedValue("Approve");
		expect(await controller.askCrossSessionApproval(view, signal.signal, () => {})).toBe("approve");
		const [title, options, dialog] = select.mock.calls[0]!;
		expect(title).toBe(
			`Message from another session: @release notes\n------------\n${view.body.split("\n").slice(0, 12).join("\n")}\n------------`,
		);
		expect(options).toEqual([{ label: "Approve" }, { label: "Deny" }]);
		expect(dialog).toEqual({ signal: signal.signal });
		select.mockResolvedValue("Deny");
		expect(await controller.askCrossSessionApproval(view, signal.signal, () => {})).toBe("deny");
		select.mockImplementation(async () => {
			signal.abort();
			return "Approve";
		});
		expect(await controller.askCrossSessionApproval(view, signal.signal, () => {})).toBeUndefined();
	});

	it("keeps /status opening the extensions dashboard", async () => {
		const showExtensionsDashboard = vi.fn();
		const ctx = {
			showExtensionsDashboard,
			editor: { setText: vi.fn() },
		} as unknown as InteractiveModeContext;
		expect(await executeBuiltinSlashCommand("/status", { ctx })).toBe(true);
		expect(showExtensionsDashboard).toHaveBeenCalledTimes(1);
	});
});
