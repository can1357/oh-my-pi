#[cfg(any(target_os = "macos", target_os = "linux"))]
mod unix {
	use std::ffi::c_int;

	#[repr(C)]
	struct RLimit {
		rlim_cur: u64,
		rlim_max: u64,
	}

	unsafe extern "C" {
		fn setrlimit(resource: c_int, rlim: *const RLimit) -> c_int;
	}

	pub fn set_rlimit(resource: c_int, limit: u64) {
		let rlim = RLimit { rlim_cur: limit, rlim_max: limit };
		// SAFETY: `rlim` is a valid `RLimit` pointer for the duration of the
		// call.
		unsafe {
			let _ = setrlimit(resource, &rlim);
		}
	}
}

#[cfg(target_os = "macos")]
pub fn apply_os_sandbox(_max_heap_mb: u64) {
	use std::{
		ffi::{c_char, c_int},
		ptr,
	};

	// Darwin resource constants (`sys/resource.h`).
	const RLIMIT_FSIZE: c_int = 1;
	const RLIMIT_CORE: c_int = 4;
	const RLIMIT_NOFILE: c_int = 8;

	unix::set_rlimit(RLIMIT_CORE, 0);
	unix::set_rlimit(RLIMIT_FSIZE, 0);
	unix::set_rlimit(RLIMIT_NOFILE, 32);

	unsafe extern "C" {
		fn sandbox_init(profile: *const c_char, flags: u64, errorbuf: *mut *mut c_char) -> c_int;
		fn sandbox_free_error(errorbuf: *mut c_char);
	}

	// Deny all filesystem, network, and process-exec operations after V8
	// startup.
	const PROFILE: &std::ffi::CStr = c"(version 1)
(deny default)
(allow process-info* (target self))
(allow sysctl-read)
(allow mach-priv-host-port)";

	let mut err_buf: *mut c_char = ptr::null_mut();
	// SAFETY: `PROFILE` is a valid NUL-terminated Seatbelt profile and `err_buf`
	// is freed with `sandbox_free_error` when non-null.
	unsafe {
		let rc = sandbox_init(PROFILE.as_ptr(), 0, &mut err_buf);
		if rc != 0 && !err_buf.is_null() {
			sandbox_free_error(err_buf);
		}
	}
}

#[cfg(target_os = "linux")]
pub fn apply_os_sandbox(_max_heap_mb: u64) {
	use std::ffi::{c_int, c_long, c_ulong};

	// Linux resource constants (`asm-generic/resource.h`).
	const RLIMIT_FSIZE: c_int = 1;
	const RLIMIT_CORE: c_int = 4;
	const RLIMIT_NOFILE: c_int = 7;

	const PR_SET_NO_NEW_PRIVS: c_int = 38;
	const SYS_LANDLOCK_CREATE_RULESET: c_long = 444;
	const SYS_LANDLOCK_RESTRICT_SELF: c_long = 446;
	const LANDLOCK_ACCESS_FS_ABI_V1: u64 = 0x1fff;

	#[repr(C)]
	struct LandlockRulesetAttr {
		handled_access_fs: u64,
	}

	unsafe extern "C" {
		fn prctl(option: c_int, arg2: c_ulong, arg3: c_ulong, arg4: c_ulong, arg5: c_ulong) -> c_int;
		fn syscall(number: c_long, ...) -> c_long;
		fn close(fd: c_int) -> c_int;
	}

	unix::set_rlimit(RLIMIT_CORE, 0);
	unix::set_rlimit(RLIMIT_FSIZE, 0);
	unix::set_rlimit(RLIMIT_NOFILE, 32);

	// SAFETY: `prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)` is required before
	// Landlock.
	unsafe {
		if prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
			return;
		}
		let attr = LandlockRulesetAttr { handled_access_fs: LANDLOCK_ACCESS_FS_ABI_V1 };
		let ruleset_fd = syscall(
			SYS_LANDLOCK_CREATE_RULESET,
			&attr as *const LandlockRulesetAttr,
			std::mem::size_of::<LandlockRulesetAttr>(),
			0usize,
		);
		if ruleset_fd >= 0 {
			let _ = syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd as c_int, 0usize);
			let _ = close(ruleset_fd as c_int);
		}
	}
}

