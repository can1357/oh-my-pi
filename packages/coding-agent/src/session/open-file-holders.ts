/**
 * Which processes hold a file open, and the kernel's proof that none does.
 *
 * A process holding a session file open is using the session. Nothing about
 * what the file holds shows it: it opened the file earlier and writes through
 * that descriptor later. Once `gc --reclaim` has moved the file into the
 * archive, such a write lands there, beside an archived copy that does not
 * hold it, where the blob sweep and the archived transcript do not see it.
 *
 * Two answers, for two jobs. {@link openFileHolders} lists the processes it
 * can see holding a file — Linux reads `/proc/<pid>/fd`, following each
 * entry with `stat` to the inode it holds; macOS asks `lsof`, where only
 * exit 1 with nothing printed shows the files unused; elsewhere nothing
 * answers — so a refusal can name who to close. A list is a snapshot, and
 * proves nothing: a process that forked after the list was read and closed
 * its own copy of the descriptor leaves a child that inherited it, and that
 * child is in no list. A descriptor handed over a socket, a shared mapping
 * whose descriptor is closed, and a process of another user or PID namespace
 * are missing from it the same way.
 *
 * {@link takeSoleOpenLease} is the proof. A Linux write lease
 * (`fcntl(F_SETLEASE, F_WRLCK)`) is granted only while no open file
 * description but the caller's own reaches the file, however many processes
 * share one by `fork` or by a socket, and a mapping keeps its description
 * alive; the kernel counts them, so nothing is listed and nothing can be
 * missed. While the lease stands, an open of the file by any other process —
 * or a `truncate` — first breaks it, which {@link soleOpenLeaseStands} sees.
 * Such an opener waits until this run lets go, or for at most the kernel's
 * `fs.lease-break-time` (45 seconds by default), after which the kernel
 * takes the lease away and lets the open through; it is never held longer.
 * Closing the descriptor lets go, and so does the end of the process, by
 * any signal. Measured on Linux 7.0 and ext4: the lease was refused while a
 * writer held the file, while only a forked child held an inherited
 * descriptor, while a reader held it, and while only a shared mapping with
 * its descriptor closed remained; it was granted once nothing held the file.
 *
 * Whether a system gives leases at all is found by asking: the answer to the
 * attempt is classified, never the name of the system. Where none is given —
 * macOS, whose C library this cannot pass `fcntl`'s argument to; Windows,
 * with no C library to load; a Linux filesystem that refuses leases, as NFS
 * does, or leases turned off with `fs.leases-enable` — no file is proved
 * unheld, and the caller keeps it.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { $ } from "bun";
import { codeOf } from "./gc-lock";
import { errnoName, isErrno, type Libc, libc } from "./libc";

/** `fcntl` commands and lease types, as Linux numbers them. */
const F_SETSIG = 10;
const F_SETLEASE = 1024;
const F_GETLEASE = 1025;
const F_WRLCK = 1;

/**
 * What the kernel answered when asked for a lease on a file this run holds
 * open — see {@link takeSoleOpenLease}. `evidence` is the call and what it
 * returned, for a refusal to quote.
 */
export type SoleOpenLease =
	/** No other open file description reaches the file, and none can be made unseen until the descriptor closes. */
	| { outcome: "held" }
	/** Another open file description reaches it: some process holds it open, or maps it. */
	| { outcome: "open-elsewhere"; evidence: string }
	/** The kernel gave no answer: `meaning` says why, and `retry` whether running again can help. */
	| { outcome: "unproved"; evidence: string; meaning: string; retry: boolean };

/**
 * Take a write lease on the regular file open at `fd`, which must be this
 * run's only descriptor on it, opened read-only: proof, from the kernel,
 * that no other process holds the file open — see the module comment. The
 * lease lasts until `fd` is closed; {@link soleOpenLeaseStands} says whether
 * it still stands unbroken.
 *
 * A lease break sends its holder `SIGIO`, whose default action ends the
 * process, so the descriptor is told to send `SIGURG` instead, which a
 * process ignores unless it asks for it, before the lease is asked for.
 */
export function takeSoleOpenLease(fd: number): SoleOpenLease {
	const call = leaseCall();
	if ("outcome" in call) return call;
	const { lib, fcntl } = call;
	// Asked first because it changes nothing: a system without Linux leases
	// refuses the command, and nothing has been set on the descriptor.
	for (const [cmd, name, arg] of [
		[F_GETLEASE, "F_GETLEASE", 0],
		[F_SETSIG, "F_SETSIG", osConstants.signals.SIGURG],
	] as const) {
		if (fcntl(fd, cmd, arg) < 0) return unproved(name, lib.errno());
	}
	if (fcntl(fd, F_SETLEASE, F_WRLCK) === 0) return { outcome: "held" };
	const code = lib.errno();
	if (isErrno(code, "EAGAIN", "EWOULDBLOCK")) {
		return { outcome: "open-elsewhere", evidence: `fcntl(F_SETLEASE, F_WRLCK) failed with ${errnoName(code)}` };
	}
	return unproved("F_SETLEASE, F_WRLCK", code);
}

