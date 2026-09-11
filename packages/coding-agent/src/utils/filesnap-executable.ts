import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { embeddedFilesnap } from "./filesnap-embedded";
import { resolveFilesnapNpmBinary } from "./filesnap-npm";

/** Bun assets are virtual files: materialize the executable before spawning it. */
export async function resolveFilesnapExecutable(dataDir: string, override?: string): Promise<string> {
	if (override) return override;
	if (!embeddedFilesnap) return resolveFilesnapNpmBinary();
	const { sha256, path: asset, license, notice } = embeddedFilesnap;
	const root = path.join(dataDir, "runtime", "filesnap");
	const directory = path.join(root, sha256);
	const filename = process.platform === "win32" ? "filesnap.exe" : "filesnap";
	const executable = path.join(directory, filename);
	async function installed(): Promise<boolean> {
		try {
			const bytes = await Bun.file(executable).bytes();
			if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
				throw new Error(`Bundled filesnap cache is damaged: ${directory}. Remove this directory and retry.`);
			}
			return true;
		} catch (error) {
			if (isEnoent(error)) return false;
			throw error;
		}
	}
	if (await installed()) return executable;
	await fs.mkdir(root, { recursive: true, mode: 0o700 });
	const temporary = await fs.mkdtemp(path.join(root, ".extract-"));
	try {
		const staged = path.join(temporary, filename);
		await Bun.write(staged, Bun.file(asset), { mode: 0o700 });
		await fs.chmod(staged, 0o700);
		await Bun.write(path.join(temporary, "LICENSE"), license, { mode: 0o600 });
		await Bun.write(path.join(temporary, "NOTICE"), notice, { mode: 0o600 });
		try {
			// Publish a complete directory atomically; concurrent sessions may win.
			await fs.rename(temporary, directory);
		} catch (error) {
			if (!(await installed())) throw error;
		}
	} finally {
		await fs.rm(temporary, { recursive: true, force: true });
	}
	return executable;
}
