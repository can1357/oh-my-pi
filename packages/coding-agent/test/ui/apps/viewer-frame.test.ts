import { signal } from "@oh-my-pi/pi-tui";
import { ViewerFrame, ViewerFrameModel } from "../../../src/ui/apps";
import { appSuite } from "./harness";

const ACCENT = "\x1b[38;2;254;188;56m";
const MUTED = "\x1b[38;2;119;125;136m";
const DIM = "\x1b[38;2;95;102;115m";
const fg = (sgr: string, text: string) => `${sgr}${text}\x1b[39m`;
const frameLine = (i: number) => `${fg(ACCENT, `line ${i}`)} ${"x".repeat(i % 7)} 日本語 ${i}`;

appSuite({
	dir: "apps/viewer-frame",
	mount(caseName) {
		const tall = caseName === "tall-follow-tail";
		const n = signal(tall ? 50 : 2);
		const height = signal(tall ? 24 : 4);
		const anchor = signal<number | undefined>(undefined);
		const header = signal<string | undefined>(undefined);
		const model = new ViewerFrameModel({
			title: "Debug Frame Title",
			height,
			headerRows: 2,
			footerRows: 1,
			minimumBodyRows: 3,
			followTail: true,
			content: ctx => {
				const lines = Array.from({ length: n() }, (_, i) => frameLine(i));
				const at = anchor();
				return {
					header: [header() ?? `width ${ctx.contentWidth} body ${ctx.bodyHeight}`, fg(MUTED, "second header")],
					body:
						at === undefined ? { lines } : { lines, anchor: { id: `a${at}`, start: at, end: at + 2, margin: 1 } },
					footer: [fg(DIM, "footer hints · esc close")],
				};
			},
		});
		return {
			view: () => ViewerFrame({ model }),
			rowsOnly: true,
			steps: {
				"scroll up 3": () => model.scroll(-3),
				"grow to 80 lines": () => n.set(80),
				"follow tail on": () => model.setFollowTail(true),
				"scroll offset 5": () => model.setScrollOffset(5),
				"anchor lines 40-42 margin 1": () => anchor.set(40),
				"height 12": () => height.set(12),
				"shrink to 0 lines": () => n.set(0),
				"very long header": () => header.set("a very long header ".repeat(10)),
			},
		};
	},
});
