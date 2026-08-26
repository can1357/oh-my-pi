/** Base64 payload and media type decoded from a data URI. */
export interface DecodedDataUri {
	data: string;
	mimeType: string;
}

function percentDecode(value: string): Buffer | undefined {
	const chunks: Buffer[] = [];
	let chunkStart = 0;
	for (let index = 0; index < value.length; index++) {
		if (value.charCodeAt(index) !== 0x25) continue;
		const escape = value.slice(index + 1, index + 3);
		if (!/^[0-9a-f]{2}$/i.test(escape)) return undefined;
		if (index > chunkStart) chunks.push(Buffer.from(value.slice(chunkStart, index), "utf8"));
		chunks.push(Buffer.from([Number.parseInt(escape, 16)]));
		index += 2;
		chunkStart = index + 1;
	}
	if (chunkStart < value.length) chunks.push(Buffer.from(value.slice(chunkStart), "utf8"));
	return Buffer.concat(chunks);
}

/**
 * Decodes base64 and percent-encoded `data:` URIs.
 *
 * Returns `undefined` for non-data URLs and malformed data URIs.
 */
export function decodeDataUri(url: string): DecodedDataUri | undefined {
	if (url.slice(0, 5).toLowerCase() !== "data:") return undefined;
	const comma = url.indexOf(",");
	if (comma < 0) return undefined;
	const metadata = url.slice(5, comma).replace(/^ +| +$/g, "");
	const base64Marker = /; *base64$/i.exec(metadata);
	const mimeType = (base64Marker ? metadata.slice(0, base64Marker.index) : metadata) || "application/octet-stream";
	const body = percentDecode(url.slice(comma + 1));
	if (!body || body.length === 0) return undefined;
	if (!base64Marker) return { data: body.toString("base64"), mimeType };
	const payload = body.toString("latin1");
	const bytes = Buffer.from(payload, "base64");
	const data = bytes.toString("base64");
	if (bytes.length === 0 || data !== payload) return undefined;
	return { data, mimeType };
}
