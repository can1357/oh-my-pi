import { describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme";

function createRuntime() {
	const handleForkCommand = vi.fn(async (_placement?: "pane" | "window") => undefined);
	const setText = vi.fn();
	const showError = vi.fn();
	const runtime = {
		ctx: {
			handleForkCommand,
			editor: { setText },
			showError,
		} as unknown as InteractiveModeContext,
	} as BuiltinSlashCommandRuntime;
	return { handleForkCommand, setText, showError, runtime };
}

function createForkEditor(): Editor {
	const editor = new Editor({
		...getEditorTheme(),
		hintStyle: text => `\x1b[2m${text}\x1b[0m`,
	});
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd()));
	return editor;
}

async function untilRendered(editor: Editor, predicate: (frame: string) => boolean): Promise<string> {
	while (true) {
		const frame = editor.render(80).join("\n");
		if (predicate(frame)) return frame;
		await nextAutocompleteUpdate(editor);
	}
}

function nextAutocompleteUpdate(editor: Editor): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const previous = editor.onAutocompleteUpdate;
	editor.onAutocompleteUpdate = () => {
		editor.onAutocompleteUpdate = previous;
		previous?.();
		resolve();
	};
	return promise;
}

function captureSubmissions(editor: Editor): string[] {
	const submitted: string[] = [];
	editor.onSubmit = text => {
		submitted.push(text.trim());
	};
	return submitted;
}

describe("/fork slash command", () => {
	it("submits bare /fork on Enter after a typed trailing space", async () => {
		const editor = createForkEditor();
		const submitted = captureSubmissions(editor);
		for (const character of "/fork ") editor.handleInput(character);
		await nextAutocompleteUpdate(editor);

		editor.handleInput("\r");
		expect(submitted).toEqual(["/fork"]);
	});

	it("submits bare /fork on Enter after Tab accepts the command name", async () => {
		const editor = createForkEditor();
		const submitted = captureSubmissions(editor);
		for (const character of "/fork") editor.handleInput(character);
		await untilRendered(editor, () => editor.isShowingAutocomplete());

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/fork ");
		// Accepting a command name chains an argument-completion request; let it settle.
		await nextAutocompleteUpdate(editor);

		editor.handleInput("\r");
		expect(submitted).toEqual(["/fork"]);
	});

	it("renders the remaining window suffix for a partial prefix and accepts it with Tab", async () => {
		const editor = createForkEditor();
		for (const character of "/fork w") editor.handleInput(character);

		await untilRendered(editor, value => editor.isShowingAutocomplete() && value.includes("\x1b[2mindow\x1b[0m"));
		expect(editor.getText()).toBe("/fork w");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("/fork window ");
	});

	it("keeps bare /fork on the in-process fork path", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/fork", harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).toHaveBeenCalledWith();
	});

	it.each([
		["pane", "pane"],
		["window", "window"],
		["tab", "window"],
	] as const)("routes /fork %s to %s placement", async (argument, expectedPlacement) => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand(`/fork ${argument}`, harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).toHaveBeenCalledWith(expectedPlacement);
	});

	it("consumes invalid placement without submitting it as a prompt", async () => {
		const harness = createRuntime();
		expect(await executeBuiltinSlashCommand("/fork pane extra", harness.runtime)).toBe(true);
		expect(harness.handleForkCommand).not.toHaveBeenCalled();
		expect(harness.showError).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});
