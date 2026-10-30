/**
 * Regression coverage for #14131: a registered `async-result` message renderer
 * must own the background-completion card on both transcript paths.
 *
 * The built-in `async-result` branch used to return the completion row before
 * `getMessageRenderer` was consulted, so `registerMessageRenderer("async-result", …)`
 * never ran — on the live path (`UiHelpers.addMessageToChat`) or on replay
 * (`ChatTranscriptBuilder`). The built-in row stays the fallback for "no renderer"
 * and for a renderer that declines (returns undefined).
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { ChatTranscriptBuilder } from "@oh-my-pi/pi-tui/chat/chat-transcript-builder";
import type { MessageRenderer } from "@oh-my-pi/pi-tui/chat/extension-types";
import { Text } from "@oh-my-pi/pi-tui/components/text";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
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

/** A renderer registered for every custom type that declines to render. */
const decliningRenderer: MessageRenderer = () => undefined;

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
		ui: { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI,
		getMessageRenderer: renderer ? () => renderer : undefined,
		cwd: process.cwd(),
		requestRender: () => {},
	});
	builder.rebuild([
		{
			type: "message",
			id: "e1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: asyncResultMessage(),
		},
	]);
	return builder.container.children.map(child => child.render(120).join("\n")).join("\n");
}

beforeAll(async () => {
	await initTheme();
});

describe("async-result message renderer precedence", () => {
	it("lets a registered renderer own the live completion card", () => {
		const { ctx } = renderLive(owningRenderer());
		const rendered = ctx.chatContainer.children.map(child => child.render(120).join("\n")).join("\n");
		expect(rendered).toContain(EXTENSION_MARKER);
		expect(rendered).not.toContain(BUILT_IN_MARKER);
	});

	it("falls back to the built-in card when a live renderer declines", () => {
		const { ctx } = renderLive(decliningRenderer);
		const rendered = ctx.chatContainer.children.map(child => child.render(120).join("\n")).join("\n");
		expect(rendered).toContain(BUILT_IN_MARKER);
		expect(rendered).not.toContain(EXTENSION_MARKER);
	});

	it("renders the built-in live card when nothing is registered", () => {
		const { ctx } = renderLive(undefined);
		const rendered = ctx.chatContainer.children.map(child => child.render(120).join("\n")).join("\n");
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
});
