#[cfg(target_os = "linux")]
use std::ffi::OsStr;
use std::{ffi::OsString, path::Path};
#[cfg(target_os = "linux")]
use std::{
	fs::{self, File},
	io::{self, Read as _, Write},
	net::{Ipv4Addr, TcpListener, TcpStream},
	os::{
		fd::{AsRawFd as _, FromRawFd as _},
		unix::net::UnixStream,
	},
	path::PathBuf,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	thread,
	time::Duration,
};

#[cfg(target_os = "linux")]
use tempfile::{Builder, NamedTempFile};

use crate::{
	Backend, BackendStatus, Capability, CapabilitySet, Caveat, DegradationPolicy, NetworkMode, Plan,
	ProbeFailure, SandboxError, SandboxOperation, SandboxSpec, runner::PreparedSandbox,
};
#[cfg(target_os = "linux")]
use crate::{
	WriteMode,
	paths::{insert_path, os_string_bytes, temp_roots},
	runner::{COMMAND_WRAPPER_PLACEHOLDER, PreparedResource},
};

/// Hidden same-binary child role which installs Linux confinement before exec.
///
/// Embedding binaries using [`crate::CommandWrapper`] must dispatch this
/// argument to [`run_child_entry`] before launching untrusted work. Its
/// stable argv contract is `HIDDEN_CHILD_ARG BPF_PATH [--landlock POLICY_PATH]
/// [--proxy-relay BROKER_UDS PORT] -- PROGRAM ARGS...`.
pub const HIDDEN_CHILD_ARG: &str = "--omp-sandbox-child";

pub const BPF_PLACEHOLDER: &str = "@omp-sandbox-bpf@";
pub const POLICY_PLACEHOLDER: &str = "@omp-sandbox-landlock-policy@";
#[cfg(target_os = "linux")]
const POLICY_MAGIC: &[u8; 8] = b"OMPLL\0\0\x01";
#[cfg(target_os = "linux")]
const MIN_ABI: u32 = 5;
#[cfg(target_os = "linux")]
const RELAY_READY_TIMEOUT: Duration = Duration::from_secs(5);

const LANDLOCK_CAPABILITIES: CapabilitySet = CapabilitySet::one(Capability::EnvScrub)
	.union(CapabilitySet::one(Capability::FsReadHost))
	.union(CapabilitySet::one(Capability::FsReadScope))
	.union(CapabilitySet::one(Capability::FsWriteDeny))
	.union(CapabilitySet::one(Capability::FsWriteScope))
	.union(CapabilitySet::one(Capability::NetDisable))
	.union(CapabilitySet::one(Capability::NetEnable))
	.union(CapabilitySet::one(Capability::NetOutbound));

pub const fn capabilities() -> CapabilitySet {
	LANDLOCK_CAPABILITIES
}

pub fn compile(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	mut enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	if !spec.unix_sockets.is_empty() {
		return Err(SandboxError::EnforcementUnavailable {
			backend:   Backend::Landlock,
			authority: "Unix-domain socket path grants",
		});
	}
	let mut unavailable = requested.difference(LANDLOCK_CAPABILITIES);
	if spec.network == NetworkMode::Disabled && !spec.unix_sockets.is_empty() {
		enforced = enforced.difference(CapabilitySet::one(Capability::NetDisable));
		unavailable = unavailable.union(CapabilitySet::one(Capability::NetDisable));
	}
	if !spec.write_deny.is_empty() {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsWriteDeny));
		unavailable = unavailable.union(CapabilitySet::one(Capability::FsWriteDeny));
	}
	if spec.degradation == DegradationPolicy::Reject {
		let fatal = unavailable.difference(spec.tolerated);
		if !fatal.is_empty() {
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::Landlock,
				missing: fatal,
			});
		}
	}

	let helper = std::env::current_exe().map_err(|source| SandboxError::BackendIo {
		backend: Backend::Landlock,
		operation: SandboxOperation::Compile,
		source,
	})?;
	let argv = std::iter::once(helper.into_os_string())
		.chain([
			OsString::from(HIDDEN_CHILD_ARG),
			OsString::from(BPF_PLACEHOLDER),
			OsString::from("--landlock"),
			OsString::from(POLICY_PLACEHOLDER),
			OsString::from("--"),
			program.as_os_str().to_owned(),
		])
		.chain(spec.args.iter().cloned())
		.collect();
	let mut plan = Plan::new(Backend::Landlock, requested, enforced, argv, true);
	plan.add_caveat(Caveat::general(
		"Landlock does not create PID or mount namespaces; host /proc remains visible subject to \
		 filesystem rules",
	));
	plan.add_caveat(Caveat::general(
		"Landlock seccomp always denies ptrace, process_vm access, and io_uring, and kill-family \
		 signals",
	));
	if spec.network == NetworkMode::Disabled && !spec.unix_sockets.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::NetDisable,
			"Landlock must permit connect for allowed pathname Unix sockets and cannot distinguish \
			 an inherited Internet socket",
		));
	}
	if !spec.write_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsWriteDeny,
			"Landlock allow rules are additive and cannot subtract a write-deny path nested beneath \
			 a writable root",
		));
	}
	if spec.degradation == DegradationPolicy::AllowCaveats {
		for capability in unavailable.iter() {
			if !plan
				.caveats()
				.iter()
				.any(|caveat| caveat.capability == Some(capability))
			{
				plan.add_caveat(Caveat::capability(
					capability,
					"Landlock cannot enforce this requested capability without namespaces",
				));
			}
		}
	}
	Ok(plan)
}

