import { FramedMessageComponent } from "../chrome/message-frame";
import type { MessageRenderer } from "./extension-types";
import { theme } from "../theme";
import { type CustomMessage, LIVE_DELEGATION_MESSAGE_TYPE } from "./messages";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends FramedMessageComponent<CustomMessage<unknown>> {
	constructor(message: CustomMessage<unknown>, customRenderer?: MessageRenderer) {
		const isLiveDelegation = message.customType === LIVE_DELEGATION_MESSAGE_TYPE;
		super({
			message,
			// The transcript dispatch routes both `custom` and legacy `hookMessage` roles here:
			// tag hooks with the hook glyph, other injected messages with a neutral package.
			icon: () => (String(message.role) === "hookMessage" ? theme.icon.extensionHook : theme.icon.package),
			hideHeader: isLiveDelegation,
			borderColor: isLiveDelegation ? "borderAccent" : undefined,
			customRenderer,
		});
	}
}
