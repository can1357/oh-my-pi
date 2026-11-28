/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { createRoot, resolveChildren } from "@oh-my-pi/pi-tui";
import { bubbleKey } from "@oh-my-pi/pi-tui/dispatch";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { TranscriptEntryLike } from "../../../../src/session/transcript/transcript-entry";
import { RewindSelector } from "../../../../src/ui/overlays/pickers/rewind-selector";
import { keyFromRaw, pickerSuite } from "./harness";

const e = (id: string, parentId: string | null, message: unknown): TranscriptEntryLike =>
	({ type: "message", id, parentId, timestamp: "2024-01-01T00:00:00Z", message }) as unknown as TranscriptEntryLike;
const user = (t: string) => ({ role: "user", content: t, timestamp: 1 });
const asst = (t: string, call?: string) => ({
	role: "assistant",
	content: [
		{ type: "text", text: t },
		...(call ? [{ type: "toolCall", id: call, name: "bash", arguments: { command: "ls" } }] : []),
	],
	stopReason: "stop",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	timestamp: 2,
});
const result = (call: string) => ({
	role: "toolResult",
	toolCallId: call,
	toolName: "bash",
	content: [{ type: "text", text: "file.txt" }],
	timestamp: 3,
});
const ENTRIES = [
	e("u1", null, user("first prompt")),
	e("a1", "u1", asst("Running a command.", "c1")),
	e("t1", "a1", result("c1")),
	e("u2", "t1", user("打开文件后输出你好世界")),
	e("a2", "u2", asst("done with a long answer ".repeat(8))),
	e("u3", "a2", user("third prompt")),
];
const LONG = Array.from({ length: 120 }, (_, i) => e(`u${i}`, i ? `u${i - 1}` : null, user(`prompt ${i}`)));
const noop = (): void => {};

test("the rewind screen's title uses the ASCII rewind icon", () => {
	createRoot(dispose => {
		try {
			const [node] = resolveChildren(
				<RewindSelector entries={ENTRIES} terminalRows={() => 30} onSelect={noop} onCancel={noop} />,
			)();
			const theme = loadThemeSync("dark", { symbolPreset: "ascii" });
			const rows = paintNode(staticEnvironment(theme), node!, 100).rows.map(stripEscapes);
			expect(rows.find(row => row.includes("pick the point"))).toContain("<- Rewind");
		} finally {
			dispose();
		}
	});
});

test("the terminal look opens a long branch on its recent turns", () => {
	// One prompt, then 700 replies: the look once drew all 701 turns at open, freezing on long sessions.
	const entries = [e("u", null, user("run the sweep"))];
	for (let i = 0; i < 700; i++) entries.push(e(`a${i}`, entries.at(-1)!.id, asst(`step ${i}`)));
	createRoot(dispose => {
		try {
			const [node] = resolveChildren(
				<RewindSelector entries={entries} terminalRows={() => 30} onSelect={noop} onCancel={noop} />,
			)();
			const screen = stripEscapes(paintNode(staticEnvironment(loadThemeSync("dark")), node!, 160).rows.join("\n"));
			expect(screen).toContain("600/600");
			expect(screen).toContain("a earlier turns");
		} finally {
			dispose();
		}
	});
});

test("a long selected turn stays in place when the rewind filter opens and closes", () => {
	const longPrompt = (prefix: string) => Array.from({ length: 40 }, (_, i) => `${prefix} line ${i}`).join("\n");
	const entries = [e("earlier", null, user(longPrompt("earlier"))), e("latest", "earlier", user(longPrompt("latest")))];
	createRoot(dispose => {
		try {
			const [node] = resolveChildren(
				<RewindSelector entries={entries} terminalRows={() => 15} onSelect={noop} onCancel={noop} />,
			)();
			const env = staticEnvironment(loadThemeSync("dark"));
			const body = () => stripEscapes(paintNode(env, node!, 100).rows.slice(3, -2).join("\n"));
			const press = (raw: string) => expect(bubbleKey([node!], keyFromRaw(raw))).toBe(true);

			const latest = body();
			expect(latest).toContain("latest line");
			press("f");
			expect(body()).toBe(latest);
			press("\x1b");
			expect(body()).toBe(latest);

			press("\x1b[A");
			expect(body()).toContain("earlier line");
			press("\x1b[B");
			expect(body()).toBe(latest);
		} finally {
			dispose();
		}
	});
});

pickerSuite({
	dir: "overlays/rewind-selector",
	mount(caseName) {
		const entries = caseName === "long" ? LONG : ENTRIES;
		const siblingPaths =
			caseName === "strip"
				? (id: string) =>
						id === "u2"
							? [
									{
										rootId: "alt",
										entries: [e("alt", "t1", user("alternate path")), e("alt2", "alt", asst("alt answer"))],
									},
								]
							: []
				: undefined;
		return {
			view: () => (
				<RewindSelector
					entries={entries}
					siblingPaths={siblingPaths as never}
					terminalRows={() => 30}
					onSelect={noop}
					onCancel={noop}
				/>
			),
			focus: d => d.root,
			steps: {
				"native rewind": d => void d.emit({ type: "action", key: "", act: "rewind", mods: [] }),
				screen: noop,
			},
		};
	},
});