pub const fn prepare(
	spec: &SandboxSpec,
	prepared: &mut PreparedSandbox,
) -> Result<(), SandboxError> {
	#[cfg(not(target_os = "linux"))]
	{
		let _ = (spec, prepared);
		Err(SandboxError::UnsupportedHost { os: std::env::consts::OS })
	}
	#[cfg(target_os = "linux")]
	{
		let backend = prepared.backend;
		let mode = FilterMode::for_spec(spec);
		let program = compile_filter(mode)?;
		let mut bpf = secure_temp_file("omp-sandbox-bpf-")?;
		write_program(bpf.as_file_mut(), &program).map_err(|source| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: bpf.path().to_path_buf(),
			source,
		})?;
		replace_placeholder(&mut prepared.args, backend, BPF_PLACEHOLDER, bpf.path())?;
		prepared.push_resource(PreparedResource::File(Some(bpf)));

		if prepared
			.args
			.iter()
			.any(|arg| arg == OsStr::new(POLICY_PLACEHOLDER))
		{
			let program = prepared
				.args
				.windows(2)
				.find(|pair| pair[0] == OsStr::new("--"))
				.map(|pair| PathBuf::from(&pair[1]))
				.ok_or(SandboxError::MissingPlanPlaceholder {
					backend,
					placeholder: COMMAND_WRAPPER_PLACEHOLDER,
				})?;
			let mut policy = secure_temp_file("omp-sandbox-landlock-")?;
			write_policy(policy.as_file_mut(), spec, &program).map_err(|source| {
				SandboxError::Artifact {
					operation: SandboxOperation::Prepare,
					path: policy.path().to_path_buf(),
					source,
				}
			})?;
			replace_placeholder(&mut prepared.args, backend, POLICY_PLACEHOLDER, policy.path())?;
			prepared.push_resource(PreparedResource::File(Some(policy)));
		}
		Ok(())
	}
}

#[cfg(target_os = "linux")]
fn replace_placeholder(
	args: &mut [OsString],
	backend: Backend,
	placeholder: &'static str,
	replacement: &Path,
) -> Result<(), SandboxError> {
	let mut found = false;
	for arg in args {
		if arg == OsStr::new(placeholder) {
			*arg = replacement.as_os_str().to_owned();
			found = true;
		}
	}
	if found {
		Ok(())
	} else {
		Err(SandboxError::MissingPlanPlaceholder { backend, placeholder })
	}
}

#[cfg(target_os = "linux")]
fn secure_temp_file(prefix: &str) -> Result<NamedTempFile, SandboxError> {
	let file =
		Builder::new()
			.prefix(prefix)
			.tempfile()
			.map_err(|source| SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: std::env::temp_dir(),
				source,
			})?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		fs::set_permissions(file.path(), fs::Permissions::from_mode(0o600)).map_err(|source| {
			SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: file.path().to_path_buf(),
				source,
			}
		})?;
	}
	Ok(file)
}

#[cfg(target_os = "linux")]
fn write_policy(mut writer: impl Write, spec: &SandboxSpec, program: &Path) -> io::Result<()> {
	writer.write_all(POLICY_MAGIC)?;
	writer.write_all(&[u8::from(spec.readable.is_empty())])?;
	let mut readable = if spec.readable.is_empty() {
		Vec::new()
	} else {
		super::bubblewrap::runtime_closure(program)
	};
	readable.extend(spec.readable.iter().cloned());
	readable.extend(spec.unix_sockets.iter().cloned());
	if let Some(dir) = &spec.dir {
		insert_path(&mut readable, dir.clone());
	}
	let mut writable = if matches!(spec.write, WriteMode::Scoped | WriteMode::Overlay) {
		spec.writable.clone()
	} else {
		Vec::new()
	};
	if spec.allow_temp {
		for root in temp_roots() {
			insert_path(&mut writable, root);
		}
	}
	write_paths(&mut writer, &readable)?;
	write_paths(&mut writer, &writable)
}

#[cfg(target_os = "linux")]
fn write_paths(writer: &mut impl Write, paths: &[PathBuf]) -> io::Result<()> {
	let count = u32::try_from(paths.len())
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many Landlock paths"))?;
	writer.write_all(&count.to_le_bytes())?;
	for path in paths {
		let bytes = os_string_bytes(path.as_os_str());
		let length = u32::try_from(bytes.len())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "Landlock path is too long"))?;
		writer.write_all(&length.to_le_bytes())?;
		writer.write_all(&bytes)?;
	}
	Ok(())
}

/// Returns the running kernel's Landlock ABI, or `None` when unavailable.
#[must_use]
pub const fn abi() -> Option<u32> {
	#[cfg(not(target_os = "linux"))]
	{
		None
	}
	#[cfg(target_os = "linux")]
	{
		// Safety: a null attribute and VERSION flag are the documented ABI query.
		let value = unsafe {
			libc::syscall(
				libc::SYS_landlock_create_ruleset,
				std::ptr::null::<libc::c_void>(),
				0,
				1_u32,
			)
		};
		(value > 0).then_some(value as u32)
	}
}

