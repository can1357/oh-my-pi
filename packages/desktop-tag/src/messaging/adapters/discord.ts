import { parseMessageEvidence, parsePreparedDispatch, validateAdapterTarget } from "../ix-client";
import type { AdapterSelectors, ChatAdapter, ChatDraft, ChatTargetIdentity, IxOperation } from "../types";

export const DISCORD_SELECTORS = {
	version: "discord-web-2026-07-v1",
	supportedHosts: ["discord.com"],
	account: ['[data-list-id="guildsnav"] [data-user-id]', '[aria-label="User area"] [data-user-id]'],
	conversation: [
		'[data-list-id="channels"] [data-channel-id][aria-selected="true"]',
		'[data-channel-id][aria-current="page"]',
	],
	thread: [
		'[data-thread-id][aria-selected="true"]',
		'[data-list-id="threads"] [data-channel-id][aria-selected="true"]',
	],
	composer: ['main form [role="textbox"][contenteditable="true"]', '[data-slate-editor="true"][role="textbox"]'],
	message: ['li[id^="chat-messages-"][data-list-item-id]', '[data-list-item-id^="chat-messages___"]'],
	selfAuthor: ['[data-author-self="true"]', '[class*="messageListItem"] [data-user-id][aria-label*="(you)"]'],
	delivered: ['li[id^="chat-messages-"]:not([data-message-state])', '[data-message-state="sent"]'],
	failed: ['[data-message-state="failed"]', '[class*="messageFailed"]'],
} as const satisfies AdapterSelectors;

function validate(target: ChatTargetIdentity): void {
	validateAdapterTarget(target, "discord", DISCORD_SELECTORS.supportedHosts);
}

export const discordAdapter: ChatAdapter = {
	provider: "discord",
	validateTarget: validate,
	readOperation(target, limit): IxOperation {
		validate(target);
		return { kind: "read", provider: "discord", target, selectors: DISCORD_SELECTORS, limit };
	},
	prepareDispatchOperation(draft: ChatDraft): IxOperation {
		validate(draft.target);
		return { kind: "prepare_dispatch", provider: "discord", draft, selectors: DISCORD_SELECTORS };
	},
	verificationOperation(draft, baselineMessageIds): IxOperation {
		validate(draft.target);
		return { kind: "verify", provider: "discord", draft, selectors: DISCORD_SELECTORS, baselineMessageIds };
	},
	parseRead: parseMessageEvidence,
	parsePrepared: parsePreparedDispatch,
	parseVerification: parseMessageEvidence,
};
