import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import type { TinyLocalModelKey } from "./models";
import type { TinyWorkerResponse } from "./title-protocol";

/** Julia-1 ONNX root-layout files (model + external data + tokenizer). */
const JULIA_JUDGE_FILES = ["model.onnx", "model.onnx.data", "tokenizer.json", "tokenizer_config.json"] as const;
const HF_RESOLVE_BASE = "https://huggingface.co";
// Coalesce download progress so streaming model.onnx.data (~577MB) doesn't
// flood the IPC channel with one event per chunk.
const PROGRESS_EMIT_BYTES = 4_000_000;

/** Minimal outbound surface for weight-download progress (matches ReplyTransport in worker.ts). */
interface JudgeDownloadTransport {
	send(message: TinyWorkerResponse): void;
}

/** Remote file size via HEAD; 0 when unknown so the caller downloads. */
async function remoteJudgeFileSize(url: string): Promise<number> {
	const response = await fetch(url, { method: "HEAD", redirect: "follow" });
	if (!response.ok) return 0;
	await response.body?.cancel().catch(() => {});
	return Number(response.headers.get("content-length") ?? 0);
}

/** Stream one weight file to disk (`.part` + rename), emitting progress; never buffers. */
async function downloadJudgeFile(
	repo: string,
	filename: string,
	dest: string,
	modelKey: TinyLocalModelKey,
	reply: JudgeDownloadTransport,
	requestId: string,
): Promise<void> {
	const url = `${HF_RESOLVE_BASE}/${repo}/resolve/main/${filename}`;
	const response = await fetch(url, { redirect: "follow" });
	if (!response.ok || !response.body) {
		throw new Error(`Failed to download ${filename} (${repo}): HTTP ${response.status}`);
	}
	const total = Number(response.headers.get("content-length") ?? 0);
	reply.send({
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
				reply.send({
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

/**
 * Ensure Julia-1 weights + tokenizer live in `getTinyModelsCacheDir()/julia-1/`,
 * skipping files whose local size already matches the remote one. Returns the
 * dir for `AutoTokenizer.from_pretrained` and `InferenceSession.create`.
 */
export async function ensureJuliaJudgeFiles(
	modelKey: TinyLocalModelKey,
	repo: string,
	reply: JudgeDownloadTransport,
	requestId: string,
): Promise<string> {
	const dir = path.join(getTinyModelsCacheDir(), modelKey);
	// Atomic `.part` + rename downloads make present files complete — no
	// network on warm start, works offline.
	const cached = await Promise.all(
		JULIA_JUDGE_FILES.map(filename =>
			fs
				.stat(path.join(dir, filename))
				.then(stats => stats.size > 0)
				.catch(() => false),
		),
	);
	if (cached.every(Boolean)) return dir;
	await fs.mkdir(dir, { recursive: true });
	for (const filename of JULIA_JUDGE_FILES) {
		const dest = path.join(dir, filename);
		const localSize = await fs
			.stat(dest)
			.then(stats => stats.size)
			.catch(() => 0);
		if (localSize > 0) {
			const remoteSize = await remoteJudgeFileSize(`${HF_RESOLVE_BASE}/${repo}/resolve/main/${filename}`).catch(
				() => 0,
			);
			// Downloads land atomically (`.part` + rename), so a present file is
			// complete; HEAD is best-effort validation, not a re-download trigger.
			if (remoteSize === 0 || remoteSize === localSize) continue;
		}
		await downloadJudgeFile(repo, filename, dest, modelKey, reply, requestId);
	}
	return dir;
}
