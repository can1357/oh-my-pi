/**
 * The system calls `omp gc` makes that Bun has no API for: on an open
 * descriptor, `flistxattr` and `fgetxattr` (the extended attributes an entry
 * carries, and what each holds), `fcntl` (a file lease, the kernel's own
 * count of who else has a file open) and `ioctl` (`FS_IOC_GETFLAGS`, the
 * inode flags `chattr` sets, which decide whether a rename is refused); by
 * name, a rename that refuses to replace what has the new name — see
 * {@link renameNoReplace}; and an exchange of two names in one call — see
 * {@link renameExchange}. Loaded once, through `bun:ffi`, the way
 * `utils/title-generator.ts` loads its library.
 *
 * Whether a system answers a call is found by making it and reading the
 * error; callers never decide by the name of the system. What differs here
 * is only which calls can be made at all. `fcntl` and `ioctl` are variadic,
 * and `bun:ffi` makes ordinary calls: on x86-64 and on Linux's arm64 an
 * ordinary call puts the third argument where the variadic callee reads it,
 * but Apple's arm64 passes variadic arguments on the stack, so through
 * macOS's C library the argument would never arrive. There those two are
 * left unbound, and a caller that needs one is told so.
 */
import { dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";
import { constants as osConstants } from "node:os";

export interface Libc {
	/** `flistxattr(fd, into, size)`: the byte length of the names, or -1. */
	flistxattr(fd: number, into: Buffer | null, size: number): number;
	/** `fgetxattr(fd, name, into, size)`: the byte length of what `name` holds, or -1. */
	fgetxattr(fd: number, name: string, into: Buffer | null, size: number): number;
	/** `fcntl(fd, cmd, arg)` with an integer argument — its result, or -1 — where it can be called. */
	fcntl?(fd: number, cmd: number, arg: number): number;
	/** `ioctl(fd, request, into)` with a pointer argument — its result, or -1 — where it can be called. */
	ioctl?(fd: number, request: number, into: Buffer): number;
	/** `statx(AT_FDCWD, file, AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS, into)`, where available. */
	statx?(file: string, into: Buffer): number;
	/** The calling thread's `errno`, read straight after the call that failed. */
	errno(): number;
}

let loaded: Libc | undefined;

/** The C library, loaded on first use; throws, saying why, where there is none to load. */
export function libc(): Libc {
	if (loaded) return loaded;
	const failures: string[] = [];
	const describe = (soname: string, error: unknown): string =>
		`${soname}: ${error instanceof Error ? error.message : String(error)}`;
	for (const soname of ["libc.so.6", "libc.so"]) {
		try {
			const lib = dlopen(soname, {
				flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
				fgetxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
				// Declared 64-bit so the whole register holds the argument: the
				// C library reads it with `va_arg` as a pointer-sized value.
				fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
				ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			// Optional: older C libraries need not export statx. Keep the
			// descriptor calls available there for the ioctl fallback.
			let statx: Libc["statx"];
			try {
				const named = dlopen(soname, {
					statx: { args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
				});
				statx = (file, into) => named.symbols.statx(AT_FDCWD, cPath(file), 0x100, 0x7ff, ptr(into));
			} catch {
				// renameLocked reports a failure if the fallback cannot inspect flags.
			}
			loaded = {
				flistxattr: (fd, into, size) => Number(lib.symbols.flistxattr(fd, into ? ptr(into) : null, size)),
				fgetxattr: (fd, name, into, size) =>
					Number(lib.symbols.fgetxattr(fd, cPath(name), into ? ptr(into) : null, size)),
				fcntl: (fd, cmd, arg) => lib.symbols.fcntl(fd, cmd, arg),
				ioctl: (fd, request, into) => lib.symbols.ioctl(fd, request, ptr(into)),
				statx,
				errno: () => read.i32(lib.symbols.__errno_location() as Pointer, 0),
			};
			return loaded;
		} catch (error) {
			failures.push(describe(soname, error));
		}
	}
	try {
		const lib = dlopen("libSystem.B.dylib", {
			flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64_fast },
			fgetxattr: {
				args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.u32, FFIType.i32],
				returns: FFIType.i64_fast,
			},
			__error: { args: [], returns: FFIType.ptr },
		});
		loaded = {
			flistxattr: (fd, into, size) => Number(lib.symbols.flistxattr(fd, into ? ptr(into) : null, size, 0)),
			fgetxattr: (fd, name, into, size) =>
				Number(lib.symbols.fgetxattr(fd, cPath(name), into ? ptr(into) : null, size, 0, 0)),
			errno: () => read.i32(lib.symbols.__error() as Pointer, 0),
		};
		return loaded;
	} catch (error) {
		failures.push(describe("libSystem.B.dylib", error));
	}
	throw new Error(`the C library could not be loaded here (${failures.join("; ")})`);
}

/** The symbolic name of an `errno` value on this system — `EAGAIN` — or the number itself. */
export function errnoName(code: number): string {
	for (const [name, value] of Object.entries(osConstants.errno)) if (value === code) return name;
	return `errno ${code}`;
}

/** Whether `code` is the `errno` this system calls by one of `names`. */
export function isErrno(code: number, ...names: string[]): boolean {
	const values = osConstants.errno as Record<string, number | undefined>;
	return names.some(name => values[name] === code);
}

/** What {@link renameNoReplace} did. */
export type NoReplaceRename =
	/** What had the old name has the new one now. */
	| { outcome: "renamed" }
	/** Something already had the new name: nothing moved, nothing was replaced. */
	| { outcome: "taken" }
	/** Nothing had the old name. */
	| { outcome: "absent" }
	/** No rename that refuses to replace can be made here — `why` says what answered — so nothing moved. */
	| { outcome: "unsupported"; why: string };

interface RenameApi {
	/** The call, by name, for a reader: `renameat2(RENAME_NOREPLACE)`. */
	call: string;
	/** Rename, refusing to replace; 0 on success. */
	rename(from: string, to: string): number;
	/** What the last failure was, by the names POSIX gives it. */
	failure(): "taken" | "absent" | "unsupported" | string;
}

/** Linux's `RENAME_NOREPLACE`, macOS's `RENAME_EXCL`, and `AT_FDCWD`. */
const RENAME_NOREPLACE = 1;
const RENAME_EXCL = 0x4;
const AT_FDCWD = -100;
/** `renameat2`'s number, for a C library that has no wrapper for it: the system call is older than the wrapper. */
const SYS_RENAMEAT2: Record<string, number> = { x64: 316, arm64: 276 };

let renameApi: RenameApi | null | undefined;
let renameApiMissing = "";

/** A path as the C library reads it: its UTF-8 bytes and a terminating NUL. */
function cPath(file: string): Buffer {
	return Buffer.from(`${file}\0`, "utf8");
}

function posixFailure(code: number): "taken" | "absent" | "unsupported" | string {
	if (isErrno(code, "EEXIST")) return "taken";
	if (isErrno(code, "ENOENT")) return "absent";
	// The kernel or the filesystem does not know the flag.
	if (isErrno(code, "EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP")) return "unsupported";
	return errnoName(code);
}

function loadRenameApi(): RenameApi | null {
	const failures: string[] = [];
	const note = (what: string, error: unknown): void => {
		failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
	};
	for (const soname of ["libc.so.6", "libc.so"]) {
		try {
			const lib = dlopen(soname, {
				renameat2: {
					args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
					returns: FFIType.i32,
				},
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			const errno = (): number => read.i32(lib.symbols.__errno_location() as Pointer, 0);
			return {
				call: "renameat2(RENAME_NOREPLACE)",
				rename: (from, to) => lib.symbols.renameat2(AT_FDCWD, cPath(from), AT_FDCWD, cPath(to), RENAME_NOREPLACE),
				failure: () => posixFailure(errno()),
			};
		} catch (error) {
			note(`${soname} renameat2`, error);
		}
		const number = SYS_RENAMEAT2[process.arch];
		if (number === undefined) continue;
		try {
			// `syscall` is variadic; see the module comment for why an ordinary
			// call reaches it on these two architectures.
			const lib = dlopen(soname, {
				syscall: {
					args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i64],
					returns: FFIType.i64_fast,
				},
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			const errno = (): number => read.i32(lib.symbols.__errno_location() as Pointer, 0);
			return {
				call: "renameat2(RENAME_NOREPLACE) as a system call",
				rename: (from, to) =>
					Number(lib.symbols.syscall(number, AT_FDCWD, cPath(from), AT_FDCWD, cPath(to), RENAME_NOREPLACE)),
				failure: () => posixFailure(errno()),
			};
		} catch (error) {
			note(`${soname} syscall`, error);
		}
	}
	try {
		const lib = dlopen("libSystem.B.dylib", {
			renamex_np: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			__error: { args: [], returns: FFIType.ptr },
		});
		return {
			call: "renamex_np(RENAME_EXCL)",
			rename: (from, to) => lib.symbols.renamex_np(cPath(from), cPath(to), RENAME_EXCL),
			failure: () => posixFailure(read.i32(lib.symbols.__error() as Pointer, 0)),
		};
	} catch (error) {
		note("libSystem.B.dylib renamex_np", error);
	}
	try {
		// `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` refuses a name
		// already taken, and without `MOVEFILE_COPY_ALLOWED` never copies.
		const lib = dlopen("kernel32.dll", {
			MoveFileExW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
			GetLastError: { args: [], returns: FFIType.u32 },
		});
		const wide = (file: string): Buffer => Buffer.from(`${file}\0`, "utf16le");
		return {
			call: "MoveFileExW",
			rename: (from, to) => (lib.symbols.MoveFileExW(wide(from), wide(to), 0) !== 0 ? 0 : -1),
			failure: () => {
				const code = lib.symbols.GetLastError();
				// ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS; ERROR_FILE_NOT_FOUND,
				// ERROR_PATH_NOT_FOUND; ERROR_NOT_SUPPORTED.
				if (code === 80 || code === 183) return "taken";
				if (code === 2 || code === 3) return "absent";
				if (code === 50) return "unsupported";
				return `Windows error ${code}`;
			},
		};
	} catch (error) {
		note("kernel32.dll MoveFileExW", error);
	}
	renameApiMissing = failures.join("; ");
	return null;
}

/**
 * Rename `from` to `to` only while nothing has the name `to`: one call, which
 * either moves what has the name `from` at that instant or, finding `to`
 * taken, moves nothing and replaces nothing. A plain `rename` replaces
 * whatever has the new name, and a review renamed a file of its own onto a
 * private name gc had made, learned from the directory's `inotify` events,
 * just before gc's own `rename` onto it; that file was gone, and the reclaim
 * reported success.
 *
 * Linux's `renameat2` with `RENAME_NOREPLACE` (through the C library, or as
 * a system call where the library has no wrapper), macOS's `renamex_np` with
 * `RENAME_EXCL`, Windows's `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`.
 * Where none can be called, or the filesystem refuses the flag (as some
 * network and FUSE filesystems do), the answer is `unsupported` and nothing
 * moved. Any other failure throws, with its code. Asynchronous, though the
 * call itself is not, so a caller awaits it the way it awaits `fs.rename`.
 */
export async function renameNoReplace(from: string, to: string): Promise<NoReplaceRename> {
	if (renameApi === undefined) renameApi = loadRenameApi();
	if (renameApi === null) {
		return {
			outcome: "unsupported",
			why: `no rename that refuses to replace can be called here (${renameApiMissing})`,
		};
	}
	if (renameApi.rename(from, to) === 0) return { outcome: "renamed" };
	const failure = renameApi.failure();
	if (failure === "taken" || failure === "absent") return { outcome: failure };
	if (failure === "unsupported") {
		return { outcome: "unsupported", why: `${renameApi.call} is not supported for ${to}` };
	}
	throw Object.assign(new Error(`${failure}: ${renameApi.call} '${from}' -> '${to}'`), {
		code: failure,
		path: from,
		dest: to,
	});
}

/** What {@link renameExchange} did. */
export type NameExchange =
	/** Each name holds what the other held. */
	| { outcome: "exchanged" }
	/** One of the names had nothing: nothing moved. */
	| { outcome: "absent" }
	/** No exchange can be made here — `why` says what answered — so nothing moved. */
	| { outcome: "unsupported"; why: string };

/** Linux's `RENAME_EXCHANGE`. */
const RENAME_EXCHANGE = 2;

interface ExchangeApi {
	call: string;
	exchange(a: string, b: string): number;
	errno(): number;
}

let exchangeApi: ExchangeApi | null | undefined;
let exchangeApiMissing = "";

function loadExchangeApi(): ExchangeApi | null {
	const failures: string[] = [];
	const note = (what: string, error: unknown): void => {
		failures.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
	};
	for (const soname of ["libc.so.6", "libc.so"]) {
		try {
			const lib = dlopen(soname, {
				renameat2: {
					args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
					returns: FFIType.i32,
				},
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			return {
				call: "renameat2(RENAME_EXCHANGE)",
				exchange: (a, b) => lib.symbols.renameat2(AT_FDCWD, cPath(a), AT_FDCWD, cPath(b), RENAME_EXCHANGE),
				errno: () => read.i32(lib.symbols.__errno_location() as Pointer, 0),
			};
		} catch (error) {
			note(`${soname} renameat2`, error);
		}
		const number = SYS_RENAMEAT2[process.arch];
		if (number === undefined) continue;
		try {
			// `syscall` is variadic; see the module comment for why an ordinary
			// call reaches it on these two architectures.
			const lib = dlopen(soname, {
				syscall: {
					args: [FFIType.i64, FFIType.i64, FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i64],
					returns: FFIType.i64_fast,
				},
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			return {
				call: "renameat2(RENAME_EXCHANGE) as a system call",
				exchange: (a, b) =>
					Number(lib.symbols.syscall(number, AT_FDCWD, cPath(a), AT_FDCWD, cPath(b), RENAME_EXCHANGE)),
				errno: () => read.i32(lib.symbols.__errno_location() as Pointer, 0),
			};
		} catch (error) {
			note(`${soname} syscall`, error);
		}
	}
	exchangeApiMissing = failures.join("; ");
	return null;
}

/**
 * Swap what the names `a` and `b` hold, in one call: each then holds what the
 * other held at that instant, so neither is ever without a file and nothing
 * is replaced or removed. Linux's `renameat2` with `RENAME_EXCHANGE`. Where
 * it cannot be called — no Linux C library (macOS, Windows) — or the kernel
 * or filesystem refuses it, the answer is `unsupported`, with the reason,
 * and nothing moved. Asynchronous, though the call itself is not, as
 * {@link renameNoReplace} is.
 */
export async function renameExchange(a: string, b: string): Promise<NameExchange> {
	if (exchangeApi === undefined) exchangeApi = loadExchangeApi();
	if (exchangeApi === null) {
		return { outcome: "unsupported", why: `no exchange of two names can be made here (${exchangeApiMissing})` };
	}
	if (exchangeApi.exchange(a, b) === 0) return { outcome: "exchanged" };
	const code = exchangeApi.errno();
	if (isErrno(code, "ENOENT")) return { outcome: "absent" };
	return { outcome: "unsupported", why: `${exchangeApi.call} '${a}' <-> '${b}' failed with ${errnoName(code)}` };
}
