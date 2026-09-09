use std::{
	ffi::{OsStr, OsString},
	fs, io,
	path::{Path, PathBuf},
};

#[cfg(windows)]
use super::windows_acl::AclMutationStack;
use crate::{
	Backend, BackendStatus, CleanupFailure, Plan, ProbeFailure, RunOptions, RunOutput, SandboxError,
	SandboxOperation, SandboxSpec, WriteMode,
	backends::appcontainer::{CapabilitySid, capability_sids},
};
#[cfg(windows)]
use crate::{CleanupFailures, OutputMode, RunFailure, SandboxExit, SandboxInput};

/// Secret-bearing state for the in-process backend. It never enters Plan argv
/// or profile text and owns the private workspace until the run is reaped.
pub(crate) struct AppContainerPrepared {
	pub(crate) profile_name:     String,
	pub(crate) program:          PathBuf,
	pub(crate) args:             Vec<OsString>,
	pub(crate) work_dir:         Option<PathBuf>,
	pub(crate) capability_sids:  Vec<CapabilitySid>,
	pub(crate) read_deny:        Vec<PathBuf>,
	pub(crate) write_deny:       Vec<PathBuf>,
	pub(crate) read_grants:      Vec<PathBuf>,
	pub(crate) write_grants:     Vec<PathBuf>,
	pub(crate) child_restricted: bool,
	pub(crate) cpu_cores:        Option<f64>,
	pub(crate) memory_bytes:     Option<u64>,
	pub(crate) pids:             Option<u32>,
	pub(crate) environment:      Option<Vec<u16>>,
	workspace:                   Option<tempfile::TempDir>,
}

/// Materializes the environment and optional full-byte workspace copy. The
/// per-run name is derive-only: no persistent AppContainer profile is created.
pub(crate) fn prepare(
	plan: &Plan,
	spec: &SandboxSpec,
) -> Result<AppContainerPrepared, SandboxError> {
	let program = plan
		.argv()
		.first()
		.map(|program| PathBuf::from(program.as_os_str()))
		.ok_or(SandboxError::EmptyPlanArgv { backend: Backend::AppContainer })?;
	let mut workspace = None;
	let mut work_dir = spec.dir.clone();
	if work_dir.is_none() && spec.readable.is_empty() {
		work_dir = Some(std::env::current_dir().map_err(|source| SandboxError::BackendIo {
			backend: Backend::AppContainer,
			operation: SandboxOperation::Prepare,
			source,
		})?);
	}
	let mut read_grants = dedup_paths(
		std::iter::once(program.clone())
			.chain(spec.readable.iter().cloned())
			.chain(work_dir.iter().cloned()),
	);
	let mut write_grants = spec.writable.clone();

	if spec.write == WriteMode::Ephemeral {
		let source = match &spec.dir {
			Some(dir) => dir.clone(),
			None => std::env::current_dir().map_err(|source| SandboxError::BackendIo {
				backend: Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				source,
			})?,
		};
		let temp = tempfile::Builder::new()
			.prefix("omp-appcontainer-")
			.tempdir()
			.map_err(|error| SandboxError::BackendPath {
				backend:   Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				path:      source.clone(),
				source:    error,
			})?;
		let clone = temp.path().join("workspace");
		copy_workspace(&source, &clone).map_err(|source_error| SandboxError::BackendPath {
			backend:   Backend::AppContainer,
			operation: SandboxOperation::Prepare,
			path:      source,
			source:    source_error,
		})?;
		work_dir = Some(clone.clone());
		read_grants.push(clone.clone());
		write_grants.clear();
		write_grants.push(clone);
		workspace = Some(temp);
	} else if spec.allow_temp {
		for path in temporary_roots() {
			if !write_grants.contains(&path) {
				write_grants.push(path);
			}
		}
	}

	Ok(AppContainerPrepared {
		profile_name: unique_profile_name(),
		program,
		args: spec.args.clone(),
		work_dir,
		capability_sids: capability_sids(spec.network),
		read_deny: spec.read_deny.clone(),
		write_deny: spec.write_deny.clone(),
		read_grants,
		write_grants,
		child_restricted: spec.no_exec,
		cpu_cores: spec.resources.cpu_cores(),
		memory_bytes: spec.resources.memory_bytes(),
		pids: spec.resources.pids(),
		environment: environment_block(spec.environment.resolve().as_deref())?,
		workspace,
	})
}

/// Executes through CreateProcessW rather than exposing an external command.
/// Dropping the async future terminates the kill-on-close job; the blocking
/// owner then reaps the process before ACL and workspace cleanup.
pub(crate) async fn run(
	prepared: AppContainerPrepared,
	options: RunOptions,
) -> Result<RunOutput, SandboxError> {
	#[cfg(windows)]
	{
		return windows::run(prepared, options).await;
	}
	#[cfg(not(windows))]
	{
		let _ = (prepared, options);
		Err(SandboxError::BackendIo {
			backend:   Backend::AppContainer,
			operation: SandboxOperation::Launch,
			source:    io::Error::new(io::ErrorKind::Unsupported, "AppContainer requires Windows"),
		})
	}
}

