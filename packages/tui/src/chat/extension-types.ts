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
