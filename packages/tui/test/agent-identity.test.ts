import { describe, expect, it } from "bun:test";
import { MAIN_AGENT_ID } from "@oh-my-pi/pi-tui/overlays/agent-hub-types";
import { agentColorHex, agentPalette, noteAgentArrival } from "@oh-my-pi/pi-tui/overlays/agent-identity";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { oklabDistance, relativeLuminance } from "@oh-my-pi/pi-utils/color";

function contrast(a: string, b: string): number {
	const [hi, lo] = [relativeLuminance(a) ?? 0, relativeLuminance(b) ?? 0].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

const dark = createTheme(getBuiltinThemes().dark!, { mode: "truecolor" });

const CARD_BACKGROUNDS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;

describe("agent palette", () => {
	it("gives Main the accent and six readable, distinct subagent colours on every built-in theme", () => {
		for (const [name, json] of Object.entries(getBuiltinThemes())) {
			const theme = createTheme(json, { mode: "truecolor" });
			const { main, subagents } = agentPalette(theme);
			expect(main, name).toBe(theme.getAccentColorHex());
			expect(subagents, name).toHaveLength(6);
			const taken = [main, theme.getColorHex("error")];
			// Names are drawn on the terminal background and on the Task card tints.
			const surfaces = [theme.surfaceHex, ...CARD_BACKGROUNDS.map(key => theme.getBgHex(key))];
			for (const hex of subagents) {
				for (const surface of surfaces)
					expect(contrast(hex, surface), `${name} ${hex} on ${surface}`).toBeGreaterThanOrEqual(3);
				for (const other of taken)
					expect(oklabDistance(hex, other), `${name} ${hex} ${other}`).toBeGreaterThanOrEqual(0.1);
				taken.push(hex);
			}
		}
	});

	it("uses a theme's declared subagent colours as written", () => {
		const json = getBuiltinThemes().dark!;
		// Close to the accent on purpose: a declared colour skips the distinctness filter.
		const declared = createTheme(
			{ ...json, colors: { ...json.colors, subagent1: dark.getAccentColorHex(), subagent2: "#808080" } },
			{ mode: "truecolor" },
		);
		const { subagents } = agentPalette(declared);
		expect(subagents.slice(0, 2)).toEqual([dark.getAccentColorHex(), "#808080"]);
		expect(subagents).toHaveLength(6);
	});
});

describe("agent colour allocation", () => {
	const palette = agentPalette(dark).subagents;
	const slotOf = (id: string) => palette.indexOf(agentColorHex(dark, id));

	it("draws Main in the accent", () => {
		expect(agentColorHex(dark, MAIN_AGENT_ID)).toBe(dark.getAccentColorHex());
	});

	it("hands out colours by creation time, keeps them across re-renders, and wraps after six", () => {
		// Arrival slots are process-wide, so these ids appear in no other test.
		const ids = Array.from({ length: 7 }, (_, index) => `ResumedArrival${index}`);
		// Registered out of order, as a resumed session restores them.
		for (const index of [3, 0, 6, 1, 5, 2, 4]) noteAgentArrival(ids[index]!, 1_000 + index);
		const first = slotOf(ids[0]!);
		const slots = ids.map(slotOf);
		expect(slots).toEqual(ids.map((_, index) => (first + index) % palette.length));
		expect(ids.map(slotOf)).toEqual(slots);
		// The seventh shares the first one's colour.
		expect(agentColorHex(dark, ids[6]!)).toBe(agentColorHex(dark, ids[0]!));
	});
});
