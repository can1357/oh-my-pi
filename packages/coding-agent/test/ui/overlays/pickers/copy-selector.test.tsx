/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import type { UiEvent } from "@oh-my-pi/pi-tui";
import { fullscreenMenuView } from "../../../../src/modes/controllers/selector-views";
import { nativeShell } from "../../../helpers/native-shell";
import type { TranscriptEntryLike } from "../../../../src/session/transcript/transcript-entry";
import { CopySelector } from "../../../../src/ui/overlays/pickers/copy-selector";
import { type Driver, pickerSuite } from "./harness";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const entry = (id: string, parentId: string | null, message: unknown): TranscriptEntryLike =>
	({ type: "message", id, parentId, timestamp: "2024-01-01T10:20:00Z", message }) as unknown as TranscriptEntryLike;
const assistant = (content: unknown[]) => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "m",
	stopReason: "stop",
	usage,
	timestamp: 2,
});
const CODE = "const answer = 42;\nconsole.log(answer);";
const LINK = "https://github.com/can1357/oh-my-pi/pull/10503";
const LONG = Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n");
const BASIC = [
	entry("u1", null, { role: "user", content: "fix the logging ✨ 日本語", timestamp: 1 }),
	entry(
		"a1",
		"u1",
		assistant([
			{
				type: "text",
				text: `Here is the fix:\n\`\`\`ts\n${CODE}\n\`\`\`\n> quoted\n\nDone. See [the PR](${LINK}).`,
			},
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "bun test" } },
		]),
	),
	entry("t1", "a1", {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: "12 pass" }],
		isError: false,
		timestamp: 3,
	}),
	entry("u2", "t1", { role: "user", content: "more\n```py\nprint(1)\n```", timestamp: 4 }),
	entry("a2", "u2", assistant([{ type: "text", text: `big:\n\`\`\`\n${LONG}\n\`\`\`` }])),
	entry("a3", "a2", assistant([{ type: "toolCall", id: "call-2", name: "read", arguments: { path: "/tmp/a.ts" } }])),
	entry("t3", "a3", {
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "read",
		content: [{ type: "text", text: "export const a = 1;" }],
		isError: false,
		timestamp: 5,
	}),
];
const MANY: TranscriptEntryLike[] = [];
for (let i = 0, parent: string | null = null; i < 330; i++) {
	MANY.push(entry(`u${i}`, parent, { role: "user", content: `question ${i}`, timestamp: i }));
	MANY.push(entry(`a${i}`, `u${i}`, assistant([{ type: "text", text: `answer ${i} \`code\`` }])));
	parent = `a${i}`;
}
const noop = (): void => {};
/**
 * Old steps addressed keypaths of the old screen's own trees (`list`, `blocks`, `preview`, `x`): they replay as the
 * picker gesture with the same effect (a `list` click picks; the others run their action on the picker).
 */
function ev(
	event: { type: "select" | "activate"; key: string; item: string } | { type: "action"; key: string; act: string },
) {
	return (d: Driver): void => {
		if (event.type !== "action") {
			if (event.key === "list") d.emit({ type: "activate", key: "", item: event.item });
			else if (event.key === "") d.emit(event as UiEvent);
			return;
		}
		const key = event.key === "" || /^b\d+$|^whole$/.test(event.key) ? event.key : "";
		d.emit({ ...event, key, mods: [] } as UiEvent);
	};
}

test("the primary Copy action picks the outlined turn; its preview action picks just the block", async () => {
	await using ui = await nativeShell();
	const picked: string[] = [];
	const text = "more\n```py\nprint(1)\n```";
	ui.shell.overlays.show(() =>
		fullscreenMenuView(
			"copy",
			<CopySelector
				entries={[entry("u", null, { role: "user", content: text, timestamp: 1 })]}
				onPick={content => picked.push(content)}
				onCancel={noop}
			/>,
		),
	);
	ui.send({ ev: "action", sf: ui.sf, id: ui.node("picker").id, act: "pick" });
	ui.send({ ev: "action", sf: ui.sf, id: ui.node("section", "b0").id, act: "pick" });
	expect(picked).toEqual([text, "print(1)"]);
});

pickerSuite({
	dir: "overlays/copy-selector",
	mount(caseName) {
		const entries = caseName === "empty" ? [] : caseName === "truncated" ? MANY : BASIC;
		const extra = caseName === "titled" ? { title: "Annotate  this", actionLabel: "annotate" } : {};
		return {
			view: () => (
				<CopySelector
					entries={entries}
					onPick={noop}
					onOpen={caseName === "titled" ? undefined : noop}
					onCancel={noop}
					terminalRows={() => 30}
					{...extra}
				/>
			),
			focus: d => d.root,
			steps: {
				render: noop,
				"native select u1": ev({ type: "select", key: "", item: "u1" }),
				"native action blocks": ev({ type: "action", key: "", act: "blocks" }),
				"native select block 2": ev({ type: "select", key: "blocks", item: "2" }),
				"native pick b1": ev({ type: "action", key: "b1", act: "pick" }),
				"native back": ev({ type: "action", key: "", act: "close" }),
				"native list select a2": ev({ type: "select", key: "list", item: "a2" }),
				"native card blocks": ev({ type: "action", key: "preview", act: "blocks" }),
				"native card back": ev({ type: "action", key: "x", act: "back" }),
				"native earlier list": d => void d.emit({ type: "action", key: "", act: "earlier", mods: [] }),
				"native picker earlier": ev({ type: "action", key: "", act: "earlier" }),
			},
		};
	},
});