#[cfg(windows)]
pub fn apply_os_sandbox(max_heap_mb: u64) {
	use std::{ffi::c_void, mem::size_of, ptr};

	type Handle = *mut c_void;
	type Bool = i32;

	const PROCESS_STRICT_HANDLE_CHECK_POLICY: u32 = 6;
	const PROCESS_FONT_DISABLE_POLICY: u32 = 8;
	const PROCESS_IMAGE_LOAD_POLICY: u32 = 10;
	const PROCESS_CHILD_PROCESS_POLICY: u32 = 15;

	const JOB_OBJECT_BASIC_UI_RESTRICTIONS: u32 = 4;
	const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS: u32 = 9;
	const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0000_0008;
	const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
	const JOB_OBJECT_UILIMIT_ALL: u32 = 0x0000_00ff;

	#[repr(C)]
	#[derive(Default)]
	struct BasicLimitInformation {
		per_process_user_time_limit: i64,
		per_job_user_time_limit:     i64,
		limit_flags:                 u32,
		minimum_working_set_size:    usize,
		maximum_working_set_size:    usize,
		active_process_limit:        u32,
		affinity:                    usize,
		priority_class:              u32,
		scheduling_class:            u32,
	}

	#[repr(C)]
	#[derive(Default)]
	struct IoCounters {
		read_operation_count:  u64,
		write_operation_count: u64,
		other_operation_count: u64,
		read_transfer_count:   u64,
		write_transfer_count:  u64,
		other_transfer_count:  u64,
	}

	#[repr(C)]
	#[derive(Default)]
	struct ExtendedLimitInformation {
		basic_limit_information:  BasicLimitInformation,
		io_info:                  IoCounters,
		process_memory_limit:     usize,
		job_memory_limit:         usize,
		peak_process_memory_used: usize,
		peak_job_memory_used:     usize,
	}

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn GetCurrentProcess() -> Handle;
		fn SetProcessMitigationPolicy(
			policy: u32,
			lp_buffer: *const c_void,
			dw_length: usize,
		) -> Bool;
		fn CreateJobObjectW(lp_job_attributes: *const c_void, lp_name: *const u16) -> Handle;
		fn SetInformationJobObject(
			h_job: Handle,
			job_object_information_class: u32,
			lp_job_object_information: *const c_void,
			cb_job_object_information_length: u32,
		) -> Bool;
		fn AssignProcessToJobObject(h_job: Handle, h_process: Handle) -> Bool;
	}

	// SAFETY: All pointers reference stack-allocated POD structs of matching
	// sizes.
	unsafe {
		let strict_handle: u32 = 0x3;
		let _ = SetProcessMitigationPolicy(
			PROCESS_STRICT_HANDLE_CHECK_POLICY,
			(&raw const strict_handle).cast(),
			size_of::<u32>(),
		);
		let font_disable: u32 = 0x1;
		let _ = SetProcessMitigationPolicy(
			PROCESS_FONT_DISABLE_POLICY,
			(&raw const font_disable).cast(),
			size_of::<u32>(),
		);
		let image_load: u32 = 0x3;
		let _ = SetProcessMitigationPolicy(
			PROCESS_IMAGE_LOAD_POLICY,
			(&raw const image_load).cast(),
			size_of::<u32>(),
		);
		let child_process: u32 = 0x1;
		let _ = SetProcessMitigationPolicy(
			PROCESS_CHILD_PROCESS_POLICY,
			(&raw const child_process).cast(),
			size_of::<u32>(),
		);

		let job = CreateJobObjectW(ptr::null(), ptr::null());
		if !job.is_null() {
			let mut ext = ExtendedLimitInformation::default();
			ext.basic_limit_information.limit_flags =
				JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
			ext.basic_limit_information.active_process_limit = 1;
			ext.process_memory_limit =
				(max_heap_mb.saturating_add(256) as usize).saturating_mul(1024 * 1024);
			let _ = SetInformationJobObject(
				job,
				JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS,
				(&raw const ext).cast(),
				size_of::<ExtendedLimitInformation>() as u32,
			);
			let ui_restrictions: u32 = JOB_OBJECT_UILIMIT_ALL;
			let _ = SetInformationJobObject(
				job,
				JOB_OBJECT_BASIC_UI_RESTRICTIONS,
				(&raw const ui_restrictions).cast(),
				size_of::<u32>() as u32,
			);
			let _ = AssignProcessToJobObject(job, GetCurrentProcess());
		}
	}
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn apply_os_sandbox(_max_heap_mb: u64) {}