pub(crate) fn probe_appcontainer() -> BackendStatus {
	#[cfg(windows)]
	{
		return windows::probe();
	}
	#[cfg(not(windows))]
	{
		BackendStatus::unavailable(Backend::AppContainer, ProbeFailure::WrongHost {
			backend: Backend::AppContainer,
			os:      std::env::consts::OS,
		})
	}
}

pub(crate) fn environment_block(
	environment: Option<&[OsString]>,
) -> Result<Option<Vec<u16>>, SandboxError> {
	let Some(environment) = environment else {
		return Ok(None);
	};
	let mut entries = environment
		.iter()
		.map(|entry| (environment_key(entry).to_uppercase(), entry))
		.collect::<Vec<_>>();
	entries.sort_by(|left, right| left.0.cmp(&right.0));
	let mut block = Vec::new();
	for (_, entry) in entries {
		let encoded = encode_wide(entry);
		if encoded.contains(&0) {
			return Err(SandboxError::BackendIo {
				backend:   Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				source:    io::Error::new(
					io::ErrorKind::InvalidInput,
					"environment entry contains NUL",
				),
			});
		}
		block.extend(encoded);
		block.push(0);
	}
	if block.is_empty() {
		block.push(0);
	}
	block.push(0);
	Ok(Some(block))
}

fn environment_key(entry: &OsStr) -> String {
	let text = entry.to_string_lossy();
	let index = if text.starts_with('=') {
		text[1..].find('=').map(|index| index + 1)
	} else {
		text.find('=')
	};
	match index {
		Some(index) => text[..index].to_owned(),
		None => text.into_owned(),
	}
}

fn encode_wide(value: &OsStr) -> Vec<u16> {
	#[cfg(windows)]
	{
		use std::os::windows::ffi::OsStrExt as _;
		value.encode_wide().collect()
	}
	#[cfg(not(windows))]
	{
		value.to_string_lossy().encode_utf16().collect()
	}
}

pub(crate) fn compose_command_line(program: &OsStr, args: &[OsString]) -> Vec<u16> {
	let mut line = Vec::new();
	for (index, arg) in std::iter::once(program)
		.chain(args.iter().map(OsString::as_os_str))
		.enumerate()
	{
		if index != 0 {
			line.push(u16::from(b' '));
		}
		quote_windows_arg(&encode_wide(arg), &mut line);
	}
	line.push(0);
	line
}

fn quote_windows_arg(arg: &[u16], output: &mut Vec<u16>) {
	let backslash = u16::from(b'\\');
	let quote = u16::from(b'"');
	if !arg.is_empty()
		&& !arg
			.iter()
			.any(|unit| matches!(*unit, 0x20 | 0x09) || *unit == quote)
	{
		output.extend_from_slice(arg);
		return;
	}
	output.push(quote);
	let mut slashes = 0;
	for &unit in arg {
		if unit == backslash {
			slashes += 1;
			continue;
		}
		if unit == quote {
			output.extend(std::iter::repeat_n(backslash, slashes * 2 + 1));
			output.push(quote);
		} else {
			output.extend(std::iter::repeat_n(backslash, slashes));
			output.push(unit);
		}
		slashes = 0;
	}
	output.extend(std::iter::repeat_n(backslash, slashes * 2));
	output.push(quote);
}

fn unique_profile_name() -> String {
	use std::{
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};
	static NONCE: AtomicU64 = AtomicU64::new(1);
	let clock = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |duration| duration.as_nanos() as u64);
	let nonce = NONCE.fetch_add(1, Ordering::Relaxed);
	let value = clock ^ (u64::from(std::process::id()) << 32) ^ nonce.rotate_left(17);
	format!("omp-{value:016x}")
}

fn temporary_roots() -> Vec<PathBuf> {
	let mut roots = vec![std::env::temp_dir()];
	for variable in ["TEMP", "TMP"] {
		if let Some(path) = std::env::var_os(variable).map(PathBuf::from)
			&& !roots.contains(&path)
		{
			roots.push(path);
		}
	}
	roots
}

fn dedup_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
	let mut result = Vec::new();
	for path in paths {
		if !result.contains(&path) {
			result.push(path);
		}
	}
	result
}

fn copy_workspace(source: &Path, destination: &Path) -> io::Result<()> {
	let metadata = fs::symlink_metadata(source)?;
	if metadata.file_type().is_symlink() {
		return copy_symlink(source, destination, &metadata);
	}
	if metadata.is_file() {
		if let Some(parent) = destination.parent() {
			fs::create_dir_all(parent)?;
		}
		fs::copy(source, destination)?;
		fs::set_permissions(destination, metadata.permissions())?;
		return Ok(());
	}
	if !metadata.is_dir() {
		return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsupported workspace entry type"));
	}
	fs::create_dir(destination)?;
	for entry in fs::read_dir(source)? {
		let entry = entry?;
		copy_workspace(&entry.path(), &destination.join(entry.file_name()))?;
	}
	fs::set_permissions(destination, metadata.permissions())?;
	Ok(())
}

