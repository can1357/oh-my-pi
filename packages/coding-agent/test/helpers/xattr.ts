/**
 * Extended attributes for tests, set and read in this process through the C
 * library. These used to run `python3 -c`, and in an agent session `python3`
 * is mise's shim: measured at 8 to 10 seconds a call on a loaded machine, so
 * a test that made two of them overran Bun's 5-second default, was abandoned
 * while its body ran on, and failed the tests after it. Linux only, like the
 * tests that use them; the library is loaded on first use, so a file that
 * imports this still loads where there is no `libc.so.6`.
 */
import { dlopen, FFIType, type Pointer, read } from "bun:ffi";
import { constants as osConstants } from "node:os";

interface XattrCalls {
	lsetxattr(target: Buffer, name: Buffer, value: Buffer, size: number): number;
	lgetxattr(target: Buffer, name: Buffer, into: Buffer, size: number): number;
	errno(): number;
}

let calls: XattrCalls | undefined;

function xattrCalls(): XattrCalls {
	if (calls) return calls;
	const lib = dlopen("libc.so.6", {
		lsetxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i32 },
		lgetxattr: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.i64_fast },
		__errno_location: { args: [], returns: FFIType.ptr },
	});
	calls = {
		lsetxattr: (target, name, value, size) => lib.symbols.lsetxattr(target, name, value, size, 0),
		lgetxattr: (target, name, into, size) => Number(lib.symbols.lgetxattr(target, name, into, size)),
		errno: () => read.i32(lib.symbols.__errno_location() as Pointer, 0),
	};
	return calls;
}

const cString = (text: string): Buffer => Buffer.from(`${text}\0`, "utf8");

/** Set the extended attribute `name` on `target` itself, not on what a link at it leads to. */
export function setXattr(target: string, name: string, value: string): void {
	const lib = xattrCalls();
	const bytes = Buffer.from(value, "utf8");
	if (lib.lsetxattr(cString(target), cString(name), bytes, bytes.length) !== 0) {
		throw new Error(`lsetxattr ${target} ${name} failed with errno ${lib.errno()}`);
	}
}

/** The value of the extended attribute `name` on `target` itself, or undefined when it has none. */
export function getXattr(target: string, name: string): string | undefined {
	const lib = xattrCalls();
	const into = Buffer.alloc(64 * 1024);
	const got = lib.lgetxattr(cString(target), cString(name), into, into.length);
	if (got >= 0) return into.subarray(0, got).toString("utf8");
	const code = lib.errno();
	if (code === osConstants.errno.ENODATA) return undefined;
	throw new Error(`lgetxattr ${target} ${name} failed with errno ${code}`);
}
