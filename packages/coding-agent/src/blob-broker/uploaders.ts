/** Built-in push-mode uploader composition and command uploader support. */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobDestinationId, type BlobDestinationMetadata, BUILTIN_BLOB_DESTINATIONS } from "./destinations";
import type { BlobPublication, BlobUploader, BlobUploadRequest } from "./publication";
import { type DestinationRuntimeConfig, DestinationUnavailableError, optionString } from "./uploader-runtime";
import { createAnonymousUploader } from "./uploaders-anonymous";
import { createCloudDriveUploader } from "./uploaders-cloud-drives";
import { createDiscordUploader } from "./uploaders-discord";
import { createImageHostUploader } from "./uploaders-image-hosts";
import { createLegacyUploader } from "./uploaders-legacy";
import { createObjectStorageUploader } from "./uploaders-object-storage";
import { createSelfHostedUploader } from "./uploaders-self-hosted";

const UPLOAD_TIMEOUT_MS = 60_000;
const URL_PATTERN = /https?:\/\/\S+/g;

/**
 * Quote-aware argv split for the command template. Supports single/double
 * quotes and backslash escapes outside single quotes — enough for uploader
 * command lines without invoking a shell.
 */
export function splitCommandTemplate(template: string): string[] {
	const argv: string[] = [];
	let current = "";
	let started = false;
	let quote: '"' | "'" | undefined;
	for (let i = 0; i < template.length; i++) {
		const ch = template[i];
		if (quote === "'") {
			if (ch === "'") quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === "\\" && i + 1 < template.length) {
			current += template[++i];
			started = true;
			continue;
		}
		if (quote === '"') {
			if (ch === '"') quote = undefined;
			else current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			started = true;
			continue;
		}
		if (ch === " " || ch === "\t") {
			if (started) argv.push(current);
			current = "";
			started = false;
			continue;
		}
		current += ch;
		started = true;
	}
	if (started) argv.push(current);
	return argv;
}

/** Last URL printed on stdout wins; uploader tools often log progress first. */
export function extractUploadUrl(stdout: string): string | null {
	let last: string | null = null;
	for (const match of stdout.matchAll(URL_PATTERN)) {
		last = match[0].replace(/[)\],.'"]+$/, "");
	}
	return last;
}

/**
 * Build an uploader from an argv template. Placeholders, substituted after
 * splitting (paths with spaces stay one argument): `{file}` temp file path,
 * `{mime}` MIME type, `{ext}` bare extension.
 */
export function createCommandUploader(template: string): BlobUploader {
	const argvTemplate = splitCommandTemplate(template);
	if (argvTemplate.length === 0) throw new Error("images.urls.command is empty");
	if (!argvTemplate.some(arg => arg.includes("{file}"))) {
		throw new Error("images.urls.command must reference {file}");
	}
	return {
		destination: "command",
		async upload(request: BlobUploadRequest): Promise<BlobPublication> {
			const { bytes, mimeType, extension } = request;
			const file = path.join(os.tmpdir(), `omp-blob-upload-${crypto.randomUUID()}.${extension}`);
			await Bun.write(file, bytes);
			try {
				const argv = argvTemplate.map(arg =>
					arg.replaceAll("{file}", file).replaceAll("{mime}", mimeType).replaceAll("{ext}", extension),
				);
				const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
				const timeout = setTimeout(() => proc.kill(), UPLOAD_TIMEOUT_MS);
				const [stdout, stderr, exitCode] = await Promise.all([
					new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
					new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
					proc.exited,
				]);
				clearTimeout(timeout);
				if (exitCode !== 0) {
					throw new Error(`${argv[0]} exited with code ${exitCode}: ${stderr.trim().slice(-300)}`);
				}
				const url = extractUploadUrl(stdout);
				if (!url) throw new Error(`${argv[0]} printed no URL on stdout`);
				return { url, destination: "command", bytes: bytes.byteLength };
			} finally {
				await fs.rm(file, { force: true });
			}
		},
	};
}

/**
 * Resolve one registry destination to its built-in uploader.
 *
 * Serving destinations deliberately return `null`; the broker selects those
 * through its separate serve-kind predicate. Registry entries known to be
 * unusable, and active entries without an implementation, fail explicitly
 * before an upload can issue a network request.
 */
export function createConfiguredUploader(
	destination: BlobDestinationId,
	config: DestinationRuntimeConfig,
): BlobUploader | null {
	const metadata: BlobDestinationMetadata = BUILTIN_BLOB_DESTINATIONS[destination];
	if (metadata.status === "incompatible" || metadata.status === "defunct") {
		const reason = metadata.reason ?? `the destination is classified as ${metadata.status}`;
		throw new DestinationUnavailableError(destination, reason);
	}

	if (destination === "command") {
		const command = optionString(config, "command");
		if (!command) {
			throw new DestinationUnavailableError(destination, "an upload command containing {file} is required");
		}
		return createCommandUploader(command);
	}

	const uploader =
		createAnonymousUploader(destination, config) ??
		createImageHostUploader(destination, config) ??
		createCloudDriveUploader(destination, config) ??
		createObjectStorageUploader(destination, config) ??
		createSelfHostedUploader(destination, config) ??
		createLegacyUploader(destination, config) ??
		createDiscordUploader(destination, config);
	if (uploader) return uploader;

	if (destination === "provider-files") {
		throw new DestinationUnavailableError(destination, "provider-native files must use the provider file channel");
	}
	if (metadata.family === "local-serving" || metadata.family === "tunnel") return null;
	throw new DestinationUnavailableError(destination, "no built-in uploader or serving adapter is implemented");
}

/** Wrap an uploader with per-hash memoization so bytes upload at most once. */
export function memoizeUploader(
	uploader: BlobUploader,
): (hash: string, request: BlobUploadRequest) => Promise<BlobPublication | null> {
	const byHash = new Map<string, Promise<BlobPublication | null>>();
	return (hash, request) => {
		let pending = byHash.get(hash);
		if (!pending) {
			pending = uploader.upload(request).catch(error => {
				byHash.delete(hash);
				logger.warn("blob-broker: upload failed; image stays inline", {
					uploader: uploader.destination,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			});
			byHash.set(hash, pending);
		}
		return pending;
	};
}