pub fn probe() -> BackendStatus {
	#[cfg(not(target_os = "linux"))]
	{
		BackendStatus::unavailable(Backend::Landlock, ProbeFailure::WrongHost {
			backend: Backend::Landlock,
			os:      std::env::consts::OS,
		})
	}
	#[cfg(target_os = "linux")]
	{
		match abi() {
			Some(available) if available >= MIN_ABI => BackendStatus::available(Backend::Landlock),
			Some(available) => {
				BackendStatus::unavailable(Backend::Landlock, ProbeFailure::LandlockAbi {
					required: MIN_ABI,
					available,
				})
			},
			None => BackendStatus::unavailable(Backend::Landlock, ProbeFailure::Start {
				backend:   Backend::Landlock,
				operation: SandboxOperation::Probe,
				source:    io::Error::last_os_error(),
			}),
		}
	}
}

/// Applies the hidden-child policy and replaces the helper process image.
///
/// The caller must dispatch this before launching untrusted work. The helper
/// reads an owned BPF artifact, optionally applies an owned Landlock manifest,
/// and then `execve(2)`s the command following the required `--` separator.
pub const fn run_child_entry() -> Result<(), SandboxError> {
	#[cfg(not(target_os = "linux"))]
	{
		Err(SandboxError::UnsupportedHost { os: std::env::consts::OS })
	}
	#[cfg(target_os = "linux")]
	{
		run_child_entry_linux()
	}
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
enum FilterMode {
	DisabledStrict,
	DisabledUnix,
	Enabled,
	Outbound,
	OutboundUnixRestricted,
}

#[cfg(target_os = "linux")]
impl FilterMode {
	fn for_spec(spec: &SandboxSpec) -> Self {
		match (spec.network, spec.unix_sockets.is_empty()) {
			(NetworkMode::Disabled, true) => Self::DisabledStrict,
			(NetworkMode::Disabled, false) => Self::DisabledUnix,
			(NetworkMode::Enabled, _) => Self::Enabled,
			(NetworkMode::Outbound, true) => Self::OutboundUnixRestricted,
			(NetworkMode::Outbound, false) => Self::Outbound,
		}
	}
}

#[cfg(target_os = "linux")]
fn compile_filter(mode: FilterMode) -> Result<seccompiler::BpfProgram, SandboxError> {
	use std::collections::BTreeMap;

	use seccompiler::{
		SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule,
		TargetArch,
	};

	fn deny(rules: &mut BTreeMap<i64, Vec<SeccompRule>>, syscall: i64) {
		rules.insert(syscall, Vec::new());
	}

	let mut rules = BTreeMap::new();
	for syscall in [
		libc::SYS_ptrace,
		libc::SYS_process_vm_readv,
		libc::SYS_process_vm_writev,
		libc::SYS_io_uring_setup,
		libc::SYS_io_uring_enter,
		libc::SYS_io_uring_register,
		libc::SYS_kill,
		libc::SYS_tkill,
		libc::SYS_tgkill,
		libc::SYS_rt_sigqueueinfo,
		libc::SYS_rt_tgsigqueueinfo,
	] {
		deny(&mut rules, syscall);
	}
	deny(&mut rules, libc::SYS_pidfd_send_signal);
	match mode {
		FilterMode::DisabledStrict => {
			let unix_only = SeccompRule::new(vec![
				SeccompCondition::new(
					0,
					SeccompCmpArgLen::Dword,
					SeccompCmpOp::Ne,
					libc::AF_UNIX as u64,
				)
				.map_err(seccompiler::Error::from)?,
			])
			.map_err(seccompiler::Error::from)?;
			rules.insert(libc::SYS_socket, vec![unix_only.clone()]);
			rules.insert(libc::SYS_socketpair, vec![unix_only]);
			for syscall in [
				libc::SYS_connect,
				libc::SYS_accept,
				libc::SYS_accept4,
				libc::SYS_bind,
				libc::SYS_listen,
				libc::SYS_getpeername,
				libc::SYS_getsockname,
				libc::SYS_shutdown,
				libc::SYS_sendto,
				libc::SYS_sendmmsg,
				libc::SYS_recvmmsg,
				libc::SYS_getsockopt,
				libc::SYS_setsockopt,
			] {
				deny(&mut rules, syscall);
			}
		},
		FilterMode::DisabledUnix => {
			let unix_only = SeccompRule::new(vec![
				SeccompCondition::new(
					0,
					SeccompCmpArgLen::Dword,
					SeccompCmpOp::Ne,
					libc::AF_UNIX as u64,
				)
				.map_err(seccompiler::Error::from)?,
			])
			.map_err(seccompiler::Error::from)?;
			rules.insert(libc::SYS_socket, vec![unix_only.clone()]);
			rules.insert(libc::SYS_socketpair, vec![unix_only]);
			for syscall in [
				libc::SYS_accept,
				libc::SYS_accept4,
				libc::SYS_bind,
				libc::SYS_listen,
				libc::SYS_sendto,
			] {
				deny(&mut rules, syscall);
			}
		},
		FilterMode::Outbound => {
			for syscall in [libc::SYS_accept, libc::SYS_accept4, libc::SYS_bind, libc::SYS_listen] {
				deny(&mut rules, syscall);
			}
		},
		FilterMode::OutboundUnixRestricted => {
			let unix_socket = SeccompRule::new(vec![
				SeccompCondition::new(
					0,
					SeccompCmpArgLen::Dword,
					SeccompCmpOp::Eq,
					libc::AF_UNIX as u64,
				)
				.map_err(seccompiler::Error::from)?,
			])
			.map_err(seccompiler::Error::from)?;
			let unix_socketpair_only = SeccompRule::new(vec![
				SeccompCondition::new(
					0,
					SeccompCmpArgLen::Dword,
					SeccompCmpOp::Ne,
					libc::AF_UNIX as u64,
				)
				.map_err(seccompiler::Error::from)?,
			])
			.map_err(seccompiler::Error::from)?;
			rules.insert(libc::SYS_socket, vec![unix_socket]);
			rules.insert(libc::SYS_socketpair, vec![unix_socketpair_only]);
			for syscall in [libc::SYS_accept, libc::SYS_accept4, libc::SYS_bind, libc::SYS_listen] {
				deny(&mut rules, syscall);
			}
		},
		FilterMode::Enabled => {},
	}
	let arch = TargetArch::try_from(std::env::consts::ARCH).map_err(seccompiler::Error::from)?;
	let filter = SeccompFilter::new(
		rules,
		SeccompAction::Allow,
		SeccompAction::Errno(libc::EPERM as u32),
		arch,
	)
	.map_err(seccompiler::Error::from)?;
	filter
		.try_into()
		.map_err(seccompiler::Error::from)
		.map_err(Into::into)
}

#[cfg(target_os = "linux")]
fn compile_relay_filter() -> Result<seccompiler::BpfProgram, SandboxError> {
	use std::collections::BTreeMap;

	use seccompiler::{
		SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter, SeccompRule,
		TargetArch,
	};

	fn deny(rules: &mut BTreeMap<i64, Vec<SeccompRule>>, syscall: i64) {
		rules.insert(syscall, Vec::new());
	}

	let mut rules = BTreeMap::new();
	for syscall in [
		libc::SYS_ptrace,
		libc::SYS_process_vm_readv,
		libc::SYS_process_vm_writev,
		libc::SYS_io_uring_setup,
		libc::SYS_io_uring_enter,
		libc::SYS_io_uring_register,
		libc::SYS_kill,
		libc::SYS_tkill,
		libc::SYS_tgkill,
		libc::SYS_rt_sigqueueinfo,
		libc::SYS_rt_tgsigqueueinfo,
		libc::SYS_pidfd_send_signal,
		libc::SYS_execve,
		libc::SYS_execveat,
		libc::SYS_openat,
		libc::SYS_openat2,
		libc::SYS_unlinkat,
		libc::SYS_renameat,
		libc::SYS_renameat2,
		libc::SYS_mkdirat,
		libc::SYS_linkat,
		libc::SYS_symlinkat,
		libc::SYS_mknodat,
		libc::SYS_ftruncate,
		libc::SYS_fchmod,
		libc::SYS_fchown,
		libc::SYS_fchownat,
		libc::SYS_utimensat,
		libc::SYS_setxattr,
		libc::SYS_lsetxattr,
		libc::SYS_fsetxattr,
		libc::SYS_removexattr,
		libc::SYS_lremovexattr,
		libc::SYS_fremovexattr,
		libc::SYS_bind,
		libc::SYS_listen,
		libc::SYS_socketpair,
	] {
		deny(&mut rules, syscall);
	}
	// Legacy path syscalls exist only on the x86 Linux ABI. The modern `*at`
	// variants above cover architectures such as aarch64 that intentionally
	// expose no `SYS_open`/`SYS_unlink` constants.
	#[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
	for syscall in [
		libc::SYS_open,
		libc::SYS_creat,
		libc::SYS_unlink,
		libc::SYS_rename,
		libc::SYS_mkdir,
		libc::SYS_rmdir,
		libc::SYS_link,
		libc::SYS_symlink,
		libc::SYS_mknod,
		libc::SYS_truncate,
		libc::SYS_chmod,
		libc::SYS_fchmodat,
		libc::SYS_chown,
		libc::SYS_lchown,
		libc::SYS_utime,
		libc::SYS_utimes,
	] {
		deny(&mut rules, syscall);
	}
	let unix_only = SeccompRule::new(vec![
		SeccompCondition::new(0, SeccompCmpArgLen::Dword, SeccompCmpOp::Ne, libc::AF_UNIX as u64)
			.map_err(seccompiler::Error::from)?,
	])
	.map_err(seccompiler::Error::from)?;
	rules.insert(libc::SYS_socket, vec![unix_only]);
	let arch = TargetArch::try_from(std::env::consts::ARCH).map_err(seccompiler::Error::from)?;
	let filter = SeccompFilter::new(
		rules,
		SeccompAction::Allow,
		SeccompAction::Errno(libc::EPERM as u32),
		arch,
	)
	.map_err(seccompiler::Error::from)?;
	filter
		.try_into()
		.map_err(seccompiler::Error::from)
		.map_err(Into::into)
}

#[cfg(target_os = "linux")]
fn write_program(writer: &mut impl Write, program: &seccompiler::BpfProgram) -> io::Result<()> {
	for instruction in program {
		writer.write_all(&instruction.code.to_le_bytes())?;
		writer.write_all(&[instruction.jt, instruction.jf])?;
		writer.write_all(&instruction.k.to_le_bytes())?;
	}
	Ok(())
}

#[cfg(target_os = "linux")]
fn read_program(path: &Path) -> Result<seccompiler::BpfProgram, SandboxError> {
	let bytes = fs::read(path).map_err(|source| SandboxError::Artifact {
		operation: SandboxOperation::Launch,
		path: path.to_path_buf(),
		source,
	})?;
	if bytes.is_empty() || bytes.len() % 8 != 0 {
		return Err(SandboxError::Artifact {
			operation: SandboxOperation::Launch,
			path:      path.to_path_buf(),
			source:    io::Error::new(io::ErrorKind::InvalidData, "invalid seccomp BPF artifact"),
		});
	}
	Ok(bytes
		.chunks_exact(8)
		.map(|chunk| seccompiler::sock_filter {
			code: u16::from_le_bytes([chunk[0], chunk[1]]),
			jt:   chunk[2],
			jf:   chunk[3],
			k:    u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
		})
		.collect())
}

#[cfg(target_os = "linux")]
fn run_child_entry_linux() -> Result<(), SandboxError> {
	use std::os::unix::process::CommandExt as _;

	let mut args = std::env::args_os().skip(2);
	let bpf_path = args
		.next()
		.ok_or(SandboxError::InvalidSandboxChildArguments)?;
	let program = read_program(Path::new(&bpf_path))?;
	let next = args
		.next()
		.ok_or(SandboxError::InvalidSandboxChildArguments)?;
	let (backend, command) = if next == OsStr::new("--landlock") {
		let policy = args
			.next()
			.ok_or(SandboxError::InvalidSandboxChildArguments)?;
		let separator = args
			.next()
			.ok_or(SandboxError::InvalidSandboxChildArguments)?;
		if separator != OsStr::new("--") {
			return Err(SandboxError::InvalidSandboxChildArguments);
		}
		apply_landlock(Path::new(&policy))?;
		(Backend::Landlock, args.next())
	} else if next == OsStr::new("--proxy-relay") {
		let socket = args
			.next()
			.ok_or(SandboxError::InvalidSandboxChildArguments)?;
		let port = args
			.next()
			.and_then(|value| value.to_string_lossy().parse::<u16>().ok())
			.filter(|port| *port != 0)
			.ok_or(SandboxError::InvalidSandboxChildArguments)?;
		let separator = args
			.next()
			.ok_or(SandboxError::InvalidSandboxChildArguments)?;
		if separator != OsStr::new("--") {
			return Err(SandboxError::InvalidSandboxChildArguments);
		}
		spawn_proxy_relay(PathBuf::from(socket), port)?;
		(Backend::Bubblewrap, args.next())
	} else {
		if next != OsStr::new("--") {
			return Err(SandboxError::InvalidSandboxChildArguments);
		}
		(Backend::Bubblewrap, args.next())
	};
	let command = command.ok_or(SandboxError::InvalidSandboxChildArguments)?;
	seccompiler::apply_filter(&program)?;
	let source = std::process::Command::new(command).args(args).exec();
	Err(SandboxError::BackendIo { backend, operation: SandboxOperation::Launch, source })
}

#[cfg(target_os = "linux")]
fn spawn_proxy_relay(socket: PathBuf, port: u16) -> Result<(), SandboxError> {
	let (ready, mut child_ready) = relay_ready_pipe().map_err(relay_launch_error)?;
	// SAFETY: the helper has not started any threads. The parent waits for the
	// isolated relay to finish its setup before installing the target filter.
	match unsafe { libc::fork() } {
		-1 => Err(relay_launch_error(io::Error::last_os_error())),
		0 => {
			drop(ready);
			let status = relay_child(&socket, port, &mut child_ready);
			if status.is_err() {
				let _ = child_ready.write_all(&[0]);
			}
			std::process::exit(i32::from(status.is_err()));
		},
		pid => {
			drop(child_ready);
			if let Err(source) = wait_for_relay_ready(ready) {
				wait_for_relay_exit(pid);
				return Err(relay_launch_error(source));
			}
			Ok(())
		},
	}
}

#[cfg(target_os = "linux")]
fn relay_launch_error(source: io::Error) -> SandboxError {
	SandboxError::BackendIo {
		backend: Backend::Bubblewrap,
		operation: SandboxOperation::Launch,
		source,
	}
}

#[cfg(target_os = "linux")]
fn relay_ready_pipe() -> io::Result<(File, File)> {
	let mut fds = [-1; 2];
	// SAFETY: `fds` has space for both returned descriptors. CLOEXEC ensures a
	// target exec cannot mistake an unready relay for a successful startup.
	if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `pipe2` returned owned descriptors exactly once.
	Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

#[cfg(target_os = "linux")]
fn wait_for_relay_ready(mut ready: File) -> io::Result<()> {
	let mut descriptor = libc::pollfd {
		fd:      ready.as_raw_fd(),
		events:  libc::POLLIN | libc::POLLHUP,
		revents: 0,
	};
	// SAFETY: `descriptor` is initialized and points to the owned readiness pipe.
	let polled = unsafe {
		libc::poll(
			&mut descriptor,
			1,
			i32::try_from(RELAY_READY_TIMEOUT.as_millis()).expect("relay timeout fits i32"),
		)
	};
	if polled == 0 {
		return Err(io::Error::new(io::ErrorKind::TimedOut, "scoped relay readiness timed out"));
	}
	if polled < 0 {
		return Err(io::Error::last_os_error());
	}
	let mut byte = [0_u8; 1];
	ready.read_exact(&mut byte)?;
	if byte == [1] {
		Ok(())
	} else {
		Err(io::Error::new(io::ErrorKind::Other, "scoped relay initialization failed"))
	}
}

#[cfg(target_os = "linux")]
fn wait_for_relay_exit(pid: libc::pid_t) {
	let mut status = 0;
	// SAFETY: `pid` is this helper's direct child and waiting only occurs after
	// the readiness pipe reported its setup failure or closure.
	loop {
		if unsafe { libc::waitpid(pid, &mut status, 0) } >= 0
			|| io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
		{
			return;
		}
	}
}

#[cfg(target_os = "linux")]
fn relay_child(socket: &Path, port: u16, ready: &mut File) -> Result<(), SandboxError> {
	configure_relay_process().map_err(relay_launch_error)?;

	bring_loopback_up().map_err(relay_launch_error)?;
	let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port)).map_err(relay_launch_error)?;
	listener.set_nonblocking(true).map_err(relay_launch_error)?;
	install_relay_filter()?;
	ready.write_all(&[1]).map_err(relay_launch_error)?;
	proxy_relay(socket, listener).map_err(relay_launch_error)
}