fn copy_symlink(source: &Path, destination: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
	let target = fs::read_link(source)?;
	#[cfg(unix)]
	{
		let _ = _metadata;
		std::os::unix::fs::symlink(target, destination)
	}
	#[cfg(windows)]
	{
		use std::os::windows::fs::{symlink_dir, symlink_file};
		if fs::metadata(source).is_ok_and(|target| target.is_dir()) {
			symlink_dir(target, destination)
		} else {
			symlink_file(target, destination)
		}
	}
	#[cfg(not(any(unix, windows)))]
	{
		let _ = (target, destination, _metadata);
		Err(io::Error::new(io::ErrorKind::Unsupported, "symbolic links are unsupported"))
	}
}

fn cleanup_workspace(prepared: &mut AppContainerPrepared) -> Vec<CleanupFailure> {
	let Some(workspace) = prepared.workspace.take() else {
		return Vec::new();
	};
	let path = workspace.path().to_path_buf();
	match workspace.close() {
		Ok(()) => Vec::new(),
		Err(source) => vec![CleanupFailure::BackendPath {
			backend: Backend::AppContainer,
			operation: SandboxOperation::Cleanup,
			path,
			source,
		}],
	}
}

#[cfg(windows)]
mod windows {
	use std::{
		ffi::c_void,
		fs::File,
		io::{Read as _, Write as _},
		mem::size_of,
		os::windows::io::{FromRawHandle as _, RawHandle},
		ptr,
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::Duration,
	};

	use omp_core::CowBytes;
	use parking_lot::Mutex;
	use windows_sys::{
		Win32::{
			Foundation::{
				CloseHandle, DuplicateHandle, HANDLE, HANDLE_FLAG_INHERIT, WAIT_OBJECT_0, WAIT_TIMEOUT,
			},
			Security::{
				CreateWellKnownSid, FreeSid, PSID, SECURITY_ATTRIBUTES, SECURITY_CAPABILITIES,
				SECURITY_MAX_SID_SIZE, SID_AND_ATTRIBUTES,
			},
			System::{
				Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
				JobObjects::{
					AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
					JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
					JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectCpuRateControlInformation,
					JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
				},
				Pipes::CreatePipe,
				SystemServices::SE_GROUP_ENABLED,
				Threading::{
					CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW,
					EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess, GetExitCodeProcess, INFINITE,
					InitializeProcThreadAttributeList, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
					PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, PROCESS_INFORMATION, ResumeThread,
					STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
					WaitForSingleObject,
				},
			},
		},
		core::{BOOL, PCWSTR},
	};

	use super::*;
	use crate::backends::appcontainer::cpu_rate_hundredths;

	const ATTRIBUTE_CHILD_PROCESS_POLICY: usize = 0x0002_000e;
	const ATTRIBUTE_ALL_APP_PACKAGES_POLICY: usize = 0x0002_000f;
	const CHILD_PROCESS_RESTRICTED: u32 = 1;
	const ALL_APP_PACKAGES_OPT_OUT: u32 = 1;
	const CPU_RATE_CONTROL_ENABLE: u32 = 1;
	const CPU_RATE_CONTROL_HARD_CAP: u32 = 4;
	const DUPLICATE_SAME_ACCESS: u32 = 2;

	#[repr(C)]
	struct JobCpuRateControlInformation {
		control_flags: u32,
		cpu_rate:      u32,
	}

	struct OwnedSid(PSID);

	unsafe impl Send for OwnedSid {}

	impl Drop for OwnedSid {
		fn drop(&mut self) {
			unsafe { FreeSid(self.0) };
		}
	}

