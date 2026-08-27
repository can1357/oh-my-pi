import { logger } from "@oh-my-pi/pi-utils";

/**
 * Blob-agnostic object storage used to replicate bulk content (session JSONL
 * bodies, externalized image blobs) that is too large and append-heavy for the
 * JSON state broker. Backed by an S3-compatible service via Bun's builtin
 * `Bun.S3Client` — deliberately no extra npm dependency and no reuse of the
 * sigv4 publication uploader (that path has a different, outbound-only contract).
 */
export interface ObjectStore {
	/** Upload bytes at `key`. Overwrites any existing object. */
	put(key: string, data: Uint8Array, contentType?: string): Promise<void>;
	/** Download `key`, or null when the object does not exist. */
	get(key: string): Promise<Uint8Array | null>;
	/** True when an object exists at `key`. */
	has(key: string): Promise<boolean>;
	/** Every key under `prefix` with size + mtime, for index reconciliation. */
	list(prefix: string): Promise<Array<{ key: string; size: number; mtimeMs: number }>>;
	/** Remove `key`. Idempotent — a missing object is not an error. */
	delete(key: string): Promise<void>;
}

/**
 * Minimal structural view of the settings object this module reads. Kept
 * intentionally narrow (rather than importing the concrete `Settings` class) so
 * `resolveObjectStore` stays trivially testable with a plain `{ get }` stub and
 * carries no construction cost when the object backend is disabled.
 */
export interface SettingsLike {
	get(key: string): unknown;
}

function optString(settings: SettingsLike, key: string): string | undefined {
	const value = settings.get(key);
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Kind-relative key for a replicated session body. The concrete on-disk key is
 * `<keyPrefix>/sessions/<rel>` once the store applies its prefix; centralizing
 * the layout here keeps the session replicator and this module from drifting.
 */
export function sessionKey(rel: string): string {
	return `sessions/${rel}`;
}

/**
 * Kind-relative key for a content-addressed blob. Yields `<keyPrefix>/blobs/<sha256>`
 * once the store applies its prefix. Blobs are immutable by hash, so this key is
 * a stable global identity.
 */
export function blobKey(hash: string): string {
	return `blobs/${hash}`;
}

/**
 * `Bun.S3Client`-backed {@link ObjectStore}. The `keyPrefix` is applied in a
 * single place ({@link S3ObjectStore.#full}) so callers deal only in
 * kind-relative keys (see {@link sessionKey} / {@link blobKey}) and can never
 * accidentally double- or under-prefix.
 */
class S3ObjectStore implements ObjectStore {
	readonly #client: Bun.S3Client;
	/** Applied to every key; empty string means "no prefix". */
	readonly #prefix: string;

	constructor(client: Bun.S3Client, prefix: string) {
		this.#client = client;
		this.#prefix = prefix;
	}

	/** Prepend the configured key prefix to a caller-supplied kind-relative key. */
	#full(key: string): string {
		return this.#prefix ? `${this.#prefix}/${key}` : key;
	}

	async put(key: string, data: Uint8Array, contentType?: string): Promise<void> {
		await this.#client.write(this.#full(key), data, contentType ? { type: contentType } : undefined);
	}

	async get(key: string): Promise<Uint8Array | null> {
		const file = this.#client.file(this.#full(key));
		try {
			return await file.bytes();
		} catch (err) {
			// A missing object must read as null; any other failure (auth, network,
			// service error) is a real fault the caller decides how to handle.
			if (!(await file.exists())) return null;
			throw err;
		}
	}

	async has(key: string): Promise<boolean> {
		return await this.#client.file(this.#full(key)).exists();
	}

	async list(prefix: string): Promise<Array<{ key: string; size: number; mtimeMs: number }>> {
		const full = this.#full(prefix);
		// S3 caps a single ListObjectsV2 response at 1000 keys; walk the
		// continuation tokens so callers reconciling an index see every object
		// rather than a silently truncated first page.
		const out: Array<{ key: string; size: number; mtimeMs: number }> = [];
		let continuationToken: string | undefined;
		do {
			const page = await this.#client.list({ prefix: full, continuationToken });
			for (const entry of page.contents ?? []) {
				// Strip the store's own prefix so callers round-trip list -> get with
				// the same kind-relative key space they wrote with.
				const relative = this.#prefix ? entry.key.slice(this.#prefix.length + 1) : entry.key;
				const mtimeMs = entry.lastModified ? Date.parse(entry.lastModified) : 0;
				out.push({ key: relative, size: entry.size ?? 0, mtimeMs: Number.isNaN(mtimeMs) ? 0 : mtimeMs });
			}
			continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
		} while (continuationToken);
		return out;
	}

	async delete(key: string): Promise<void> {
		await this.#client.delete(this.#full(key));
	}
}

/**
 * Build an {@link ObjectStore} from settings, or `undefined` when object storage
 * is off or unconfigured. Returning `undefined` (rather than throwing) lets every
 * caller degrade to local-only operation; a single `warn` naming the first
 * missing key is emitted when the backend is requested but cannot be satisfied.
 */
export function resolveObjectStore(settings: SettingsLike): ObjectStore | undefined {
	if (settings.get("objects.backend") !== "s3") return undefined;

	const bucket = optString(settings, "objects.s3.bucket");
	const accessKeyId = optString(settings, "objects.s3.accessKeyId");
	const secretAccessKey = optString(settings, "objects.s3.secretAccessKey");

	const missing = !bucket
		? "objects.s3.bucket"
		: !accessKeyId
			? "objects.s3.accessKeyId"
			: !secretAccessKey
				? "objects.s3.secretAccessKey"
				: undefined;
	if (missing) {
		logger.warn(`objects.backend=s3 but ${missing} is not set; falling back to local-only storage`);
		return undefined;
	}

	const endpoint = optString(settings, "objects.s3.endpoint");
	const region = optString(settings, "objects.s3.region");
	const keyPrefix = optString(settings, "objects.s3.keyPrefix") ?? "";
	// `pathStyle` (MinIO/Garage) is the inverse of Bun's `virtualHostedStyle`
	// option — path-style is Bun's default (false), so only opt into virtual
	// hosting when the user explicitly disables path style.
	const pathStyle = settings.get("objects.s3.pathStyle") !== false;

	const client = new Bun.S3Client({
		bucket,
		accessKeyId,
		secretAccessKey,
		...(endpoint ? { endpoint } : {}),
		...(region ? { region } : {}),
		virtualHostedStyle: !pathStyle,
	});

	return new S3ObjectStore(client, keyPrefix);
}