#[cfg(target_os = "linux")]
fn configure_relay_process() -> io::Result<()> {
	// The relay is owned by the target helper. A parent-death signal closes the
	// network bridge even if the target exits without orderly cleanup.
	// SAFETY: PR_SET_* settings are process-local Linux kernel controls.
	if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) } != 0 {
		return Err(io::Error::last_os_error());
	}
	if unsafe { libc::getppid() } == 1 {
		return Err(io::Error::new(io::ErrorKind::Other, "relay parent exited during startup"));
	}
	// A target in the same PID namespace cannot inspect this trusted child
	// through /proc/<pid>/mem once dumpability is disabled.
	if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0) } != 0
		|| unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0
	{
		return Err(io::Error::last_os_error());
	}
	Ok(())
}

#[cfg(target_os = "linux")]
fn install_relay_filter() -> Result<(), SandboxError> {
	let filter = compile_relay_filter()?;
	seccompiler::apply_filter(&filter)?;
	Ok(())
}

#[cfg(target_os = "linux")]
fn proxy_relay(socket: &Path, listener: TcpListener) -> io::Result<()> {
	const MAX_CONNECTIONS: usize = 32;
	const IDLE_TIMEOUT: Duration = Duration::from_secs(30);
	let live = Arc::new(AtomicUsize::new(0));
	loop {
		match listener.accept() {
			Ok((client, _)) if live.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS => {
				live.fetch_sub(1, Ordering::AcqRel);
			},
			Ok((client, _)) => {
				let socket = socket.to_path_buf();
				let worker_live = Arc::clone(&live);
				if thread::Builder::new()
					.name("omp-scoped-relay".into())
					.spawn(move || {
						let _ = relay_connection(client, &socket, IDLE_TIMEOUT);
						worker_live.fetch_sub(1, Ordering::AcqRel);
					})
					.is_err()
				{
					live.fetch_sub(1, Ordering::AcqRel);
				}
			},
			Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
				thread::sleep(Duration::from_millis(10));
			},
			Err(error) => return Err(error),
		}
	}
}

