import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { jsx } from "@oh-my-pi/pi-tui";
import type { TranscriptBlock } from "../src/ui/shell";
import { initTheme } from "../src/ui/theme/service";
import { createInteractiveModeContext, renderTranscript } from "./helpers/interactive-mode-context";
import { renderRows } from "./helpers/mode-terminal";

/** A fixture context whose transcript helpers are the real {@link UiHelpers}. */
function createHarness(): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = createInteractiveModeContext({
		session: { buildTranscriptSessionContext: () => buildSessionContext([]) },
	});
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = helpers.addMessageToChat.bind(helpers);
	ctx.renderSessionContext = helpers.renderSessionContext.bind(helpers);
	ctx.renderSessionContextIncrementally = helpers.renderSessionContextIncrementally.bind(helpers);
	return { ctx, helpers };
}

const blocks = (ctx: InteractiveModeContext): readonly TranscriptBlock[] => ctx.shell.transcript.blocks();
const blockText = (block: TranscriptBlock | undefined): string =>
	block ? renderRows(() => block.node).join("\n") : "";
const lastText = (ctx: InteractiveModeContext): string => blockText(blocks(ctx).at(-1));
const transcript = (ctx: InteractiveModeContext): string => renderTranscript(ctx).join("\n");

describe("InteractiveMode.showStatus", () => {
	beforeAll(async () => {
		// showStatus uses the global theme instance; renderInitialMessages reads
		// the global Settings (display.collapseCompacted).
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		initTheme();
	});

	afterAll(() => {
		resetSettingsForTest();
	});

	test("coalesces immediately-sequential status messages", () => {
		const { ctx, helpers } = createHarness();

		helpers.showStatus("STATUS_ONE");
		expect(blocks(ctx)).toHaveLength(1);
		expect(lastText(ctx)).toContain("STATUS_ONE");

		helpers.showStatus("STATUS_TWO");
		// second status updates the previous notice instead of appending
		expect(blocks(ctx)).toHaveLength(1);
		expect(lastText(ctx)).toContain("STATUS_TWO");
		expect(lastText(ctx)).not.toContain("STATUS_ONE");
	});

	test("a repeated identical status swaps in a fresh notice so native terminals re-toast it", () => {
		const { ctx, helpers } = createHarness();

		helpers.showStatus("Objective: ship it");
		const first = blocks(ctx)[0];
		helpers.showStatus("Objective: ship it");
		// One line in the transcript, but a new block: the reconciler only
		// sends a toast for a node it has not seen, never for identical props.
		expect(blocks(ctx)).toHaveLength(1);
		expect(blocks(ctx)[0]).not.toBe(first);
		expect(lastText(ctx)).toContain("Objective: ship it");
	});

	test("appends a new status line if something else was added in between", () => {
		const { ctx, helpers } = createHarness();

		helpers.showStatus("STATUS_ONE");
		expect(blocks(ctx)).toHaveLength(1);

		// Something else gets added to the chat in between status updates
		ctx.present(() => jsx("text", { text: "OTHER" }));
		expect(blocks(ctx)).toHaveLength(2);

		helpers.showStatus("STATUS_TWO");
		// adds a fresh notice rather than rewriting the stale one
		expect(blocks(ctx)).toHaveLength(3);
		expect(lastText(ctx)).toContain("STATUS_TWO");
		expect(blockText(blocks(ctx)[0])).toContain("STATUS_ONE");
	});

	test("a keyed status updates its line across notices but appends once other content follows", () => {
		const { ctx, helpers } = createHarness();

		helpers.showStatus("Connecting…", { key: "k" });
		helpers.showStatus("NOTICE_A", { collapse: false });
		helpers.showStatus("NOTICE_B", { collapse: false });
		helpers.showStatus("Connected", { key: "k" });
		// Notices in between survive, and the keyed line is rewritten rather than duplicated.
		const startup = transcript(ctx);
		expect(blocks(ctx)).toHaveLength(3);
		expect(startup).toContain("NOTICE_A");
		expect(startup).toContain("NOTICE_B");
		expect(startup).toContain("Connected");
		expect(startup).not.toContain("Connecting…");

		// Once the conversation moves on, the old line may be in scrollback: append a fresh one.
		ctx.present(() => jsx("text", { text: "OTHER" }));
		helpers.showStatus("Reconnecting…", { key: "k" });
		expect(blocks(ctx)).toHaveLength(5);
		expect(lastText(ctx)).toContain("Reconnecting…");
		expect(blockText(blocks(ctx)[0])).toContain("Connected");
	});

	test("preserves startup notifications while rendering the initial transcript", async () => {
		const { ctx, helpers } = createHarness();

		helpers.showWarning("startup notification probe");
		await helpers.renderInitialMessages({ preserveExistingChat: true });

		expect(transcript(ctx)).toContain("startup notification probe");
	});

	test("preserves optimistic user signatures when rebuilding transcript state", () => {
		const { ctx, helpers } = createHarness();
		ctx.optimisticUserMessageSignature = "hello\u00001";

		helpers.renderSessionContext(buildSessionContext([]));

		// renderSessionContext must not clear the signature — the message_start
		// handler owns this lifecycle and uses it to guard against clearing the
		// user's in-progress editor draft during an optimistic send (#783).
		expect(ctx.optimisticUserMessageSignature).toBe("hello\u00001");
	});
});
