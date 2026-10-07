/**
 * Content-addressed binary blobs (images) for `image` nodes.
 *
 * `describe()` registers the bytes and puts the returned id in `image.p.blob`;
 * the native backend delivers each referenced blob once per terminal
 * connection (asking the terminal first which it holds, or through its blob
 * cache), else uploads it with verb `b` before the frame that first
 * references it.
 */
import type { TspProps } from "@oh-my-pi/pi-wire";
import { getImageDimensions } from "../terminal-capabilities";
import { node } from "./describe";
import type { NativeNode } from "./node";

export interface NativeBlob {
	readonly id: string;
	readonly mime: string;
	readonly bytes: Uint8Array;
}

const blobs = new Map<string, NativeBlob>();
// Registration usually repeats with the same bytes object on every describe;
// the tag skips rehashing it.
const kBlobId = Symbol("native.blobId");

interface BlobTagged {
	[kBlobId]?: string;
}

/** Register `bytes` and return their content address (sha256 hex) for `image.p.blob`. */
export function registerNativeBlob(bytes: Uint8Array, mime: string): string {
	const known = (bytes as BlobTagged)[kBlobId];
	if (known !== undefined) return known;
	const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	(bytes as BlobTagged)[kBlobId] = id;
	if (!blobs.has(id)) blobs.set(id, { id, mime, bytes });
	return id;
}

/** A registered blob by id. */
export function getNativeBlob(id: string): NativeBlob | undefined {
	return blobs.get(id);
}

/**
 * An `image` node for a base64 payload: the bytes are registered as a blob and
 * the pixel size probed from the header. Decoding and hashing cost real time,
 * so callers cache the node per payload ({@link NativeImageCache}).
 */
export function base64ImageNode(
	data: string,
	mimeType: string,
	p?: Omit<TspProps<"image">, "blob" | "builtin" | "w" | "h">,
	key?: string,
): NativeNode {
	const blob = registerNativeBlob(Buffer.from(data, "base64"), mimeType);
	const size = getImageDimensions(data, mimeType);
	return node("image", size ? { ...p, blob, w: size.widthPx, h: size.heightPx } : { ...p, blob }, undefined, key);
}

/** `image` nodes for base64 payloads, one per slot key, rebuilt only when the slot's payload changes. */
export class NativeImageCache {
	#entries = new Map<string, { data: string; node: NativeNode }>();

	get(key: string, data: string, mimeType: string): NativeNode {
		const cached = this.#entries.get(key);
		if (cached?.data === data) return cached.node;
		const image = base64ImageNode(data, mimeType, { alt: mimeType }, key);
		this.#entries.set(key, { data, node: image });
		return image;
	}
}
