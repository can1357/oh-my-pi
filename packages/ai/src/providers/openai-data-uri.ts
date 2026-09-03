/** Base64 payload and media type decoded from a data URI. */
export interface DecodedDataUri {
	data: string;
	mimeType: string;
}

function hexValue(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	return -1;
}

/** Decode percent escapes as bytes; image data is not necessarily valid UTF-8. */
function decodePercentEncodedBytes(payload: string): Buffer {
	const output = Buffer.allocUnsafe(Buffer.byteLength(payload, "utf8"));
	let sourceOffset = 0;
	let outputOffset = 0;
	while (sourceOffset < payload.length) {
		if (payload.charCodeAt(sourceOffset) !== 0x25) {
			const nextEscape = payload.indexOf("%", sourceOffset);
			const end = nextEscape < 0 ? payload.length : nextEscape;
			outputOffset += output.write(payload.slice(sourceOffset, end), outputOffset, "utf8");
			sourceOffset = end;
			continue;
		}
		const high = hexValue(payload.charCodeAt(sourceOffset + 1));
		const low = hexValue(payload.charCodeAt(sourceOffset + 2));
		if (high < 0 || low < 0) throw new URIError("URI malformed");
		output[outputOffset++] = (high << 4) | low;
		sourceOffset += 3;
	}
	return output.subarray(0, outputOffset);
}

/**
 * Decodes base64 and percent-encoded `data:` URIs.
 *
 * Returns `undefined` for non-data URLs and data URIs without a comma separator.
 */
export function decodeDataUri(url: string): DecodedDataUri | undefined {
	if (url.slice(0, 5).toLowerCase() !== "data:") return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const header = url.slice(5, comma);
	const payload = url.slice(comma + 1);
	const isBase64 = header.toLowerCase().endsWith(";base64");
	const mimeType = (isBase64 ? header.slice(0, -";base64".length) : header) || "application/octet-stream";
	const data = isBase64 ? payload : decodePercentEncodedBytes(payload).toString("base64");
	return { data, mimeType };
}
