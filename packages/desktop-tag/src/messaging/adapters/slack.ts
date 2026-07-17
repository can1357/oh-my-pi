import { parseMessageEvidence, parsePreparedDispatch, validateAdapterTarget } from "../ix-client";
import type { AdapterSelectors, ChatAdapter, ChatDraft, ChatTargetIdentity, IxOperation } from "../types";

export const SLACK_SELECTORS = {
	version: "slack-web-2026-07-v1",
	supportedHosts: ["app.slack.com"],
	account: ['[data-qa="team-menu-trigger"][data-team-id]', "[data-team-id]"],
	conversation: ['[data-qa="channel_name"][data-channel-id]', '[data-channel-id][aria-current="page"]'],
	thread: ['[data-qa="thread-pane"][data-thread-ts]', "[data-thread-ts]"],
	composer: [
		'[data-qa="message_input"][contenteditable="true"]',
		'[data-qa="message_input"] [contenteditable="true"]',
	],
	message: ['[data-qa="message_container"][data-ts]', '[data-ts][role="listitem"]'],
	selfAuthor: ['[data-qa="message_sender_name"][data-member-id]', '[data-message-author-is-self="true"]'],
	delivered: ['[data-qa="message_container"][data-ts]:not([data-send-state])'],
	failed: ['[data-send-state="failed"]', '[data-qa="message_failed_icon"]'],
} as const satisfies AdapterSelectors;

function validate(target: ChatTargetIdentity): void {
	validateAdapterTarget(target, "slack", SLACK_SELECTORS.supportedHosts);
}

export const slackAdapter: ChatAdapter = {
	provider: "slack",
	validateTarget: validate,
	readOperation(target, limit): IxOperation {
		validate(target);
		return { kind: "read", provider: "slack", target, selectors: SLACK_SELECTORS, limit };
	},
	prepareDispatchOperation(draft: ChatDraft): IxOperation {
		validate(draft.target);
		return { kind: "prepare_dispatch", provider: "slack", draft, selectors: SLACK_SELECTORS };
	},
	verificationOperation(draft, baselineMessageIds): IxOperation {
		validate(draft.target);
		return { kind: "verify", provider: "slack", draft, selectors: SLACK_SELECTORS, baselineMessageIds };
	},
	parseRead: parseMessageEvidence,
	parsePrepared: parsePreparedDispatch,
	parseVerification: parseMessageEvidence,
};
