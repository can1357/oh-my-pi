/**
 * The C library calls `omp gc` makes on an open descriptor, which Bun has no
 * API for: `flistxattr` (the extended attributes an entry carries), `fcntl`
 * (a file lease, the kernel's own count of who else has a file open) and
 * `ioctl` (`FS_IOC_GETFLAGS`, the inode flags `chattr` sets). Loaded once,
 * through `bun:ffi`, the way `utils/title-generator.ts` loads its library.
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
	/** `fcntl(fd, cmd, arg)` with an integer argument — its result, or -1 — where it can be called. */
	fcntl?(fd: number, cmd: number, arg: number): number;
	/** `ioctl(fd, request, into)` with a pointer argument — its result, or -1 — where it can be called. */
	ioctl?(fd: number, request: number, into: Buffer): number;
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
				// Declared 64-bit so the whole register holds the argument: the
				// C library reads it with `va_arg` as a pointer-sized value.
				fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i64], returns: FFIType.i32 },
				ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
				__errno_location: { args: [], returns: FFIType.ptr },
			});
			loaded = {
				flistxattr: (fd, into, size) => Number(lib.symbols.flistxattr(fd, into ? ptr(into) : null, size)),
				fcntl: (fd, cmd, arg) => lib.symbols.fcntl(fd, cmd, arg),
				ioctl: (fd, request, into) => lib.symbols.ioctl(fd, request, ptr(into)),
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
			__error: { args: [], returns: FFIType.ptr },
		});
		loaded = {
			flistxattr: (fd, into, size) => Number(lib.symbols.flistxattr(fd, into ? ptr(into) : null, size, 0)),
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