/** A {@link SoleOpenLease} the kernel was never asked for. */
type UnaskedLease = Extract<SoleOpenLease, { outcome: "unproved" }>;

/** The C library and its `fcntl`, or why a lease cannot be asked for here at all. */
function leaseCall(): { lib: Libc; fcntl: NonNullable<Libc["fcntl"]> } | UnaskedLease {
	let lib: Libc;
	try {
		lib = libc();
	} catch (error) {
		return {
			outcome: "unproved",
			evidence: error instanceof Error ? error.message : String(error),
			meaning: "this system has no C library to ask the kernel for a file lease through",
			retry: false,
		};
	}
	if (!lib.fcntl) {
		return {
			outcome: "unproved",
			evidence: "fcntl was not called",
			meaning: "this system's C library takes `fcntl`'s third argument where omp cannot pass it",
			retry: false,
		};
	}
	return { lib, fcntl: lib.fcntl };
}

/**
 * Why no lease can be asked for on this system at all, whatever the file —
 * macOS, whose C library this cannot pass `fcntl`'s argument to, or Windows,
 * with no C library to load — as the refusal {@link takeSoleOpenLease} would
 * give; undefined where the call can be made. A system that can make it may
 * still refuse a lease on a given filesystem, which only an attempt on a
 * file there shows.
 */
export function leaseCallUnavailable(): UnaskedLease | undefined {
	const call = leaseCall();
	return "outcome" in call ? call : undefined;
}

/** A refused lease call, classified by its `errno`. */
function unproved(call: string, code: number): SoleOpenLease {
	const evidence = `fcntl(${call}) failed with ${errnoName(code)}`;
	if (isErrno(code, "EINVAL", "ENOTSUP", "EOPNOTSUPP", "ENOSYS")) {
		return {
			outcome: "unproved",
			evidence,
			meaning:
				"the kernel gives no file lease here: this system has no Linux leases, the file's filesystem refuses " +
				"them (NFS does), or they are turned off (`fs.leases-enable`)",
			retry: false,
		};
	}
	if (isErrno(code, "ENOLCK", "ENOMEM")) {
		return { outcome: "unproved", evidence, meaning: "the kernel had no room to record a lease", retry: true };
	}
	if (isErrno(code, "EACCES", "EPERM")) {
		return {
			outcome: "unproved",
			evidence,
			meaning: "the kernel grants a lease only to the file's owner, and this user does not own it",
			retry: false,
		};
	}
	return { outcome: "unproved", evidence, meaning: "the kernel refused to say", retry: true };
}

/**
 * Whether the lease {@link takeSoleOpenLease} took on `fd` still stands
 * unbroken: no process has opened or truncated the file since. A break that
 * is pending, or that the kernel has already forced, reads as false. A
 * failure to ask is not taken for a broken lease: it throws, saying why, so
 * no caller reads "could not look" as "another process opened it".
 */
export function soleOpenLeaseStands(fd: number): boolean {
	const lib = libc();
	if (!lib.fcntl) throw new Error("whether its lease still stands cannot be asked here (no fcntl)");
	const state = lib.fcntl(fd, F_GETLEASE, 0);
	if (state < 0) throw new Error(`whether its lease still stands could not be read (${errnoName(lib.errno())})`);
	return state === F_WRLCK;
}

/** One process holding one of the files asked about. */
export interface OpenFileHolder {
	pid: number;
	/** The process's command name, when it could be read. */
	command?: string;
	file: string;
}

/** Who holds the files open, or why that could not be told. */
export type OpenFileHolders = { holders: OpenFileHolder[] } | { unknown: string };

/** Every process found holding one of `files` open; none of them may be a directory. */
export async function openFileHolders(files: readonly string[]): Promise<OpenFileHolders> {
	if (files.length === 0) return { holders: [] };
	if (process.platform === "linux") return await linuxHolders(files);
	if (process.platform === "darwin") return await darwinHolders(files);
	return { unknown: `${process.platform} gives omp no way to see which processes hold a file open` };
}

