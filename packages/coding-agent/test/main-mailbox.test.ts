import { afterEach, describe, expect, it, vi } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MailboxService } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { cfgIrcCrossProcess } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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

	for (const mailboxFlag of [false, true]) {
		it(
			mailboxFlag
				? "lets print receive only with --mailbox and withdraws before capturing the answer"
				: "keeps print send-only despite a saved enabled setting and withdraws before capture",
			async () => {
				const dir = TempDir.createSync("@pi-main-mailbox-");
				tempDirs.push(dir);
				const authStorage = await AuthStorage.create(":memory:");
				const manager = SessionManager.create(dir.path(), `${dir.path()}/sessions`);
				const settings = Settings.isolated({
					"marketplace.autoUpdate": "off",
					"irc.crossProcess": !mailboxFlag,
				});
				let bound = false;
				let captured = false;
				const session = {
					extensionRunner: undefined,
					model: { provider: "anthropic", id: "test-model" },
					settings,
					sessionManager: manager,
					isStreaming: false,
					subscribe: () => () => {},
					addDisposer: () => {},
					getAgentId: () => "Main",
					getAllToolNames: () => [],
					getQueuedMessages: () => ({ steering: [], followUp: [] }),
					getLastAssistantMessage: () => {
						expect(bound).toBe(false);
						captured = true;
						return undefined;
					},
					prepareForHeadlessAdvisorDrain: () => {},
					setTextOutputCommitted: () => {},
					waitForAdvisorCatchup: async () => true,
					prompt: async () => {
						expect(bound).toBe(true);
					},
					dispose: () => manager.close(),
				} as unknown as AgentSession;
				const service = MailboxService.global();
				vi.spyOn(service, "initialize").mockImplementation(() => {});
				vi.spyOn(service, "whenSettled").mockResolvedValue(undefined);
				const bindSpy = vi.spyOn(service, "bindTarget").mockImplementation(target => {
					expect(target.receive).toBe(mailboxFlag);
					expect(cfgIrcCrossProcess.get(target.settings)).toBe(true);
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
});
