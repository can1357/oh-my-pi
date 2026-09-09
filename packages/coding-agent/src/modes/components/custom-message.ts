import type { Component } from "@oh-my-pi/pi-tui";
import { Box, Container } from "@oh-my-pi/pi-tui";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { theme } from "../../modes/theme/theme";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE } from "../../session/messages";
import { renderFramedMessage } from "./message-frame";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	#box: Box;
	#customComponent?: Component;
	#expanded = false;

	constructor(
		private readonly message: CustomMessage<unknown>,
		private readonly customRenderer?: MessageRenderer,
	) {
		super();

		// Create box with custom background (used for default rendering)
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

		// The transcript dispatch routes both `custom` and legacy `hookMessage` roles here:
		// tag hooks with the hook glyph, other injected messages with a neutral package.
		const isHook = (this.message.role as string) === "hookMessage";
		const isLiveDelegation = this.message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
		const custom = renderFramedMessage({
			message: this.message,
			box: this.#box,
			expanded: this.#expanded,
			customRenderer: this.customRenderer,
			icon: isHook ? theme.icon.extensionHook : theme.icon.package,
			hideHeader: isLiveDelegation,
			borderColor: isLiveDelegation ? "borderAccent" : undefined,
		});

		if (custom) {
			this.#customComponent = custom;
			this.addChild(custom);
		} else {
			this.addChild(this.#box);
		}
	}
}
