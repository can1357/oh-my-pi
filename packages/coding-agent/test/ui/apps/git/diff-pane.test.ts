import { signal } from "@oh-my-pi/pi-tui";
import { paintNode, releasePaintCache } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import type { DiffBuildOptions } from "../../../../src/cli/git-tui/model/diff-pane";
import type { FileAssetSide, FileStreamUpdate } from "../../../../src/cli/git-tui/model/state";
import { buildDiffDocument, DiffPaneModel, type DiffPaneState, GitDiffPane } from "../../../../src/ui/apps/git";
import { type AppDriver, appSuite } from "../harness";

interface DocInput {
	readonly filePath: string;
	readonly oldText: string;
	readonly newText: string;
	readonly options: DiffBuildOptions;
}

interface PaneInputs {
	readonly height: number;
	readonly patchTarget?: "stage" | "unstage" | null;
	readonly document?: DocInput | string;
	readonly filePath?: string;
	readonly sides?: readonly { label: string; old: FileAssetSide; new: FileAssetSide }[];
	readonly startStream?: string;
	readonly updates?: Record<"first" | "long" | "tail", FileStreamUpdate>;
	readonly emptyMessage?: string;
	readonly longMessage?: string;
}

const textLines = (n: number, f: (i: number) => string) => `${Array.from({ length: n }, (_, i) => f(i)).join("\n")}\n`;
const MAIN: DocInput = {
	filePath: "src/very/long/path/to/some/deeply/nested/module/file.ts",
	oldText: textLines(80, i =>
		i === 5
			? "\tconst value = compute(alpha, beta);"
			: i === 30
				? "日本語のテキスト 🎉 emoji line"
				: i === 50
					? `long ${"x".repeat(300)} end`
					: `line ${i} of the file`,
	),
	newText: textLines(84, i =>
		i === 5
			? "\tconst value = compute(alpha, gamma, delta);"
			: i === 6
				? "\tconsole.log(value);"
				: i === 31
					? "日本語のテキスト 🎊 changed"
					: i === 52
						? `long ${"y".repeat(280)} changed end`
						: i === 70
							? "brand new line"
							: `line ${i > 6 ? i - 1 : i} of the file`,
	),
	options: {},
};

const docOf = (input: DocInput) => buildDiffDocument(input.oldText, input.newText, input.filePath, input.options);

/** Column ranges of each hunk header that fire a hunk action (the pane last painted 120 wide). */
function scanHeaders(d: AppDriver, pane: DiffPaneModel, height: number): void {
	releasePaintCache(d.root);
	const rows = paintNode(d.env, d.root, 120, height).rows.map(stripEscapes);
	rows.forEach((text, row) => {
		if (!text.includes("@@ -")) return;
		for (let col = 0; col < 118; col++) pane.clickAt(col, row);
	});
}

