import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * Run `run` with a directory holding a fake `tmux` CLI. Each `replies` key is a
 * space-joined argument list; the CLI prints its value, and exits 64 for any
 * other invocation. Callers put the directory first on `PATH`.
 * `options.replyDelayMs` makes every invocation answer that much later, so a
 * caller can exercise a probe that is slower than the client's timeout budget.
 */
export async function withFakeTmux<T>(
	replies: Readonly<Record<string, string>>,
	run: (binDir: string) => Promise<T>,
	options?: { replyDelayMs?: number },
): Promise<T> {
	const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-fake-tmux-"));
	try {
		const cases = Object.entries(replies)
			.map(([args, reply]) => `${shellQuote(args)}) printf '%s\\n' ${shellQuote(reply)} ;;`)
			.join("\n");
		const delay = options?.replyDelayMs ? `sleep ${options.replyDelayMs / 1000}\n` : "";
		const tmux = path.join(binDir, "tmux");
		await Bun.write(tmux, `#!/bin/sh\n${delay}case "$*" in\n${cases}\n*) exit 64 ;;\nesac\n`);
		await fs.chmod(tmux, 0o755);
		return await run(binDir);
	} finally {
		await fs.rm(binDir, { force: true, recursive: true });
	}
}
