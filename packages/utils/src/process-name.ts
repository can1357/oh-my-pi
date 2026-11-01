/**
 * Set the OS-visible process name (`/proc/self/comm`) so `omp` shows up as
 * `omp` — not `bun` — in `ps`, `pgrep`, `killall`, `top`, `htop`, and systemd.
 *
 * Bun's `process.title` setter only stores the value on the JS side; unlike
 * Node/libuv it never calls `prctl(PR_SET_NAME)`, so the kernel's `comm` stays
 * `bun` and process-name-based tooling can't target omp (and `pkill bun` becomes
 * a footgun that kills every Bun process on the machine). We keep the
 * `process.title` assignment (correct getter, future-proof if Bun ever fixes the
 * setter) and additionally drive `prctl` via `bun:ffi` on Linux, mirroring the
 * libc-FFI pattern in `ttyid.ts` / `stderr-guard.ts`.
 *
 * macOS has no clean userspace equivalent for the shebang-run path, so there
 * we only set `process.title`. Windows derives the name from the exec'd file,
 * and there Bun's `process.title` setter is libuv's `SetConsoleTitleW`: every
 * omp child attached to a pane's console (workers, `browser-relay`, servers)
 * would overwrite that pane's tab title, so Windows skips it entirely.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import * as os from "node:os";

/** `prctl(2)` option that sets the calling thread's `comm` name. */
const PR_SET_NAME = 15;

/**
 * Set the JS `process.title` (except on Windows, see above) and — on Linux —
 * the kernel `comm` name.
 *
 * Never throws: `bun:ffi` unavailability or a failed syscall degrades silently
 * to the `process.title`-only behavior, so it is safe to call at startup.
 */
export function setProcessName(name: string): void {
	const platform = os.platform();
	if (platform === "win32") return;
	try {
		process.title = name;
	} catch {}

	if (platform !== "linux") return;

	// glibc first, then the generic soname for musl-style layouts (see stderr-guard.ts).
	for (const soname of ["libc.so.6", "libc.so"]) {
		try {
			const libc = dlopen(soname, {
				prctl: {
					args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.u64, FFIType.u64],
					returns: FFIType.i32,
				},
			});
			try {
				// TASK_COMM_LEN is 16 (name + NUL); the kernel truncates the rest.
				const buf = Buffer.from(`${name}\0`, "utf8");
				libc.symbols.prctl(PR_SET_NAME, ptr(buf), 0n, 0n, 0n);
			} finally {
				libc.close();
			}
			return;
		} catch {
			// bun:ffi unavailable or this soname missing; try the next candidate.
		}
	}
}
