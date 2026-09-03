import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { InternalResource } from "../internal-urls";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "../session/streaming-output";

export interface SecurityResourceOptions {
	url: string;
	content: string;
	contentType: InternalResource["contentType"];
	isDirectory?: boolean;
}

function boundedJson(content: string): { content: string; truncated: boolean } {
	const sanitized = sanitizeText(content);
	const truncated = truncateHead(sanitized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
	if (!truncated.truncated) return { content: sanitized, truncated: false };
	return {
		content: `${JSON.stringify(
			{
				truncated: true,
				originalBytes: truncated.totalBytes,
				originalLines: truncated.totalLines,
				preview: truncated.content,
			},
			null,
			2,
		)}\n`,
		truncated: true,
	};
}

export function createSecurityResource(options: SecurityResourceOptions): InternalResource {
	const bounded =
		options.contentType === "application/json"
			? boundedJson(options.content)
			: (() => {
					const sanitized = sanitizeText(options.content);
					const truncated = truncateHead(sanitized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
					return { content: truncated.content, truncated: truncated.truncated };
				})();
	return {
		url: options.url,
		content: bounded.content,
		contentType: options.contentType,
		size: Buffer.byteLength(bounded.content),
		isDirectory: options.isDirectory,
		notes: bounded.truncated
			? [`Security resource truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes.`]
			: undefined,
	};
}
