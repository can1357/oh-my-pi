import { register } from "../config/registry";

export const cfgIrcCrossProcess = register({
	id: "irc.crossProcess",
	type: "boolean",
	default: false,
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Cross-Process Peers",
		description: "Let this omp process discover and message other omp processes on this machine (same user)",
	},
});

export const cfgIrcPeerAlias = register({
	id: "irc.peerAlias",
	type: "string",
	default: "",
	ui: {
		tab: "interaction",
		group: "Agent",
		label: "Peer Alias",
		description:
			"Optional name other omp processes on this machine can use to message this session (agent://<alias>)",
	},
});
