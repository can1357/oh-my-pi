/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { type BrowserAnchor, TranscriptBrowser, TranscriptBrowserModel } from "../../../../src/ui/transcript/figures";
import { single } from "../messages/harness";
import { figureSuite } from "./harness";

const bodyLines = (n: number, prefix = "line"): string[] =>
	Array.from({ length: n }, (_, i) => `${prefix} ${i} ${"·".repeat(i % 17)} 日本語テキスト`);

figureSuite("browser", (corpusCase, { env }) => {
	const inputs = corpusCase.inputs as { height: number; followBottom: boolean; minimumBodyRows: number | null };
	const height = signal(inputs.height);
	const header = signal(["Transcript", "a very long header line that must be truncated at narrow widths"]);
	const footer = signal(["↑/↓ scroll · q close"]);
	const body = signal(bodyLines(60));
	const anchor = signal<BrowserAnchor | undefined>(undefined);
	const model = new TranscriptBrowserModel({
		height,
		followBottom: inputs.followBottom,
		...(inputs.minimumBodyRows === null ? {} : { minimumBodyRows: inputs.minimumBodyRows }),
		frame: cx => ({
			header: header().map(h =>
				env.theme().fg("accent", `${h} [${cx.frameWidth}/${cx.contentWidth}/${cx.chromeWidth}]`),
			),
			body: { lines: body(), anchor: anchor() },
			footer: footer().map(f => env.theme().fg("dim", f)),
		}),
	});
	return {
		node: single(<TranscriptBrowser model={model} />),
		apply(label) {
			if (label === "scroll down 3") model.scroll(3);
			else if (label === "page down key") model.handleKey({ id: "pageDown", kind: "press", raw: "\x1b[6~" });
			else if (label === "j key") model.handleKey({ id: "j", kind: "press", raw: "j", text: "j" });
			else if (label === "top") model.scrollToTop();
			else if (label === "bottom") model.scrollToBottom();
			else if (label === "body grown to 120 lines") body.set(bodyLines(120, "grown"));
			else if (label === "height 6") height.set(6);
			else if (label === "anchored lines 40-45") anchor.set({ id: "a1", start: 40, end: 45 });
			else if (label === "anchor cleared, scroll up 2") {
				anchor.set(undefined);
				model.scroll(-2);
			} else if (label === "no header or footer") {
				header.set([]);
				footer.set([]);
			} else if (label === "height 0") height.set(0);
			else if (label === "empty body") {
				height.set(20);
				body.set([]);
			} else throw new Error(`unknown stage ${label}`);
		},
	};
});
