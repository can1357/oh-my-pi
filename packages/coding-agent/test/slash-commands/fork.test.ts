import { afterAll, describe, expect, it, vi } from "bun:test";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMANDS,
	executeBuiltinSlashCommand,
	type BuiltinSlashCommandRuntime,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/autocomplete/autocomplete";
import { createRoot } from "@oh-my-pi/pi-tui";
import { Composer } from "../../src/ui/composer";
import { key, sendKey } from "../ui/composer/harness";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

function createRuntime() {
	const handleForkCommand = vi.fn(async (_placement?: "pane" | "window") => undefined);
	const setText = vi.fn();
	const showError = vi.fn();
	const runtime = {
		ctx: {
			handleForkCommand,
			composer: { setText },
			showError,
		} as unknown as InteractiveModeContext,
	} as BuiltinSlashCommandRuntime;
	return { handleForkCommand, setText, showError, runtime };
}

interface ForkComposer {
	readonly composer: Composer;
	readonly submitted: string[];
	/** Type `text` one key at a time, or press a key by raw sequence (`\r`, `\t`). */
	press(text: string): void;
}

function createForkComposer(): ForkComposer {
	return createRoot(() => {
		const submitted: string[] = [];
		const composer = new Composer({
			autocomplete: new CombinedAutocompleteProvider([...BUILTIN_SLASH_COMMANDS], process.cwd()),
			onSubmit: text => submitted.push(text.trim()),
		});
		return {
			composer,
			submitted,
			press(text) {
				if (text === "\r" || text === "\t") sendKey(composer.node, composer.field, key(text));
				else for (const ch of text) sendKey(composer.node, composer.field, key(ch));
			},
		};
	});
}

/** Let the provider's pending suggestion requests answer. */
async function settleCompletions(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("/fork slash command", () => {
	it("submits bare /fork on Enter after a typed trailing space", async () => {
		const editor = createForkComposer();
		editor.press("/fork ");
		await settleCompletions();

		editor.press("\r");
		expect(editor.submitted).toEqual(["/fork"]);
	});

	it("submits bare /fork on Enter after Tab accepts the command name", async () => {
		const editor = createForkComposer();
		editor.press("/fork");
		await settleCompletions();
		expect(editor.composer.completing()).toBe(true);

		editor.press("\t");
		expect(editor.composer.text()).toBe("/fork ");
		// Accepting a command name chains an argument-completion request; let it settle.
		await settleCompletions();

		editor.press("\r");
		expect(editor.submitted).toEqual(["/fork"]);
	});

	it("completes a partial placement prefix to the window placement with Tab", async () => {
		const editor = createForkComposer();
		editor.press("/fork w");
		// Tab asks for the argument's completions; the popup lists the matching placement.
		editor.press("\t");
		await settleCompletions();
		expect(editor.composer.completing()).toBe(true);
		expect(editor.composer.text()).toBe("/fork w");

		editor.press("\t");
		expect(editor.composer.text()).toBe("/fork window ");
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
