import { FG_RESET } from "../theme/color";
import { getSessionAccentAnsi } from "../theme/session-color";
import { MAIN_AGENT_ID } from "./agent-hub-types";

/** Tern's tab colour names minus red, which Tern keeps for "needs you". */
export type AgentColor = "blue" | "orange" | "yellow" | "green" | "teal" | "purple" | "pink";

/** One hex per colour, each at least 3:1 against both white and `#1e1e1e`. */
export const AGENT_COLOR_HEX: Readonly<Record<AgentColor, string>> = {
	blue: "#268bd2",
	orange: "#d9620f",
	yellow: "#b58900",
	green: "#4c9a2a",
	teal: "#2aa198",
	purple: "#8b6fd6",
	pink: "#d33682",
};

/** Colours subagents hash into; blue is the main agent's alone. */
const SUBAGENT_COLORS: readonly AgentColor[] = ["orange", "yellow", "green", "teal", "purple", "pink"];

const utf8 = new TextEncoder();

/** FNV-1a, 32-bit, over the UTF-8 bytes of `text`. */
function fnv1a(text: string): number {
	let hash = 0x811c9dc5;
	for (const byte of utf8.encode(text)) {
		hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
	}
	return hash;
}

/** Main is blue; every other registry id hashes to a stable non-red colour. */
export function agentColor(agentId: string): AgentColor {
	return agentId === MAIN_AGENT_ID ? "blue" : SUBAGENT_COLORS[fnv1a(agentId) % SUBAGENT_COLORS.length]!;
}

/** `text` in the foreground colour of `agentId`'s identity. */
export function agentColored(agentId: string, text: string): string {
	const ansi = getSessionAccentAnsi(AGENT_COLOR_HEX[agentColor(agentId)]);
	return ansi ? `${ansi}${text}${FG_RESET}` : text;
}
