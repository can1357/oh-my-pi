import * as fs from "node:fs/promises";
import type { HostFileMutation } from "./host-protocol";

/**
 * Flags that open a file read-only without ever blocking: a FIFO opens at once instead of waiting
 * for a writer. Both opens of a contained read use them (the host's `file.identify` and omp's own).
 * Windows has no such flag.
 */
export const OPEN_READ_NONBLOCK = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0);

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
