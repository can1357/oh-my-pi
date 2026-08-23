import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { promisify } from "node:util";
import type { AuthStorage } from "../session/auth-storage";
import { CliUsageError } from "./usage-error";

const MAX_BUNDLE_BYTES = 1_000_000;
const MAX_PROVIDERS = 16;
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW ?? 0);

// fs/promises has no fstat/close for a bare descriptor, and the launcher's fd
// is not ours to adopt as a FileHandle, so promisify the callback forms rather
// than block the event loop with the sync ones.
const fstatByFd = promisify(fs.fstat);
const closeByFd = promisify(fs.close);

/** Provider name / API key pairs recovered from a validated bundle. */
export type ProviderApiKeyEntries = readonly (readonly [string, string])[];

type ReadChunk = (buffer: Buffer, offset: number, length: number, position: number) => Promise<number>;

/** Reads and validates a named credential bundle without following its final path component. */
export async function readProviderApiKeyBundle(path: string): Promise<ProviderApiKeyEntries> {
	try {
		if ((await fsp.lstat(path)).isSymbolicLink()) {
			throw new CliUsageError(
				"--provider-api-keys must not be a symbolic link; use --provider-api-keys-fd for descriptor handoff",
			);
		}
	} catch (error) {
		if (error instanceof CliUsageError) throw error;
		throw new CliUsageError("--provider-api-keys must name a readable credential bundle");
	}

	let handle: fsp.FileHandle;
	try {
		// O_NONBLOCK keeps special files from hanging. O_NOFOLLOW closes the race
		// between lstat and open if the final component is replaced by a symlink.
		handle = await fsp.open(path, OPEN_FLAGS);
	} catch {
		throw new CliUsageError("--provider-api-keys must name a readable credential bundle");
	}
	try {
		const stat = await handle.stat();
		validateBundleFile(stat);
		return await readBundle(async (buffer, offset, length, position) => {
			const chunk = await handle.read(buffer, offset, length, position);
			return chunk.bytesRead;
		});
	} finally {
		await handle.close();
	}
}

/** Closes a valid launcher descriptor without inspecting its contents. */
export async function closeProviderApiKeyBundleFd(value: string | number): Promise<void> {
	const fd = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(fd) || fd <= 2) return;
	try {
		await closeByFd(fd);
	} catch {
		// It was already closed; nothing known remains safe to close.
	}
}

/** Reads, validates and consumes the exact launcher descriptor N. */
export async function readProviderApiKeyBundleFd(value: string | number): Promise<ProviderApiKeyEntries> {
	const fd = typeof value === "number" ? value : Number(value);
	if (!Number.isSafeInteger(fd) || fd <= 2) {
		throw new CliUsageError("--provider-api-keys-fd must be an integer descriptor greater than 2");
	}
	let stat: fs.Stats;
	try {
		stat = await fstatByFd(fd);
	} catch {
		throw new CliUsageError("--provider-api-keys-fd must name a readable open descriptor");
	}
	try {
		validateBundleFile(stat);
		return await readBundle((buffer, offset, length, position) => readFd(fd, buffer, offset, length, position));
	} catch (error) {
		if (error instanceof CliUsageError) throw error;
		throw new CliUsageError("--provider-api-keys-fd descriptor must be readable");
	} finally {
		await closeProviderApiKeyBundleFd(fd);
	}
}

/** Installs consumed bundle entries as process-local runtime API keys. */
export function installProviderApiKeys(
	entries: ProviderApiKeyEntries,
	authStorage: Pick<AuthStorage, "setRuntimeApiKey">,
): void {
	for (const [provider, value] of entries) authStorage.setRuntimeApiKey(provider, value);
}

async function readBundle(readChunk: ReadChunk): Promise<ProviderApiKeyEntries> {
	// st_size is a snapshot. A same-user writer can append after validation, so
	// the cap is enforced on the read itself as well.
	const buf = Buffer.alloc(MAX_BUNDLE_BYTES + 1);
	let bytesRead = 0;
	while (bytesRead < buf.length) {
		const count = await readChunk(buf, bytesRead, buf.length - bytesRead, bytesRead);
		if (count === 0) break;
		bytesRead += count;
	}
	if (bytesRead > MAX_BUNDLE_BYTES) {
		throw new CliUsageError(`credential bundle must be 1-${MAX_BUNDLE_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(buf.subarray(0, bytesRead).toString("utf8"));
	} catch {
		throw new CliUsageError("credential bundle must be valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new CliUsageError("credential bundle must be an object");
	}
	const entries = Object.entries(parsed);
	if (entries.length === 0 || entries.length > MAX_PROVIDERS) {
		throw new CliUsageError(`credential bundle must contain 1-${MAX_PROVIDERS} providers`);
	}
	if (entries.some(([provider, entry]) => provider.length === 0 || typeof entry !== "string" || entry.length === 0)) {
		throw new CliUsageError("credential bundle requires provider IDs and non-empty string values");
	}
	return entries as ProviderApiKeyEntries;
}

function readFd(fd: number, buffer: Buffer, offset: number, length: number, position: number): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	fs.read(fd, buffer, offset, length, position, (error, bytesRead) => {
		if (error) reject(error);
		else resolve(bytesRead);
	});
	return promise;
}

function validateBundleFile(stat: fs.Stats): void {
	if (!stat.isFile()) throw new CliUsageError("credential bundle must name a regular file");
	if (process.platform !== "win32") {
		if (stat.nlink !== 0 && (stat.mode & 0o077) !== 0) {
			throw new CliUsageError("credential bundle must not be group/world-accessible");
		}
		if (typeof process.geteuid === "function" && stat.uid !== process.geteuid()) {
			throw new CliUsageError("credential bundle must be owned by the current user");
		}
	}
	if (stat.size === 0 || stat.size > MAX_BUNDLE_BYTES) {
		throw new CliUsageError(`credential bundle must be 1-${MAX_BUNDLE_BYTES} bytes`);
	}
}
