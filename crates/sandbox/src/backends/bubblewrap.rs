#[cfg(target_os = "linux")]
use std::process::Command;
use std::{
	env,
	ffi::OsString,
	fs,
	path::{Path, PathBuf},
};

#[cfg(target_os = "linux")]
use omp_core::CowBytes;

use crate::{
	Backend, BackendStatus, Capability, CapabilitySet, Caveat, DegradationPolicy,
	FilesystemVirtualizationKind, NetworkMode, Plan, ProbeFailure, RUNTIME_READ_ROOTS, SandboxError,
	SandboxOperation, SandboxSpec, WriteMode,
	paths::{insert_path, path_under_any, temp_roots},
	runner::COMMAND_WRAPPER_PLACEHOLDER,
};

pub const FILE_MASK_PLACEHOLDER: &str = "@omp-bwrap-file-mask@";
pub const DIRECTORY_MASK_PLACEHOLDER: &str = "@omp-bwrap-directory-mask@";

const LAUNCHERS: [&str; 2] = ["/usr/bin/bwrap", "/bin/bwrap"];

pub fn compile(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	mut enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	if !spec.unix_sockets.is_empty() {
		return Err(SandboxError::EnforcementUnavailable {
			backend:   Backend::Bubblewrap,
			authority: "Unix-domain socket path grants",
		});
	}
	if spec.network == NetworkMode::Outbound
		&& (spec.proxy_port.is_some() != spec.proxy_socket.is_some())
	{
		return Err(SandboxError::EnforcementUnavailable {
			backend:   Backend::Bubblewrap,
			authority: "complete scoped proxy endpoint",
		});
	}
	let scoped_proxy = spec.proxy_socket.is_some();
	let mut unavailable = requested.difference(Backend::Bubblewrap.capabilities());
	let has_future_deny = spec.read_deny.iter().any(|path| !path.exists());
	if has_future_deny {
		unavailable = unavailable.union(CapabilitySet::one(Capability::FsReadDeny));
		enforced = enforced.difference(CapabilitySet::one(Capability::FsReadDeny));
	}
	if spec.degradation == DegradationPolicy::Reject {
		let fatal = unavailable.difference(spec.tolerated);
		if !fatal.is_empty() {
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::Bubblewrap,
				missing: fatal,
			});
		}
	}

	if !spec.unix_sockets.is_empty() {
		enforced = enforced.difference(CapabilitySet::one(Capability::IpcRestrict));
	}
	if spec.network == NetworkMode::Enabled {
		enforced = enforced.difference(CapabilitySet::one(Capability::IpcRestrict));
	}
	if spec.degradation == DegradationPolicy::AllowCaveats && spec.write == WriteMode::Ephemeral {
		enforced = enforced.union(CapabilitySet::one(Capability::FsWriteDeny));
	}

	let mut temporary_writable = spec.allow_temp.then(temp_roots).unwrap_or_default();
	if spec.allow_temp {
		insert_path(&mut temporary_writable, PathBuf::from("/tmp"));
	}
	reject_protected_symlinks(spec, &temporary_writable)?;

	let launcher = launcher();
	let seccomp_helper = (spec.network == NetworkMode::Disabled
		|| spec.network == NetworkMode::Outbound)
		.then(|| {
			env::current_exe().map_err(|source| SandboxError::BackendIo {
				backend: Backend::Bubblewrap,
				operation: SandboxOperation::Compile,
				source,
			})
		})
		.transpose()?;
	let mut argv = vec![launcher];
	if spec.supervised {
		argv.push(OsString::from("--die-with-parent"));
	}
	argv.extend([OsString::from("--new-session"), OsString::from("--unshare-all")]);
	// Bubblewrap passes inherited descriptors through to the final exec; it has
	// no `--preserve-fds` flag. Leaving them open preserves shell-injected high
	// descriptors such as process-substitution fd 63.
	if spec.network == NetworkMode::Enabled || spec.network == NetworkMode::Outbound && !scoped_proxy
	{
		argv.push(OsString::from("--share-net"));
	}

	if spec.readable.is_empty() {
		push_bind(&mut argv, "--ro-bind", Path::new("/"));
	} else {
		argv.extend([OsString::from("--tmpfs"), OsString::from("/")]);
		let mut readable = runtime_closure(program);
		readable.extend(
			RUNTIME_READ_ROOTS
				.iter()
				.map(PathBuf::from)
				.filter(|path| path.exists()),
		);
		if let Some(helper) = &seccomp_helper {
			readable.extend(runtime_closure(helper));
		}
		readable.extend(spec.readable.iter().cloned());
		readable.sort();
		readable.dedup();
		for path in readable {
			if !path_under_any(&path, &spec.writable) {
				push_bind(&mut argv, "--ro-bind", &path);
			}
		}
	}

	argv.extend([OsString::from("--proc"), OsString::from("/proc")]);
	argv.extend([OsString::from("--dev"), OsString::from("/dev")]);
	if spec.allow_temp {
		for root in &temporary_writable {
			push_bind(&mut argv, "--bind", root);
		}
	}
	if matches!(spec.write, WriteMode::Scoped | WriteMode::Overlay) {
		for path in &spec.writable {
			push_bind(&mut argv, "--bind", path);
		}
	}
	for socket in &spec.unix_sockets {
		push_bind(&mut argv, "--bind", socket);
	}
	if let Some(socket) = &spec.proxy_socket {
		let parent = socket.parent().ok_or(SandboxError::InvalidMountPath {
			backend: Backend::Bubblewrap,
			path:    socket.clone(),
		})?;
		push_bind(&mut argv, "--ro-bind", parent);
	}
	for path in spec.write_deny.iter().filter(|path| {
		path_under_any(path, &spec.writable) || path_under_any(path, &temporary_writable)
	}) {
		if path.exists() {
			push_bind(&mut argv, "--ro-bind", path);
		} else {
			// Bubblewrap constructs its root on a private tmpfs and creates
			// missing bind destinations there. Binding an owned empty directory
			// read-only therefore blocks creation without touching the host.
			argv.extend([
				OsString::from("--ro-bind"),
				OsString::from(DIRECTORY_MASK_PLACEHOLDER),
				path.as_os_str().to_owned(),
			]);
		}
	}
	// Bind overrides after read-only masks so a one-shot nested exception
	// supersedes only its own parent carve-out.
	for path in &spec.write_override {
		push_bind(&mut argv, "--bind", path);
	}
	for path in spec.read_deny.iter().filter(|path| path.exists()) {
		let placeholder = if fs::metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
			DIRECTORY_MASK_PLACEHOLDER
		} else {
			FILE_MASK_PLACEHOLDER
		};
		argv.extend([
			OsString::from("--ro-bind"),
			OsString::from(placeholder),
			path.as_os_str().to_owned(),
		]);
	}
	// Bind one-shot read approvals after every deny mask while preserving the
	// unrestricted base bind when reads are otherwise host-visible.
	for path in &spec.read_override {
		push_bind(&mut argv, "--ro-bind", path);
	}
	if seccomp_helper.is_some() {
		push_bind(&mut argv, "--ro-bind", Path::new(super::landlock::BPF_PLACEHOLDER));
	}

	argv.push(OsString::from("--"));
	if let Some(helper) = seccomp_helper {
		argv.extend([
			helper.into_os_string(),
			OsString::from(super::landlock::HIDDEN_CHILD_ARG),
			OsString::from(super::landlock::BPF_PLACEHOLDER),
		]);
		if let (Some(socket), Some(port)) = (&spec.proxy_socket, spec.proxy_port) {
			argv.extend([
				OsString::from("--proxy-relay"),
				socket.as_os_str().to_owned(),
				OsString::from(port.to_string()),
			]);
		}
		argv.push(OsString::from("--"));
	}
	argv.push(program.as_os_str().to_owned());
	argv.extend(spec.args.iter().cloned());

	let mut plan = Plan::new(Backend::Bubblewrap, requested, enforced, argv, true);
	if spec.network == NetworkMode::Disabled && spec.unix_sockets.is_empty() {
		plan.add_caveat(Caveat::general(
			"Bubblewrap seccomp denies host-reaching socket operations while allowing private Unix \
			 socketpairs; it also denies ptrace, process_vm access, io_uring, and signals to other \
			 processes",
		));
	}
	if spec.network == NetworkMode::Outbound && scoped_proxy {
		plan.add_caveat(Caveat::general(
			"Bubblewrap keeps scoped egress in a private network namespace; only the loopback relay \
			 can reach the policy-enforcing Unix-domain broker",
		));
	}
	if spec.network == NetworkMode::Enabled && spec.unix_sockets.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::IpcRestrict,
			"Bubblewrap shares the host network namespace, so abstract Unix sockets are not \
			 restricted",
		));
	}
	if !spec.unix_sockets.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::IpcRestrict,
			"Bubblewrap relaxes Unix-domain socket filtering for explicit socket grants, so host \
			 local IPC is not fully restricted",
		));
	}
	if spec.degradation == DegradationPolicy::AllowCaveats {
		add_degradation_caveats(&mut plan, spec, unavailable, has_future_deny);
	}
	if spec.write == WriteMode::Overlay {
		plan.set_filesystem(FilesystemVirtualizationKind::ScopedDeny);
	}
	Ok(plan)
}