/** How a holder reads in a sentence: "process 4242 (python3), holding /a/b". */
export function describeOpenFileHolder(holder: OpenFileHolder): string {
	return `process ${holder.pid}${holder.command ? ` (${holder.command})` : ""}, holding ${holder.file}`;
}

/**
 * How many descriptors this process holds on the file `identity` names, by
 * `/proc/self/fd`; undefined where that cannot be read. A lease is refused
 * while any other open of the file exists — this process's own included —
 * so a caller holding one descriptor of its own, and asking why the kernel
 * refused, reads more than one as this process holding the file elsewhere.
 */
export async function ownDescriptorCount(identity: { dev: number; ino: number }): Promise<number | undefined> {
	if (process.platform !== "linux") return undefined;
	let descriptors: string[];
	try {
		descriptors = await fs.readdir("/proc/self/fd");
	} catch {
		return undefined;
	}
	let count = 0;
	for (const descriptor of descriptors) {
		const held = await fs.stat(`/proc/self/fd/${descriptor}`).catch(() => undefined);
		if (held && held.dev === identity.dev && held.ino === identity.ino) count++;
	}
	return count;
}

async function linuxHolders(files: readonly string[]): Promise<OpenFileHolders> {
	const wanted = new Map<string, string>();
	for (const file of files) {
		const stat = await fs.lstat(file);
		wanted.set(`${stat.dev}:${stat.ino}`, file);
	}
	let pids: string[];
	try {
		pids = (await fs.readdir("/proc")).filter(name => /^\d+$/.test(name));
	} catch (error) {
		return { unknown: `/proc could not be read: ${error instanceof Error ? error.message : String(error)}` };
	}
	const holders: OpenFileHolder[] = [];
	// A failure that is neither "gone" nor "not this user's" says nothing
	// about what the process holds, and is not read as "nothing".
	let unreadable: string | undefined;
	await Promise.all(
		pids.map(async pid => {
			let descriptors: string[];
			try {
				descriptors = await fs.readdir(`/proc/${pid}/fd`);
			} catch (error) {
				const code = codeOf(error);
				if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") return;
				unreadable ??= `/proc/${pid}/fd could not be read: ${error instanceof Error ? error.message : String(error)}`;
				return;
			}
			await Promise.all(
				descriptors.map(async descriptor => {
					let held: Stats;
					try {
						held = await fs.stat(`/proc/${pid}/fd/${descriptor}`);
					} catch (error) {
						const code = codeOf(error);
						// Closed since the listing, or the process is gone.
						if (code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM") return;
						unreadable ??= `/proc/${pid}/fd/${descriptor} could not be followed: ${error instanceof Error ? error.message : String(error)}`;
						return;
					}
					const file = wanted.get(`${held.dev}:${held.ino}`);
					if (file !== undefined) holders.push({ pid: Number(pid), file });
				}),
			);
		}),
	);
	if (unreadable !== undefined && holders.length === 0) return { unknown: unreadable };
	for (const holder of holders) {
		holder.command =
			(
				await Bun.file(`/proc/${holder.pid}/comm`)
					.text()
					.catch(() => "")
			).trim() || undefined;
	}
	return { holders: dedupe(holders) };
}

async function darwinHolders(files: readonly string[]): Promise<OpenFileHolders> {
	let result: { exitCode: number; stdout: Buffer; stderr: Buffer };
	try {
		result = await $`/usr/sbin/lsof -F pcn -- ${files}`.quiet().nothrow();
	} catch (error) {
		return { unknown: `lsof could not be run: ${error instanceof Error ? error.message : String(error)}` };
	}
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString().trim();
	if (result.exitCode === 1 && stdout.length === 0 && stderr.length === 0) return { holders: [] };
	if (result.exitCode !== 0) {
		return { unknown: `lsof exited ${result.exitCode}${stderr ? `: ${stderr}` : ""}` };
	}
	const holders: OpenFileHolder[] = [];
	let pid = 0;
	let command: string | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("p")) {
			pid = Number(line.slice(1));
			command = undefined;
		} else if (line.startsWith("c")) command = line.slice(1);
		else if (line.startsWith("n") && pid > 0) holders.push({ pid, command, file: line.slice(1) });
	}
	if (holders.length === 0) return { unknown: `lsof exited 0 and named no process: ${stdout.trim()}` };
	return { holders: dedupe(holders) };
}

function dedupe(holders: readonly OpenFileHolder[]): OpenFileHolder[] {
	const seen = new Set<string>();
	return holders
		.filter(holder => {
			const key = `${holder.pid}\0${holder.file}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.sort((a, b) => a.pid - b.pid || a.file.localeCompare(b.file));
}
