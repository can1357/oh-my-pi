import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AtomicFileWriteOptions {
	readonly mode?: number;
	readonly directoryMode?: number;
}

/** Publish a complete sibling temporary file with one atomic rename. */
export async function writeFileAtomic(
	filePath: string,
	content: string | Uint8Array,
	options: AtomicFileWriteOptions = {},
): Promise<void> {
	const directory = path.dirname(filePath);
	const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${Bun.randomUUIDv7()}.tmp`);
	await fs.mkdir(directory, { recursive: true, mode: options.directoryMode });
	try {
		await fs.writeFile(temporaryPath, content, { flag: "wx", mode: options.mode });
		await fs.rename(temporaryPath, filePath);
	} finally {
		await fs.rm(temporaryPath, { force: true });
	}
}
