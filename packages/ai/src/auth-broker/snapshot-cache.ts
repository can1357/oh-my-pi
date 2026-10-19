/**
 * AES-GCM encrypted local cache for auth-broker snapshots.
 *
 * The cache is defense-in-depth for at-rest snapshots: a copied cache file is
 * useless without the matching broker bearer token and URL. The token itself is
 * still the trust boundary; a process that can read both the token and this file
 * can decrypt the snapshot.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import { asStrict } from "../providers/aws-sigv4";
import type { SnapshotResponse } from "./types";

const MAGIC = new Uint8Array([0x4f, 0x4d, 0x50, 0x53]); // "OMPS"
const VERSION = 2;
const VERSION_OFFSET = MAGIC.byteLength;
const IV_OFFSET = VERSION_OFFSET + 1;
const IV_LENGTH = 12;
const HEADER_LENGTH = IV_OFFSET + IV_LENGTH;
const AES_ALGORITHM = "AES-GCM";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const HEX = "0123456789abcdef";
/** Trailing window that collapses a burst of scheduled writes into one write of the newest snapshot. */
const WRITE_COALESCE_MS = 2_000;
/**
 * A scheduled snapshot matching the last write (same generation and credential
 * content) is skipped unless that write is this much older, so the cache's
 * `generatedAt` — its TTL clock — never lags the newest confirmation by more.
 */
const UNCHANGED_REWRITE_MS = 60_000;
/** Cache paths whose abandoned temp siblings this process already swept. */
const sweptCachePaths = new Set<string>();

export interface ReadAuthBrokerSnapshotCacheOptions {
	path: string;
	token: string;
	url: string;
	ttlMs: number;
	/** Override clock for deterministic tests. */
	now?: () => number;
}

export interface WriteAuthBrokerSnapshotCacheOptions {
	path: string;
	token: string;
	url: string;
	snapshot: SnapshotResponse;
}

/**
 * Cheap structural guard for a decrypted cache payload. The bytes are already
 * AES-256-GCM authenticated, so this only rejects shape/version drift (a cache
 * written by a different omp build, or a buggy write) — not tampering. A
 * mismatch returns null so the caller refetches a fresh snapshot.
 */
function isSnapshotResponseShape(v: unknown): v is SnapshotResponse {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		typeof o.generation === "number" &&
		typeof o.generatedAt === "number" &&
		typeof o.serverNowMs === "number" &&
		typeof o.refresher === "object" &&
		o.refresher !== null &&
		Array.isArray(o.credentials)
	);
}

export async function readAuthBrokerSnapshotCache(
	opts: ReadAuthBrokerSnapshotCacheOptions,
): Promise<SnapshotResponse | null> {
	if (opts.ttlMs <= 0) return null;
	let data: Uint8Array;
	try {
		data = await fs.readFile(opts.path);
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}

	try {
		const plaintext = await decryptCachePayload(data, opts.token, opts.url);
		if (!plaintext) return null;
		const parsed: unknown = JSON.parse(TEXT_DECODER.decode(plaintext));
		if (!isSnapshotResponseShape(parsed)) {
			logger.debug("auth-broker snapshot cache schema invalid", { path: opts.path });
			return null;
		}
		const snapshot = parsed;
		const now = opts.now?.() ?? Date.now();
		const ageMs = now - snapshot.generatedAt;
		if (ageMs > opts.ttlMs) return null;
		// `rotatesInMs` counts from `generatedAt`, and unchanged snapshots skip
		// rewrites, so the file can be up to UNCHANGED_REWRITE_MS old: rebase the
		// countdowns onto now so a restarted reader doesn't push rotations back.
		if (ageMs > 0) {
			for (const entry of snapshot.credentials) {
				if (entry.rotatesInMs !== null) entry.rotatesInMs = Math.max(0, entry.rotatesInMs - ageMs);
			}
		}
		return snapshot;
	} catch (error) {
		logger.debug("auth-broker snapshot cache read failed", { path: opts.path, error: String(error) });
		return null;
	}
}

export async function writeAuthBrokerSnapshotCache(opts: WriteAuthBrokerSnapshotCacheOptions): Promise<void> {
	const payload = await encryptCachePayload(opts.snapshot, opts.token, opts.url);
	await fs.mkdir(path.dirname(opts.path), { recursive: true });
	const tmpPath = `${opts.path}.${process.pid}.${randomHex(8)}.tmp`;
	let removeTemp = false;
	try {
		const handle = await fs.open(tmpPath, "wx", 0o600);
		removeTemp = true;
		try {
			await handle.writeFile(payload);
		} finally {
			await handle.close();
		}
		await fs.chmod(tmpPath, 0o600);
		await fs.rename(tmpPath, opts.path);
		removeTemp = false;
	} finally {
		if (removeTemp) await fs.rm(tmpPath, { force: true }).catch(() => {});
	}
	// Debris only comes from processes that died mid-write; one sweep per path
	// per process catches it without a directory scan on every write.
	if (sweptCachePaths.has(opts.path)) return;
	sweptCachePaths.add(opts.path);
	await sweepStaleTempFiles(opts.path);
}

