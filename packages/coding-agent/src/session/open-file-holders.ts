/**
 * Which processes hold a file open.
 *
 * A removal judged by what a file holds cannot see a process that opened it
 * earlier and writes through that descriptor later: once the file is
 * unlinked, the write lands in an inode no name reaches, and a review lost a
 * background job's output that way to a reclaim and a restore that both
 * exited 0. `omp gc --reclaim` asks this about every file it is about to give
 * up, after it has moved them all to private names: a descriptor opened by
 * the file's name before its move is in the answer, and an open by that name
 * after the move makes a file of the opener's own.
 *
 * Linux reads `/proc/<pid>/fd`, following each entry with `stat` to the inode
 * it holds, compared by device and inode. Two holders are outside that
 * answer, and are said rather than narrowed: a process whose descriptors this
 * user may not read — another user's, which needs write access to a file of
 * this user's to matter, or one in a PID namespace this one cannot see — and
 * a shared memory mapping whose descriptor is already closed, which
 * `/proc/<pid>/fd` does not list. macOS asks `lsof`, where only exit 1 with
 * nothing printed shows the files unused. Elsewhere nothing answers, and the
 * caller keeps the files.
 */
import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { $ } from "bun";
import { codeOf } from "./gc-lock";

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