#[cfg(target_os = "linux")]
fn bring_loopback_up() -> io::Result<()> {
	// Bubblewrap creates the private namespace before invoking this helper, but
	// Linux leaves its loopback device down until its namespace owner enables it.
	// SAFETY: the fd and `ifreq` are initialized for the documented SIOC* ioctls.
	let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	let result = (|| {
		// SAFETY: zero initialization is valid for the C `ifreq` input buffer.
		let mut request: libc::ifreq = unsafe { std::mem::zeroed() };
		request.ifr_name[0] = b'l' as libc::c_char;
		request.ifr_name[1] = b'o' as libc::c_char;
		// SAFETY: SIOCGIFFLAGS fills the flags union member of `request`.
		if unsafe { libc::ioctl(fd, libc::SIOCGIFFLAGS, &mut request) } != 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: the preceding ioctl initialized this union member.
		unsafe { request.ifr_ifru.ifru_flags |= libc::IFF_UP as libc::c_short };
		// SAFETY: SIOCSIFFLAGS consumes the initialized flags union member.
		if unsafe { libc::ioctl(fd, libc::SIOCSIFFLAGS, &request) } != 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(())
	})();
	// SAFETY: `fd` is owned by this function and is no longer used.
	unsafe { libc::close(fd) };
	result
}

