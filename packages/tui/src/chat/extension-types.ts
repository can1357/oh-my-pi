import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "../tui";
import type { Theme } from "../theme/theme";
import type { CustomMessage, HookMessage } from "./messages";

export type ExtensionUiComponent = Component & { dispose?(): void };

export type ExtensionUiComponentFactory = (tui: TUI, theme: Theme) => ExtensionUiComponent;

export type ExtensionWidgetContent = string[] | ExtensionUiComponentFactory | undefined;

export interface MessageRenderOptions {
	expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
	message: CustomMessage<T>,
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

export interface AssistantThinkingRenderContext {
	contentIndex: number;
	thinkingIndex: number;
	text: string;
	requestRender(): void;
}

export type AssistantThinkingRenderer = (
	context: AssistantThinkingRenderContext,
	theme: Theme,
) => Component | undefined;

/** Original assistant data and the lifecycle of the displayed text block. */
export interface AssistantTextDisplayContext {
	message: AssistantMessage;
	blockIndex: number;
	transient: boolean;
}

export interface AssistantTextDisplayResult {
	text: string;
	/** Keep this block mutable until its terminal display is available. */
	pending?: boolean;
}

/** Synchronous display-only projection; undefined delegates to the next renderer. */
export type AssistantTextDisplayRenderer = (
	sourceText: string,
	context: AssistantTextDisplayContext,
) => AssistantTextDisplayResult | undefined;

export interface HookMessageRenderOptions {
	/** Whether the view is expanded */
	expanded: boolean;
}

/**
 * Renderer for hook messages.
 * Hooks register these to provide custom TUI rendering for their message types.
 */
export type HookMessageRenderer<T = unknown> = (
	message: HookMessage<T>,
	options: HookMessageRenderOptions,
	theme: Theme,
) => Component | undefined;
