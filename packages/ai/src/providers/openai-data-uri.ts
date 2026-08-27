/** Base64 payload and media type decoded from a data URI. */
export interface DecodedDataUri {
	data: string;
	mimeType: string;
}

/**
 * Decodes base64 and percent-encoded `data:` URIs.
 *
 * Returns `undefined` for non-data URLs and data URIs without a comma separator.
 */
export function decodeDataUri(url: string): DecodedDataUri | undefined {
	if (!url.startsWith("data:")) return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const header = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isBase64 = header.endsWith(";base64");
	const mimeType = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
	const data = isBase64 ? payload : Buffer.from(decodeURIComponent(payload), "utf8").toString("base64");
	return { data, mimeType };
}
