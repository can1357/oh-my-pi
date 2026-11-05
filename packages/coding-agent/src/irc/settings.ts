/**
 * Settings declared by the peer-messaging (IRC) domain (see `config/registry.ts`).
 * Declaration order is the settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgIrcIngressGuard = register({
	id: "irc.ingressGuard",
	type: "boolean",
	default: true,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "IRC Ingress Guard",
		description:
			"Refuse peer messages that exhaust the sender's rate budget, repeat a body already sent to the same recipient, or carry too long a hop chain",
	},
});

export const cfgIrcRateLimitTokens = register({
	id: "irc.rateLimitTokens",
	type: "number",
	default: 30,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "IRC Sender Rate",
		description:
			"Tokens one sender may spend per 500 ms of peer messaging; a message costs its body length in characters / 4, at least 1. 0 disables the rate limit",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "10", label: "10 tokens / 500 ms" },
			{ value: "30", label: "30 tokens / 500 ms" },
			{ value: "60", label: "60 tokens / 500 ms" },
			{ value: "120", label: "120 tokens / 500 ms" },
		],
	},
});

export const cfgIrcDedupWindowMs = register({
	id: "irc.dedupWindowMs",
	type: "number",
	default: 30_000,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "IRC Duplicate Window",
		description:
			"Refuse an identical message (same sender, recipient, and body) sent again within this many milliseconds; 0 disables duplicate detection",
		options: [
			{ value: "0", label: "Off" },
			{ value: "10000", label: "10 s" },
			{ value: "30000", label: "30 s" },
			{ value: "60000", label: "1 min" },
			{ value: "300000", label: "5 min" },
		],
	},
});

export const cfgIrcMaxHops = register({
	id: "irc.maxHops",
	type: "number",
	default: 28,
	ui: {
		tab: "tasks",
		group: "Subagents",
		label: "IRC Max Hops",
		description:
			"Longest accepted chain of agents a message may pass through (each send appends its sender); a longer chain is refused. 0 disables the limit",
		options: [
			{ value: "0", label: "Unlimited" },
			{ value: "8", label: "8 hops" },
			{ value: "16", label: "16 hops" },
			{ value: "28", label: "28 hops" },
			{ value: "56", label: "56 hops" },
		],
	},
});
