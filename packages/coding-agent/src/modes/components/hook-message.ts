import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Container } from "@oh-my-pi/pi-tui";
import type { HookMessageRenderer } from "../../extensibility/hooks/types";
import { theme } from "../../modes/theme/theme";
import type { HookMessage } from "../../session/messages";
import { renderFramedMessage } from "./message-frame";

/** Lines of default markdown body shown before the "…" fold when collapsed. */
const HOOK_COLLAPSED_LINES = 5;

/**
 * Component that renders a custom message entry from hooks.
 * Uses distinct styling to differentiate from user messages.
 */
export class HookMessageComponent extends Container {
	#box: Box;
	#customComponent?: Component;
	#expanded = false;

	constructor(
		private readonly message: HookMessage<unknown>,
		private readonly customRenderer?: HookMessageRenderer,
	) {
		super();

		// Create box with purple background (used for default rendering)
		this.#box = new Box(1, 1, t => theme.bg("customMessageBg", t));
		this.#box.setIgnoreTight(true);

		this.#rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.#expanded !== expanded) {
			this.#expanded = expanded;
			this.#rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.#rebuild();
	}

	#rebuild(): void {
		if (this.#customComponent) {
			this.removeChild(this.#customComponent);
			this.#customComponent = undefined;
		}
		this.removeChild(this.#box);

		const custom = renderFramedMessage({
			message: this.message,
			box: this.#box,
			expanded: this.#expanded,
			customRenderer: this.customRenderer,
			collapseAfterLines: HOOK_COLLAPSED_LINES,
		});

		if (custom) {
			this.#customComponent = custom;
			this.addChild(custom);
		} else {
			this.addChild(this.#box);
		}
	}
}
