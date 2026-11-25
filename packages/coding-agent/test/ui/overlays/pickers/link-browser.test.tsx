/** @jsxImportSource @oh-my-pi/pi-tui */
import { LinkBrowser, type LinkReply } from "../../../../src/ui/overlays/pickers/link-browser";
import { pickerSuite } from "./harness";

const reply = (text: string, at: number): LinkReply => ({ id: `r${at}`, text });

const REPLIES: Record<string, () => LinkReply[]> = {
	transcript: () => [
		reply("First [gamma](demo:g) here.", 1),
		...Array.from({ length: 6 }, (_, i) =>
			reply(`Filler paragraph number ${i} with [link ${i}](demo:${i}) ünïcödé.`, 10 + i),
		),
		reply("Crowded [a](demo:a)[b](demo:b)[c](demo:c)[d](demo:d)[e](demo:e)[f](demo:f)", 3),
		reply("Last [omega](demo:z) here.", 2),
	],
	"long-history": () => Array.from({ length: 120 }, (_, i) => reply(`Reply ${i} [x${i}](demo:${i})`, 100 + i)),
	empty: () => [],
};

pickerSuite({
	dir: "overlays/link-browser",
	mount(caseName) {
		const replies = REPLIES[caseName]!();
		return {
			view: () => (
				<LinkBrowser replies={replies} schemes={["demo"]} rows={12} onActivate={() => {}} onClose={() => {}} />
			),
			focus: d => d.root,
			// Host API calls with nothing to redraw (the host re-sends a redrawn reply's text).
			steps: { hasLinks: () => {}, rerender: () => {}, "rerender missing": () => {} },
		};
	},
});