/** Per-path state behind {@link scheduleAuthBrokerSnapshotCacheWrite}. */
interface CacheWriteQueue {
	/** Newest scheduled snapshot not yet written; replaced by later schedules. */
	pending?: WriteAuthBrokerSnapshotCacheOptions;
	/** Identity of the last snapshot written (or being written); see {@link cacheWriteSignature}. */
	writtenSignature?: number | bigint;
	writtenGeneratedAt: number;
	lastWriteStartedAt: number;
	inFlight?: Promise<void>;
	timer?: Timer;
}

const writeQueues = new Map<string, CacheWriteQueue>();
let shutdownFlushArmed = false;

/**
 * Fire-and-forget cache write for snapshot callbacks. The first snapshot after
 * a quiet period is written immediately; later ones within
 * {@link WRITE_COALESCE_MS} collapse into a single trailing write of the
 * newest. A snapshot whose generation and credential content match the last
 * write is skipped (see {@link UNCHANGED_REWRITE_MS}). Pending writes are
 * flushed on process shutdown and by {@link flushAuthBrokerSnapshotCacheWrites};
 * failures are logged, never thrown.
 */
export function scheduleAuthBrokerSnapshotCacheWrite(opts: WriteAuthBrokerSnapshotCacheOptions): void {
	let queue = writeQueues.get(opts.path);
	if (!queue) {
		queue = { writtenGeneratedAt: 0, lastWriteStartedAt: 0 };
		writeQueues.set(opts.path, queue);
		armShutdownFlush();
	}
	queue.pending = opts;
	pumpCacheWrite(opts.path, queue, false);
}

/** Write every pending scheduled snapshot now and wait for in-flight writes to settle. */
export async function flushAuthBrokerSnapshotCacheWrites(): Promise<void> {
	for (const [cachePath, queue] of writeQueues) {
		while (queue.inFlight || queue.pending) {
			pumpCacheWrite(cachePath, queue, true);
			if (queue.inFlight) await queue.inFlight;
		}
	}
}

/**
 * Flush pending writes when the process shuts down: postmortem cleanup covers
 * signals and `postmortem.quit`, `beforeExit` covers a drained event loop
 * (the coalescing timer is unref'd so it never holds the process open).
 */
function armShutdownFlush(): void {
	if (shutdownFlushArmed) return;
	shutdownFlushArmed = true;
	postmortem.register("auth-broker-snapshot-cache", () => flushAuthBrokerSnapshotCacheWrites());
	process.on("beforeExit", () => {
		for (const queue of writeQueues.values()) {
			if (!queue.pending) continue;
			void flushAuthBrokerSnapshotCacheWrites();
			return;
		}
	});
}

function pumpCacheWrite(cachePath: string, queue: CacheWriteQueue, force: boolean): void {
	if (queue.inFlight || !queue.pending) return;
	const waitMs = queue.lastWriteStartedAt + WRITE_COALESCE_MS - Date.now();
	if (!force && waitMs > 0) {
		if (!queue.timer) {
			queue.timer = setTimeout(() => {
				queue.timer = undefined;
				pumpCacheWrite(cachePath, queue, false);
			}, waitMs);
			queue.timer.unref?.();
		}
		return;
	}
	if (queue.timer) {
		clearTimeout(queue.timer);
		queue.timer = undefined;
	}
	const opts = queue.pending;
	queue.pending = undefined;
	const signature = cacheWriteSignature(opts);
	if (
		signature === queue.writtenSignature &&
		opts.snapshot.generatedAt - queue.writtenGeneratedAt < UNCHANGED_REWRITE_MS
	) {
		return;
	}
	queue.writtenSignature = signature;
	queue.writtenGeneratedAt = opts.snapshot.generatedAt;
	queue.lastWriteStartedAt = Date.now();
	queue.inFlight = writeAuthBrokerSnapshotCache(opts)
		.catch(error => {
			// Let the next identical snapshot retry instead of being skipped.
			if (queue.writtenSignature === signature) queue.writtenSignature = undefined;
			logger.debug("auth-broker snapshot cache write failed", { path: cachePath, error: String(error) });
		})
		.finally(() => {
			queue.inFlight = undefined;
			pumpCacheWrite(cachePath, queue, false);
		});
}

