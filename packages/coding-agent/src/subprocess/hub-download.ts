/**
 * Shared Hugging Face Hub file downloader for worker subprocesses.
 *
 * Consolidates the byte-identical `downloadSherpaFile` (stt/asr-worker.ts)
 * and `downloadJudgeFile` (tiny/judge-weights.ts) implementations: stream one
 * Hub `resolve` URL to disk via a `.part` sidecar + rename (so an interrupted
 * fetch never reads as cached), emitting coalesced per-file progress. Never
 * buffers the whole file in memory.
 */
import * as fs from "node:fs/promises";

/** Hub origin for raw Hub `resolve` downloads. */
const HF_RESOLVE_BASE = "https://huggingface.co";

// Coalesce download progress so streaming a multi-hundred-MB file doesn't
// flood the IPC channel with one event per chunk.
const PROGRESS_EMIT_BYTES = 4_000_000;

/**
 * Minimal structural transport for hub-download progress. Both
 * `TinyWorkerResponse` (tiny/title-protocol.ts) and `SttWorkerOutbound`
 * (stt/asr-protocol.ts) declare an identical literal `progress` event shape
 * (`download` then coalesced `progress` per file), so a single generic call
 * site satisfies both without importing either protocol.
 */
export interface HubDownloadProgressEvent<ModelKey> {
	modelKey: ModelKey;
	status: "download" | "progress";
	name: string;
	file: string;
	loaded?: number;
	total?: number;
}

export interface HubDownloadTransport<ModelKey> {
	send(message: { type: "progress"; id: string; event: HubDownloadProgressEvent<ModelKey> }): void;
}

export interface HubDownloadOptions<ModelKey> {
	repo: string;
	revision: string;
	filename: string;
	dest: string;
	modelKey: ModelKey;
	transport: HubDownloadTransport<ModelKey>;
	requestId: string;
}

/** Remote file size via HEAD; 0 when unknown so the caller downloads. */
export async function remoteHubFileSize(url: string): Promise<number> {
	const response = await fetch(url, { method: "HEAD", redirect: "follow" });
	if (!response.ok) return 0;
	await response.body?.cancel().catch(() => {});
	return Number(response.headers.get("content-length") ?? 0);
}

/** Hub `resolve` URL for one file at a pinned revision (or branch). */
export function hubResolveUrl(repo: string, revision: string, filename: string): string {
	return `${HF_RESOLVE_BASE}/${repo}/resolve/${revision}/${filename}`;
}

/**
 * Stream one Hub file to disk (`.part` + rename), emitting progress; never
 * buffers. Byte-identical wire + event behavior to the pre-consolidation
 * `downloadSherpaFile`/`downloadJudgeFile` implementations.
 */
export async function downloadHubFile<ModelKey>(options: HubDownloadOptions<ModelKey>): Promise<void> {
	const { repo, revision, filename, dest, modelKey, transport, requestId } = options;
	const url = hubResolveUrl(repo, revision, filename);
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${filename} (${repo}): HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length") ?? 0);
	transport.send({
		type: "progress",
		id: requestId,
		event: { modelKey, status: "download", name: `${repo}/${filename}`, file: filename },
	});
	const part = `${dest}.part`;
	const handle = await fs.open(part, "w");
	let loaded = 0;
	let lastEmitted = 0;
	const reader = response.body.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			await handle.write(value);
			loaded += value.byteLength;
			if (loaded - lastEmitted >= PROGRESS_EMIT_BYTES || (total > 0 && loaded >= total)) {
				lastEmitted = loaded;
				transport.send({
					type: "progress",
					id: requestId,
					event: {
						modelKey,
						status: "progress",
						name: `${repo}/${filename}`,
						file: filename,
						loaded,
						total: total || loaded,
					},
				});
			}
		}
	} finally {
		await handle.close();
	}
	await fs.rename(part, dest);
}
