import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { KeybindingsManager } from "../src/app-keybindings";
import { MoveOverlay, type MoveOverlayResult } from "../src/overlays/move-overlay";
import { AnnotationOverlay } from "../src/overlays/annotation-overlay";
import { AgentTranscriptViewer, type AgentTranscriptViewerDeps } from "../src/overlays/agent-transcript-viewer";
import { BtwHistoryPanel } from "../src/overlays/btw-history-panel";
import type { BtwHistoryRecord } from "../src/overlays/btw-history";
import { CodexResetFireworksController } from "../src/overlays/codex-reset-fireworks";
import { type Component, Input, type OverlayHandle, type TUI } from "../src/index";
import type { NativeChild, NativeNode, NativeUiEvent } from "../src/native/node";
import { setNativeRendering } from "../src/native/state";
import { initTheme, theme } from "../src/theme/theme";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	setNativeRendering(false);
	vi.useRealTimers();
});

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search over described nodes, not descending into component children. */
function findNode(root: NativeNode, predicate: (node: NativeNode) => boolean): NativeNode | undefined {
	if (predicate(root)) return root;
	for (const child of root.c ?? []) {
		if (!isNode(child)) continue;
		const found = findNode(child, predicate);
		if (found) return found;
	}
	return undefined;
}

/** The top-right `esc` / Close click, as the native backend delivers it. */
const CLOSE_CLICK: NativeUiEvent = { type: "action", key: "esc-close", act: "close", mods: [] };

function listOf(root: NativeNode): NativeNode & { k: "list" } {
	const list = findNode(root, node => node.k === "list");
	if (list?.k !== "list") throw new Error("no list described");
	return list;
}

describe("MoveOverlay native events", () => {
	const entries = [
		{ value: "/work/alpha", label: "alpha/" },
		{ value: "/work/beta", label: "beta/" },
		{ value: "/work/gamma", label: "gamma/" },
	];

	it("mirrors a selected suggestion and confirms the activated one", () => {
		const results: (MoveOverlayResult | undefined)[] = [];
		const overlay = new MoveOverlay("/work", result => results.push(result), { search: () => entries });
		expect(listOf(overlay.describe()).p?.selected).toBe("/work/alpha");

		overlay.handleNativeEvent({ type: "select", key: "results", item: "/work/gamma" });
		expect(listOf(overlay.describe()).p?.selected).toBe("/work/gamma");
		expect(results).toEqual([]);

		overlay.handleNativeEvent({ type: "activate", key: "results", item: "/work/beta" });
		expect(results).toEqual([{ directory: "/work/beta" }]);
	});

	it("Accept fills the field with the highlighted folder, Confirm moves there, Cancel resolves nothing", () => {
		const results: (MoveOverlayResult | undefined)[] = [];
		// Like the real source, suggestions narrow to the typed path.
		const overlay = new MoveOverlay("/work", result => results.push(result), {
			search: prefix => entries.filter(entry => entry.value.startsWith(prefix)),
		});
		overlay.handleNativeEvent({ type: "select", key: "results", item: "/work/gamma" });
		overlay.handleNativeEvent({ type: "action", key: "actions/accept", act: "accept", mods: [] });
		expect(results).toEqual([]);
		// Accept filled the field, so the suggestions narrowed to the accepted folder.
		expect(listOf(overlay.describe()).c?.map(child => (isNode(child) ? child.key : undefined))).toEqual([
			"/work/gamma",
		]);
		overlay.handleNativeEvent({ type: "action", key: "actions/confirm", act: "confirm", mods: [] });
		expect(results).toEqual([{ directory: "/work/gamma" }]);

		const cancelled: (MoveOverlayResult | undefined)[] = [];
		const other = new MoveOverlay("/work", result => cancelled.push(result), { search: () => entries });
		other.handleNativeEvent({ type: "action", key: "actions/cancel", act: "cancel", mods: [] });
		expect(cancelled).toEqual([undefined]);
	});
});

