import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MailboxService, type MailboxTargetState } from "@oh-my-pi/pi-coding-agent/mailbox/service";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgIrcCrossProcess } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("interactive peers notices", () => {
	it("shows mailbox state, updates the footer and merges the command's duplicate status", async () => {
		const settings = Settings.isolated();
		const chatContainer = new Container();
		const statusLine = createStartupStatusLine({
			settings: { preset: "default" },
			gitEnabled: false,
			autoThinking: false,
			fastMode: false,
			usingSubscription: false,
			autoCompactEnabled: false,
			compactionBoundaries: null,
		});
		statusLine.setComposerStyle({ statusAttachment: "none", bottomBar: "full", bottomBarGap: false });
		const ctx = {
			chatContainer,
			statusLine,
			ui: { requestRender: vi.fn() },
			present: (content: Component | readonly Component[]) => {
				for (const item of Array.isArray(content) ? content : [content]) chatContainer.addChild(item);
			},
		} as unknown as InteractiveModeContext;
		const helpers = new UiHelpers(ctx);
		ctx.showStatus = helpers.showStatus.bind(helpers);
		const state = (): MailboxTargetState =>
			cfgIrcCrossProcess.get(settings)
				? { enabled: true, address: "project-1234abcd", receiving: true }
				: { enabled: false };
		vi.spyOn(MailboxService, "global").mockReturnValue({
			state,
			whenSettled: async () => {
				Reflect.apply(InteractiveMode.prototype.showMailboxState, ctx, [state()]);
			},
		} as unknown as MailboxService);
		const runtime = {
			settings,
			session: { getAgentId: () => "Main" },
			output: ctx.showStatus,
		} as unknown as SlashCommandRuntime;
		try {
			await executeAcpBuiltinSlashCommand("/peers on", runtime);
			expect(chatContainer.children).toHaveLength(1);
			expect(Bun.stripANSI(chatContainer.render(160).join("\n"))).toContain(
				"Peers: on — this session is project-1234abcd",
			);
			expect(Bun.stripANSI(statusLine.render(200).join("\n"))).toContain("peers:project-1234abcd");
			expect(ctx.ui.requestRender).toHaveBeenCalled();
			await executeAcpBuiltinSlashCommand("/peers off", runtime);
			expect(chatContainer.children).toHaveLength(1);
			expect(Bun.stripANSI(chatContainer.render(160).join("\n"))).toContain("Peers: off");
			expect(Bun.stripANSI(statusLine.render(200).join("\n"))).not.toContain("peers:");
		} finally {
			statusLine.dispose();
		}
	});
});
