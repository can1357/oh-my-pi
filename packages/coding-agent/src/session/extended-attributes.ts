/**
 * The extended attributes an entry carries that `omp gc` does not copy.
 *
 * The archive holds a file's bytes and mode and a directory's mode, and
 * nothing else. An extended attribute — `user.*` data a tool stored, a POSIX
 * ACL (`system.posix_acl_*`), a macOS tag — is therefore held only by the live
 * entry, and a reclaim that gives the entry up loses it for good: a review set
 * one on a file and on its directory, and archive, reclaim and restore each
 * exited 0 with both gone. A reclaim asks this about every entry it would give
 * up and keeps any that carries one.
 *
 * Linux leaves out the `security.` namespace: those are labels (SELinux, file
 * capabilities) the system's policy gives a file it creates, a restored one
 * included, and counting them would refuse every reclaim on an SELinux host.
 * Windows has no extended attributes in this sense; an NTFS alternate data
 * stream is not asked about. Bun has no xattr API, so this calls the C
 * library's `flistxattr` through `bun:ffi`, the way `utils/process-name.ts`
 * calls `prctl`.
 */
import { dlopen, FFIType, type Pointer, ptr, read } from "bun:ffi";

/** `ENOTSUP`/`EOPNOTSUPP`: the filesystem keeps no extended attributes. */
const ENOTSUP = process.platform === "darwin" ? 45 : 95;
/** `ERANGE`: the list grew between sizing the buffer and reading it. */
const ERANGE = 34;

interface ListApi {
	list(fd: number, into: Buffer | null, size: number): number;
	errno(): number;
}

let api: ListApi | undefined;

function listApi(): ListApi {
	if (api) return api;
	const failures: string[] = [];
	for (const soname of process.platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", "libc.so"]) {
		try {
			if (process.platform === "darwin") {
				const lib = dlopen(soname, {
					flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64_fast },
					__error: { args: [], returns: FFIType.ptr },
				});
				api = {
					list: (fd, into, size) => Number(lib.symbols.flistxattr(fd, into ? ptr(into) : null, size, 0)),
					errno: () => read.i32(lib.symbols.__error() as Pointer, 0),
				};
			} else {
				const lib = dlopen(soname, {
					flistxattr: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
					__errno_location: { args: [], returns: FFIType.ptr },
				});
				api = {
					list: (fd, into, size) => Number(lib.symbols.flistxattr(fd, into ? ptr(into) : null, size)),
					errno: () => read.i32(lib.symbols.__errno_location() as Pointer, 0),
				};
			}
			return api;
		} catch (error) {
			failures.push(`${soname}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	throw new Error(`extended attributes cannot be read here (${failures.join("; ")})`);
}

/**
 * The names of the extended attributes on the file or directory open at
 * `fd` that a copy by gc would not carry. Throws when they cannot be read:
 * "could not look" is not "none".
 */
export function uncopiedExtendedAttributes(fd: number): string[] {
	if (process.platform === "win32") return [];
	const lib = listApi();
	for (let attempt = 0; attempt < 8; attempt++) {
		const size = lib.list(fd, null, 0);
		if (size < 0) {
			const code = lib.errno();
			if (code === ENOTSUP) return [];
			throw new Error(`its extended attributes could not be listed (errno ${code})`);
		}
		if (size === 0) return [];
		const names = Buffer.alloc(size);
		const got = lib.list(fd, names, size);
		if (got < 0) {
			const code = lib.errno();
			if (code === ERANGE) continue;
			if (code === ENOTSUP) return [];
			throw new Error(`its extended attributes could not be listed (errno ${code})`);
		}
		return names
			.subarray(0, got)
			.toString("utf8")
			.split("\0")
			.filter(name => name.length > 0 && !(process.platform === "linux" && name.startsWith("security.")));
	}
	throw new Error("its extended attributes kept changing while they were listed");
}
