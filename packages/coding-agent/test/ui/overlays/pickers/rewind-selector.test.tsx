/** @jsxImportSource @oh-my-pi/pi-tui */
import type { TranscriptEntryLike } from "../../../../src/session/transcript/transcript-entry";
import { RewindSelector } from "../../../../src/ui/overlays/pickers/rewind-selector";
import { pickerSuite } from "./harness";

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
