import { register } from "../config/registry";

function positiveInteger(raw: unknown): void {
	if (raw === undefined) return;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
		throw new Error("Messaging limits must be positive integers");
	}
}

export const cfgMessagingEnabled = register({
	id: "messaging.enabled",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Cross-session messaging",
		description: "Message other top-level omp sessions on this machine. A project config can only restrict this.",
	},
});

export const cfgMessagingInbound = register({
	id: "messaging.crossSessionInbound",
	type: "enum",
	values: ["default", "accept", "hold", "refuse"] as const,
	default: "default",
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Messages from your other sessions",
		description: "Default follows permission classes; project settings may only tighten inbound rules",
	},
});

export const cfgMessagingDialogExpiry = register({
	id: "messaging.dialogExpiry",
	type: "enum",
	values: ["60s", "5m", "10m", "never"] as const,
	default: "5m",
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Dialog expiry",
		description:
			"How long a default-policy message waits for approval; explicit hold does not expire. Project configs cannot change this.",
	},
});

export const cfgMessagingSend = register({
	id: "messaging.send",
	type: "enum",
	values: ["allow", "deny"] as const,
	default: "allow",
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Send to other sessions",
		description: "Allow or deny outgoing cross-session messages. A project config can only restrict this.",
	},
});

export const cfgMessagingList = register({
	id: "messaging.list",
	type: "enum",
	values: ["allow", "deny"] as const,
	default: "allow",
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "List other sessions",
		description:
			"Show or hide the other-sessions roster; does not prevent sending by address. A project config can only restrict this.",
	},
});

export const cfgMessagingRateLimit = register({
	id: "messaging.rateLimit",
	type: "number",
	default: 30,
	validate: positiveInteger,
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Messages per sender per window",
		description:
			"Maximum messages from one sender in a rate window (positive integer). A project config can only restrict this.",
	},
});

export const cfgMessagingRateWindowSeconds = register({
	id: "messaging.rateWindowSeconds",
	type: "number",
	default: 60,
	validate: positiveInteger,
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Rate window (s)",
		description: "Per-sender rate window in seconds (positive integer). A project config can only restrict this.",
	},
});

export const cfgMessagingRepeatWindowSeconds = register({
	id: "messaging.repeatWindowSeconds",
	type: "number",
	default: 30,
	validate: positiveInteger,
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Identical-repeat window (s)",
		description:
			"Drop a message identical to one the same sender sent within this many seconds (positive integer). A project config can only restrict this.",
	},
});

export const cfgMessagingRelayMaxHops = register({
	id: "messaging.relayMaxHops",
	type: "number",
	default: 8,
	validate: positiveInteger,
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Relay chain max hops",
		description:
			"Drop relay chains that have reached this many hops (positive integer). A project config can only restrict this.",
	},
});

export const cfgMessagingRelayMaxRevisits = register({
	id: "messaging.relayMaxRevisits",
	type: "number",
	default: 3,
	validate: positiveInteger,
	ui: {
		tab: "interaction",
		group: "Messages",
		label: "Relay chain max revisits",
		description:
			"Drop relay chains that have revisited this session this many times (at least 1). A project config can only restrict this.",
	},
});
