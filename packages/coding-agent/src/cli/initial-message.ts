import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Args } from "./args";

export interface InitialMessageInput {
	parsed: Args;
	fileText?: string;
	fileImages?: ImageContent[];
	stdinContent?: string;
}

export interface InitialMessageResult {
	initialMessage?: string;
	initialImages?: ImageContent[];
}

/**
 * Combine stdin content, @file text, and the first CLI message into a single
 * initial prompt for non-interactive mode.
 */
export function buildInitialMessage({
	parsed,
	fileText,
	fileImages,
	stdinContent,
}: InitialMessageInput): InitialMessageResult {
	const hasInitialContext = stdinContent !== undefined || fileText !== undefined || (fileImages?.length ?? 0) > 0;
	if (!hasInitialContext) {
		return {
			initialImages: undefined,
		};
	}

	let body = "";
	if (fileText !== undefined) {
		body += fileText;
	}

	if (parsed.messages.length > 0) {
		body += parsed.messages[0];
		parsed.messages.shift();
	}

	const initialMessage =
		stdinContent !== undefined
			? body.length > 0
				? `${stdinContent}\n${body}`
				: stdinContent
			: body.length > 0
				? body
				: fileImages && fileImages.length > 0
					? ""
					: undefined;

	return {
		initialMessage,
		initialImages: fileImages && fileImages.length > 0 ? fileImages : undefined,
	};
}
