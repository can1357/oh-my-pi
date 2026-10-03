/**
 * The transport a status-line renderer's rows would ride to a Tern (TSP)
 * terminal: a dock root that only knows `render()` reaches the described
 * document as a `rows` node, and the same rows are not re-sent every frame.
 *
 * The reconciler already emits `rows` for any component without `describe`
 * (native/reconcile.ts `#resolve`), and the interactive native dock already
 * carries hook-widget containers built that way, so this is the mechanism the
 * design leans on — exercised here against a real `Composer` over the fake
 * Tern terminal rather than inferred from reading the reconciler.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { TspNode } from "@oh-my-pi/pi-wire";
import { type Component, Container } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { isNativeRendering, setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { COMPOSER_DEFAULTS, Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import type { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { createStartupStatusLine } from "@oh-my-pi/pi-tui/status-line/startup";
import type { StatusLineSettings } from "@oh-my-pi/pi-tui/status-line/types";
import { ManualScheduler, TspTestTerminal } from "./tsp-harness";

const COLS = 120;

/** A real status line, so the renderer's rows travel the host's own dock path. */
function statusLine(settings: StatusLineSettings): StatusLineComponent {
	return createStartupStatusLine({
		settings,
		gitEnabled: false,
		autoThinking: false,
		fastMode: false,
		usingSubscription: false,
		autoCompactEnabled: false,
		compactionBoundaries: null,
	});
}

/** An ANSI-only component: the shape every `render()`-based extension has. */
class PaintedRows implements Component {
	lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.lines = lines;
	}

	render(): readonly string[] {
		return this.lines;
	}
}

interface Harness {
	readonly composer: Composer;
	readonly terminal: TspTestTerminal;
	flush(advanceMs?: number): void;
	doc(): TspNode;
	region(name: "main" | "dock"): TspNode | undefined;
	stop(): void;
}

/** A started composer over the fake Tern terminal, with the handshake settled. */
function startComposer(): Harness {
	const scheduler = new ManualScheduler();
	const terminal = new TspTestTerminal({ cols: COLS, rows: 40 });
	const composer = new Composer({
		terminal,
		tuiOptions: { renderScheduler: scheduler },
		preferences: { ...COMPOSER_DEFAULTS, quiet: true },
		exit: () => {},
	});
	const flush = (advanceMs = 0): void => {
		scheduler.flush(advanceMs, () => (terminal.answersProbe && terminal.answerProbe()) || terminal.deliver());
	};
	composer.start();
	flush();
	const doc = (): TspNode => {
		const surface = terminal.surface;
		const document = surface === undefined ? undefined : terminal.docs.get(surface);
		if (!document) throw new Error("no TSP surface open");
		return document.snapshot();
	};
	return {
		composer,
		terminal,
		flush,
		doc,
		region: name => doc().c?.find(node => node.id === name),
		stop: () => {
			composer.stop();
			flush();
		},
	};
}

/** Every node in the dock subtree, depth first. */
function dockNodes(harness: Harness): TspNode[] {
	const out: TspNode[] = [];
	const visit = (node: TspNode): void => {
		out.push(node);
		for (const child of node.c ?? []) visit(child);
	};
	const dock = harness.region("dock");
	if (dock) visit(dock);
	return out;
}

function rowsNodes(harness: Harness): TspNode[] {
	return dockNodes(harness).filter(node => node.k === "rows");
}

afterEach(() => {
	setNativeRendering(false);
});

describe("TSP dock: an ANSI-only root's rows", () => {
	it("carries an extension-shaped render() component into the dock as a rows node", () => {
		setNativeRendering(true);
		const harness = startComposer();
		try {
			// The interactive native dock mounts hook widgets exactly this way: a
			// plain container in `nativeDock`, holding a component that only renders.
			const widget = new PaintedRows(["  branch feat/seam   12%"]);
			const widgetContainer = new Container();
			widgetContainer.addChild(widget);
			harness.composer.setRuntimeChildren([new TranscriptContainer(), widgetContainer], {
				nativeDock: [widgetContainer],
			});
			harness.flush();

			expect(isNativeRendering()).toBe(true);
			expect(harness.terminal.errors).toEqual([]);
			const rows = rowsNodes(harness);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.p).toEqual({ cols: COLS, lines: ["  branch feat/seam   12%"] });
		} finally {
			harness.stop();
		}
	});

	it("keeps a multi-row component's rows in order rather than collapsing them", () => {
		setNativeRendering(true);
		const harness = startComposer();
		try {
			const widget = new PaintedRows(["quota 37m", "claude · opus", "──────────"]);
			const widgetContainer = new Container();
			widgetContainer.addChild(widget);
			harness.composer.setRuntimeChildren([new TranscriptContainer(), widgetContainer], {
				nativeDock: [widgetContainer],
			});
			harness.flush();

			// Three declared rows must stay three rows: this is the whole reason a
			// `rows` node carries `lines` instead of a joined string.
			expect(rowsNodes(harness)[0]!.p).toMatchObject({ lines: ["quota 37m", "claude · opus", "──────────"] });
		} finally {
			harness.stop();
		}
	});

	it("does not re-send a rows node whose lines are unchanged", () => {
		setNativeRendering(true);
		const harness = startComposer();
		try {
			const widget = new PaintedRows(["steady"]);
			const widgetContainer = new Container();
			widgetContainer.addChild(widget);
			harness.composer.setRuntimeChildren([new TranscriptContainer(), widgetContainer], {
				nativeDock: [widgetContainer],
			});
			harness.flush();
			const before = harness.terminal.log.length;

			harness.composer.ui.requestRender();
			harness.flush();
			expect(harness.terminal.log.slice(before)).toEqual([]);

			// A changed line is re-sent, so the assertion above is a skip and not a
			// dead dock.
			widget.lines = ["changed"];
			harness.composer.ui.requestRender();
			harness.flush();
			expect(harness.terminal.log.slice(before).length).toBeGreaterThan(0);
			expect(rowsNodes(harness)[0]!.p).toMatchObject({ lines: ["changed"] });
		} finally {
			harness.stop();
		}
	});

	it("carries a renderer override's rows into the dock as its own block", () => {
		setNativeRendering(true);
		const harness = startComposer();
		try {
			const line = statusLine({ preset: "custom", leftSegments: ["hostname"], rightSegments: [] });
			line.setRendererOverride({ id: "probe", label: "Probe", render: () => ["RENDERER-ROW"] });
			harness.composer.setStatusComponent(line);
			// A transcript is what routes the dock through `nativeDock`.
			harness.composer.setRuntimeChildren([new TranscriptContainer()], { nativeDock: [] });
			harness.flush();

			// The renderer's rows reach the described document — the same rows the box
			// surface shows, which is what lets the host install the override on a
			// Tern terminal instead of declining it.
			expect(line.render(COLS)).toEqual(["RENDERER-ROW"]);
			expect(harness.terminal.errors).toEqual([]);
			const rows = rowsNodes(harness);
			expect(rows).toHaveLength(1);
			expect(rows[0]!.p).toEqual({ cols: COLS, lines: ["RENDERER-ROW"] });
		} finally {
			harness.stop();
		}
	});
});
