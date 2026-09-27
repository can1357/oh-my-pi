import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getTinyModelsCacheDir } from "@oh-my-pi/pi-utils";
import { downloadHubFile, hubResolveUrl, remoteHubFileSize } from "../subprocess/hub-download";
import type { TinyLocalModelKey } from "./models";
import type { TinyWorkerResponse } from "./title-protocol";

/** Julia-1 ONNX root-layout files (model + external data + tokenizer). */
const JULIA_JUDGE_FILES = ["model.onnx", "model.onnx.data", "tokenizer.json", "tokenizer_config.json"] as const;
/** Pinned Julia-1-ONNX revision so judge weights are reproducible (tokenizer_config.json resolves at this sha). */
const JULIA_JUDGE_REVISION = "82a2fadf8fccfccdc5fd4e1009ba8f1a265eb7a8";

/** Minimal outbound surface for weight-download progress (matches ReplyTransport in worker.ts). */
interface JudgeDownloadTransport {
	send(message: TinyWorkerResponse): void;
}

/** Stream one weight file to disk via the shared Hub downloader (`.part` + rename, never buffers). */
function downloadJudgeFile(
	repo: string,
	filename: string,
	dest: string,
	modelKey: TinyLocalModelKey,
	reply: JudgeDownloadTransport,
	requestId: string,
): Promise<void> {
	return downloadHubFile({
		repo,
		revision: JULIA_JUDGE_REVISION,
		filename,
		dest,
		modelKey,
		transport: reply,
		requestId,
	});
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
			const remoteSize = await remoteHubFileSize(hubResolveUrl(repo, JULIA_JUDGE_REVISION, filename)).catch(() => 0);
			// Present file with matching size is complete (downloads land atomically
			// via `.part` + rename), so skip it; an unknown remote size keeps the
			// local file, while a known size mismatch re-downloads below.
			if (remoteSize === 0 || remoteSize === localSize) continue;
		}
		await downloadJudgeFile(repo, filename, dest, modelKey, reply, requestId);
	}
	return dir;
}
