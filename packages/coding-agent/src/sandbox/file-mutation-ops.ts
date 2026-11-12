import * as fs from "node:fs/promises";
import type { HostFileMutation } from "./host-protocol";

/**
 * Performs `mutation` in this process: how the sandbox host serves `file.mutate`, and how the file
 * tools mutate when nothing is contained.
 */
export async function applyFileMutation(mutation: HostFileMutation): Promise<void> {
	switch (mutation.kind) {
		case "write":
			await Bun.write(mutation.path, mutation.data);
			return;
		case "append":
			await fs.appendFile(mutation.path, mutation.data);
			return;
		case "create":
			await (await fs.open(mutation.path, "wx")).close();
			return;
		case "unlink":
			await fs.unlink(mutation.path);
			return;
		case "rmdir":
			await fs.rmdir(mutation.path);
			return;
		case "mkdir":
			await fs.mkdir(mutation.path, { recursive: true });
			return;
		case "rename":
			await fs.rename(mutation.from, mutation.to);
			return;
		case "rm":
			await fs.rm(mutation.path, { recursive: mutation.recursive, force: mutation.force });
			return;
		case "chmod":
			await fs.chmod(mutation.path, mutation.mode);
			return;
	}
}
