import * as path from "node:path";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createRoot, resolveChildren } from "@oh-my-pi/pi-tui";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { ResolvedTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { CORPUS_NOW, type CorpusCase, corpusEnvironment, describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { RawSseDebugBuffer } from "../../../../src/debug/raw-sse-buffer";
import { RawSseMain, RawSseViewer, RawSseViewerModel } from "../../../../src/ui/apps/raw-sse";
import { type AppDriver, appSuite, caseFiles, nativeDiff, paintAppRows } from "../harness";
import { click, mouse } from "./mouse";

setSystemTime(new Date(CORPUS_NOW));

let originalTheme: ResolvedTheme | undefined;
afterEach(() => {
	if (originalTheme) setCurrentTheme(originalTheme);
	originalTheme = undefined;
});

test("the raw SSE footer paints ASCII keycaps", () => {
	originalTheme = currentTheme();
	const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
	setCurrentTheme(theme);
	const model = new RawSseViewerModel({
		buffer: new RawSseDebugBuffer(),
		terminalRows: 12,
		copyToClipboard: () => {},
		onExit: () => {},
	});
	try {
		const rows = paintAppRows(() => RawSseViewer({ model }), staticEnvironment(theme), 120);
		expect(rows.find(row => row.includes("copy raw"))).toContain("Esc close · Ctrl+C copy raw · End follow tail");
	} finally {
		model.dispose();
	}
});

const sseData = (i: number) =>
	i % 3 === 0
		? JSON.stringify({
				type: "delta",
				index: i,
				text: "日本語 ".repeat(20),
				nested: { a: [1, 2, 3], b: "x".repeat(40) },
			})
		: `{"short":${i}}`;

function fill(buffer: RawSseDebugBuffer, n: number, offset = 0): void {
	for (let i = 0; i < n; i++) {
		const data = sseData(i + offset);
		buffer.recordEvent({ event: i % 2 ? "message" : null, data, raw: ["event: message", `data: ${data}`] });
	}
}

const action = (act: string) => (d: AppDriver) => void d.emit({ type: "action", key: "", act, mods: [] });

appSuite({
	dir: "apps/raw-sse",
	mount(caseName) {
		const records = caseName === "30-records" ? 30 : caseName === "copy-fails" ? 4 : 0;
		const buffer = new RawSseDebugBuffer();
		if (records > 0) {
			buffer.recordResponse({ status: 200, headers: {}, requestId: "req_1" });
			fill(buffer, records);
		}
		const model = new RawSseViewerModel({
			buffer,
			terminalRows: 30,
			copyToClipboard: () => {
				if (caseName === "copy-fails") throw new Error("clipboard unavailable");
			},
			onExit: () => {},
		});
		return {
			view: () => RawSseViewer({ model }),
			steps: {
				"native screen": () => {},
				up: d => d.press("\x1b[A"),
				"page up": d => d.press("\x1b[5~"),
				home: d => d.press("\x1b[H"),
				"append 5 events": () => fill(buffer, 5, 100),
				end: d => d.press("\x1b[F"),
				down: d => d.press("\x1b[B"),
				"page down": d => d.press("\x1b[6~"),
				"wheel down": d => mouse(d, "\x1b[<65;10;8M"),
				"click header": d => mouse(d, ...click(1, 4)),
				"click body": d => mouse(d, ...click(5, 4)),
				"ctrl+c copies": d => d.press("\x03"),
				"native action copy-raw": action("copy-raw"),
				"buffer cleared": () => buffer.clear(),
				"refill 3 events": () => fill(buffer, 3, 500),
			},
			dispose: () => model.dispose(),
		};
	},
});

/** The stream page against the screens the old viewer described (stage notes). */
describe.skipIf(caseFiles("apps/raw-sse").length === 0)("apps/raw-sse page", () => {
	for (const file of caseFiles("apps/raw-sse")) {
		test(path.basename(file), async () => {
			const corpusCase = (await Bun.file(file).json()) as CorpusCase;
			const records = (corpusCase.inputs as { events: unknown[] }).events.length;
			const buffer = new RawSseDebugBuffer();
			if (records) {
				buffer.recordResponse({ status: 200, headers: {}, requestId: "req_1" });
				fill(buffer, records);
			}
			const model = new RawSseViewerModel({ buffer, terminalRows: 30, copyToClipboard: () => {}, onExit: () => {} });
			const env = corpusEnvironment(corpusCase.theme);
			const replay: Record<string, () => void> = {
				up: () => model.key("up"),
				"page up": () => model.key("pageUp"),
				home: () => model.key("home"),
				"append 5 events": () => fill(buffer, 5, 100),
				end: () => model.key("end"),
				down: () => model.key("down"),
				"page down": () => model.key("pageDown"),
				"buffer cleared": () => buffer.clear(),
				"refill 3 events": () => fill(buffer, 3, 500),
			};
			createRoot(dispose => {
				const nodes = resolveChildren(() => RawSseMain({ model }));
				for (const stage of corpusCase.stages) {
					replay[stage.label]?.();
					const screen = (stage.note as { describeScreen?: { main: unknown[] } } | undefined)?.describeScreen;
					if (!screen) continue;
					const actual = nodes().map(node => describeTree(node, env));
					expect(nativeDiff(screen.main, actual), stage.label).toBeNull();
				}
				dispose();
			});
			model.dispose();
		});
	}
});
