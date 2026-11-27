/**
 * Content-addressed blobs (image bytes) shared by both backends.
 *
 * A program registers bytes once and puts the returned id (the sha256 hex of
 * the bytes, as Tern names blobs) in an `image` node's `blob` prop or an
 * editor decoration. The native backend uploads each blob a terminal does not
 * hold before or alongside the frame that first references it; the terminal
 * backend reads the bytes back by id. Bytes stay until {@link releaseBlob}.
 */

/** A registered blob. */
export interface BlobEntry {
	readonly bytes: Uint8Array;
	readonly mime: string;
}

const registry = new Map<string, BlobEntry>();

/** Register `bytes` and return their content address. Registering the same bytes again is a no-op. */
export function registerBlob(bytes: Uint8Array, mime: string): string {
	const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
	if (!registry.has(id)) registry.set(id, { bytes, mime });
	return id;
}

/** The bytes registered under `id`, if any. */
export function getBlob(id: string): BlobEntry | undefined {
	return registry.get(id);
}

/** Forget the bytes of `id` (a terminal that loses the blob can no longer get it back). */
export function releaseBlob(id: string): void {
	registry.delete(id);
}
