import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const templateJs = readFileSync(new URL("../src/export/html/template.js", import.meta.url), "utf8");

function extractKeydownHandlerBody(source: string): string {
	const start = source.indexOf("document.addEventListener('keydown', (e) => {");
	expect(start).toBeGreaterThanOrEqual(0);
	const bodyStart = source.indexOf("{", start) + 1;
	let depth = 1;
	for (let i = bodyStart; i < source.length; i++) {
		const ch = source[i];
		if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return source.slice(bodyStart, i);
		}
	}
	throw new Error("keydown listener did not close");
}

function exerciseShortcut(body: string, eventInit: Record<string, unknown>) {
	const calls: string[] = [];
	let prevented = false;
	const e = {
		key: eventInit.key,
		ctrlKey: Boolean(eventInit.ctrlKey),
		metaKey: Boolean(eventInit.metaKey),
		altKey: Boolean(eventInit.altKey),
		target: eventInit.target ?? { tagName: "BODY", isContentEditable: false },
		preventDefault() {
			prevented = true;
		},
	};
	const run = new Function(
		"e",
		"overlayStack",
		"popSubSession",
		"searchInput",
		"searchQuery",
		"navigateTo",
		"leafId",
		"toggleThinking",
		"toggleToolOutputs",
		body,
	);
	run(
		e,
		[],
		() => calls.push("pop"),
		{ value: "needle" },
		"needle",
		() => calls.push("navigate"),
		"leaf",
		() => calls.push("thinking"),
		() => calls.push("tools"),
	);
	return { calls, prevented };
}

describe("HTML export keyboard shortcuts", () => {
	const keydownBody = extractKeydownHandlerBody(templateJs);

	it("advertises browser-safe single-key toggles", () => {
		expect(templateJs).toContain("T toggle thinking · O toggle tools");
		expect(templateJs).not.toContain("Ctrl+T toggle thinking · Ctrl+O toggle tools");
	});

	it("toggles thinking and tool outputs with bare keys", () => {
		expect(exerciseShortcut(keydownBody, { key: "t" })).toEqual({ calls: ["thinking"], prevented: true });
		expect(exerciseShortcut(keydownBody, { key: "T" })).toEqual({ calls: ["thinking"], prevented: true });
		expect(exerciseShortcut(keydownBody, { key: "o" })).toEqual({ calls: ["tools"], prevented: true });
		expect(exerciseShortcut(keydownBody, { key: "O" })).toEqual({ calls: ["tools"], prevented: true });
	});

	it("does not intercept browser-reserved modifier chords", () => {
		expect(exerciseShortcut(keydownBody, { key: "t", ctrlKey: true })).toEqual({ calls: [], prevented: false });
		expect(exerciseShortcut(keydownBody, { key: "o", ctrlKey: true })).toEqual({ calls: [], prevented: false });
		expect(exerciseShortcut(keydownBody, { key: "t", metaKey: true })).toEqual({ calls: [], prevented: false });
		expect(exerciseShortcut(keydownBody, { key: "o", altKey: true })).toEqual({ calls: [], prevented: false });
	});

	it("leaves editable targets alone", () => {
		expect(
			exerciseShortcut(keydownBody, { key: "t", target: { tagName: "INPUT", isContentEditable: false } }),
		).toEqual({ calls: [], prevented: false });
		expect(
			exerciseShortcut(keydownBody, { key: "o", target: { tagName: "TEXTAREA", isContentEditable: false } }),
		).toEqual({ calls: [], prevented: false });
		expect(exerciseShortcut(keydownBody, { key: "T", target: { tagName: "DIV", isContentEditable: true } })).toEqual({
			calls: [],
			prevented: false,
		});
	});
});

describe("export tree collapse", () => {
	function extractFunctionBody(source: string, signature: string): string {
		const start = source.indexOf(signature);
		expect(start).toBeGreaterThanOrEqual(0);
		const bodyStart = source.indexOf("{", start) + 1;
		let depth = 1;
		for (let i = bodyStart; i < source.length; i++) {
			const ch = source[i];
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) return source.slice(bodyStart, i);
			}
		}
		throw new Error(`${signature} did not close`);
	}

	function hideCollapsed(collapsed: string[], tree: Array<[string, string | null]>): string[] {
		const body = extractFunctionBody(templateJs, "function hideCollapsedDescendants(flatNodes)");
		const run = new Function("flatNodes", "collapsedNodeIds", body);
		const flatNodes = tree.map(([id, parentId]) => ({ node: { entry: { id, parentId } } }));
		const kept = run(flatNodes, new Set(collapsed)) as Array<{ node: { entry: { id: string } } }>;
		return kept.map(flatNode => flatNode.node.entry.id);
	}

	// root ─┬─ a ── a2 ── a3
	//       └─ b
	const tree: Array<[string, string | null]> = [
		["root", null],
		["a", "root"],
		["a2", "a"],
		["a3", "a2"],
		["b", "root"],
	];

	it("hides a collapsed node's whole subtree, not just its children", () => {
		expect(hideCollapsed(["a"], tree)).toEqual(["root", "a", "b"]);
	});

	it("keeps the collapsed node itself, so the fold stays reversible", () => {
		expect(hideCollapsed(["root"], tree)).toEqual(["root"]);
	});

	it("leaves sibling branches alone", () => {
		expect(hideCollapsed(["b"], tree)).toEqual(["root", "a", "a2", "a3", "b"]);
	});

	it("is a no-op with nothing collapsed", () => {
		expect(hideCollapsed([], tree)).toEqual(["root", "a", "a2", "a3", "b"]);
	});
});
