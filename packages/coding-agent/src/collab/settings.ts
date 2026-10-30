/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { register } from "../config/registry";
import { DEFAULT_RELAY_URL } from "./protocol";

// Collab
export const cfgCollabRelayUrl = register({
	id: "collab.relayUrl",
	type: "string",
	default: DEFAULT_RELAY_URL,
	ui: {
		tab: "interaction",
		group: "Collab",
		label: __ompTranslate("Relay URL"),
		description: "Relay used by /collab (wss://host[:port])",
	},
});

export const cfgCollabWebUrl = register({
	id: "collab.webUrl",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: __ompTranslate("Web UI URL"),
		description:
			"Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only",
	},
});

export const cfgCollabDisplayName = register({
	id: "collab.displayName",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: __ompTranslate("Display Name"),
		description: "Name shown to other collab participants (default: OS username)",
	},
});

export const cfgCollabAutoStart = register({
	id: "collab.autoStart",
	type: "enum",
	values: ["off", "view", "control"] as const,
	default: "off",
	ui: {
		tab: "interaction",
		group: "Collab",
		label: __ompTranslate("Auto Start"),
		description:
			"Host every interactive session via collab.relayUrl as it starts and publish it to the local registry (omp collab list); rooms rotate on session switch",
		options: [
			{
				value: "off",
				label: __ompTranslate("Off\u0004collaboration.auto-start.disabled"),
				description: __ompTranslate("Share only when /collab is run"),
			},
			{
				value: "view",
				label: __ompTranslate("View"),
				description: __ompTranslate("Auto-host; the registry hands out view-only links (omp collab link --view)"),
			},
			{
				value: "control",
				label: __ompTranslate("Control"),
				description: __ompTranslate("Auto-host; the registry hands out control links that can prompt the session"),
			},
		],
	},
});
