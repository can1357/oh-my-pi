/**
 * SSH-backed access to the Docker host that runs compaction-benchmark trials.
 *
 * Every call opens a fresh `ssh` session, so a dropped connection never takes a
 * container process with it: agents run detached inside their container and the
 * runner re-attaches to their logs (see `followJsonl`).
 */
import * as path from "node:path";
import { readLines } from "@oh-my-pi/pi-utils";
import type { Subprocess } from "bun";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=4"];

/** Captured result of one remote shell command. */
export interface RemoteResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Quote one word for the remote POSIX shell. */
export function shq(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** One SSH-reachable Docker host. */
export class RemoteHost {
	constructor(readonly host: string) {}

	/** Run one shell command line remotely; throws on a non-zero exit unless `nothrow`. */
	async sh(command: string, opts: { stdin?: string; nothrow?: boolean } = {}): Promise<RemoteResult> {
		const child = Bun.spawn(["ssh", ...SSH_OPTIONS, this.host, command], {
			stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (exitCode !== 0 && !opts.nothrow) {
			const detail = (stderr.trim() || stdout.trim()).slice(-2_000);
			throw new Error(`${this.host}: \`${command}\` exited ${exitCode}${detail ? `: ${detail}` : ""}`);
		}
		return { exitCode, stdout, stderr };
	}

	/** Write text to a remote file, creating parent directories. */
	async write(remotePath: string, content: string): Promise<void> {
		await this.sh(`mkdir -p ${shq(path.posix.dirname(remotePath))} && cat > ${shq(remotePath)}`, { stdin: content });
	}

	/** Copy a local file or directory to the host. */
	upload(localPath: string, remotePath: string): Promise<void> {
		return this.#scp(localPath, `${this.host}:${remotePath}`);
	}

	/** Copy a remote file or directory to a local path. */
	download(remotePath: string, localPath: string): Promise<void> {
		return this.#scp(`${this.host}:${remotePath}`, localPath);
	}

	/** Start a long-lived `ssh` process (forwards, log followers); `sshArgs` precede the host. */
	spawn(sshArgs: string[], command?: string): Subprocess<"ignore", "pipe", "pipe"> {
		const argv = ["ssh", ...SSH_OPTIONS, ...sshArgs, this.host];
		if (command !== undefined) argv.push(command);
		return Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	}

	/**
	 * Stream a JSONL file inside a container from the first line, reconnecting
	 * after SSH drops, until `onRecord` returns `true`. Non-JSON lines are counted
	 * (so reconnects resume at the right line) but not delivered.
	 */
	async followJsonl(container: string, file: string, onRecord: (record: unknown) => boolean): Promise<void> {
		let consumed = 0;
		const decoder = new TextDecoder();
		while (true) {
			const child = this.spawn(
				[],
				`docker exec ${shq(container)} tail -n +${consumed + 1} -F ${shq(file)} 2>/dev/null`,
			);
			try {
				for await (const line of readLines(child.stdout)) {
					consumed++;
					let record: unknown;
					try {
						record = JSON.parse(decoder.decode(line));
					} catch {
						continue;
					}
					if (onRecord(record)) return;
				}
			} finally {
				child.kill();
				await child.exited;
				// Killing local ssh leaves the remote `tail -F` running; reap it.
				await this.sh(`docker exec ${shq(container)} pkill -f -- ${shq(`-F ${file}`)}`, { nothrow: true });
			}
			await Bun.sleep(2_000);
		}
	}

	async #scp(from: string, to: string): Promise<void> {
		const child = Bun.spawn(["scp", "-q", "-r", "-o", "BatchMode=yes", from, to], {
			stdout: "ignore",
			stderr: "pipe",
		});
		const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
		if (exitCode !== 0) throw new Error(`scp ${from} ${to} exited ${exitCode}: ${stderr.trim()}`);
	}
}
