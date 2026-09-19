import { FramedMessageComponent } from "../chrome/message-frame";
import type { HookMessageRenderer } from "./extension-types";
import type { HookMessage } from "./messages";

/** Lines of default markdown body shown before the "…" fold when collapsed. */
const HOOK_COLLAPSED_LINES = 5;

/**
 * Component that renders a custom message entry from hooks.
 * Uses distinct styling to differentiate from user messages.
 */
export class HookMessageComponent extends FramedMessageComponent<HookMessage<unknown>> {
	constructor(message: HookMessage<unknown>, customRenderer?: HookMessageRenderer) {
		super({
			message,
			collapseAfterLines: HOOK_COLLAPSED_LINES,
			customRenderer,
		});
	}
}
