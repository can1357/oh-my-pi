/**
 * Shell process: the bash tool's shell run as a process of its own.
 *
 * `omp __omp_worker_shell_process [options] -- <command>` runs one command in
 * the embedded engine with the tool profile (omp's utilities and tools resolve
 * ahead of `PATH`) over this process's own stdin, stdout and stderr, then
 * exits with its status. Externals stay in this process's session and group,
 * so a process started on a pseudo-terminal is that terminal's shell: its
 * programs own the terminal, receive its signals and see `/dev/tty`. Named
 * services and `pty` commands run this way.
 *
 * There is no session here. The URL paths a command names resolve through the
 * {@link ShellPathMap} the process was started with: `local://`, `skill://`,
 * `artifact://` and `attachment://` are the host files behind them, and every
 * other scheme is missing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	Shell,
	type ShellFilesystem,
	ShellFsOp,
	type ShellFsRequest,
	type ShellFsResponse,
} from "@oh-my-pi/pi-natives";
import { parseShellProcessArgs, type ShellPathMap } from "./shell-process-protocol";

/**
 * How long the externals alive at a terminal interrupt have to exit for the
 * interrupt to end the command, as a shell stops a script whose foreground
 * program the interrupt killed. One that outlives it handled the signal itself
 * (a REPL, an editor) and the command goes on.
 */
const INTERRUPT_SETTLE_MS = 250;

const URL_PATH = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;
/** The schemes a {@link ShellPathMap} backs. */
const MAPPED_SCHEMES: Partial<Record<string, true>> = { local: true, skill: true, artifact: true, attachment: true };
/** `artifact://<id>`, with the whole-file selector `read` accepts on it. */
const ARTIFACT_ID = /^(\d+)(?::raw)?$/i;
/** Operations that change the entry they name. */
const MUTATIONS: Partial<Record<ShellFsOp, true>> = {
	[ShellFsOp.CreateDir]: true,
	[ShellFsOp.RemoveFile]: true,
	[ShellFsOp.RemoveDir]: true,
	[ShellFsOp.RemoveDirAll]: true,
	[ShellFsOp.Rename]: true,
	[ShellFsOp.HardLink]: true,
	[ShellFsOp.Symlink]: true,
	[ShellFsOp.Mknod]: true,
	[ShellFsOp.SetPermissions]: true,
	[ShellFsOp.SetTimes]: true,
	[ShellFsOp.Chown]: true,
	[ShellFsOp.SetXattr]: true,
	[ShellFsOp.RemoveXattr]: true,
};

/** A filesystem failure carrying the errno name the shell reports. */
class UrlPathError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

/** The host entry a path names. */
interface HostEntry {
	/** The scheme it was reached through; empty for a host path. */
	scheme: string;
	path: string;
	/** The entry refuses every change: an immutable scheme, or a read-only `local://`. */
	readOnly: boolean;
}

/** The names below a URL's `scheme://`, with `.` and `..` resolved; a `..` above the root names nothing. */
function urlSegments(url: string, rest: string): string[] {
	const segments: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (segments.length === 0) throw new UrlPathError("ENOENT", `${url}: No such file or directory`);
			segments.pop();
			continue;
		}
		let name: string;
		try {
			name = decodeURIComponent(part);
		} catch {
			throw new UrlPathError("ENOENT", `${url}: No such file or directory`);
		}
		// An encoded separator or `..` would step outside the entry it claims to name.
		if (name === "." || name === ".." || /[/\\\0]/.test(name)) {
			throw new UrlPathError("ENOENT", `${url}: No such file or directory`);
		}
		segments.push(name);
	}
	return segments;
}

/** The URL paths of a shell process: each answered with the host entry its {@link ShellPathMap} gives it. */
class MappedUrls {
	#localRootMade = false;

	constructor(readonly map: ShellPathMap) {}

	filesystem(): ShellFilesystem {
		return {
			handler: async (error, request) => {
				if (error) return { error: { code: "EIO", message: error.message } };
				try {
					return await this.#answer(request);
				} catch (failure) {
					if (failure instanceof UrlPathError) return { error: { code: failure.code, message: failure.message } };
					return { error: { code: "EIO", message: failure instanceof Error ? failure.message : String(failure) } };
				}
			},
			nativeLocalPaths: true,
		};
	}

