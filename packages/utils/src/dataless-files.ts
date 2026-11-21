/**
 * Reads of cloud-only (dataless) files on macOS.
 *
 * File Provider folders (iCloud Drive with Optimize Mac Storage, synced
 * Desktop & Documents, Google Drive streaming, Dropbox online-only) keep
 * evicted files as placeholders whose bytes download on first access. A
 * per-process I/O policy, inherited by children, decides whether that access
 * downloads or fails at once with `EDEADLK` ("Resource deadlock avoided"). The
 * system default is off. Terminal.app turns it on, but a terminal or session
 * daemon started as a launchd job without `MaterializeDatalessFiles` passes
 * the off policy to every shell and to omp.
 *
 * {@link materializeDatalessFiles} turns it on for omp and every process it
 * spawns afterwards.
 */
import { dlopen, FFIType } from "bun:ffi";

/** `IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES`: the download-on-access policy. */
const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES = 3;
/** `IOPOL_SCOPE_PROCESS`: every thread of the process, inherited by children. */
const IOPOL_SCOPE_PROCESS = 0;
/** `IOPOL_MATERIALIZE_DATALESS_FILES_ON`: download a placeholder's bytes when read. */
const IOPOL_MATERIALIZE_DATALESS_FILES_ON = 2;

/**
 * Make reads of cloud-only files in this process, and in processes it spawns
 * from now on, download them as in Terminal.app instead of failing with
 * `EDEADLK`. For the CLI process entry, before it spawns anything.
 *
 * Never throws: off macOS, or when libSystem's symbol cannot load, the policy
 * stays as inherited.
 */
export function materializeDatalessFiles(): void {
	if (process.platform !== "darwin") return;
	try {
		const libSystem = dlopen("libSystem.B.dylib", {
			setiopolicy_np: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		});
		try {
			libSystem.symbols.setiopolicy_np(
				IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
				IOPOL_SCOPE_PROCESS,
				IOPOL_MATERIALIZE_DATALESS_FILES_ON,
			);
		} finally {
			libSystem.close();
		}
	} catch {
		// bun:ffi or libSystem unavailable: the policy stays as inherited.
	}
}
