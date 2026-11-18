import { dlopen, FFIType } from "bun:ffi";

/**
 * Windows Job Object containment for a session-owned process tree.
 *
 * A job created here carries KILL_ON_JOB_CLOSE: when the last handle closes —
 * including the owner dying without cleanup — the kernel terminates every
 * process in the job, and every descendant inherits it. This is the only
 * reliable way to reap a detached process on Windows: `Bun.spawn` already
 * job-contains non-detached children, but `detached: true` children escape.
 *
 * No-op off Windows and when kernel32 is unavailable; callers must treat
 * `create()` returning `undefined` as "containment unavailable" and keep the
 * current behavior.
 */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_TERMINATE = 0x0001;
/** JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64: Basic(64) + IoCounters(48) + 4 pointers. */
const JOB_INFO_SIZE = 144;
/** BasicLimitInformation.LimitFlags offset inside the extended struct. */
const JOB_LIMIT_FLAGS_OFFSET = 16;

interface Kernel32 {
	CreateJobObjectW: (attributes: null, name: null) => unknown;
	SetInformationJobObject: (job: unknown, infoClass: number, info: Uint8Array, length: number) => number;
	AssignProcessToJobObject: (job: unknown, process: unknown) => number;
	OpenProcess: (access: number, inherit: number, pid: number) => unknown;
	CloseHandle: (handle: unknown) => number;
	TerminateJobObject: (job: unknown, exitCode: number) => number;
	GetLastError: () => number;
}

let kernel32: Kernel32 | undefined;

function loadKernel32(): Kernel32 | undefined {
	if (process.platform !== "win32") return undefined;
	if (kernel32) return kernel32;
	const { symbols } = dlopen("kernel32.dll", {
		CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
		SetInformationJobObject: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
	kernel32 = symbols as unknown as Kernel32;
	return kernel32;
}

export class WindowsJob {
	readonly #api: Kernel32;
	readonly #handle: unknown;
	#closed = false;

	private constructor(api: Kernel32, handle: unknown) {
		this.#api = api;
		this.#handle = handle;
	}

	/** Create a kill-on-close job; undefined when unsupported (non-Windows) or creation fails. */
	static create(): WindowsJob | undefined {
		const api = loadKernel32();
		if (!api) return undefined;
		const handle = api.CreateJobObjectW(null, null);
		if (!handle) return undefined;
		const job = new WindowsJob(api, handle);
		try {
			job.#applyLimits();
		} catch {
			api.CloseHandle(handle);
			return undefined;
		}
		return job;
	}

	#applyLimits(): void {
		const limits = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
		const info = new Uint8Array(JOB_INFO_SIZE);
		new DataView(info.buffer).setUint32(JOB_LIMIT_FLAGS_OFFSET, limits, true);
		if (
			!this.#api.SetInformationJobObject(this.#handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, info, JOB_INFO_SIZE)
		) {
			throw new Error(`SetInformationJobObject failed (${this.#api.GetLastError()})`);
		}
	}

	/**
	 * Put an already-spawned process (and everything it spawns afterwards) in the job.
	 * Fails with the Win32 error when the OS refuses, e.g. under an outer job that
	 * forbids nesting; callers must fall back to uncontained behavior.
	 */
	assign(pid: number): { ok: true } | { ok: false; error: number } {
		if (this.#closed) return { ok: false, error: 6 /* ERROR_INVALID_HANDLE */ };
		const processHandle = this.#api.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
		if (!processHandle) return { ok: false, error: this.#api.GetLastError() };
		try {
			const assigned = this.#api.AssignProcessToJobObject(this.#handle, processHandle);
			return assigned ? { ok: true } : { ok: false, error: this.#api.GetLastError() };
		} finally {
			this.#api.CloseHandle(processHandle);
		}
	}

	/** Terminate every process in the job now. */
	kill(exitCode = 1): boolean {
		return !this.#closed && !!this.#api.TerminateJobObject(this.#handle, exitCode);
	}

	/**
	 * Close the job handle. Idempotent: Windows recycles handle values, so a second
	 * close could otherwise release an unrelated object. With KILL_ON_JOB_CLOSE this
	 * also terminates every process still in the job.
	 */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#api.CloseHandle(this.#handle);
	}
}