#[cfg(target_os = "linux")]
fn relay_connection(mut client: TcpStream, socket: &Path, timeout: Duration) -> io::Result<()> {
	client.set_read_timeout(Some(timeout))?;
	client.set_write_timeout(Some(timeout))?;
	let mut broker = UnixStream::connect(socket)?;
	broker.set_read_timeout(Some(timeout))?;
	broker.set_write_timeout(Some(timeout))?;
	let mut client_copy = client.try_clone()?;
	let closer = client_copy.try_clone()?;
	let mut broker_copy = broker.try_clone()?;
	let copied = thread::Builder::new()
		.name("omp-scoped-relay-copy".into())
		.spawn(move || io::copy(&mut client_copy, &mut broker_copy));
	let down = io::copy(&mut broker, &mut client);
	let _ = closer.shutdown(std::net::Shutdown::Both);
	if let Ok(copied) = copied {
		let _ = copied.join();
	}
	down.map(|_| ())
}

#[cfg(target_os = "linux")]
fn apply_landlock(path: &Path) -> Result<(), SandboxError> {
	use landlock::{
		ABI, Access as _, AccessFs, CompatLevel, Compatible as _, Ruleset, RulesetAttr,
		RulesetCreatedAttr, RulesetStatus,
	};

	let bytes = fs::read(path).map_err(|source| SandboxError::Artifact {
		operation: SandboxOperation::Launch,
		path: path.to_path_buf(),
		source,
	})?;
	let policy = Policy::decode(&bytes).map_err(|source| SandboxError::Artifact {
		operation: SandboxOperation::Launch,
		path: path.to_path_buf(),
		source,
	})?;
	let abi = ABI::V5;
	let access_all = AccessFs::from_all(abi);
	let access_read = AccessFs::from_read(abi);
	let ruleset = Ruleset::default()
		.set_compatibility(CompatLevel::HardRequirement)
		.handle_access(access_all)?
		.create()?;
	let ruleset = if policy.read_all {
		ruleset.add_rules(landlock::path_beneath_rules(["/"], access_read))?
	} else {
		ruleset.add_rules(landlock::path_beneath_rules(&policy.readable, access_read))?
	};
	let ruleset = ruleset.add_rules(landlock::path_beneath_rules(&policy.writable, access_all))?;
	let status = ruleset.restrict_self()?;
	if status.ruleset != RulesetStatus::FullyEnforced {
		return Err(SandboxError::LandlockNotEnforced);
	}
	Ok(())
}

