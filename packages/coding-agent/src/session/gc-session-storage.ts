/**
 * gc's read-only listing boundary. The picker deliberately tolerates failed
 * reads; gc must instead report every failed look that the scanner swallowed.
 * Each instance retains those failures until its caller has read the report.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { codeOf } from "./gc-lock";
import { isArchivedSessionPath } from "./session-archive";
import { readSessionInfo, type SessionInfo } from "./session-listing";
import { FileSessionStorage, type SessionStorageStat } from "./session-storage";
import { isAssistantMessageLine } from "./session-entries";
import { absentFile as absent, kindOf, NotARegularFile, openRegularFile } from "./regular-file";

export class RegularFileSessionStorage extends FileSessionStorage {
	readonly failures: { file: string; message: string }[] = [];

	get failureMessages(): string[] {
		return this.failures.map(({ file, message }) => `${file}: ${message}`);
	}

	#failed(file: string, error: unknown): never {
		if (codeOf(error) !== "ENOENT" && codeOf(error) !== "ENOTDIR") {
			this.failures.push({ file, message: error instanceof Error ? error.message : String(error) });
		}
		throw error;
	}

	override statSync(file: string): SessionStorageStat {
		try {
			const stat = fs.lstatSync(file);
			if (!stat.isFile()) throw new NotARegularFile(file, kindOf(stat));
			return { size: stat.size, mtimeMs: stat.mtimeMs, mtime: stat.mtime };
		} catch (error) {
			return this.#failed(file, error);
		}
	}

	override listFilesSync(dir: string, pattern: string): string[] {
		try {
			// A glob omits FIFOs and dangling links. They are names a gc scan
			// must see and report, not evidence of an empty session bucket.
			const glob = new Bun.Glob(pattern);
			return fs
				.readdirSync(dir)
				.filter(name => glob.match(name))
				.map(name => path.join(dir, name));
		} catch (error) {
			return this.#failed(dir, error);
		}
	}

	override async readTextSlices(file: string, prefixBytes: number, suffixBytes: number): Promise<[string, string]> {
		try {
			if (isArchivedSessionPath(file)) return await super.readTextSlices(file, prefixBytes, suffixBytes);
			const handle = await openRegularFile(file, { noFollow: true });
			if (!handle) throw absent(file);
			try {
				const { size } = await handle.stat();
				const head = Buffer.allocUnsafe(Math.min(prefixBytes, size));
				const first = await handle.read(head, 0, head.byteLength, 0);
				const tail = Buffer.allocUnsafe(Math.min(suffixBytes, size));
				const last =
					tail.byteLength > 0 ? await handle.read(tail, 0, tail.byteLength, size - tail.byteLength) : undefined;
				const decoder = new TextDecoder();
				return [
					decoder.decode(head.subarray(0, first.bytesRead)),
					decoder.decode(tail.subarray(0, last?.bytesRead ?? 0)),
				];
			} finally {
				await handle.close().catch(() => undefined);
			}
		} catch (error) {
			return this.#failed(file, error);
		}
	}

	override async hasAssistantTurn(file: string): Promise<boolean> {
		try {
			const handle = await openRegularFile(file, { noFollow: true });
			if (!handle) throw absent(file);
			try {
				for await (const line of handle.readLines()) {
					if (isAssistantMessageLine(line)) return true;
				}
				return false;
			} finally {
				await handle.close().catch(() => undefined);
			}
		} catch (error) {
			return this.#failed(file, error);
		}
	}
}

/** A scanner's undefined means "not a session" only when no storage check failed. */
export async function readRegularSessionInfo(file: string): Promise<SessionInfo | undefined> {
	const storage = new RegularFileSessionStorage();
	const session = await readSessionInfo(file, storage);
	if (storage.failures.length > 0) throw new Error(storage.failureMessages.join("; "));
	return session;
}
