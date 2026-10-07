import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { getKeybindings, setKeybindings, type TUI } from "@oh-my-pi/pi-tui";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { AnnotationOverlay } from "@oh-my-pi/pi-tui/overlays/annotation-overlay";
import type { CodeReviewOverlayResult, ReviewDiffFile } from "@oh-my-pi/pi-tui/overlays/annotation-types";
import { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";

const ENTER = "\r";

let darkTheme: Theme | undefined;
let previousKeybindings: KeybindingsManager;

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search for the described node with sibling key `key`, returning it with its keypath. */
function findKeyed(root: NativeNode, key: string, path = ""): { node: NativeNode; path: string } | undefined {
	for (const [index, child] of (root.c ?? []).entries()) {
		if (!isNode(child)) continue;
		const childPath = path ? `${path}/${child.key ?? index}` : `${child.key ?? index}`;
		if (child.key === key) return { node: child, path: childPath };
		const found = findKeyed(child, key, childPath);
		if (found) return found;
	}
	return undefined;
}

function list(root: NativeNode, key: string): { path: string; items: NativeNode[]; selected: unknown } {
	const found = findKeyed(root, key);
	if (!found || found.node.k !== "list") throw new Error(`no list ${key}`);
	return {
		path: found.path,
		items: (found.node.c ?? []).filter(isNode),
		selected: found.node.p?.selected,
	};
}

function itemLabel(node: NativeNode): string {
	if (node.k !== "item") return "";
	const label = node.p?.label ?? "";
	return typeof label === "string" ? label : label.map(s => s.t).join("");
}

const PLAN = "# Plan\n\n## Alpha\n\nfirst\n\n## Beta\n\nsecond\n\n## Gamma\n\nthird\n";
const OPTIONS = ["Approve", "Refine plan"];

describe("review overlays under a native surface", () => {
	beforeAll(async () => {
		darkTheme = await getThemeByName("dark");
	});

	beforeEach(() => {
		if (!darkTheme) throw new Error("dark theme unavailable");
		setThemeInstance(darkTheme);
		previousKeybindings = getKeybindings() as KeybindingsManager;
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	it("plan review: a Contents click retargets the section that `a` annotates", () => {
		const onFeedbackChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			PLAN,
			{ options: OPTIONS },
			{ onPick: vi.fn(), onCancel: vi.fn(), onFeedbackChange },
		);
		const toc = list(overlay.describe(), "toc");
		expect(toc.items.map(itemLabel)).toEqual(["Alpha", "Beta", "Gamma"]);
		const beta = toc.items[1]!;

		overlay.handleNativeEvent({ type: "select", key: toc.path, item: beta.key! });
		expect(list(overlay.describe(), "toc").selected).toBe(beta.key);

		overlay.handleInput("a");
		overlay.handleInput("tighten this");
		overlay.handleInput(ENTER);
		const feedback = String(onFeedbackChange.mock.lastCall?.[0]);
		expect(feedback).toContain("## Beta");
		expect(feedback).toContain("tighten this");
		// The note shows next to its section and the Contents entry counts it.
		const root = overlay.describe();
		const betaSection = findKeyed(root, "s2");
		expect(betaSection?.node.k).toBe("col");
		expect(JSON.stringify(betaSection?.node)).toContain("tighten this");
		expect(JSON.stringify(list(root, "toc").items[1])).toContain("✎1");
	});

	it("plan review: activating an option picks it; disabled options ignore events", () => {
		const onPick = vi.fn();
		const overlay = new PlanReviewOverlay(
			PLAN,
			{ options: OPTIONS, disabledIndices: [1] },
			{ onPick, onCancel: vi.fn() },
		);
		const options = list(overlay.describe(), "options");
		overlay.handleNativeEvent({ type: "activate", key: options.path, item: options.items[1]!.key! });
		expect(onPick).not.toHaveBeenCalled();

		overlay.handleNativeEvent({ type: "activate", key: options.path, item: options.items[0]!.key! });
		expect(onPick).toHaveBeenCalledWith("Approve");
		// Committed: the options give way to a submitting spinner.
		expect(findKeyed(overlay.describe(), "options")?.node.k).toBe("spinner");
	});

	it("plan review: describe returns the same tree until visible state changes", () => {
		const overlay = new PlanReviewOverlay(PLAN, { options: OPTIONS }, { onPick: vi.fn(), onCancel: vi.fn() });
		const first = overlay.describe();
		expect(overlay.describe()).toBe(first);
		overlay.handleInput("\x1b[B");
		const moved = overlay.describe();
		expect(moved).not.toBe(first);
		expect(list(moved, "options").selected).toBe("o1");
	});

	it("code review: selecting a diff row anchors the next line note to it", () => {
		const hunkHeader = "@@ -1,2 +1,2 @@";
		const file: ReviewDiffFile = {
			path: "src/a.ts",
			occurrence: 1,
			rawDiff: "",
			rows: [
				{ kind: "hunk", raw: hunkHeader, hunkHeader },
				{ kind: "context", raw: " keep", content: "keep", oldLine: 1, newLine: 1, hunkHeader },
				{ kind: "removed", raw: "-gone", content: "gone", oldLine: 2, hunkHeader },
			],
			linesAdded: 0,
			linesRemoved: 1,
			isBinary: false,
		};
		let result: CodeReviewOverlayResult | undefined;
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			[file],
			"Reviewing",
			{ onComplete: r => (result = r) },
		);
		const lines = list(overlay.describe(), "lines");
		const removed = lines.items.find(node => itemLabel(node).includes("gone"))!;
		overlay.handleNativeEvent({ type: "select", key: lines.path, item: removed.key! });
		expect(list(overlay.describe(), "lines").selected).toBe(removed.key);

		overlay.handleInput("a");
		overlay.handleInput("why remove");
		overlay.handleInput(ENTER);
		expect(overlay.getAnnotations()).toEqual([
			expect.objectContaining({ scope: "line", oldLine: 2, rawLine: "-gone", note: "why remove" }),
		]);

		// Paste is enabled once a note exists; activating it finishes with the notes.
		const actions = list(overlay.describe(), "actions");
		overlay.handleNativeEvent({ type: "activate", key: actions.path, item: actions.items[1]!.key! });
		expect(result).toEqual({ action: "paste", annotations: overlay.getAnnotations() });
	});

	it("code review: pages native diff selection by logical source rows", () => {
		const hunkHeader = "@@ -1,6 +1,6 @@";
		const sourceRows: ReviewDiffFile["rows"] = Array.from(
			{ length: 6 },
			(_, index): ReviewDiffFile["rows"][number] => {
				const number = index + 1;
				const content = `NATIVE_ROW_${number}`;
				return { kind: "added", raw: `+${content}`, content, newLine: number, hunkHeader };
			},
		);
		const file: ReviewDiffFile = {
			path: "src/native.ts",
			occurrence: 1,
			rawDiff: "",
			rows: [{ kind: "hunk", raw: hunkHeader, hunkHeader }, ...sourceRows],
			linesAdded: sourceRows.length,
			linesRemoved: 0,
			isBinary: false,
		};
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 12 }, requestRender() {}, nativeRendering: true } as unknown as TUI,
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			[file],
			"Reviewing",
			{ onComplete: () => {} },
		);

		overlay.describe();
		overlay.handleInput("\t");
		overlay.handleInput("\x1b[6~");
		expect(list(overlay.describe(), "lines").selected).toBe("l2");
		overlay.handleInput("\x1b[5~");
		expect(list(overlay.describe(), "lines").selected).toBe("l0");
		overlay.handleInput("G");
		expect(list(overlay.describe(), "lines").selected).toBe("l5");
		overlay.handleInput("g");
		expect(list(overlay.describe(), "lines").selected).toBe("l0");
	});
	it("code review: a disabled paste action ignores activation", () => {
		const onComplete = vi.fn();
		const overlay = new AnnotationOverlay(
			{ terminal: { rows: 40 }, requestRender() {} } as unknown as TUI,
			darkTheme!,
			getKeybindings() as KeybindingsManager,
			[],
			"Reviewing",
			{ onComplete },
		);
		const actions = list(overlay.describe(), "actions");
		expect(actions.items[1]?.p).toMatchObject({ disabled: true });
		overlay.handleNativeEvent({ type: "activate", key: actions.path, item: actions.items[1]!.key! });
		expect(onComplete).not.toHaveBeenCalled();
	});
});