	struct OwnedHandle(HANDLE);

	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			if !self.0.is_null() {
				unsafe { CloseHandle(self.0) };
			}
		}
	}

	unsafe impl Send for OwnedHandle {}

	struct CancellationState {
		job:       Mutex<Option<HANDLE>>,
		cancelled: AtomicBool,
		finished:  AtomicBool,
	}

	unsafe impl Send for CancellationState {}
	unsafe impl Sync for CancellationState {}

	struct CancellationGuard(Arc<CancellationState>);

	struct RegisteredJob<'a>(&'a CancellationState);

	impl Drop for RegisteredJob<'_> {
		fn drop(&mut self) {
			*self.0.job.lock() = None;
		}
	}

	impl Drop for CancellationGuard {
		fn drop(&mut self) {
			if self.0.finished.load(Ordering::Acquire) {
				return;
			}
			self.0.cancelled.store(true, Ordering::Release);
			if let Some(job) = *self.0.job.lock() {
				unsafe { TerminateJobObject(job, 1) };
			}
		}
	}

	pub(super) async fn run(
		prepared: AppContainerPrepared,
		options: RunOptions,
	) -> Result<RunOutput, SandboxError> {
		let state = Arc::new(CancellationState {
			job:       Mutex::new(None),
			cancelled: AtomicBool::new(false),
			finished:  AtomicBool::new(false),
		});
		let guard = CancellationGuard(state.clone());
		let result = tokio::task::spawn_blocking(move || run_blocking(prepared, options, &state))
			.await
			.map_err(|source| SandboxError::BackendIo {
				backend:   Backend::AppContainer,
				operation: SandboxOperation::Wait,
				source:    io::Error::other(source),
			})?;
		guard.0.finished.store(true, Ordering::Release);
		drop(guard);
		result
	}

	fn run_blocking(
		mut prepared: AppContainerPrepared,
		options: RunOptions,
		state: &Arc<CancellationState>,
	) -> Result<RunOutput, SandboxError> {
		let sid = match derive_sid(&prepared.profile_name, SandboxOperation::Prepare) {
			Ok(sid) => sid,
			Err(error) => return finish_with_workspace(error, &mut prepared),
		};
		let mut acl = match AclMutationStack::apply(
			sid.0,
			&prepared.read_deny,
			&prepared.write_deny,
			&prepared.read_grants,
			&prepared.write_grants,
		) {
			Ok(acl) => acl,
			Err((error, mut cleanup)) => {
				cleanup.extend(cleanup_workspace(&mut prepared));
				return if cleanup.is_empty() {
					Err(error)
				} else {
					Err(SandboxError::RunAndCleanup {
						backend: Backend::AppContainer,
						run:     run_failure(error),
						cleanup: CleanupFailures::new(cleanup),
					})
				};
			},
		};
		let result = launch_and_wait(&prepared, options, sid.0, state);
		let mut cleanup = acl.cleanup();
		cleanup.extend(cleanup_workspace(&mut prepared));
		match (result, cleanup.is_empty()) {
			(Ok(output), true) => Ok(output),
			(Ok(_), false) => Err(CleanupFailures::new(cleanup).into()),
			(Err(error), false) => Err(SandboxError::RunAndCleanup {
				backend: Backend::AppContainer,
				run:     run_failure(error),
				cleanup: CleanupFailures::new(cleanup),
			}),
			(Err(error), true) => Err(error),
		}
	}

	fn finish_with_workspace(
		error: SandboxError,
		prepared: &mut AppContainerPrepared,
	) -> Result<RunOutput, SandboxError> {
		let cleanup = cleanup_workspace(prepared);
		if cleanup.is_empty() {
			Err(error)
		} else {
			Err(SandboxError::RunAndCleanup {
				backend: Backend::AppContainer,
				run:     run_failure(error),
				cleanup: CleanupFailures::new(cleanup),
			})
		}
	}

	fn run_failure(error: SandboxError) -> RunFailure {
		match error {
			SandboxError::Launch { source, .. } => RunFailure::Launch { source },
			SandboxError::Wait { source, .. } => RunFailure::Wait { source },
			SandboxError::Input { source, .. } => RunFailure::Input { source },
			SandboxError::Output { source, .. } => RunFailure::Output { source },
			SandboxError::Timeout { .. } => RunFailure::Timeout,
			SandboxError::BackendCommand { operation, status, diagnostic, .. } => {
				RunFailure::BackendCommand { operation, status, diagnostic }
			},
			SandboxError::BackendIo { operation, source, .. } => {
				RunFailure::BackendIo { operation, source }
			},
			SandboxError::BackendPath { operation, path, source, .. } => {
				RunFailure::BackendPath { operation, path, source }
			},
			other => RunFailure::BackendIo {
				operation: SandboxOperation::Cleanup,
				source:    io::Error::other(other),
			},
		}
	}

	fn launch_and_wait(
		prepared: &AppContainerPrepared,
		options: RunOptions,
		app_sid: PSID,
		state: &Arc<CancellationState>,
	) -> Result<RunOutput, SandboxError> {
		let mut capability_storage =
			Vec::<[u8; SECURITY_MAX_SID_SIZE as usize]>::with_capacity(prepared.capability_sids.len());
		let mut capability_attrs = Vec::with_capacity(prepared.capability_sids.len());
		for sid in &prepared.capability_sids {
			capability_storage.push([0_u8; SECURITY_MAX_SID_SIZE as usize]);
			let storage = capability_storage
				.last_mut()
				.expect("capability slot was pushed");
			let mut size = SECURITY_MAX_SID_SIZE;
			if unsafe {
				CreateWellKnownSid(
					sid.well_known_type() as i32,
					ptr::null_mut(),
					storage.as_mut_ptr().cast(),
					&mut size,
				)
			} == 0
			{
				return Err(last_error(SandboxOperation::Prepare));
			}
			capability_attrs.push(SID_AND_ATTRIBUTES {
				Sid:        storage.as_mut_ptr().cast(),
				Attributes: SE_GROUP_ENABLED as u32,
			});
		}
		let mut security_capabilities = SECURITY_CAPABILITIES {
			AppContainerSid: app_sid,
			Capabilities:    if capability_attrs.is_empty() {
				ptr::null_mut()
			} else {
				capability_attrs.as_mut_ptr()
			},
			CapabilityCount: capability_attrs.len() as u32,
			Reserved:        0,
		};

		let mut stdio = StdioHandles::new(options.input, options.stdout, options.stderr)?;
		let attribute_count = 3 + u32::from(prepared.child_restricted);
		let mut bytes = 0_usize;
		unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), attribute_count, 0, &mut bytes) };
		let mut attribute_storage = vec![0_usize; bytes.div_ceil(size_of::<usize>())];
		let attributes = attribute_storage.as_mut_ptr().cast();
		if unsafe { InitializeProcThreadAttributeList(attributes, attribute_count, 0, &mut bytes) }
			== 0
		{
			return Err(last_error(SandboxOperation::Prepare));
		}
		let attributes = AttributeList(attributes);
		update_attribute(
			attributes.0,
			PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
			ptr::from_mut(&mut security_capabilities).cast(),
			size_of::<SECURITY_CAPABILITIES>(),
		)?;
		update_attribute(
			attributes.0,
			PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
			stdio.child.as_mut_ptr().cast(),
			stdio.child.len() * size_of::<HANDLE>(),
		)?;
		let mut all_packages = ALL_APP_PACKAGES_OPT_OUT;
		update_attribute(
			attributes.0,
			ATTRIBUTE_ALL_APP_PACKAGES_POLICY,
			ptr::from_mut(&mut all_packages).cast(),
			size_of::<u32>(),
		)?;
		let mut child_policy = CHILD_PROCESS_RESTRICTED;
		if prepared.child_restricted {
			update_attribute(
				attributes.0,
				ATTRIBUTE_CHILD_PROCESS_POLICY,
				ptr::from_mut(&mut child_policy).cast(),
				size_of::<u32>(),
			)?;
		}

		let mut executable = encode_wide(prepared.program.as_os_str());
		executable.push(0);
		let mut command_line = compose_command_line(prepared.program.as_os_str(), &prepared.args);
		let directory = prepared.work_dir.as_ref().map(|path| {
			let mut wide = encode_wide(path.as_os_str());
			wide.push(0);
			wide
		});
		let mut startup = STARTUPINFOEXW::default();
		startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
		startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
		startup.StartupInfo.hStdInput = stdio.child[0];
		startup.StartupInfo.hStdOutput = stdio.child[1];
		startup.StartupInfo.hStdError = stdio.child[2];
		startup.lpAttributeList = attributes.0;
		let mut process = PROCESS_INFORMATION::default();
		let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
		if unsafe {
			CreateProcessW(
				executable.as_ptr(),
				command_line.as_mut_ptr(),
				ptr::null(),
				ptr::null(),
				1,
				flags,
				prepared
					.environment
					.as_ref()
					.map_or(ptr::null(), |block| block.as_ptr().cast()),
				directory.as_ref().map_or(ptr::null(), |dir| dir.as_ptr()),
				&startup.StartupInfo,
				&mut process,
			)
		} == 0
		{
			return Err(last_error(SandboxOperation::Launch));
		}
		drop(attributes);
		drop(attribute_storage);
		drop(capability_attrs);
		drop(capability_storage);
		let process_handle = OwnedHandle(process.hProcess);
		let thread_handle = OwnedHandle(process.hThread);
		stdio.close_child();
		stdio.start_pumps();

		let job = match create_job(prepared, process_handle.0) {
			Ok(job) => job,
			Err(error) => {
				unsafe { TerminateProcess(process_handle.0, 1) };
				let _ = unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
				let _ = stdio.finish_pumps();
				return Err(error);
			},
		};
		{
			let mut current = state.job.lock();
			*current = Some(job.0);
		}
		let _registered_job = RegisteredJob(state);
		if state.cancelled.load(Ordering::Acquire) {
			unsafe { TerminateJobObject(job.0, 1) };
		}
		if unsafe { ResumeThread(thread_handle.0) } == u32::MAX {
			let error = last_error(SandboxOperation::Launch);
			unsafe { TerminateJobObject(job.0, 1) };
			let _ = unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
			let _ = stdio.finish_pumps();
			return Err(error);
		}

		let wait_millis = options.timeout.map(duration_millis).unwrap_or(INFINITE);
		let wait = unsafe { WaitForSingleObject(process_handle.0, wait_millis) };
		let timed_out = wait == WAIT_TIMEOUT;
		if timed_out {
			unsafe { TerminateJobObject(job.0, 1) };
			let reap = unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
			if reap != WAIT_OBJECT_0 {
				let error = last_error(SandboxOperation::Wait);
				let _ = stdio.finish_pumps();
				return Err(error);
			}
		} else if wait != WAIT_OBJECT_0 {
			unsafe { TerminateJobObject(job.0, 1) };
			let _ = unsafe { WaitForSingleObject(process_handle.0, INFINITE) };
			let error = last_error(SandboxOperation::Wait);
			let _ = stdio.finish_pumps();
			return Err(error);
		}
		if !timed_out {
			unsafe { TerminateJobObject(job.0, 1) };
		}
		let mut exit_code = 0_u32;
		if unsafe { GetExitCodeProcess(process_handle.0, &mut exit_code) } == 0 {
			let error = last_error(SandboxOperation::Wait);
			let _ = stdio.finish_pumps();
			return Err(error);
		}
		let (stdout, stderr) = stdio.finish_pumps()?;
		if timed_out {
			return Err(SandboxError::Timeout { backend: Backend::AppContainer });
		}
		Ok(RunOutput {
			exit:   SandboxExit { code: Some(exit_code as i32), signal: None },
			stdout: CowBytes::from(stdout),
			stderr: CowBytes::from(stderr),
		})
	}

	fn create_job(
		prepared: &AppContainerPrepared,
		process: HANDLE,
	) -> Result<OwnedHandle, SandboxError> {
		let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
		if handle.is_null() {
			return Err(last_error(SandboxOperation::Prepare));
		}
		let job = OwnedHandle(handle);
		let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
		limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
		if let Some(memory) = prepared.memory_bytes {
			limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
			limits.JobMemoryLimit = usize::try_from(memory).map_err(|_| SandboxError::BackendIo {
				backend:   Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				source:    io::Error::new(
					io::ErrorKind::InvalidInput,
					"memory limit exceeds the Windows pointer width",
				),
			})?;
		}
		if let Some(pids) = prepared.pids {
			limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
			limits.BasicLimitInformation.ActiveProcessLimit = pids;
		}
		if unsafe {
			SetInformationJobObject(
				job.0,
				JobObjectExtendedLimitInformation,
				ptr::from_ref(&limits).cast(),
				size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
			)
		} == 0
		{
			return Err(last_error(SandboxOperation::Prepare));
		}
		if let Some(cpus) = prepared.cpu_cores {
			let logical = std::thread::available_parallelism().map_or(1, |count| count.get());
			let cpu = JobCpuRateControlInformation {
				control_flags: CPU_RATE_CONTROL_ENABLE | CPU_RATE_CONTROL_HARD_CAP,
				cpu_rate:      cpu_rate_hundredths(cpus, logical),
			};
			if unsafe {
				SetInformationJobObject(
					job.0,
					JobObjectCpuRateControlInformation,
					ptr::from_ref(&cpu).cast(),
					size_of::<JobCpuRateControlInformation>() as u32,
				)
			} == 0
			{
				return Err(last_error(SandboxOperation::Prepare));
			}
		}
		if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
			return Err(last_error(SandboxOperation::Prepare));
		}
		Ok(job)
	}

	struct AttributeList(*mut c_void);

	impl Drop for AttributeList {
		fn drop(&mut self) {
			unsafe { windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList(self.0) };
		}
	}

	fn update_attribute(
		list: *mut c_void,
		attribute: usize,
		value: *const c_void,
		size: usize,
	) -> Result<(), SandboxError> {
		if unsafe {
			UpdateProcThreadAttribute(
				list,
				0,
				attribute,
				value,
				size,
				ptr::null_mut(),
				ptr::null_mut(),
			)
		} == 0
		{
			Err(last_error(SandboxOperation::Prepare))
		} else {
			Ok(())
		}
	}

	struct StdioHandles {
		child:       [HANDLE; 3],
		input:       Option<(File, CowBytes<'static>)>,
		stdout:      Option<File>,
		stderr:      Option<File>,
		input_pump:  Option<thread::JoinHandle<io::Result<()>>>,
		stdout_pump: Option<thread::JoinHandle<io::Result<Vec<u8>>>>,
		stderr_pump: Option<thread::JoinHandle<io::Result<Vec<u8>>>>,
	}

	impl StdioHandles {
		fn new(
			input: SandboxInput,
			stdout: OutputMode,
			stderr: OutputMode,
		) -> Result<Self, SandboxError> {
			let (stdin_child, input) = match input {
				SandboxInput::Bytes(bytes) => {
					let (child, parent) = pipe(true)?;
					(child, Some((parent, bytes)))
				},
				SandboxInput::Inherit => (duplicate(unsafe { GetStdHandle(STD_INPUT_HANDLE) })?, None),
				SandboxInput::Null => (duplicate(null_file(true)?.0)?, None),
			};
			let (stdout_child, stdout_parent) = match output_handle(stdout, STD_OUTPUT_HANDLE) {
				Ok(handles) => handles,
				Err(error) => {
					unsafe { CloseHandle(stdin_child) };
					return Err(error);
				},
			};
			let (stderr_child, stderr_parent) = match output_handle(stderr, STD_ERROR_HANDLE) {
				Ok(handles) => handles,
				Err(error) => {
					unsafe {
						CloseHandle(stdin_child);
						CloseHandle(stdout_child);
					}
					return Err(error);
				},
			};
			Ok(Self {
				child: [stdin_child, stdout_child, stderr_child],
				input,
				stdout: stdout_parent,
				stderr: stderr_parent,
				input_pump: None,
				stdout_pump: None,
				stderr_pump: None,
			})
		}

		fn close_child(&mut self) {
			for handle in &mut self.child {
				if !handle.is_null() {
					unsafe { CloseHandle(*handle) };
					*handle = ptr::null_mut();
				}
			}
		}

		fn start_pumps(&mut self) {
			if let Some((mut writer, bytes)) = self.input.take() {
				self.input_pump = Some(thread::spawn(move || writer.write_all(&bytes)));
			}
			if let Some(mut reader) = self.stdout.take() {
				self.stdout_pump = Some(thread::spawn(move || {
					let mut bytes = Vec::new();
					reader.read_to_end(&mut bytes)?;
					Ok(bytes)
				}));
			}
			if let Some(mut reader) = self.stderr.take() {
				self.stderr_pump = Some(thread::spawn(move || {
					let mut bytes = Vec::new();
					reader.read_to_end(&mut bytes)?;
					Ok(bytes)
				}));
			}
		}

		fn finish_pumps(&mut self) -> Result<(Vec<u8>, Vec<u8>), SandboxError> {
			if let Some(pump) = self.input_pump.take() {
				join_pump(pump, SandboxOperation::Input)?;
			}
			let stdout = match self.stdout_pump.take() {
				Some(pump) => join_pump(pump, SandboxOperation::Output)?,
				None => Vec::new(),
			};
			let stderr = match self.stderr_pump.take() {
				Some(pump) => join_pump(pump, SandboxOperation::Output)?,
				None => Vec::new(),
			};
			Ok((stdout, stderr))
		}
	}

	fn join_pump<T>(
		pump: thread::JoinHandle<io::Result<T>>,
		operation: SandboxOperation,
	) -> Result<T, SandboxError> {
		pump
			.join()
			.map_err(|_| SandboxError::BackendIo {
				backend: Backend::AppContainer,
				operation,
				source: io::Error::other("AppContainer stdio pump panicked"),
			})?
			.map_err(|source| SandboxError::BackendIo {
				backend: Backend::AppContainer,
				operation,
				source,
			})
	}

	impl Drop for StdioHandles {
		fn drop(&mut self) {
			self.close_child();
		}
	}

	fn output_handle(
		mode: OutputMode,
		standard: u32,
	) -> Result<(HANDLE, Option<File>), SandboxError> {
		match mode {
			OutputMode::Capture => {
				let (child, parent) = pipe(false)?;
				Ok((child, Some(parent)))
			},
			OutputMode::Inherit => Ok((duplicate(unsafe { GetStdHandle(standard) })?, None)),
			OutputMode::Null => Ok((duplicate(null_file(false)?.0)?, None)),
		}
	}

	fn pipe(child_reads: bool) -> Result<(HANDLE, File), SandboxError> {
		let attributes = SECURITY_ATTRIBUTES {
			nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
			lpSecurityDescriptor: ptr::null_mut(),
			bInheritHandle:       1,
		};
		let mut read = ptr::null_mut();
		let mut write = ptr::null_mut();
		if unsafe { CreatePipe(&mut read, &mut write, &attributes, 0) } == 0 {
			return Err(last_error(SandboxOperation::Prepare));
		}
		let (child, parent) = if child_reads {
			(read, write)
		} else {
			(write, read)
		};
		if unsafe {
			windows_sys::Win32::Foundation::SetHandleInformation(parent, HANDLE_FLAG_INHERIT, 0)
		} == 0
		{
			unsafe {
				CloseHandle(read);
				CloseHandle(write);
			}
			return Err(last_error(SandboxOperation::Prepare));
		}
		let file = unsafe { File::from_raw_handle(parent as RawHandle) };
		Ok((child, file))
	}

	fn duplicate(source: HANDLE) -> Result<HANDLE, SandboxError> {
		let mut duplicate = ptr::null_mut();
		if source.is_null()
			|| unsafe {
				DuplicateHandle(
					GetCurrentProcess(),
					source,
					GetCurrentProcess(),
					&mut duplicate,
					0,
					1,
					DUPLICATE_SAME_ACCESS,
				)
			} == 0
		{
			return Err(last_error(SandboxOperation::Prepare));
		}
		Ok(duplicate)
	}

	fn null_file(read: bool) -> Result<OwnedHandle, SandboxError> {
		use std::os::windows::io::IntoRawHandle as _;
		let file = if read {
			File::open("NUL")
		} else {
			File::options().write(true).open("NUL")
		}
		.map_err(|source| SandboxError::BackendIo {
			backend: Backend::AppContainer,
			operation: SandboxOperation::Prepare,
			source,
		})?;
		Ok(OwnedHandle(file.into_raw_handle() as HANDLE))
	}

	fn derive_sid(name: &str, operation: SandboxOperation) -> Result<OwnedSid, SandboxError> {
		let library = UserEnv::load(operation)?;
		let name = OsString::from(name);
		let mut wide = encode_wide(&name);
		wide.push(0);
		let mut sid = ptr::null_mut();
		let status = unsafe { (library.derive)(wide.as_ptr(), &mut sid) };
		if status != 0 || sid.is_null() {
			return Err(SandboxError::BackendIo {
				backend: Backend::AppContainer,
				operation,
				source: io::Error::from_raw_os_error(status),
			});
		}
		Ok(OwnedSid(sid))
	}

	struct UserEnv {
		module: *mut c_void,
		derive: unsafe extern "system" fn(PCWSTR, *mut PSID) -> i32,
	}

	impl UserEnv {
		fn load(operation: SandboxOperation) -> Result<Self, SandboxError> {
			let module = unsafe { LoadLibraryWRaw(windows_sys::core::w!("userenv.dll")) };
			if module.is_null() {
				return Err(last_error(operation));
			}
			let address = unsafe {
				GetProcAddressRaw(module, b"DeriveAppContainerSidFromAppContainerName\0".as_ptr())
			};
			if address.is_null() {
				unsafe { FreeLibraryRaw(module) };
				return Err(last_error(operation));
			}
			Ok(Self { module, derive: unsafe { std::mem::transmute(address) } })
		}
	}

	impl Drop for UserEnv {
		fn drop(&mut self) {
			unsafe { FreeLibraryRaw(self.module) };
		}
	}

	#[link(name = "kernel32")]
	unsafe extern "system" {
		#[link_name = "LoadLibraryW"]
		fn LoadLibraryWRaw(name: PCWSTR) -> *mut c_void;
		#[link_name = "GetProcAddress"]
		fn GetProcAddressRaw(module: *mut c_void, name: *const u8) -> *mut c_void;
		#[link_name = "FreeLibrary"]
		fn FreeLibraryRaw(module: *mut c_void) -> BOOL;
	}

	pub(super) fn probe() -> BackendStatus {
		match derive_sid(&unique_profile_name(), SandboxOperation::Probe).and_then(|_| {
			let mut storage = [0_u8; SECURITY_MAX_SID_SIZE as usize];
			let mut size = SECURITY_MAX_SID_SIZE;
			if unsafe {
				CreateWellKnownSid(85, ptr::null_mut(), storage.as_mut_ptr().cast(), &mut size)
			} == 0
			{
				Err(last_error(SandboxOperation::Probe))
			} else {
				Ok(())
			}
		}) {
			Ok(()) => BackendStatus::available(Backend::AppContainer),
			Err(SandboxError::BackendIo { source, .. }) => {
				BackendStatus::unavailable(Backend::AppContainer, ProbeFailure::Start {
					backend: Backend::AppContainer,
					operation: SandboxOperation::Probe,
					source,
				})
			},
			Err(_) => BackendStatus::unavailable(Backend::AppContainer, ProbeFailure::Start {
				backend:   Backend::AppContainer,
				operation: SandboxOperation::Probe,
				source:    io::Error::other("AppContainer API probe failed"),
			}),
		}
	}

	fn last_error(operation: SandboxOperation) -> SandboxError {
		SandboxError::BackendIo {
			backend: Backend::AppContainer,
			operation,
			source: io::Error::last_os_error(),
		}
	}

	fn duration_millis(duration: Duration) -> u32 {
		duration.as_millis().min(u128::from(u32::MAX - 1)) as u32
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn profile_names_are_unique_per_prepare() {
		let first = unique_profile_name();
		let second = unique_profile_name();
		assert!(first.starts_with("omp-"));
		assert_ne!(first, second);
	}

	#[test]
	fn environment_is_sorted_and_double_nul_terminated() {
		let entries = [OsString::from("z=last"), OsString::from("A=first")];
		let block = environment_block(Some(&entries)).unwrap().unwrap();
		let expected = "A=first\0z=last\0\0".encode_utf16().collect::<Vec<_>>();
		assert_eq!(block, expected);
	}

	#[test]
	fn explicit_empty_environment_is_not_inherit() {
		assert_eq!(environment_block(None).unwrap(), None);
		assert_eq!(environment_block(Some(&[])).unwrap(), Some(vec![0, 0]));
	}

	#[test]
	fn workspace_copy_is_private() {
		let source = tempfile::tempdir().unwrap();
		std::fs::write(source.path().join("file"), b"original").unwrap();
		let destination_parent = tempfile::tempdir().unwrap();
		let destination = destination_parent.path().join("workspace");
		copy_workspace(source.path(), &destination).unwrap();
		std::fs::write(destination.join("file"), b"changed").unwrap();
		assert_eq!(std::fs::read(source.path().join("file")).unwrap(), b"original");
		assert_eq!(std::fs::read(destination.join("file")).unwrap(), b"changed");
	}

	#[test]
	fn command_line_uses_windows_backslash_quote_rules() {
		let line = compose_command_line(OsStr::new(r"C:\Program Files\probe.exe"), &[
			OsString::from(r#"a\"b"#),
			OsString::from(""),
		]);
		let text = String::from_utf16(&line[..line.len() - 1]).unwrap();
		assert_eq!(text, r#""C:\Program Files\probe.exe" "a\\\"b" """#);
	}
}
