/**
 * Regression coverage for #14131: a registered `async-result` message renderer
 * must own the background-completion card on both transcript paths.
 *
 * The built-in `async-result` branch used to return the completion row before
 * `getMessageRenderer` was consulted, so `registerMessageRenderer("async-result", …)`
 * never ran — on the live path (`UiHelpers.addMessageToChat`) or on replay
 * (`ChatTranscriptBuilder`). The built-in row stays the fallback for three
 * cases: no renderer registered, a renderer that declines (returns undefined),
 * and a renderer that THROWS. The throw case is the reason the dispatch lives
 * in one shared helper: `FramedMessageComponent` swallows renderer exceptions
 * and falls through to the generic frame, which would otherwise replace the
 * useful completion row with the raw `<system-notice>` body.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { MessageRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { buildAsyncResultComponent } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

const BUILT_IN_MARKER = "Background job completed";
const EXTENSION_MARKER = "EXTENSION OWNED THIS CARD";

function asyncResultMessage(): AgentMessage {
	return {
		role: "custom",
		customType: "async-result",
		content: "<system-notice>Background job bg_1 has completed.</system-notice>",
		display: true,
		details: { jobId: "bg_1", type: "bash", label: "npm test", durationMs: 1234 },
	} as unknown as AgentMessage;
}

/** A renderer that owns the card and identifies itself in the transcript. */
function owningRenderer(): MessageRenderer {
	return () => new Text(EXTENSION_MARKER);
}

/** A renderer that declines to render, leaving the built-in card in place. */
const decliningRenderer: MessageRenderer = () => undefined;

/** A renderer that faults: the built-in card must survive it. */
const throwingRenderer: MessageRenderer = () => {
	throw new Error("boom");
};

function renderLive(
	renderer: MessageRenderer | undefined,
): { ctx: InteractiveModeContext; helpers: UiHelpers } {
	const ctx = {
		chatContainer: new Container(),
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		ui: { requestRender: vi.fn() },
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		session: {
			retryAttempt: 0,
			getToolByName: () => undefined,
			sessionManager: { getCwd: () => process.cwd() },
			// No extension runner at all when nothing is registered.
			extensionRunner: renderer ? { getMessageRenderer: () => renderer } : undefined,
		},
		get viewSession() {
			return (this as typeof ctx).session;
		},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	helpers.addMessageToChat(asyncResultMessage());
	return { ctx, helpers };
}

function renderReplay(renderer: MessageRenderer | undefined): string {
	const builder = new ChatTranscriptBuilder({
		ui: { requestRender: vi.fn() } as unknown as TUI,
		cwd: process.cwd(),
		requestRender: vi.fn(),
		getMessageRenderer: renderer ? () => renderer : undefined,
	});
	builder.rebuild([
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: asyncResultMessage(),
		} as never,
	]);
	return builder.container.children.map(child => child.render(120).join("\n")).join("\n");
}

function liveText(ctx: InteractiveModeContext): string {
	return ctx.chatContainer.children.map(child => child.render(120).join("\n")).join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("async-result message renderer precedence", () => {
	it("lets a registered renderer own the live completion card", () => {
		const { ctx } = renderLive(owningRenderer());
		const rendered = liveText(ctx);
		expect(rendered).toContain(EXTENSION_MARKER);
		expect(rendered).not.toContain(BUILT_IN_MARKER);
	});

	it("falls back to the built-in card when a live renderer declines", () => {
		const { ctx } = renderLive(decliningRenderer);
		const rendered = liveText(ctx);
		expect(rendered).toContain(BUILT_IN_MARKER);
		expect(rendered).not.toContain(EXTENSION_MARKER);
	});

	it("falls back to the built-in card when a live renderer throws", () => {
		const { ctx } = renderLive(throwingRenderer);
		const rendered = liveText(ctx);
		expect(rendered).toContain(BUILT_IN_MARKER);
		// The generic frame would print the raw message body instead.
		expect(rendered).not.toContain("<system-notice>");
	});

	it("renders the built-in live card when nothing is registered", () => {
		const { ctx } = renderLive(undefined);
		const rendered = liveText(ctx);
		expect(rendered).toContain(BUILT_IN_MARKER);
	});

	it("lets a registered renderer own the replayed completion card", () => {
		const rendered = renderReplay(owningRenderer());
		expect(rendered).toContain(EXTENSION_MARKER);
		expect(rendered).not.toContain(BUILT_IN_MARKER);
	});

	it("falls back to the built-in card on replay when a renderer declines", () => {
		const rendered = renderReplay(decliningRenderer);
		expect(rendered).toContain(BUILT_IN_MARKER);
		expect(rendered).not.toContain(EXTENSION_MARKER);
	});

	it("falls back to the built-in card on replay when a renderer throws", () => {
		const rendered = renderReplay(throwingRenderer);
		expect(rendered).toContain(BUILT_IN_MARKER);
		expect(rendered).not.toContain("<system-notice>");
	});

	it("renders the built-in replayed card when nothing is registered", () => {
		const rendered = renderReplay(undefined);
		expect(rendered).toContain(BUILT_IN_MARKER);
	});
});

describe("async-result card honors display.hideToolActivity", () => {
	// Regression: the built-in fallback used to be nested inside the frame, and
	// `TranscriptContainer` only propagates the preference to TOP-LEVEL
	// children implementing `setToolActivityVisible`. Registering a renderer
	// that declined or threw therefore re-showed completion rows to users who
	// had hidden tool activity.
	function throughContainer(renderer: MessageRenderer | undefined, visible: boolean): string {
		const container = new TranscriptContainer();
		container.setToolActivityVisible(visible);
		container.addChild(buildAsyncResultComponent(asyncResultMessage() as never, renderer));
		return container.children.map(child => child.render(120).join("\n")).join("\n");
	}

	it("keeps the built-in card hidden when a renderer declines", () => {
		expect(throughContainer(decliningRenderer, false)).not.toContain(BUILT_IN_MARKER);
	});

	it("keeps the built-in card hidden when a renderer throws", () => {
		expect(throughContainer(throwingRenderer, false)).not.toContain(BUILT_IN_MARKER);
	});

	it("keeps the built-in card hidden with no renderer at all", () => {
		expect(throughContainer(undefined, false)).not.toContain(BUILT_IN_MARKER);
	});

	it("still shows the built-in card when tool activity is visible", () => {
		expect(throughContainer(decliningRenderer, true)).toContain(BUILT_IN_MARKER);
	});
});