describe("AnnotationOverlay native esc", () => {
	it("saves an active note draft and closes the review", () => {
		const onComplete = vi.fn();
		const tui = { terminal: { rows: 40, columns: 100 }, requestRender: () => {} } as unknown as TUI;
		const overlay = new AnnotationOverlay(
			tui,
			theme,
			KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }),
			{ id: "s", kind: "prompt", label: "prompt", text: "one\ntwo" },
			{ onComplete },
		);
		overlay.handleInput("A");
		overlay.handleInput("x");
		overlay.handleNativeEvent(CLOSE_CLICK);
		expect(onComplete).toHaveBeenCalledWith(undefined);
		expect(overlay.getTextAnnotations()).toEqual([]);
		expect(overlay.getDraft()).toMatchObject({ kind: "text", editor: { text: "x" } });
		overlay.handleNativeEvent(CLOSE_CLICK);
		expect(onComplete).toHaveBeenCalledTimes(1);
	});
});

describe("AgentTranscriptViewer native esc", () => {
	it("clears a typed draft first, then closes the viewer", () => {
		const onClose = vi.fn();
		const missing = (): never => {
			throw Object.assign(new Error("missing"), { code: "ENOENT" });
		};
		const deps = {
			agentId: "a1",
			transcript: {
				sessionFile: () => undefined,
				fs: { openSync: missing, closeSync: missing, readSync: missing, readFileSync: missing, statSync: missing },
				parseEntries: () => [],
			},
			registry: { get: () => ({ id: "a1", kind: "task", status: "running" }) },
			lifecycle: () => ({}),
			ui: { terminal: { rows: 40, columns: 100 }, requestRender: () => {} },
			cwd: "/",
			expandKeys: ["ctrl+o"],
			hubKeys: [],
			requestRender: () => {},
			onClose,
			onHubClose: () => {},
		} as unknown as AgentTranscriptViewerDeps;
		const viewer = new AgentTranscriptViewer(deps);
		try {
			viewer.handleInput("h");
			viewer.handleInput("i");
			viewer.handleNativeEvent(CLOSE_CLICK);
			expect(onClose).not.toHaveBeenCalled();
			viewer.handleNativeEvent(CLOSE_CLICK);
			expect(onClose).toHaveBeenCalledTimes(1);
		} finally {
			viewer.dispose();
		}
	});
});