	async #answer(request: ShellFsRequest): Promise<ShellFsResponse> {
		const { op, path: subject } = request;
		// Every answer is a host path, so no handle of this filesystem exists.
		if (subject === undefined) throw new UrlPathError("EBADF", "Bad file handle");
		const scheme = URL_PATH.exec(subject)?.[1].toLowerCase();
		// A URL of another scheme handed to a program is the program's own (`curl https://…`).
		if (op === ShellFsOp.BackingPath && scheme !== undefined && !MAPPED_SCHEMES[scheme]) return {};
		const entry = await this.#locate(subject);
		const readOnly = new UrlPathError("EROFS", `${subject}: Read-only file system`);
		if (op === ShellFsOp.Rename || op === ShellFsOp.HardLink) {
			const target = await this.#locate(request.target ?? "");
			// Each scheme is its own filesystem: links and renames never cross into or out of it.
			if (target.scheme !== entry.scheme) throw new UrlPathError("EXDEV", `${subject}: Cross-device link`);
			if (target.readOnly || (op === ShellFsOp.Rename && entry.readOnly)) throw readOnly;
			return { local: entry.path, localTarget: target.path };
		}
		if (op === ShellFsOp.Open) {
			const flags = request.open;
			const writes = flags?.write || flags?.append || flags?.truncate || flags?.create || flags?.createNew;
			if (!entry.readOnly) return { local: entry.path };
			if (writes) throw readOnly;
			return { local: entry.path, readonly: true };
		}
		if (entry.readOnly && (MUTATIONS[op] || (op === ShellFsOp.Access && request.access?.write))) throw readOnly;
		return { local: entry.path };
	}

	/** The host entry `input` names: a mapped URL's, or `input` itself when it is a host path. */
	async #locate(input: string): Promise<HostEntry> {
		const match = URL_PATH.exec(input);
		if (!match) return { scheme: "", path: input, readOnly: false };
		const scheme = match[1].toLowerCase();
		const missing = new UrlPathError("ENOENT", `${input}: No such file or directory`);
		const unavailable = new UrlPathError("ENOENT", `${input}: not available in pty commands and services`);
		if (!MAPPED_SCHEMES[scheme]) throw unavailable;
		const segments = urlSegments(input, match[2]);
		if (scheme === "local") {
			const root = this.map.local;
			if (root === undefined) throw unavailable;
			if (!this.#localRootMade) {
				// The session scratch root always exists, like a mount point.
				fs.mkdirSync(root, { recursive: true });
				this.#localRootMade = true;
			}
			return { scheme, path: path.join(root, ...segments), readOnly: this.map.localReadOnly === true };
		}
		// The other schemes have no root to list.
		if (segments.length === 0) throw unavailable;
		if (scheme === "skill") {
			const skills = this.map.skills ?? {};
			// A namespaced skill (`<plugin>/<name>`) spans the first two names and wins over a path inside `<plugin>`.
			const namespaced = segments.length > 1 ? `${segments[0]}/${segments[1]}` : undefined;
			const name = namespaced !== undefined && Object.hasOwn(skills, namespaced) ? namespaced : segments[0];
			if (!Object.hasOwn(skills, name)) throw missing;
			const inside = segments.slice(name === namespaced ? 2 : 1);
			const file = skills[name];
			return { scheme, path: inside.length === 0 ? file : path.join(path.dirname(file), ...inside), readOnly: true };
		}
		if (scheme === "artifact") {
			const id = segments.length === 1 ? ARTIFACT_ID.exec(segments[0])?.[1] : undefined;
			const dir = this.map.artifacts;
			if (id === undefined || dir === undefined) throw missing;
			const file = (await fs.promises.readdir(dir).catch(() => [])).find(name => name.startsWith(`${id}.`));
			if (file === undefined) throw missing;
			return { scheme, path: path.join(dir, file), readOnly: true };
		}
		const attachments = this.map.attachments ?? {};
		const uri = `attachment://${segments.join("/")}`;
		if (!Object.hasOwn(attachments, uri)) throw missing;
		return { scheme, path: attachments[uri], readOnly: true };
	}
}

/** Run the shell process `args` (the argv after the worker selector) describe, then exit with the command's status. */
export async function runShellProcess(args: readonly string[]): Promise<never> {
	const spec = parseShellProcessArgs(args);
	if (!spec) {
		process.stderr.write("omp: malformed shell process arguments\n");
		process.exit(2);
	}
	const shell = new Shell({
		process: true,
		// A relaunch may outlive the script its first start was given.
		snapshotPath: spec.source !== undefined && fs.existsSync(spec.source) ? spec.source : undefined,
		filesystem: spec.paths ? new MappedUrls(spec.paths).filesystem() : undefined,
	});

	const abort = new AbortController();
	/** The status this process exits with once a signal ended the command. */
	let signalStatus: number | undefined;
	const stop = (status: number): void => {
		signalStatus ??= status;
		abort.abort();
	};
	// The terminal sends its interrupt to the whole foreground group, the externals included.
	const interrupt = (status: number): void => {
		const running = shell.pids();
		if (running.length === 0) {
			stop(status);
			return;
		}
		setTimeout(() => {
			const alive = new Set(shell.pids());
			if (!running.some(pid => alive.has(pid))) stop(status);
		}, INTERRUPT_SETTLE_MS);
	};
	// The CLI's own handler exits at once, leaving the command's programs behind.
	process.removeAllListeners("SIGINT");
	process.on("SIGINT", () => interrupt(130));
	process.on("SIGTERM", () => stop(143));
	process.on("SIGHUP", () => stop(129));
	if (process.platform !== "win32") process.on("SIGQUIT", () => interrupt(131));

	let status: number;
	try {
		const result = await shell.run({ command: spec.command, cwd: spec.cwd, signal: abort.signal });
		status = signalStatus ?? result.exitCode ?? 1;
	} catch (error) {
		process.stderr.write(`omp: ${error instanceof Error ? error.message : String(error)}\n`);
		status = 1;
	}
	process.exit(status);
}
