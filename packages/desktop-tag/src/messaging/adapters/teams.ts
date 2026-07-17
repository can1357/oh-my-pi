import { parseMessageEvidence, parsePreparedDispatch, validateAdapterTarget } from "../ix-client";
import type { AdapterSelectors, ChatAdapter, ChatDraft, ChatTargetIdentity, IxOperation } from "../types";

export const TEAMS_SELECTORS = {
	version: "teams-web-2026-07-v1",
	supportedHosts: ["teams.microsoft.com"],
	account: ['[data-tid="app-header"] [data-tenant-id]', '[data-tid="me-control-avatar-trigger"][data-user-id]'],
	conversation: ['[data-tid="chat-header"][data-thread-id]', '[data-tid="channel-header"][data-channel-id]'],
	thread: ['[data-tid="thread-pane"][data-thread-id]', '[data-tid="channel-pane"][data-thread-id]'],
	composer: [
		'[data-tid="ckeditor"] [contenteditable="true"]',
		'[data-tid="message-compose-input"][contenteditable="true"]',
	],
	message: ['[data-tid="chat-pane-message"][data-message-id]', '[data-tid="message-body"][data-message-id]'],
	selfAuthor: ['[data-tid="message-author"][data-is-self="true"]', '[data-author-is-self="true"]'],
	delivered: ['[data-message-id][data-delivery-state="delivered"]', '[data-message-id][data-delivery-state="read"]'],
	failed: ['[data-delivery-state="failed"]', '[data-tid="message-send-failed"]'],
} as const satisfies AdapterSelectors;

function validate(target: ChatTargetIdentity): void {
	validateAdapterTarget(target, "teams", TEAMS_SELECTORS.supportedHosts);
}

export const teamsAdapter: ChatAdapter = {
	provider: "teams",
	validateTarget: validate,
	readOperation(target, limit): IxOperation {
		validate(target);
		return { kind: "read", provider: "teams", target, selectors: TEAMS_SELECTORS, limit };
	},
	prepareDispatchOperation(draft: ChatDraft): IxOperation {
		validate(draft.target);
		return { kind: "prepare_dispatch", provider: "teams", draft, selectors: TEAMS_SELECTORS };
	},
	verificationOperation(draft, baselineMessageIds): IxOperation {
		validate(draft.target);
		return { kind: "verify", provider: "teams", draft, selectors: TEAMS_SELECTORS, baselineMessageIds };
	},
	parseRead: parseMessageEvidence,
	parsePrepared: parsePreparedDispatch,
	parseVerification: parseMessageEvidence,
};