appSuite({
	dir: "apps/git-diff-pane",
	mount(_caseName, corpusCase) {
		const inputs = corpusCase.inputs as PaneInputs;
		const pane = new DiffPaneModel();
		const height = signal(inputs.height);
		const document = typeof inputs.document === "object" ? inputs.document : MAIN;
		if (inputs.sides) pane.setAsset(inputs.filePath!, inputs.sides[0]!.old, inputs.sides[0]!.new);
		else if (inputs.startStream) pane.startStream(inputs.startStream);
		else if (inputs.emptyMessage) pane.emptyMessage = inputs.emptyMessage;
		else {
			pane.patchTarget = inputs.patchTarget ?? null;
			pane.setDocument(docOf(document), "ready");
		}
		const sideStep = (label: string) => {
			const side = inputs.sides?.find(candidate => candidate.label === label);
			return () => {
				if (side) pane.setAsset(inputs.filePath!, side.old, side.new);
			};
		};
		const assetSteps = Object.fromEntries(
			(inputs.sides ?? []).slice(1).map(side => [side.label, sideStep(side.label)]),
		);
		const highlight = () => pane.highlightAsync(new AbortController().signal);
		return {
			view: () => GitDiffPane({ model: pane }),
			height: () => height(),
			rowsOnly: true,
			fresh: true,
			steps: {
				...assetSteps,
				focus: () => void (pane.focused = true),
				unfocus: () => void (pane.focused = false),
				"cursor down": () => pane.moveCursor(1, false),
				"cursor down 4": () => pane.moveCursor(4, false),
				"extend selection 3": () => pane.moveCursor(3, true),
				"extend selection 2 more": () => pane.moveCursor(2, true),
				"clear selection": () => void pane.clearSelection(),
				"scroll by 7": () => pane.scrollBy(7),
				"scroll by 10": () => pane.scrollBy(10),
				"scroll left by 8": () => pane.scrollLeftBy(8),
				"scroll left by 16": () => pane.scrollLeftBy(16),
				"scroll left by 400 (clamped)": () => pane.scrollLeftBy(400),
				"page down": () => pane.pageBy(1),
				"cursor to end": () => pane.cursorToEdge("end"),
				"cursor to start": () => pane.cursorToEdge("start"),
				"next hunk": () => void pane.jumpHunk(1),
				"next hunk again": () => void pane.jumpHunk(1),
				"previous hunk": () => void pane.jumpHunk(-1),
				"last hunk": () => pane.seekHunk("last"),
				"first hunk": () => pane.seekHunk("first"),
				"seek to row 40": () => pane.seekTo(40),
				"click minimap row 3": () => void pane.clickAt(118, 3),
				"click minimap row 1": () => void pane.clickAt(118, 1),
				"click row 2": () => void pane.clickAt(10, 2),
				"click row 1": () => void pane.clickAt(3, 1),
				"shift click row 4": () => void pane.clickAt(10, 4, true),
				"click past end": () => void pane.clickAt(10, 200),
				"wrap on": () => pane.toggleWrap(),
				"wrap off": () => pane.toggleWrap(),
				"wrap extend 5": () => pane.moveCursor(5, true),
				"wrap next hunk": () => void pane.jumpHunk(1),
				"inline mode": () => pane.setMode("inline"),
				"inline next hunk": () => void pane.jumpHunk(1),
				"inline extend 2": () => pane.moveCursor(2, true),
				"hunk mode": () => pane.setMode("hunk"),
				"hunk mode next hunk": () => void pane.jumpHunk(1),
				"hunk mode cursor down 3": () => pane.moveCursor(3, false),
				"hunk mode click header text": () => void pane.clickAt(5, 0),
				"hunk header buttons, stage target": d => scanHeaders(d, pane, height()),
				"hunk header buttons, unstage target": d => {
					pane.patchTarget = "unstage";
					scanHeaders(d, pane, height());
				},
				"hunk header buttons, no target": d => {
					pane.patchTarget = null;
					scanHeaders(d, pane, height());
				},
				"back to stage target": () => void (pane.patchTarget = "stage"),
				"hunk mode last hunk": () => pane.seekHunk("last"),
				"hunk mode wrap on": () => pane.toggleWrap(),
				"file mode": () => pane.setMode("file"),
				"file mode next hunk": () => void pane.jumpHunk(1),
				"file mode scroll 3": () => pane.scrollBy(3),
				"file mode extend 4": () => pane.moveCursor(4, true),
				"cycle mode": () => pane.cycleMode(),
				"cycle mode again": () => pane.cycleMode(),
				"fields set directly: inline, top 4, cursor 6, anchor 2, hunk 1, no wrap": () => {
					pane.mode = "inline";
					pane.scrollTop = 4;
					pane.cursor = 6;
					pane.anchor = 2;
					pane.selectedHunk = 1;
					pane.wrap = false;
				},
				"height 0": () => height.set(0),
				"height 1": () => height.set(1),
				"height 2": () => height.set(2),
				"height 5": () => height.set(5),
				"height 12": () => height.set(12),
				"height 30": () => height.set(30),
				"height 5 cursor down 9": () => pane.moveCursor(9, false),
				"empty message set while ready": () => void (pane.emptyMessage = "Nothing"),
				"state loading": () => void (pane.state = "loading"),
				"state ready": () => void (pane.state = "ready"),
				"state empty with asset kept": () => void (pane.state = "empty"),
				"state asset again": () => void (pane.state = "asset"),
				"syntax highlighted": highlight,
				"split mode highlighted": () => pane.setMode("split"),
				"syntax highlighted split": () => {
					pane.setMode("split");
					return highlight();
				},
				"document cleared": () => pane.setDocument(null, "empty"),
				"update 1": () => pane.updateStream(inputs.updates!.first),
				"long update": () => pane.updateStream(inputs.updates!.long),
				"replace tail with control chars": () => pane.updateStream(inputs.updates!.tail),
				"restart stream other.ts": () => pane.startStream("other.ts"),
				loading: () =>
					inputs.startStream ? pane.setDocument(null, "loading") : void (pane.state = "loading" as DiffPaneState),
				"ready without document": () => void (pane.state = "ready"),
				"long message": () => {
					pane.state = "empty";
					pane.emptyMessage = inputs.longMessage!;
				},
				"streaming without stream": () => void (pane.state = "streaming"),
				"asset without asset": () => void (pane.state = "asset"),
				"document loaded": () => {
					height.set(inputs.height);
					pane.setDocument(docOf(MAIN), "ready");
				},
			},
		};
	},
});
