/**
 * The names a directory gains, as a process watching it with `inotify` learns
 * them: from the kernel's create and move-in events, not by guessing. A test
 * uses it the way a review's watcher did — learn the private name gc moves a
 * file to, and rename something of its own onto it — and decides itself the
 * moment it acts, so the ordering is the test's, not the scheduler's. Linux
 * only, like the tests that use it.
 */
import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";

const IN_NONBLOCK = 0o4000;
const IN_CLOEXEC = 0o2000000;
const IN_CREATE = 0x100;
const IN_MOVED_TO = 0x80;

interface InotifyCalls {
	init(flags: number): number;
	addWatch(fd: number, dir: Buffer, mask: number): number;
}

let calls: InotifyCalls | undefined;

/** The two calls, from a library loaded on first use, so a file importing this still loads where there is none. */
function inotifyCalls(): InotifyCalls {
	if (calls) return calls;
	const lib = dlopen("libc.so.6", {
		inotify_init1: { args: [FFIType.i32], returns: FFIType.i32 },
		inotify_add_watch: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
	});
	calls = {
		init: flags => lib.symbols.inotify_init1(flags),
		addWatch: (fd, dir, mask) => lib.symbols.inotify_add_watch(fd, dir, mask),
	};
	return calls;
}

export interface NameWatch {
	/** Every name the directory has gained since the watch began, oldest first, read from the kernel's events now. */
	names(): string[];
	close(): void;
}

/** Watch `dir` for names that appear in it, by creation or by a rename into it. */
export function watchNames(dir: string): NameWatch {
	const lib = inotifyCalls();
	const fd = lib.init(IN_NONBLOCK | IN_CLOEXEC);
	if (fd < 0) throw new Error("inotify_init1 failed");
	if (lib.addWatch(fd, Buffer.from(`${dir}\0`), IN_CREATE | IN_MOVED_TO) < 0) {
		fs.closeSync(fd);
		throw new Error(`inotify_add_watch ${dir} failed`);
	}
	const seen: string[] = [];
	return {
		names() {
			const buffer = Buffer.alloc(64 * 1024);
			for (;;) {
				let got: number;
				try {
					got = fs.readSync(fd, buffer);
				} catch {
					// EAGAIN: no event is waiting.
					break;
				}
				for (let at = 0; at + 16 <= got;) {
					const length = buffer.readUInt32LE(at + 12);
					const name = buffer
						.subarray(at + 16, at + 16 + length)
						.toString("utf8")
						.replace(/\0+$/, "");
					if (name) seen.push(name);
					at += 16 + length;
				}
			}
			return [...seen];
		},
		close() {
			fs.closeSync(fd);
		},
	};
}