fn launcher() -> OsString {
	env::var_os("OMP_SANDBOX_BWRAP")
		.or_else(|| {
			LAUNCHERS
				.into_iter()
				.map(Path::new)
				.find(|path| path.is_file())
				.map(Path::as_os_str)
				.map(OsString::from)
		})
		.unwrap_or_else(|| OsString::from(LAUNCHERS[0]))
}

pub fn runtime_closure(program: &Path) -> Vec<PathBuf> {
	let mut paths = if program == Path::new(COMMAND_WRAPPER_PLACEHOLDER) {
		Vec::new()
	} else {
		vec![program.to_path_buf()]
	};
	for candidate in [
		"/etc/ld.so.cache",
		"/etc/ld.so.conf",
		"/etc/ld.so.conf.d",
		"/etc/ld.so.preload",
		"/lib",
		"/lib32",
		"/lib64",
		"/libx32",
		"/usr/lib",
		"/usr/lib32",
		"/usr/lib64",
		"/usr/libx32",
	] {
		let candidate = PathBuf::from(candidate);
		if candidate.exists() {
			paths.push(candidate);
		}
	}
	paths.sort();
	paths.dedup();
	paths
}

fn add_degradation_caveats(
	plan: &mut Plan,
	spec: &SandboxSpec,
	unavailable: CapabilitySet,
	has_future_deny: bool,
) {
	for capability in unavailable.iter() {
		let message = match capability {
			Capability::NetOutbound => {
				"Bubblewrap permits outbound networking, but inbound listeners are not blocked"
			},
			Capability::FsWriteEphemeral if spec.write == WriteMode::Ephemeral => {
				"Bubblewrap narrows ephemeral writes to write denial"
			},
			Capability::FsWriteEphemeral => {
				"Bubblewrap persists configured scopes and denies writes elsewhere"
			},
			Capability::ProcNoExec => "Bubblewrap cannot prevent subsequent program execution",
			Capability::ResCpu => "Bubblewrap does not enforce CPU limits",
			Capability::ResMemory => "Bubblewrap does not enforce memory limits",
			Capability::ResPids => "Bubblewrap does not enforce process-count limits",
			Capability::FsReadDeny if has_future_deny => {
				"Bubblewrap masks existing read-deny paths but cannot mask a future path"
			},
			_ => "Bubblewrap cannot enforce this requested capability",
		};
		plan.add_caveat(Caveat::capability(capability, message));
	}
}

