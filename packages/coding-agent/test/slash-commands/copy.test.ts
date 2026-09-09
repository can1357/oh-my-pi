import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
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

function createRuntimeHarness(messages: AgentMessage[]) {
	const setText = vi.fn();
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showCopySelector = vi.fn();
	return {
		setText,
		showStatus,
		showWarning,
		showCopySelector,
		runtime: {
			ctx: {
				session: { messages },
				editor: { setText },
				showStatus,
				showWarning,
				showCopySelector,
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

	it("keeps bare /copy on the picker", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		const harness = createRuntimeHarness([assistantText("answer")]);

		expect(await executeBuiltinSlashCommand("/copy", harness.runtime)).toBe(true);

		expect(harness.showCopySelector).toHaveBeenCalledTimes(1);
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
		expect(harness.showStatus).toHaveBeenLastCalledWith(
			"Usage: /open [link]  (pick a specific link: /copy, → blocks, o)",
		);
		expect(openSpy).not.toHaveBeenCalled();
	});
});