#[cfg(target_os = "linux")]
struct Policy {
	read_all: bool,
	readable: Vec<PathBuf>,
	writable: Vec<PathBuf>,
}

#[cfg(target_os = "linux")]
impl Policy {
	fn decode(bytes: &[u8]) -> io::Result<Self> {
		if !bytes.starts_with(POLICY_MAGIC) || bytes.len() < POLICY_MAGIC.len() + 1 {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid Landlock policy"));
		}
		let mut cursor = POLICY_MAGIC.len();
		let read_all = take(bytes, &mut cursor, 1)?[0] != 0;
		let readable = read_paths(bytes, &mut cursor)?;
		let writable = read_paths(bytes, &mut cursor)?;
		if cursor != bytes.len() {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "trailing Landlock policy data"));
		}
		Ok(Self { read_all, readable, writable })
	}
}

#[cfg(target_os = "linux")]
fn read_paths(bytes: &[u8], cursor: &mut usize) -> io::Result<Vec<PathBuf>> {
	use std::os::unix::ffi::OsStringExt as _;

	let count = u32::from_le_bytes(take(bytes, cursor, 4)?.try_into().unwrap()) as usize;
	let mut paths = Vec::with_capacity(count);
	for _ in 0..count {
		let length = u32::from_le_bytes(take(bytes, cursor, 4)?.try_into().unwrap()) as usize;
		let path = OsString::from_vec(take(bytes, cursor, length)?.to_vec());
		paths.push(PathBuf::from(path));
	}
	Ok(paths)
}

#[cfg(target_os = "linux")]
fn take<'a>(bytes: &'a [u8], cursor: &mut usize, length: usize) -> io::Result<&'a [u8]> {
	let end = cursor
		.checked_add(length)
		.filter(|end| *end <= bytes.len())
		.ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "truncated Landlock policy"))?;
	let value = &bytes[*cursor..end];
	*cursor = end;
	Ok(value)
}
#[cfg(all(test, target_os = "linux"))]
mod tests {
	use std::io::Write as _;

	use super::{
		FilterMode, compile_filter, compile_relay_filter, configure_relay_process, read_program,
		relay_ready_pipe, wait_for_relay_ready, write_program,
	};
	use crate::{NetworkMode, SandboxSpec};

