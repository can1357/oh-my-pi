/** @jsxImportSource @oh-my-pi/pi-tui */
import { afterEach, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { describeTree } from "@oh-my-pi/pi-tui/testing/corpus";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { bindEffects } from "../../../src/config/registry";
import { Settings } from "../../../src/config/settings";
import { cfgTuiTight } from "../../../src/modes/settings";
import "../../../src/ui/styles/tools/block";
import "../../../src/ui/styles/tools/glob";
import "../../../src/ui/styles/transcript/exec-run";
import "../../../src/ui/styles/transcript/read-group";
import { globPresenter } from "../../../src/ui/tools/glob";
import { ExecRun, ExecRunBlock } from "../../../src/ui/transcript/exec-run";
import { AssistantMessageBlock } from "../../../src/ui/transcript/messages/assistant-message";
import { UserMessage } from "../../../src/ui/transcript/messages/user-message";
import { ReadGroup, ReadGroupBlock } from "../../../src/ui/transcript/read-group";
import { ToolBlock, ToolCall } from "../../../src/ui/transcript/tool-block";
import { single } from "./messages/harness";

const TEXT = "1234 5678";
const WIDTH = TEXT.length;
const reply: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: TEXT }],
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	provider: "openai",
	model: "test",
	api: "openai-responses",
	timestamp: 0,
};

let cleanup: (() => void) | undefined;
afterEach(() => {
	cleanup?.();
	cleanup = undefined;
});

function layoutSettings(): Settings {
	const settings = Settings.isolated();
	const release = bindEffects(settings);
	cleanup = () => {
		cfgTuiTight.override(settings, cfgTuiTight.default);
		release();
	};
	return settings;
}

function plainRows(rows: readonly string[]): string[] {
	return rows.map(row => stripEscapes(row).trimEnd());
}

test("live Tight Layout reflows assistant prose, keeps search and read one cell in, and leaves the user bubble alone", () => {
	const settings = layoutSettings();
	createRoot(dispose => {
		try {
			const assistant = single(<AssistantMessageBlock model={{ message: reply, finalized: true }} />);
			const user = single(<UserMessage model={{ text: TEXT, liveSteered: true, reaction: "👍" }} />);
			const call = new ToolCall({ id: "glob", name: "glob", args: { path: "src" }, presenter: globPresenter });
			const search = single(<ToolBlock call={call} />);
			const group = new ReadGroup();
			group.updateArgs({ path: "src/main.ts" }, "read");
			const read = single(ReadGroupBlock({ group })());
			const env = staticEnvironment(currentTheme(), { reduceMotion: true });
			const assistantRows = () => paintNode(env, assistant, WIDTH).rows;
			const userRows = () => paintNode(env, user, WIDTH).rows;
			const searchRows = () => paintNode(env, search, 40).rows;
			const readRows = () => paintNode(env, read, 40).rows;
			const rows = () => ({ assistant: assistantRows(), user: userRows(), search: searchRows(), read: readRows() });
			const off = rows();
			const native = describeTree(assistant, env);

			expect(plainRows(off.assistant)).toEqual([" 1234", " 5678"]);
			expect(plainRows(off.search).find(row => row.includes("Glob"))).toMatch(/^ \S/);
			expect(plainRows(off.read).find(row => row.includes("Read"))).toMatch(/^ \S/);
			expect(plainRows(off.user)).toContain(" 1234");

			cfgTuiTight.override(settings, true);
			expect(plainRows(assistantRows())).toEqual([TEXT]);
			expect(searchRows()).toEqual(off.search);
			expect(readRows()).toEqual(off.read);
			expect(userRows()).toEqual(off.user);
			expect(describeTree(assistant, env)).toEqual(native);

			cfgTuiTight.override(settings, false);
			expect(rows()).toEqual(off);
		} finally {
			dispose();
		}
	});
});

test("live Tight Layout widens command output, without changing the execution rules", () => {
	const settings = layoutSettings();
	createRoot(dispose => {
		try {
			const run = new ExecRun({ kind: "bash", source: "ls" });
			run.setComplete(0, false, { output: TEXT });
			const shell = single(<ExecRunBlock run={run} />);
			const env = staticEnvironment(currentTheme());
			const rows = () => paintNode(env, shell, WIDTH).rows;
			const off = rows();

			expect(plainRows(off).slice(1, -1)).toEqual([" $ ls", "", " 1234", " 5678"]);
			cfgTuiTight.override(settings, true);
			const tight = rows();
			expect(plainRows(tight).slice(1, -1)).toEqual(["$ ls", "", TEXT]);
			expect([tight[0], tight.at(-1)]).toEqual([off[0], off.at(-1)]);
			cfgTuiTight.override(settings, false);
			expect(rows()).toEqual(off);
		} finally {
			dispose();
		}
	});
});