describe("BtwHistoryPanel native events", () => {
	const record = (id: string, question: string): BtwHistoryRecord => ({
		id,
		leafId: null,
		question,
		answer: `answer to ${question}`,
		status: "complete",
		createdAt: 0,
		updatedAt: 0,
	});

	function panel(): BtwHistoryPanel {
		return new BtwHistoryPanel({
			records: [record("a", "first question"), record("b", "second question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async () => true,
			requestRender: () => {},
			getHeight: () => 30,
		});
	}

	it("shows the natively selected record's turn in the details pane", () => {
		const history = panel();
		history.handleNativeEvent({ type: "select", key: "body/history/records", item: "b" });
		const described = history.describe();
		expect(listOf(described).p?.selected).toBe("b");
		const question = findNode(described, node => node.k === "md" && node.p?.text === "second question");
		expect(question).toBeDefined();
	});

	it("opens the follow-up composer for an activated record", () => {
		const history = panel();
		expect(findNode(history.describe(), node => node.key === "composer")).toBeUndefined();
		history.handleNativeEvent({ type: "activate", key: "body/history/records", item: "b" });
		const described = history.describe();
		expect(listOf(described).p?.selected).toBe("b");
		expect(findNode(described, node => node.key === "composer")).toBeDefined();
	});

	it("with escapeHides, puts a running answer away on Esc without cancelling it; x cancels it", () => {
		const onClose = vi.fn();
		const onCancel = vi.fn();
		const running: BtwHistoryRecord = { ...record("a", "still going"), status: "running" };
		const history = new BtwHistoryPanel({
			records: [running],
			onClose,
			onCopy: () => {},
			onCancel,
			requestRender: () => {},
			getHeight: () => 30,
			escapeHides: true,
		});
		history.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
		history.handleInput("x");
		expect(onCancel).toHaveBeenCalledWith(running);
	});

	it("jumps the answer pane to its end on a follow-up, and a streamed update does not re-pin it", () => {
		const records = [record("a", "first question")];
		const history = new BtwHistoryPanel({
			records,
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async () => true,
			requestRender: () => {},
			getHeight: () => 30,
		});
		const details = () => findNode(history.describe(), node => node.key === "details");
		expect(details()?.scroll).toBeUndefined();
		history.handleInput("\r");
		expect(details()?.scroll).toEqual({ by: "end", n: 1 });
		// Tern reports no wheel scroll: following every delta would pull a reader back down.
		history.update([{ ...records[0]!, answer: "answer to first question, longer now" }]);
		expect(details()?.scroll).toEqual({ by: "end", n: 1 });
	});

	it("forwards answer scroll keys while composing a follow-up, keeping the draft", () => {
		const history = new BtwHistoryPanel({
			records: [record("a", "first question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async () => true,
			requestRender: () => {},
			getHeight: () => 30,
		});
		const find = (key: string) => findNode(history.describe(), node => node.key === key);
		history.handleInput("f");
		history.pasteText("draft");
		history.handleInput("\x1b[5~");
		expect(find("details")?.scroll?.by).toBe("page-up");
		history.handleInput("\x1b[A");
		expect(find("details")?.scroll?.by).toBe("line-up");
		const input = find("composer")?.c?.[0];
		expect(input instanceof Input ? input.getValue() : undefined).toBe("draft");
	});

	it("routes the footer buttons to the same paths as their keys", async () => {
		const onCopy = vi.fn();
		const onFollowUp = vi.fn(async () => true);
		// The accepted follow-up closes the composer and renders once more.
		const sent = Promise.withResolvers<void>();
		const history: BtwHistoryPanel = new BtwHistoryPanel({
			records: [record("a", "first question"), record("b", "second question")],
			onClose: () => {},
			onCopy,
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp,
			requestRender: () => {
				if (onFollowUp.mock.calls.length > 0 && !findNode(history.describe(), node => node.key === "composer")) {
					sent.resolve();
				}
			},
			getHeight: () => 30,
		});
		const click = (act: string): void =>
			history.handleNativeEvent({ type: "action", key: `actions/${act}`, act, mods: [] });
		// Click the act the rendered button carries: `copy` would be the terminal-local
		// action, which copies the button's own label and never reaches the panel.
		const copyAct = findNode(
			history.describe(),
			node => node.p?.role === "omp.btn" && String(node.p?.title).startsWith("Copy answer"),
		)?.p?.actions?.click;
		expect(copyAct).toBeDefined();
		expect(copyAct).not.toBe("copy");
		click(copyAct!);
		expect(onCopy).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
		click("follow-up");
		expect(findNode(history.describe(), node => node.key === "composer")).toBeDefined();
		click("discard");
		expect(findNode(history.describe(), node => node.key === "composer")).toBeUndefined();
		click("follow-up");
		history.handleInput("w");
		history.handleInput("hy?");
		click("send");
		await sent.promise;
		expect(onFollowUp).toHaveBeenCalledWith(
			expect.objectContaining({ id: "a" }),
			"why?",
			expect.any(AbortSignal),
			undefined,
		);
	});

	it("sends images pasted into a follow-up, dropping one whose marker left the draft", () => {
		const onFollowUp = vi.fn(async () => true);
		const history = new BtwHistoryPanel({
			records: [record("a", "first question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp,
			requestRender: () => {},
			getHeight: () => 30,
		});
		const first: ImageContent = { type: "image", data: "Zmlyc3Q=", mimeType: "image/png" };
		const second: ImageContent = { type: "image", data: "c2Vjb25k", mimeType: "image/png" };
		expect(history.acceptsImages).toBe(false);
		history.handleInput("f");
		expect(history.acceptsImages).toBe(true);
		history.pasteText(`what is this ${history.attachImage(first)}`);
		history.attachImage(second);
		history.handleInput("\r");
		expect(onFollowUp).toHaveBeenCalledWith(
			expect.objectContaining({ id: "a" }),
			"what is this [Image #1]",
			expect.any(AbortSignal),
			[first],
		);
		// The sent follow-up already took its images: a new one would vanish when the composer clears.
		expect(history.acceptsImages).toBe(false);
		expect(history.attachImage(second)).toBeUndefined();
	});

	it("hands a follow-up's pasted image path and empty paste to the host, and types other pastes", () => {
		const onPasteImage = vi.fn(async () => true);
		const onPasteImagePath = vi.fn(async (_path: string) => {});
		const history = new BtwHistoryPanel({
			records: [record("a", "first question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp: async () => true,
			onPasteImage,
			onPasteImagePath,
			requestRender: () => {},
			getHeight: () => 30,
		});
		history.handleInput("f");
		history.handleInput("\x1b[200~/tmp/shot.png\x1b[201~");
		history.handleInput("\x1b[200~\x1b[201~");
		history.handleInput("\x1b[200~plain words\x1b[201~");
		expect(onPasteImagePath).toHaveBeenCalledWith("/tmp/shot.png");
		expect(onPasteImage).toHaveBeenCalledTimes(1);
		const input = findNode(history.describe(), node => node.key === "composer")?.c?.[0];
		expect(input instanceof Input ? input.getValue() : undefined).toBe("plain words");
	});

	it("holds Enter until a follow-up's pasted image loads, and drops a submit whose image failed", () => {
		const onFollowUp = vi.fn(async () => true);
		const history = new BtwHistoryPanel({
			records: [record("a", "first question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			canFollowUp: () => true,
			onFollowUp,
			requestRender: () => {},
			getHeight: () => 30,
		});
		const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
		history.handleInput("f");
		history.pasteText("what is this ");
		const failed = history.beginPaste();
		history.handleInput("\r");
		failed(undefined);
		expect(onFollowUp).not.toHaveBeenCalled();
		const loading = history.beginPaste();
		history.handleInput("\r");
		expect(onFollowUp).not.toHaveBeenCalled();
		loading(history.attachImage(image));
		expect(onFollowUp).toHaveBeenCalledWith(
			expect.objectContaining({ id: "a" }),
			"what is this [Image #1]",
			expect.any(AbortSignal),
			[image],
		);
	});

	it("stops a running answer from its footer button and sizes the sheet to what it lists", () => {
		const onCancel = vi.fn();
		const running: BtwHistoryRecord = { ...record("a", "still going"), status: "running" };
		const history = new BtwHistoryPanel({
			records: [running],
			onClose: () => {},
			onCopy: () => {},
			onCancel,
			requestRender: () => {},
			getHeight: () => 30,
			escapeHides: true,
		});
		expect(history.nativeOverlay.size).toBe("lg");
		history.handleNativeEvent({ type: "action", key: "actions/stop", act: "stop", mods: [] });
		expect(onCancel).toHaveBeenCalledWith(running);
		history.update([]);
		expect(history.nativeOverlay.size).toBe("md");
		expect(findNode(history.describe(), node => node.key === "empty")).toBeDefined();
	});

	it("gives a lone record's answer the arrow keys in text mode, with no pane switch to offer", () => {
		const history = new BtwHistoryPanel({
			records: [record("a", "only question")],
			onClose: () => {},
			onCopy: () => {},
			onCancel: () => {},
			requestRender: () => {},
			getHeight: () => 30,
		});
		history.handleInput("\t");
		const screen = Bun.stripANSI(history.render(80).join("\n"));
		expect(screen).toContain("answer to only question");
		expect(screen).not.toContain("switch pane");
	});
});

describe("CodexResetFireworks under a native surface", () => {
	it("does not run the frame repaint loop", () => {
		vi.useFakeTimers();
		setNativeRendering(true);
		let renders = 0;
		const handle: OverlayHandle = { hide: () => {}, setHidden: () => {}, isHidden: () => false };
		const controller = new CodexResetFireworksController({
			ui: {
				showOverlay: (_component: Component) => handle,
				setFocus: () => {},
				requestRender: () => {
					renders++;
				},
				terminal: { rows: 30 },
			},
		});
		expect(controller.show({ kind: "unscheduled-weekly-reset" })).toBe(true);
		vi.advanceTimersByTime(1_000);
		controller.dispose();
		// One paint to show the overlay; no 85ms frame ticks.
		expect(renders).toBe(1);
	});
});