	#[test]
	fn strict_filter_serializes_as_a_larger_deny_program() {
		let strict = compile_filter(FilterMode::DisabledStrict).expect("strict filter");
		let enabled = compile_filter(FilterMode::Enabled).expect("baseline filter");
		assert!(strict.len() > enabled.len());

		let mut file = tempfile::NamedTempFile::new().expect("BPF artifact");
		write_program(file.as_file_mut(), &strict).expect("serialize BPF");
		let decoded = read_program(file.path()).expect("deserialize BPF");
		assert_eq!(decoded.len(), strict.len());
		assert!(
			decoded
				.iter()
				.zip(strict.iter())
				.all(|(left, right)| left.code == right.code
					&& left.jt == right.jt
					&& left.jf == right.jf
					&& left.k == right.k)
		);
	}

	#[test]
	fn filters_deny_host_process_signals() {
		let enabled = compile_filter(FilterMode::Enabled).expect("baseline filter");
		for syscall in [
			libc::SYS_kill,
			libc::SYS_tkill,
			libc::SYS_tgkill,
			libc::SYS_rt_sigqueueinfo,
			libc::SYS_rt_tgsigqueueinfo,
			libc::SYS_pidfd_send_signal,
		] {
			assert!(
				enabled
					.iter()
					.any(|instruction| instruction.k == syscall as u32),
				"filter must guard syscall {syscall}",
			);
		}
	}

	#[test]
	fn relay_filter_denies_process_access_exec_and_filesystem_opens() {
		let filter = compile_relay_filter().expect("relay filter");
		for syscall in [
			libc::SYS_ptrace,
			libc::SYS_process_vm_readv,
			libc::SYS_process_vm_writev,
			libc::SYS_execve,
			libc::SYS_execveat,
			libc::SYS_openat,
			libc::SYS_openat2,
			libc::SYS_unlinkat,
			libc::SYS_renameat,
			libc::SYS_kill,
			libc::SYS_rt_sigqueueinfo,
			libc::SYS_rt_tgsigqueueinfo,
		] {
			assert!(
				filter
					.iter()
					.any(|instruction| instruction.k == syscall as u32),
				"relay filter must guard syscall {syscall}",
			);
		}
		assert!(
			filter
				.iter()
				.any(|instruction| instruction.k == libc::SYS_socket as u32),
			"relay filter must only create Unix sockets",
		);
	}

	#[test]
	fn relay_readiness_requires_an_explicit_success_byte() {
		let (ready, mut child_ready) = relay_ready_pipe().expect("readiness pipe");
		child_ready.write_all(&[1]).expect("ready byte");
		wait_for_relay_ready(ready).expect("relay ready");

		let (ready, child_ready) = relay_ready_pipe().expect("failure pipe");
		drop(child_ready);
		assert!(wait_for_relay_ready(ready).is_err());
	}

	#[test]
	fn relay_process_is_non_dumpable_and_cannot_gain_privileges() {
		// SAFETY: the child performs only process-local prctls and exits through
		// `_exit`, preserving the concurrent test process.
		match unsafe { libc::fork() } {
			-1 => panic!("fork relay defense child"),
			0 => {
				let configured = configure_relay_process().is_ok();
				// SAFETY: these documented prctl getters take no pointer arguments.
				let dumpable = unsafe { libc::prctl(libc::PR_GET_DUMPABLE) };
				let no_new_privs = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) };
				// SAFETY: exit without invoking post-fork Rust cleanup.
				unsafe { libc::_exit(i32::from(!(configured && dumpable == 0 && no_new_privs == 1))) };
			},
			pid => {
				let mut status = 0;
				// SAFETY: `pid` is this test's direct child.
				assert_eq!(unsafe { libc::waitpid(pid, &mut status, 0) }, pid);
				assert_eq!(status, 0, "relay defense child failed");
			},
		}
	}

	#[test]
	fn socket_filters_preserve_private_unix_socketpairs() {
		let strict = compile_filter(FilterMode::DisabledStrict).expect("strict filter");
		let outbound = compile_filter(FilterMode::Outbound).expect("outbound filter");
		let outbound_no_unix =
			compile_filter(FilterMode::OutboundUnixRestricted).expect("outbound Unix filter");
		assert!(
			strict
				.iter()
				.any(|instruction| instruction.k == libc::SYS_socket as u32),
			"strict filter must conditionally guard socket",
		);
		assert!(
			strict
				.iter()
				.any(|instruction| instruction.k == libc::SYS_socketpair as u32),
			"strict filter must conditionally guard socketpair",
		);
		assert!(
			outbound_no_unix
				.iter()
				.any(|instruction| instruction.k == libc::SYS_socket as u32),
			"outbound no-Unix filter must guard socket",
		);
		assert!(
			outbound_no_unix
				.iter()
				.any(|instruction| instruction.k == libc::SYS_socketpair as u32),
			"outbound no-Unix filter must guard socketpair",
		);
		assert!(
			outbound_no_unix.len() > outbound.len(),
			"outbound no-Unix filter must include AF_UNIX socket rules",
		);

		let mut no_unix = SandboxSpec::new("/bin/true");
		no_unix.set_network(NetworkMode::Outbound);
		assert!(matches!(FilterMode::for_spec(&no_unix), FilterMode::OutboundUnixRestricted));
		no_unix.unix_sockets.push("/tmp/allowed.sock".into());
		assert!(matches!(FilterMode::for_spec(&no_unix), FilterMode::Outbound));
	}
}
