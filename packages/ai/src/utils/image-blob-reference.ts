import { logger } from "@oh-my-pi/pi-utils";
import type { ImageContent, TextContent } from "../types";

const BLOB_REFERENCE = /^(?:data:[^,]*;base64,)*blob:sha256:[a-f0-9]{64}$/i;
const UNRESOLVED_BLOB_REASON = "unresolved blob reference";

/** Warn and return the omission reason when image data or a URL still points to local blob storage. */
export function unresolvedImageReferenceReason(value: unknown): string | undefined {
	if (typeof value !== "string" || !BLOB_REFERENCE.test(value)) return undefined;
	logger.warn("Omitting image with unresolved blob reference");
	return UNRESOLVED_BLOB_REASON;
}

/** Return model-visible text in place of an image whose selected source is an unresolved blob reference. */
export function unresolvedImageReferenceOmission(value: unknown): string | undefined {
	const reason = unresolvedImageReferenceReason(value);
	return reason === undefined ? undefined : `[image omitted: ${reason}]`;
}

/** Replace missing images without changing the source transcript or copying clean content arrays. */
export function omitUnresolvedImageBlocks(
	content: (TextContent | ImageContent)[],
	source: "inline" | "url" = "inline",
): (TextContent | ImageContent)[] {
	let rewritten: (TextContent | ImageContent)[] | undefined;
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (part.type !== "image") continue;
		const text = unresolvedImageReferenceOmission(source === "url" ? (part.url ?? part.data) : part.data);
		if (text === undefined) continue;
		rewritten ??= content.slice();
		rewritten[index] = { type: "text", text };
	}
	return rewritten ?? content;
}
