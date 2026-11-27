import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import * as opener from "@oh-my-pi/pi-coding-agent/utils/open";

function assistantText(text: string): AgentMessage {
	return { role: "assistant", content: [{ type: "text", text }] } as unknown as AgentMessage;
}

function assistantCalls(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>): AgentMessage {
	return {
		role: "assistant",
		content: toolCalls.map((tc, i) => ({ type: "toolCall", id: `tc-${i}`, name: tc.name, arguments: tc.arguments })),
	} as unknown as AgentMessage;
}

function createRuntimeHarness(messages: AgentMessage[], viewMessages: AgentMessage[] = messages) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showCopySelector = vi.fn();
	const showCodeBlockSelector = vi.fn();
	return {
		setText,
		showStatus,
		showWarning,
		showCopySelector,
		showCodeBlockSelector,
		runtime: {
			ctx: {
				session: { messages },
				viewSession: { messages: viewMessages },
				composer: { setText },
				showStatus,
				showWarning,
				showCopySelector,
				showCodeBlockSelector,
			} as unknown as InteractiveModeContext,
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/copy slash command", () => {
	it("copies the last assistant code block without opening the picker", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([
			assistantText("old\n```ts\nconst oldValue = 1;\n```"),
			assistantText("new\n```sh\necho first\n```\n```py\nprint('last')\n```"),
		]);

		expect(await executeBuiltinSlashCommand("/copy code", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("print('last')");
		expect(harness.showStatus).toHaveBeenCalledWith("Copied code block to clipboard");
		expect(harness.showCopySelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("copies from the focused subagent's transcript, not the main session", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness(
			[assistantText("main\n```ts\nconst main = 1;\n```")],
			[assistantText("subagent\n```ts\nconst sub = 1;\n```")],
		);

		expect(await executeBuiltinSlashCommand("/copy code", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("const sub = 1;");
	});

	it("copies the last runnable command without opening the picker", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([
			assistantCalls([{ name: "bash", arguments: { command: "echo old" } }]),
			assistantCalls([{ name: "eval", arguments: { language: "py", code: "print(42)" } }]),
		]);

		expect(await executeBuiltinSlashCommand("/copy cmd", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("print(42)");
		expect(harness.showStatus).toHaveBeenCalledWith("Copied eval code to clipboard");
		expect(harness.showCopySelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("copies the last link's URL with /copy link", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([
			assistantText("first https://example.com/old"),
			assistantText("see [docs](https://example.com/docs) and https://example.com/last."),
		]);

		expect(await executeBuiltinSlashCommand("/copy link", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("https://example.com/last");
		expect(harness.showStatus).toHaveBeenCalledWith("Copied link to clipboard");
		expect(harness.showCopySelector).not.toHaveBeenCalled();
	});

	it("reports when there is no link to copy", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([assistantText("no links")]);

		expect(await executeBuiltinSlashCommand("/copy link", harness.runtime)).toBe(true);

		expect(copySpy).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith("No link to copy.");
	});

	it("creates and copies the session's local:// directory with /copy local", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		using tempDir = TempDir.createSync("@pi-copy-local-");
		const localRoot = path.join(tempDir.path(), "session", "local");
		const harness = createRuntimeHarness([assistantText("answer")]);
		Object.assign(harness.runtime.ctx.session, { localRoot });

		expect(await executeBuiltinSlashCommand("/copy local", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith(localRoot);
		expect(fs.statSync(localRoot).isDirectory()).toBe(true);
		expect(harness.showCopySelector).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("keeps bare /copy on the picker", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([assistantText("answer")]);

		expect(await executeBuiltinSlashCommand("/copy", harness.runtime)).toBe(true);

		expect(harness.showCopySelector).toHaveBeenCalledTimes(1);
		expect(copySpy).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("strips trailing spaces per line when copying code blocks", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([assistantText("```ts\nconst a = 1;   \n  const b = 2;\t\n```")]);

		expect(await executeBuiltinSlashCommand("/copy code", harness.runtime)).toBe(true);

		expect(copySpy).toHaveBeenCalledWith("const a = 1;\n  const b = 2;");
	});

	it("copies a specific 1-based code block from the latest reply with /copy code <n>", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([
			assistantText("old\n```ts\nconst old = 1;\n```"),
			assistantText("first\n```sh\necho first   \n```\nsecond\n````md\n```ts\nconst nested = 2;  \n```\n````"),
		]);

		expect(await executeBuiltinSlashCommand("/copy code 1", harness.runtime)).toBe(true);
		expect(copySpy).toHaveBeenLastCalledWith("echo first");
		expect(harness.showStatus).toHaveBeenLastCalledWith("Copied sh code block #1 to clipboard");

		expect(await executeBuiltinSlashCommand("/copy code 2", harness.runtime)).toBe(true);
		expect(copySpy).toHaveBeenLastCalledWith("```ts\nconst nested = 2;\n```");
		expect(harness.showStatus).toHaveBeenLastCalledWith("Copied md code block #2 to clipboard");

		expect(await executeBuiltinSlashCommand("/copy code 3", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenLastCalledWith("Code block #3 not found (latest reply has 2 code blocks).");
	});

	it("opens the interactive code-block selector with /copy code pick", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([assistantText("```sh\necho one\n```\n```ts\nconst two = 2;\n```")]);

		expect(await executeBuiltinSlashCommand("/copy code pick", harness.runtime)).toBe(true);
		expect(harness.showCodeBlockSelector).toHaveBeenCalledTimes(1);
		expect(copySpy).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/open slash command", () => {
	it("opens the last assistant link with the system opener", async () => {
		const openSpy = spyOn(opener, "openPath").mockImplementation(() => {});
		const harness = createRuntimeHarness([
			assistantText("older https://example.com/old"),
			assistantText(
				"CI: https://github.com/dalilshorja/dalilshorja/actions/runs/1 and the PR https://github.com/dalilshorja/dalilshorja/pull/4.",
			),
		]);

		expect(await executeBuiltinSlashCommand("/open", harness.runtime)).toBe(true);

		expect(openSpy).toHaveBeenCalledWith("https://github.com/dalilshorja/dalilshorja/pull/4");
		expect(harness.showStatus).toHaveBeenCalledWith("Opening https://github.com/dalilshorja/dalilshorja/pull/4");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	it("reports when there is no link and rejects unknown arguments", async () => {
		const openSpy = spyOn(opener, "openPath").mockImplementation(() => {});
		const harness = createRuntimeHarness([assistantText("no links")]);

		expect(await executeBuiltinSlashCommand("/open", harness.runtime)).toBe(true);
		expect(harness.showStatus).toHaveBeenCalledWith("No link to open.");

		expect(await executeBuiltinSlashCommand("/open code", harness.runtime)).toBe(true);
		expect(openSpy).not.toHaveBeenCalled();
	});
});
