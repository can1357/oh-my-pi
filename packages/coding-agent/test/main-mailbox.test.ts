import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MailboxService } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { cfgIrcCrossProcess } from "@oh-my-pi/pi-coding-agent/irc/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as runtimeInit from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcOutputWriter } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-output";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

describe("--mailbox", () => {
	it("enables peers without consuming the prompt or following profile flag", () => {
		const args = parseArgs(["--print", "--mailbox", "--profile", "work", "hello"]);
		expect(args.mailbox).toBe(true);
		expect(args.print).toBe(true);
		expect(args.profile).toBe("work");
		expect(args.messages).toEqual(["hello"]);
	});

	for (const [savedEnabled, mailboxFlag] of [
		[true, false],
		[false, true],
		[false, false],
	] as const) {
		it(
			mailboxFlag
				? "enables print receiving only with --mailbox and withdraws before shutdown"
				: `keeps print send-only with peers ${savedEnabled ? "on" : "off"} and retains the toggle target`,
			async () => {
				const dir = TempDir.createSync("@pi-main-mailbox-");
				tempDirs.push(dir);
				const authStorage = await AuthStorage.create(":memory:");
				const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
				const settings = Settings.isolated({
					"marketplace.autoUpdate": "off",
					"irc.crossProcess": savedEnabled,
				});
				let bound = false;
				let captured = false;
				let subscriber: ((event: AgentSessionEvent) => void) | undefined;
				const session = {
					extensionRunner: undefined,
					model: { provider: "anthropic", id: "test-model" },
					settings,
					sessionManager: manager,
					isStreaming: false,
					subscribe: (listener: (event: AgentSessionEvent) => void) => {
						subscriber = listener;
						return () => {};
					},
					addDisposer: () => {},
					getAgentId: () => "Main",
					getAllToolNames: () => [],
					getQueuedMessages: () => ({ steering: [], followUp: [] }),
					prepareForHeadlessAdvisorDrain: () => {
						expect(bound).toBe(false);
						captured = true;
					},
					setTextOutputCommitted: () => {},
					waitForAdvisorCatchup: async () => true,
					prompt: async () => {
						expect(bound).toBe(true);
						subscriber?.({ type: "agent_start" });
						subscriber?.({ type: "agent_end", messages: [], isTerminal: true });
					},
					dispose: () => manager.close(),
				} as unknown as AgentSession;
				const service = MailboxService.global();
				vi.spyOn(service, "initialize").mockImplementation(() => {});
				vi.spyOn(service, "whenSettled").mockResolvedValue(undefined);
				const bindSpy = vi.spyOn(service, "bindTarget").mockImplementation(target => {
					expect(target.receive).toBe(mailboxFlag);
					expect(cfgIrcCrossProcess.get(target.settings)).toBe(savedEnabled || mailboxFlag);
					bound = true;
					return () => {
						bound = false;
					};
				});
				vi.spyOn(postmortem, "quit").mockImplementation(async () => {});
				vi.spyOn(process.stderr, "write").mockImplementation(() => true);
				const rawArgs = ["--print", ...(mailboxFlag ? ["--mailbox"] : []), "hello"];
				const args = parseArgs(rawArgs);
				args.noExtensions = true;
				args.noSkills = true;
				args.noRules = true;
				args.noTools = true;
				args.noLsp = true;
				args.sessionDir = dir.path();
				try {
					await runRootCommand(args, rawArgs, {
						discoverAuthStorage: async () => authStorage,
						settings,
						createAgentSession: async () => ({ session }) as unknown as CreateAgentSessionResult,
					});
					expect(bindSpy).toHaveBeenCalledTimes(1);
					expect(captured).toBe(true);
				} finally {
					logger.endTiming();
					authStorage.close();
					await manager.close().catch(() => undefined);
				}
			},
			15_000,
		);
	}

	it("forwards a peer event arriving at RPC publication and withdraws on EOF", async () => {
		using dir = TempDir.createSync("@pi-rpc-mailbox-");
		const manager = SessionManager.create(dir.path(), dir.join("sessions"));
		let subscriber: ((event: AgentSessionEvent) => void) | undefined;
		let initialized = false;
		let receiving = false;
		const disposers: Array<() => void> = [];
		const session = {
			settings: Settings.isolated(),
			sessionManager: manager,
			goalRuntime: { clearAccounting: () => {} },
			setGoalModeState: () => {},
			getGoalModeState: () => undefined,
			customCommands: [],
			skills: [],
			setSlashCommands: () => {},
			subscribeCommandMetadataChanged: () => () => {},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				subscriber = listener;
				return () => {};
			},
			addDisposer: (disposer: () => void) => disposers.push(disposer),
			dispose: async () => {
				for (const dispose of disposers) dispose();
				await manager.close();
			},
		} as unknown as AgentSession;
		vi.spyOn(runtimeInit, "initializeExtensions").mockImplementation(async () => {
			expect(receiving).toBe(false);
			initialized = true;
		});
		const frames: unknown[] = [];
		vi.spyOn(RpcOutputWriter.prototype, "write").mockImplementation(lines => {
			for (const line of lines) frames.push(JSON.parse(line));
		});
		vi.spyOn(MailboxService.global(), "whenSettled").mockResolvedValue(undefined);
		vi.spyOn(MailboxService.global(), "close").mockResolvedValue(undefined);
		const exited = new Error("test RPC exit");
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw exited;
		});
		const notifications = process.env.PI_NOTIFICATIONS;
		try {
			await expect(
				runRpcMode(session, {
					input: new ReadableStream({ start: controller => controller.close() }),
					bindMailboxTarget: () => {
						expect(initialized).toBe(true);
						expect(subscriber).toBeDefined();
						receiving = true;
						subscriber?.({
							type: "notice",
							level: "info",
							message: "peer arrived at publication",
							source: "mailbox-test",
						});
						return () => {
							receiving = false;
						};
					},
				}),
			).rejects.toBe(exited);
			expect(frames).toContainEqual({
				type: "notice",
				level: "info",
				message: "peer arrived at publication",
				source: "mailbox-test",
			});
			expect(receiving).toBe(false);
		} finally {
			if (notifications === undefined) delete process.env.PI_NOTIFICATIONS;
			else process.env.PI_NOTIFICATIONS = notifications;
			await manager.close().catch(() => {});
		}
	});
});
