import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type WasmGrammarInfo, type WasmGrammarQuery, wasmGrammarFor } from "@oh-my-pi/pi-natives";
import { getNativeGrammarsDir, logger, withFileLock } from "@oh-my-pi/pi-utils";
import { withDownload } from "../downloads/activity";
import { downloadFile } from "./tools-manager";

/**
 * On-demand tree-sitter grammars. Less common languages ship as WebAssembly
 * grammars attached to a GitHub release instead of being linked into the
 * native addon; the addon loads `<natives dir>/grammars/<file>` lazily on next
 * use (the natives loader configures that directory), so installing is just
 * placing the verified `.wasm` there.
 *
 * Asset URL: `${PI_GRAMMARS_URL ?? GitHub releases}/<release>/<file>.zst`, a
 * zstd frame whose decompressed bytes must match the pinned size and SHA-256
 * reported by `wasmGrammarFor`.
 */

const DEFAULT_GRAMMARS_URL = "https://github.com/stencil-hq/wasm-grammars/releases/download";
/** Whole-transfer bound for one compressed grammar. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Lock wait long enough to cover a peer process's whole download. */
const LOCK_OPTIONS = { retries: DOWNLOAD_TIMEOUT_MS / 100 + 50, retryDelayMs: 100 };
/** After a failed install, skip that grammar for this long so offline sessions do not refetch on every call. */
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;

/** In-flight installs keyed by destination path. */
const inflight = new Map<string, Promise<boolean>>();
/** Last failed install time keyed by destination path. */
const failedAt = new Map<string, number>();

async function fetchGrammar(
	info: WasmGrammarInfo,
	dest: string,
	onProgress: (loaded: number, total: number | undefined) => void,
): Promise<void> {
	const base = process.env.PI_GRAMMARS_URL?.trim().replace(/\/+$/, "") || DEFAULT_GRAMMARS_URL;
	const url = `${base}/${info.release}/${info.file}.zst`;
	const compressed = `${dest}.zst.part`;
	const part = `${dest}.part`;
	logger.debug("grammar: downloading", { language: info.language, url });
	try {
		await downloadFile(url, compressed, { timeoutMs: DOWNLOAD_TIMEOUT_MS, onProgress });
		const wasm = Bun.zstdDecompressSync(await Bun.file(compressed).bytes());
		if (wasm.byteLength !== info.size) {
			throw new Error(`${info.file}: expected ${info.size} bytes, received ${wasm.byteLength}`);
		}
		const digest = new Bun.CryptoHasher("sha256").update(wasm).digest("hex");
		if (digest !== info.sha256.toLowerCase()) throw new Error(`${info.file}: SHA-256 mismatch (${digest})`);
		await Bun.write(part, wasm);
		// Rename, never rewrite in place: the addon reads `<dir>/<file>` lazily and must never see a partial file.
		await fs.rename(part, dest);
	} finally {
		await fs.rm(compressed, { force: true });
		await fs.rm(part, { force: true });
	}
}

async function installLocked(info: WasmGrammarInfo, dir: string, dest: string): Promise<boolean> {
	try {
		await fs.mkdir(dir, { recursive: true });
		return await withFileLock(
			`${dest}.install`,
			async () => {
				// Another process may have finished the install while we waited.
				if (await Bun.file(dest).exists()) return true;
				await withDownload(
					`${info.language} grammar`,
					tracker => fetchGrammar(info, dest, (loaded, total) => tracker.update({ loaded, total })),
					{ detail: info.file },
				);
				logger.debug("grammar: installed", { language: info.language, file: info.file });
				return true;
			},
			LOCK_OPTIONS,
		);
	} catch (error) {
		failedAt.set(dest, Date.now());
		logger.warn("grammar: install failed; files in this language are skipped", {
			language: info.language,
			file: info.file,
			error: String(error),
		});
		return false;
	}
}

/**
 * Download, verify, and install `info`'s wasm grammar into `dir` (default:
 * the directory the addon reads). Returns whether `<dir>/<file>` exists
 * afterwards. Concurrent calls for the same file share one install, and an OS
 * file lock serializes installs across processes. Never throws: network and
 * integrity failures are logged, return `false`, and back off for a few
 * minutes. {@link ensureGrammar} is the usual entry point; this takes the
 * resolved info directly (test seam).
 */
export function installGrammar(info: WasmGrammarInfo, dir: string = getNativeGrammarsDir()): Promise<boolean> {
	const dest = path.join(dir, info.file);
	const pending = inflight.get(dest);
	if (pending) return pending;
	const failed = failedAt.get(dest);
	if (failed !== undefined && Date.now() - failed < RETRY_AFTER_FAILURE_MS) return Promise.resolve(false);
	const install = installLocked(info, dir, dest).finally(() => inflight.delete(dest));
	inflight.set(dest, install);
	return install;
}

/**
 * Make sure the wasm grammar for `query` (a `lang` alias or a file `path`) is
 * installed, downloading it on first use. Returns `true` without network
 * access for built-in, unknown, or already installed languages; otherwise
 * whether the install succeeded. Offline or integrity failures log and return
 * `false`; native AST APIs then treat the language as unsupported.
 */
export async function ensureGrammar(query: WasmGrammarQuery): Promise<boolean> {
	const info = wasmGrammarFor(query);
	if (!info || info.installed) return true;
	return installGrammar(info);
}

/**
 * Install the wasm grammars of `languages` (typically a native result's
 * `missingGrammars`). Returns `true` when at least one of them is now
 * installed, i.e. a caller that saw them missing should re-run.
 */
export async function ensureGrammars(languages: readonly string[]): Promise<boolean> {
	const installed = await Promise.all(
		languages.map(lang => {
			const info = wasmGrammarFor({ lang });
			if (!info) return false;
			return info.installed || installGrammar(info);
		}),
	);
	return installed.includes(true);
}

/**
 * Run an idempotent native AST call (a search or a dry-run preview) against
 * the grammar cache and, when it reports `missingGrammars`, install them and
 * run it once more. Never use it for calls that write: the re-run would apply
 * rewrites twice.
 */
export async function rerunWithGrammars<T extends { missingGrammars?: string[] }>(run: () => Promise<T>): Promise<T> {
	const result = await run();
	if (!result.missingGrammars?.length || !(await ensureGrammars(result.missingGrammars))) return result;
	return run();
}

/** Tool-output note for languages whose files were skipped because their grammar could not be installed. */
export function missingGrammarsNote(languages: readonly string[]): string {
	return `Skipped ${languages.join(", ")} files: grammar could not be downloaded (offline?); results exclude them.`;
}
