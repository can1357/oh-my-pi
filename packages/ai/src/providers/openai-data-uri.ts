/** Base64 payload and media type decoded from a data URI. */
export interface DecodedDataUri {
	data: string;
	mimeType: string;
}

function hexDigitValue(code: number): number {
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	return -1;
}

function percentDecode(value: string): Buffer | undefined {
	const output = Buffer.allocUnsafe(Buffer.byteLength(value, "utf8"));
	let readIndex = 0;
	let writeIndex = 0;
	while (readIndex < value.length) {
		let codePoint = value.codePointAt(readIndex);
		if (codePoint === undefined) break;
		if (codePoint === 0x25) {
			const high = hexDigitValue(value.charCodeAt(readIndex + 1));
			const low = hexDigitValue(value.charCodeAt(readIndex + 2));
			if (high < 0 || low < 0) return undefined;
			output[writeIndex++] = (high << 4) | low;
			readIndex += 3;
			continue;
		}

		const width = codePoint > 0xffff ? 2 : 1;
		if (codePoint >= 0xd800 && codePoint <= 0xdfff) codePoint = 0xfffd;
		if (codePoint <= 0x7f) {
			output[writeIndex++] = codePoint;
		} else if (codePoint <= 0x7ff) {
			output[writeIndex++] = 0xc0 | (codePoint >> 6);
			output[writeIndex++] = 0x80 | (codePoint & 0x3f);
		} else if (codePoint <= 0xffff) {
			output[writeIndex++] = 0xe0 | (codePoint >> 12);
			output[writeIndex++] = 0x80 | ((codePoint >> 6) & 0x3f);
			output[writeIndex++] = 0x80 | (codePoint & 0x3f);
		} else {
			output[writeIndex++] = 0xf0 | (codePoint >> 18);
			output[writeIndex++] = 0x80 | ((codePoint >> 12) & 0x3f);
			output[writeIndex++] = 0x80 | ((codePoint >> 6) & 0x3f);
			output[writeIndex++] = 0x80 | (codePoint & 0x3f);
		}
		readIndex += width;
	}
	return output.subarray(0, writeIndex);
}

export function isDataUri(url: string): boolean {
	return url.slice(0, 5).toLowerCase() === "data:";
}

/**
 * Decodes base64 and percent-encoded `data:` URIs.
 *
 * Returns `undefined` for non-data URLs and malformed data URIs.
 */
export function decodeDataUri(url: string): DecodedDataUri | undefined {
	if (!isDataUri(url)) return undefined;
	const fragmentIndex = url.indexOf("#");
	const dataUrl = fragmentIndex < 0 ? url : url.slice(0, fragmentIndex);
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return undefined;
	const metadataBytes = percentDecode(dataUrl.slice(5, comma));
	if (!metadataBytes) return undefined;
	const metadata = metadataBytes.toString("utf8").replace(/^ +| +$/g, "");
	const base64Marker = /; *base64$/i.exec(metadata);
	const mimeType = (base64Marker ? metadata.slice(0, base64Marker.index) : metadata) || "application/octet-stream";
	const body = percentDecode(dataUrl.slice(comma + 1));
	if (!body || body.length === 0) return undefined;
	if (!base64Marker) return { data: body.toString("base64"), mimeType };
	const payload = body.toString("latin1");
	const bytes = Buffer.from(payload, "base64");
	const data = bytes.toString("base64");
	if (bytes.length === 0 || data !== payload) return undefined;
	return { data, mimeType };
}
