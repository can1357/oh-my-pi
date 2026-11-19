/**
 * Scheduling class of omp's main thread on macOS.
 *
 * macOS schedules a thread by its QoS class. A process started by an app (a
 * terminal, a terminal's session daemon) rather than by Launch Services
 * takes the app's type but not its role, and macOS runs every thread of a
 * role-less app at most in the default class: the class compilers run in.
 * Asking for a higher class changes nothing, so on a busy machine omp's JS
 * thread shares cores with the build, and startup, typing and redraws crawl.
 *
 * {@link raiseInteractiveQos} puts the calling thread in the user-initiated
 * class and gives the process the default app role, which has no cap.
 * Neither reaches child processes: a build omp runs starts role-less and
 * capped as before.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";

/** `QOS_CLASS_USER_INITIATED`: work the user is waiting on. */
const QOS_CLASS_USER_INITIATED = 0x19;
/** `TASK_CATEGORY_POLICY`: the task's role, one integer. */
const TASK_CATEGORY_POLICY = 1;
/** `TASK_UNSPECIFIED`: no role, as every process starts. */
const TASK_UNSPECIFIED = 0;
/** `TASK_DEFAULT_APPLICATION`: an app that may or may not be in front. */
const TASK_DEFAULT_APPLICATION = 7;

/**
 * Run the calling thread in macOS's user-initiated QoS class, lifting the
 * default-class cap of a role-less app process. For the main thread of the
 * process a user waits on, early in startup; worker processes keep the
 * default class.
 *
 * Never throws: off macOS, or when libSystem's symbols cannot load, the
 * thread keeps its class.
 */
export function raiseInteractiveQos(): void {
	if (process.platform !== "darwin") return;
	try {
		const libSystem = dlopen("libSystem.B.dylib", {
			pthread_set_qos_class_self_np: { args: [FFIType.u32, FFIType.i32], returns: FFIType.i32 },
			// `mach_task_self()` is a macro over a data symbol bun:ffi cannot
			// read; the trap answers the same port name (one more reference).
			task_self_trap: { args: [], returns: FFIType.u32 },
			task_policy_get: {
				args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr],
				returns: FFIType.i32,
			},
			task_policy_set: { args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		});
		try {
			const lib = libSystem.symbols;
			// First: once the cap is gone, a main thread whose class was never
			// set runs as user-interactive, the class of a window's drawing.
			lib.pthread_set_qos_class_self_np(QOS_CLASS_USER_INITIATED, 0);
			const task = lib.task_self_trap();
			const role = new Int32Array([TASK_UNSPECIFIED]);
			const count = new Uint32Array([1]);
			// False: the role the task has, not the one it would start with.
			const getDefault = new Int32Array(1);
			if (lib.task_policy_get(task, TASK_CATEGORY_POLICY, ptr(role), ptr(count), ptr(getDefault)) !== 0) return;
			// A role the system gave (Launch Services, RunningBoard) stays.
			if (role[0] !== TASK_UNSPECIFIED) return;
			role[0] = TASK_DEFAULT_APPLICATION;
			lib.task_policy_set(task, TASK_CATEGORY_POLICY, ptr(role), 1);
		} finally {
			libSystem.close();
		}
	} catch {
		// bun:ffi or libSystem unavailable: the thread keeps its class.
	}
}