pub fn probe() -> BackendStatus {
	#[cfg(not(target_os = "linux"))]
	{
		BackendStatus::unavailable(Backend::Bubblewrap, ProbeFailure::WrongHost {
			backend: Backend::Bubblewrap,
			os:      std::env::consts::OS,
		})
	}
	#[cfg(target_os = "linux")]
	{
		let launcher = launcher();
		let output = match Command::new(&launcher)
			.args([
				"--die-with-parent",
				"--new-session",
				"--unshare-all",
				"--ro-bind",
				"/",
				"/",
				"--",
				"/bin/true",
			])
			.output()
		{
			Ok(output) => output,
			Err(source) => {
				return BackendStatus::unavailable(Backend::Bubblewrap, ProbeFailure::Start {
					backend: Backend::Bubblewrap,
					operation: SandboxOperation::Probe,
					source,
				});
			},
		};
		if output.status.success() {
			BackendStatus::available(Backend::Bubblewrap)
		} else {
			let mut diagnostic = output.stderr;
			diagnostic.truncate(4096);
			BackendStatus::unavailable(Backend::Bubblewrap, ProbeFailure::Rejected {
				backend:    Backend::Bubblewrap,
				operation:  SandboxOperation::Probe,
				status:     output.status.code(),
				diagnostic: CowBytes::from(diagnostic),
			})
		}
	}
}

