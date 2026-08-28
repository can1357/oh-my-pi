import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which } from "../src/which";

describe("$which", () => {
	const originalPath = process.env.PATH;
	const tempDirs: string[] = [];

	afterEach(() => {
		process.env.PATH = originalPath;
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.platform === "win32")("uses the current process PATH for each cached lookup", () => {
		const firstDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-which-first-"));
		const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-which-second-"));
		tempDirs.push(firstDir, secondDir);

		const command = `omp-which-${process.pid}`;
		const firstExecutable = path.join(firstDir, command);
		const secondExecutable = path.join(secondDir, command);
		fs.writeFileSync(firstExecutable, "#!/bin/sh\n");
		fs.writeFileSync(secondExecutable, "#!/bin/sh\n");
		fs.chmodSync(firstExecutable, 0o755);
		fs.chmodSync(secondExecutable, 0o755);

		process.env.PATH = firstDir;
		expect($which(command)).toBe(firstExecutable);

		process.env.PATH = secondDir;
		expect($which(command)).toBe(secondExecutable);
	});
});