/**
 * Identity of a scheduled write for unchanged-skip: broker binding, generation,
 * and credential rows minus `rotatesInMs`, which is relative to `serverNowMs`
 * and shifts on every broker response even when nothing changed. A skipped
 * write leaves the file's `rotatesInMs` pinned to its own `generatedAt`, which
 * {@link readAuthBrokerSnapshotCache} rebases onto the read time.
 */
function cacheWriteSignature(opts: WriteAuthBrokerSnapshotCacheOptions): number | bigint {
	const rows = opts.snapshot.credentials.map(({ rotatesInMs: _rotatesInMs, ...entry }) => entry);
	return Bun.hash(`${opts.token}\u0000${opts.url}\u0000${opts.snapshot.generation}\u0000${JSON.stringify(rows)}`);
}

/** Temp files older than this are debris from a killed process, never a live write. */
const STALE_TMP_MAX_AGE_MS = 60 * 60_000;

/**
 * Remove abandoned `<cache>.<pid>.<hex>.tmp` siblings. Writes are fire-and-forget
 * from snapshot callbacks, so a process exiting between `open` and `rename`
 * strands its temp file; without this sweep they accumulate unboundedly.
 */
async function sweepStaleTempFiles(cachePath: string): Promise<void> {
	const dir = path.dirname(cachePath);
	const prefix = `${path.basename(cachePath)}.`;
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	const cutoff = Date.now() - STALE_TMP_MAX_AGE_MS;
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		const staleTmp = path.join(dir, name);
		try {
			if ((await fs.stat(staleTmp)).mtimeMs > cutoff) continue;
			await fs.rm(staleTmp, { force: true });
		} catch {}
	}
}

async function encryptCachePayload(snapshot: SnapshotResponse, token: string, url: string): Promise<Uint8Array> {
	const key = await deriveAesKey(token, ["encrypt"]);
	const iv = new Uint8Array(IV_LENGTH);
	globalThis.crypto.getRandomValues(iv);
	const plaintext = TEXT_ENCODER.encode(JSON.stringify(snapshot));
	const ciphertext = new Uint8Array(
		await globalThis.crypto.subtle.encrypt(
			{
				name: AES_ALGORITHM,
				iv,
				additionalData: cacheAdditionalData(url),
			},
			key,
			plaintext,
		),
	);
	const payload = new Uint8Array(HEADER_LENGTH + ciphertext.byteLength);
	payload.set(MAGIC, 0);
	payload[VERSION_OFFSET] = VERSION;
	payload.set(iv, IV_OFFSET);
	payload.set(ciphertext, HEADER_LENGTH);
	return payload;
}

async function decryptCachePayload(data: Uint8Array, token: string, url: string): Promise<Uint8Array | null> {
	if (data.byteLength <= HEADER_LENGTH) {
		logger.debug("auth-broker snapshot cache file too short");
		return null;
	}
	for (let i = 0; i < MAGIC.byteLength; i++) {
		if (data[i] !== MAGIC[i]) {
			logger.debug("auth-broker snapshot cache magic mismatch");
			return null;
		}
	}
	if (data[VERSION_OFFSET] !== VERSION) {
		logger.debug("auth-broker snapshot cache version mismatch", { version: data[VERSION_OFFSET] });
		return null;
	}
	const key = await deriveAesKey(token, ["decrypt"]);
	const iv = asStrict(data.subarray(IV_OFFSET, HEADER_LENGTH));
	const ciphertext = asStrict(data.subarray(HEADER_LENGTH));
	try {
		return new Uint8Array(
			await globalThis.crypto.subtle.decrypt(
				{
					name: AES_ALGORITHM,
					iv,
					additionalData: cacheAdditionalData(url),
				},
				key,
				ciphertext,
			),
		);
	} catch (error) {
		logger.debug("auth-broker snapshot cache decrypt failed", { error: String(error) });
		return null;
	}
}

function cacheAdditionalData(url: string): Uint8Array<ArrayBuffer> {
	const urlBytes = TEXT_ENCODER.encode(url);
	const additionalData = new Uint8Array(IV_OFFSET + urlBytes.byteLength);
	additionalData.set(MAGIC, 0);
	additionalData[VERSION_OFFSET] = VERSION;
	additionalData.set(urlBytes, IV_OFFSET);
	return additionalData;
}

async function deriveAesKey(token: string, usages: Array<"encrypt" | "decrypt">): Promise<CryptoKey> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(token));
	return globalThis.crypto.subtle.importKey("raw", digest, AES_ALGORITHM, false, usages);
}

function randomHex(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
	return out;
}