fn push_bind(argv: &mut Vec<OsString>, option: &str, path: &Path) {
	argv.push(OsString::from(option));
	argv.push(path.as_os_str().to_owned());
	argv.push(path.as_os_str().to_owned());
}

fn reject_protected_symlinks(
	spec: &SandboxSpec,
	temporary_writable: &[PathBuf],
) -> Result<(), SandboxError> {
	for path in spec.write_deny.iter().filter(|path| {
		path_under_any(path, &spec.writable) || path_under_any(path, temporary_writable)
	}) {
		for writable_root in spec
			.writable
			.iter()
			.chain(temporary_writable.iter())
			.filter(|root| path.starts_with(root))
		{
			reject_protected_symlink(writable_root, path)?;
		}
	}
	Ok(())
}

fn reject_protected_symlink(
	writable_root: &Path,
	protected_path: &Path,
) -> Result<(), SandboxError> {
	let relative = protected_path
		.strip_prefix(writable_root)
		.expect("write-deny path was filtered beneath writable root");
	let mut component_path = writable_root.to_path_buf();
	for component in relative.components() {
		component_path.push(component);
		match fs::symlink_metadata(&component_path) {
			Ok(metadata) if metadata.file_type().is_symlink() => {
				return Err(SandboxError::ProtectedWriteDenySymlink {
					writable_root: writable_root.to_path_buf(),
					path:          protected_path.to_path_buf(),
					symlink:       component_path,
				});
			},
			Ok(_) => {},
			Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
			Err(source) => {
				return Err(SandboxError::BackendPath {
					backend: Backend::Bubblewrap,
					operation: SandboxOperation::Compile,
					path: component_path,
					source,
				});
			},
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn outbound_proxy_uses_private_netns_and_hidden_relay() {
		let mut spec = SandboxSpec::new("/bin/true");
		spec.set_network(NetworkMode::Outbound);
		spec
			.set_proxy_endpoint(18443, Some(Path::new("/tmp/omp-broker.sock")))
			.expect("proxy endpoint");
		let requested = spec.requested_capabilities();
		let plan = compile(&spec, Path::new("/bin/true"), requested, requested).expect("relay plan");
		let argv = plan
			.argv()
			.iter()
			.map(|value| value.to_string_lossy())
			.collect::<Vec<_>>();
		assert!(!argv.iter().any(|value| value == "--share-net"));
		assert!(argv.windows(4).any(|window| {
			window[0] == "--proxy-relay"
				&& window[1] == "/tmp/omp-broker.sock"
				&& window[2] == "18443"
				&& window[3] == "--"
		}));
	}

	#[test]
	fn partial_proxy_endpoint_is_rejected() {
		let mut spec = SandboxSpec::new("/bin/true");
		spec.set_network(NetworkMode::Outbound);
		spec.set_proxy_endpoint(18443, None).expect("proxy port");
		let requested = spec.requested_capabilities();
		assert!(matches!(
			compile(&spec, Path::new("/bin/true"), requested, requested),
			Err(SandboxError::EnforcementUnavailable {
				authority: "complete scoped proxy endpoint",
				..
			})
		));
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn external_target_carve_out_symlink_rejects_kernel_plan() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().expect("workspace");
		let external = tempfile::tempdir().expect("external");
		symlink(external.path(), workspace.path().join(".git")).expect("carve-out symlink");

		let mut spec = SandboxSpec::new("/bin/true");
		spec.set_write(WriteMode::Scoped);
		spec
			.allow_write(workspace.path())
			.expect("writable workspace");
		spec
			.deny_write_lexical(workspace.path().join(".git"))
			.expect("protected carve-out");
		let requested = spec.requested_capabilities();
		assert!(matches!(
			compile(&spec, Path::new("/bin/true"), requested, requested),
			Err(SandboxError::ProtectedWriteDenySymlink { .. })
		));
	}
}
