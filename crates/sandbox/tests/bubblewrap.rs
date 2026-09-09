//! Bubblewrap plan, preparation, and live confinement contracts.

use std::{fs, path::Path};

use omp_sandbox::{
	Backend, Capability, DegradationPolicy, FilesystemVirtualizationKind, NetworkMode,
	ResourceLimits, Runner, SandboxError, SandboxSpec, WriteMode,
};
use tempfile::tempdir;

#[test]
fn broad_view_has_required_namespaces_and_runtime_mounts() {
	let plan = compile(SandboxSpec::new(executable()));
	let argv = plan.argv();
	assert_eq!(argv[1], "--die-with-parent");
	assert_eq!(argv[2], "--new-session");
	assert_eq!(argv[3], "--unshare-all");
	assert!(!argv.iter().any(|argument| argument == "--preserve-fds"));
	assert!(has_mount(argv, "--ro-bind", Path::new("/"), Path::new("/")));
	assert!(has_pair(argv, "--proc", Path::new("/proc")));
	assert!(has_pair(argv, "--dev", Path::new("/dev")));
	assert!(!argv.iter().any(|argument| argument == "--share-net"));
	assert!(plan.enforced().contains(Capability::NetDisable));
	assert!(plan.enforced().contains(Capability::FsReadHost));
	assert_enforced_subset(&plan);
}

#[test]
fn enabled_network_alone_shares_the_host_network_namespace() {
	let mut spec = SandboxSpec::new(executable());
	spec.set_network(NetworkMode::Enabled);
	spec.tolerate_missing(Capability::IpcRestrict);
	let plan = compile(spec);
	assert!(plan.argv().iter().any(|argument| argument == "--share-net"));
	assert!(plan.enforced().contains(Capability::NetEnable));
	assert!(!plan.enforced().contains(Capability::NetDisable));
	assert!(!plan.enforced().contains(Capability::IpcRestrict));
	assert_caveat(&plan, Capability::IpcRestrict);
	assert_enforced_subset(&plan);
}
#[test]
fn disabled_network_uses_hidden_seccomp_child_contract() {
	let target = executable();
	let plan = compile(SandboxSpec::new(target));
	let argv = plan.argv();
	let child = argv
		.iter()
		.position(|argument| argument == omp_sandbox::HIDDEN_CHILD_ARG)
		.expect("hidden sandbox child");
	assert_eq!(argv[child + 1], "@omp-sandbox-bpf@");
	assert_eq!(argv[child + 2], "--");
	assert_eq!(Path::new(&argv[child + 3]), target);
	assert!(has_mount(
		argv,
		"--ro-bind",
		Path::new("@omp-sandbox-bpf@"),
		Path::new("@omp-sandbox-bpf@"),
	));
}

#[test]
fn enabled_network_skips_hidden_seccomp_child() {
	let mut spec = SandboxSpec::new(executable());
	spec.set_network(NetworkMode::Enabled);
	spec.tolerate_missing(Capability::IpcRestrict);
	let plan = compile(spec);
	assert!(
		!plan
			.argv()
			.iter()
			.any(|argument| argument == omp_sandbox::HIDDEN_CHILD_ARG)
	);
}

#[test]
fn scoped_view_binds_loader_reads_and_writable_overrides() {
	let root = tempdir().expect("temporary paths");
	let readable = root.path().join("readable");
	let writable = root.path().join("writable");
	fs::create_dir(&readable).expect("readable directory");
	fs::create_dir(&writable).expect("writable directory");
	let readable = fs::canonicalize(readable).expect("canonical readable directory");
	let writable = fs::canonicalize(writable).expect("canonical writable directory");

	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(&readable).expect("read scope");
	spec.set_write(WriteMode::Scoped);
	spec.allow_write(&writable).expect("write scope");
	spec.set_allow_temp(true);
	let plan = compile(spec);

	assert!(has_pair(plan.argv(), "--tmpfs", Path::new("/")));
	assert!(has_mount(plan.argv(), "--ro-bind", &readable, &readable));
	assert!(has_mount(plan.argv(), "--bind", &writable, &writable));
	let canonical_temp =
		fs::canonicalize(std::env::temp_dir()).expect("canonical temporary directory");
	assert!(has_mount(plan.argv(), "--bind", &canonical_temp, &canonical_temp));
	assert!(has_mount(plan.argv(), "--bind", Path::new("/tmp"), Path::new("/tmp")));
	assert!(!has_pair(plan.argv(), "--tmpfs", Path::new("/tmp")));
	let resolved_program = fs::canonicalize(executable()).expect("resolved executable");
	assert!(has_mount(plan.argv(), "--ro-bind", &resolved_program, &resolved_program,));
	assert!(plan.enforced().contains(Capability::FsReadScope));
	assert!(plan.enforced().contains(Capability::FsWriteScope));
	assert_enforced_subset(&plan);
}

#[test]
fn write_denies_remount_subtrees_read_only_after_writable_bind() {
	let root = tempdir().expect("writable scope");
	let denied = root.path().join("denied");
	fs::create_dir(&denied).expect("denied directory");
	let root = fs::canonicalize(root.path()).expect("canonical root");
	let denied = fs::canonicalize(denied).expect("canonical denied");

	let mut spec = SandboxSpec::new(executable());
	spec.set_write(WriteMode::Scoped);
	spec.allow_write(&root).expect("write scope");
	spec.deny_write(&denied).expect("write denial");
	let plan = compile(spec);
	let writable_index = mount_index(plan.argv(), "--bind", &root);
	let denied_index = mount_index(plan.argv(), "--ro-bind", &denied);
	assert!(writable_index < denied_index, "read-only carve-out must shadow writable bind");
	assert!(plan.enforced().contains(Capability::FsWriteDeny));
}

#[test]
fn future_write_denies_bind_an_owned_read_only_synthetic_target() {
	let root = tempdir().expect("writable scope");
	let root = fs::canonicalize(root.path()).expect("canonical root");
	let future = root.join("not-created");

	let mut spec = SandboxSpec::new(executable());
	spec.set_write(WriteMode::Scoped);
	spec.allow_write(&root).expect("write scope");
	spec.deny_write(&future).expect("future write denial");
	let plan = compile(spec);

	assert_eq!(
		mount_source(plan.argv(), "--ro-bind", &future).to_str(),
		Some("@omp-bwrap-directory-mask@"),
	);
	assert!(plan.enforced().contains(Capability::FsWriteDeny));
	assert!(
		!plan
			.caveats()
			.iter()
			.any(|caveat| caveat.capability == Some(Capability::FsWriteDeny))
	);
}

#[test]
fn temporary_and_overlay_write_denies_accept_every_effective_writable_region() {
	let temporary_root = tempdir().expect("temporary write scope");
	let temporary = fs::canonicalize(temporary_root.path())
		.expect("canonical temporary scope")
		.join("future-deny");
	let mut scoped = SandboxSpec::new(executable());
	scoped.set_write(WriteMode::Scoped).set_allow_temp(true);
	scoped
		.deny_write(&temporary)
		.expect("temporary write denial");
	let scoped = compile(scoped);
	assert_eq!(
		mount_source(scoped.argv(), "--ro-bind", &temporary).to_str(),
		Some("@omp-bwrap-directory-mask@"),
	);

	let root = tempdir().expect("overlay paths");
	let writable = root.path().join("writable");
	let outside = root.path().join("outside");
	fs::create_dir(&writable).expect("writable directory");
	fs::create_dir(&outside).expect("outside directory");
	let mut overlay = SandboxSpec::new(executable());
	overlay
		.set_write(WriteMode::Overlay)
		.set_degradation(DegradationPolicy::AllowCaveats);
	overlay.allow_write(&writable).expect("overlay write scope");
	overlay
		.deny_write(&outside)
		.expect("overlay-wide write denial");
	let overlay = compile(overlay);
	assert!(overlay.enforced().contains(Capability::FsWriteDeny));
	assert!(
		!overlay
			.argv()
			.windows(3)
			.any(|window| window[0] == "--ro-bind" && Path::new(&window[2]) == outside),
		"the already-read-only Bubblewrap root needs no redundant carve-out",
	);
}

#[cfg(unix)]
#[test]
fn write_deny_rejects_symlinked_protected_paths() {
	use std::os::unix::fs::symlink;

	let root_dir = tempdir().expect("writable root");
	let root = root_dir
		.path()
		.canonicalize()
		.expect("canonical writable root");
	let target = root.join("target");
	fs::create_dir(&target).expect("target directory");

	let git = root.join(".git");
	symlink(&target, &git).expect("direct symlink");
	let mut direct = SandboxSpec::new(executable());
	direct.set_write(WriteMode::Scoped);
	direct.allow_write(&root).expect("write root");
	direct
		.deny_write(&git)
		.expect("direct symlink write denial");
	let error = Runner::for_backend(Backend::Bubblewrap)
		.compile(&direct)
		.expect_err("direct symlinked carve-out must fail");
	assert!(
		matches!(
			error,
			SandboxError::ProtectedWriteDenySymlink { ref writable_root, ref path, ref symlink }
				if writable_root == &root && path == &git && symlink == &git
		),
		"unexpected error: {error:?}"
	);

	let intermediate = root.join("linked");
	symlink(&target, &intermediate).expect("intermediate symlink");
	let protected = intermediate.join("private").join("secret");
	let mut nested = SandboxSpec::new(executable());
	nested.set_write(WriteMode::Scoped);
	nested.allow_write(&root).expect("write root");
	nested
		.deny_write(&protected)
		.expect("intermediate symlink write denial");
	let error = Runner::for_backend(Backend::Bubblewrap)
		.compile(&nested)
		.expect_err("intermediate symlinked carve-out must fail");
	assert!(matches!(
		error,
		SandboxError::ProtectedWriteDenySymlink { writable_root, path, symlink }
			if writable_root == root && path == protected && symlink == intermediate
	));
}

#[test]
fn existing_read_denies_compile_to_typed_mask_mounts() {
	let root = tempdir().expect("temporary paths");
	let denied_file = root.path().join("secret");
	let denied_directory = root.path().join("private");
	fs::write(&denied_file, "secret").expect("denied file");
	fs::create_dir(&denied_directory).expect("denied directory");
	let denied_file = fs::canonicalize(denied_file).expect("canonical denied file");
	let denied_directory = fs::canonicalize(denied_directory).expect("canonical denied directory");

	let mut spec = SandboxSpec::new(executable());
	spec.deny_read(&denied_file).expect("file deny");
	spec.deny_read(&denied_directory).expect("directory deny");
	let plan = compile(spec);

	let file_source = mount_source(plan.argv(), "--ro-bind", &denied_file);
	let directory_source = mount_source(plan.argv(), "--ro-bind", &denied_directory);
	assert_eq!(file_source.to_str(), Some("@omp-bwrap-file-mask@"));
	assert_eq!(directory_source.to_str(), Some("@omp-bwrap-directory-mask@"));
	assert!(plan.enforced().contains(Capability::FsReadDeny));
	assert_enforced_subset(&plan);
}

#[test]
fn future_read_denies_reject_or_drop_the_unenforceable_guarantee() {
	let root = tempdir().expect("temporary paths");
	let future = root.path().join("not-created");
	let mut strict = SandboxSpec::new(executable());
	strict.deny_read(&future).expect("future deny");
	let error = Runner::for_backend(Backend::Bubblewrap)
		.compile(&strict)
		.expect_err("future target cannot be overmounted");
	assert!(matches!(
		error,
		SandboxError::BackendCapabilities { backend: Backend::Bubblewrap, missing }
			if missing.contains(Capability::FsReadDeny)
	));

	strict.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = compile(strict);
	assert!(!plan.enforced().contains(Capability::FsReadDeny));
	assert!(
		plan
			.caveats()
			.iter()
			.any(|caveat| caveat.capability == Some(Capability::FsReadDeny))
	);
	assert_enforced_subset(&plan);
}

#[test]
fn unsupported_modes_reject_or_narrow_authoritative_enforcement() {
	let mut outbound = SandboxSpec::new(executable());
	outbound.set_network(NetworkMode::Outbound);
	let plan = compile(outbound);
	assert!(plan.enforced().contains(Capability::NetOutbound));
	assert!(plan.enforced().contains(Capability::IpcRestrict));
	assert!(!plan.enforced().contains(Capability::NetDisable));
	assert!(plan.argv().iter().any(|argument| argument == "--share-net"));
	assert!(
		plan
			.argv()
			.iter()
			.any(|argument| argument == omp_sandbox::HIDDEN_CHILD_ARG)
	);
	assert_enforced_subset(&plan);

	let mut ephemeral = SandboxSpec::new(executable());
	ephemeral.set_write(WriteMode::Ephemeral);
	assert_missing(&ephemeral, Capability::FsWriteEphemeral);
	ephemeral.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = compile(ephemeral);
	assert!(plan.enforced().contains(Capability::FsWriteDeny));
	assert!(!plan.enforced().contains(Capability::FsWriteEphemeral));
	assert_caveat(&plan, Capability::FsWriteEphemeral);
	assert_enforced_subset(&plan);

	let root = tempdir().expect("temporary paths");
	let writable = root.path().join("writable");
	fs::create_dir(&writable).expect("writable directory");
	let writable = fs::canonicalize(writable).expect("canonical writable directory");
	let mut overlay = SandboxSpec::new(executable());
	overlay.set_write(WriteMode::Overlay);
	overlay.allow_write(&writable).expect("write scope");
	assert_missing(&overlay, Capability::FsWriteEphemeral);
	overlay.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = compile(overlay);
	assert!(plan.enforced().contains(Capability::FsWriteScope));
	assert!(!plan.enforced().contains(Capability::FsWriteEphemeral));
	assert_eq!(plan.filesystem_virtualization(), Some(FilesystemVirtualizationKind::ScopedDeny),);
	assert!(has_mount(plan.argv(), "--bind", &writable, &writable));
	assert_caveat(&plan, Capability::FsWriteEphemeral);
	assert_enforced_subset(&plan);
}

#[test]
fn unsupervised_plans_omit_die_with_parent() {
	let mut spec = SandboxSpec::new(executable());
	spec.set_supervised(false);
	let plan = compile(spec);
	assert!(
		!plan
			.argv()
			.iter()
			.any(|argument| argument == "--die-with-parent")
	);
	assert!(
		plan
			.argv()
			.iter()
			.any(|argument| argument == "--new-session")
	);
}

#[test]
fn no_exec_and_resources_are_never_advertised() {
	let mut spec = SandboxSpec::new(executable());
	spec.set_no_exec(true);
	spec.set_resource_limits(
		ResourceLimits::new(Some(0.5), Some(1024), Some(2)).expect("resource limits"),
	);
	let error = Runner::for_backend(Backend::Bubblewrap)
		.compile(&spec)
		.expect_err("unsupported hard guarantees");
	let SandboxError::BackendCapabilities { backend, missing } = error else {
		panic!("unexpected error: {error:?}");
	};
	assert_eq!(backend, Backend::Bubblewrap);
	for capability in
		[Capability::ProcNoExec, Capability::ResCpu, Capability::ResMemory, Capability::ResPids]
	{
		assert!(missing.contains(capability));
	}

	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = compile(spec);
	for capability in
		[Capability::ProcNoExec, Capability::ResCpu, Capability::ResMemory, Capability::ResPids]
	{
		assert!(!plan.enforced().contains(capability));
		assert!(
			plan
				.caveats()
				.iter()
				.any(|caveat| caveat.capability == Some(capability))
		);
	}
	assert_enforced_subset(&plan);
}

#[cfg(unix)]
#[test]
fn explicit_unix_socket_fails_closed_when_exact_enforcement_is_unavailable() {
	use std::os::unix::net::UnixListener;

	let root = tempdir().expect("temporary paths");
	let socket = root.path().join("service.sock");
	let _listener = UnixListener::bind(&socket).expect("Unix listener");
	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(executable()).expect("scoped executable");
	spec.set_network(NetworkMode::Outbound);
	spec.allow_unix_socket(&socket).expect("socket grant");
	let error = Runner::for_backend(Backend::Bubblewrap)
		.compile(&spec)
		.expect_err("exact Unix-socket grant must fail closed");
	assert!(matches!(error, SandboxError::EnforcementUnavailable {
		backend:   Backend::Bubblewrap,
		authority: "Unix-domain socket path grants",
	}));
}

#[cfg(target_os = "linux")]
#[test]
fn wrapper_prefix_executes_and_filters_environment_names() {
	use std::process::Command;

	if !omp_sandbox::backend_status(Backend::Bubblewrap).is_available() {
		return;
	}
	let mut spec = SandboxSpec::new("");
	spec.deny_env("*TOKEN*").expect("deny environment glob");
	spec
		.set_network(NetworkMode::Outbound)
		.set_degradation(DegradationPolicy::AllowCaveats);
	let wrapper = Runner::for_backend(Backend::Bubblewrap)
		.wrap_template(&spec)
		.expect("compile wrapper");
	assert!(wrapper.env_allowed("PATH"));
	assert!(!wrapper.env_allowed("API_TOKEN"));
	assert_eq!(wrapper.prefix_args().last().and_then(|arg| arg.to_str()), Some("--"));
	let output = Command::new(wrapper.launcher().expect("kernel launcher"))
		.args(wrapper.prefix_args())
		.arg("/bin/echo")
		.arg("wrapped")
		.output()
		.expect("run wrapped echo");
	assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
	assert_eq!(output.stdout, b"wrapped\n");
}

#[cfg(target_os = "linux")]
#[test]
fn prepared_future_write_deny_uses_an_owned_directory_mask() {
	use std::os::unix::fs::PermissionsExt as _;

	if !omp_sandbox::backend_status(Backend::Bubblewrap).is_available() {
		return;
	}
	let root = tempdir().expect("writable scope");
	let future = root.path().join("not-created");
	let mut spec = SandboxSpec::new(executable());
	spec.set_write(WriteMode::Scoped);
	spec.allow_write(root.path()).expect("write scope");
	spec.deny_write(&future).expect("future write denial");
	let runner = Runner::for_backend(Backend::Bubblewrap);
	let plan = runner.compile(&spec).expect("Bubblewrap plan");
	let prepared = runner.prepare(plan, &spec).expect("prepared mask");
	let source = mount_source(prepared.args(), "--ro-bind", &future).to_path_buf();
	assert!(source.is_dir());
	assert_eq!(
		fs::metadata(&source)
			.expect("directory mask")
			.permissions()
			.mode()
			& 0o777,
		0o700,
	);
	drop(prepared);
	assert!(!source.exists());
}

#[cfg(target_os = "linux")]
#[test]
fn prepared_masks_are_private_owned_and_removed_on_drop() {
	use std::os::unix::fs::PermissionsExt as _;

	if !omp_sandbox::backend_status(Backend::Bubblewrap).is_available() {
		return;
	}
	let root = tempdir().expect("temporary paths");
	let denied_file = root.path().join("secret");
	let denied_directory = root.path().join("private");
	fs::write(&denied_file, "secret").expect("denied file");
	fs::create_dir(&denied_directory).expect("denied directory");
	let mut spec = SandboxSpec::new(executable());
	spec.arg("@omp-bwrap-file-mask@");
	spec.deny_read(&denied_file).expect("file deny");
	spec.deny_read(&denied_directory).expect("directory deny");
	let runner = Runner::for_backend(Backend::Bubblewrap);
	let plan = runner.compile(&spec).expect("Bubblewrap plan");
	let prepared = runner.prepare(plan, &spec).expect("prepared masks");
	let file_mask = mount_source(prepared.args(), "--ro-bind", &denied_file).to_path_buf();
	let directory_mask = mount_source(prepared.args(), "--ro-bind", &denied_directory).to_path_buf();
	assert_eq!(
		prepared
			.args()
			.last()
			.and_then(|argument| argument.to_str()),
		Some("@omp-bwrap-file-mask@"),
	);
	assert_eq!(
		fs::metadata(&file_mask)
			.expect("file mask")
			.permissions()
			.mode()
			& 0o777,
		0o600
	);
	assert_eq!(
		fs::metadata(&directory_mask)
			.expect("directory mask")
			.permissions()
			.mode()
			& 0o777,
		0o700,
	);
	drop(prepared);
	assert!(!file_mask.exists());
	assert!(!directory_mask.exists());
}

#[cfg(target_os = "linux")]
#[test]
fn live_bubblewrap_confines_reads_writes_socket_and_preserves_fd_63() {
	use std::{
		io::Read as _,
		os::{
			fd::AsRawFd as _,
			unix::{
				net::{UnixListener, UnixStream},
				process::CommandExt as _,
			},
		},
		process::Stdio,
		thread,
	};

	if !omp_sandbox::backend_status(Backend::Bubblewrap).is_available() {
		return;
	}
	let root = tempdir().expect("temporary paths");
	let readable = root.path().join("readable");
	let denied = root.path().join("denied");
	let writable_directory = root.path().join("writable");
	let writable = writable_directory.join("created");
	let future_denied = writable_directory.join("blocked");
	let outside = root.path().join("outside");
	let socket = root.path().join("service.sock");
	fs::write(&readable, "readable").expect("readable file");
	fs::write(&denied, "denied-secret").expect("denied file");
	fs::create_dir(&writable_directory).expect("writable directory");
	let listener = UnixListener::bind(&socket).expect("Unix listener");

	let script = r#"
import os, socket, sys
readable, denied, writable, future_denied, outside, socket_path = sys.argv[1:]
assert open(readable).read() == "readable"
try:
    denied_value = open(denied).read()
except OSError:
    denied_value = ""
assert denied_value != "denied-secret"
with open(writable, "w") as stream:
    stream.write("persisted")
try:
    with open(future_denied, "w") as stream:
        stream.write("blocked")
except OSError:
    pass
else:
    raise AssertionError("future write-deny creation succeeded")
try:
    with open(outside, "w") as stream:
        stream.write("escaped")
except OSError:
    pass
else:
    raise AssertionError("outside write succeeded")
client = socket.socket(socket.AF_UNIX)
client.connect(socket_path)
client.sendall(b"socket")
client.close()
os.fstat(63)
print("ok")
"#;
	let mut spec = SandboxSpec::new("python3");
	spec
		.arg("-c")
		.arg(script)
		.arg(&readable)
		.arg(&denied)
		.arg(&writable)
		.arg(&future_denied)
		.arg(&outside)
		.arg(&socket);
	spec.set_write(WriteMode::Scoped);
	spec.allow_write(&writable_directory).expect("write scope");
	spec.deny_write(&future_denied).expect("future write deny");
	spec.deny_read(&denied).expect("read deny");
	spec.allow_unix_socket(&socket).expect("socket grant");

	let runner = Runner::for_backend(Backend::Bubblewrap);
	let plan = runner.compile(&spec).expect("Bubblewrap plan");
	let prepared = runner.prepare(plan, &spec).expect("prepared Bubblewrap");
	let server = thread::spawn(move || {
		let (mut stream, _) = listener.accept().expect("sandbox socket connection");
		let mut bytes = [0; 6];
		stream.read_exact(&mut bytes).expect("socket payload");
		bytes
	});
	let (inherited_child, _inherited_parent) =
		UnixStream::pair().expect("inherited descriptor pair");
	let inherited_fd = inherited_child.as_raw_fd();
	let mut command = prepared.command().expect("prepared command");
	command.stdout(Stdio::piped()).stderr(Stdio::piped());
	// SAFETY: the closure performs only async-signal-safe dup2 and error lookup
	// between fork and exec; the source descriptor remains owned until output().
	unsafe {
		command.pre_exec(move || {
			if libc::dup2(inherited_fd, 63) == -1 {
				return Err(std::io::Error::last_os_error());
			}
			Ok(())
		});
	}
	let output = command.output().expect("launch Bubblewrap probe");
	assert!(
		output.status.success(),
		"sandbox probe failed: {}",
		String::from_utf8_lossy(&output.stderr),
	);
	assert_eq!(output.stdout, b"ok\n");
	assert_eq!(server.join().expect("socket server"), *b"socket");
	assert_eq!(fs::read_to_string(&writable).expect("persistent write"), "persisted");
	assert!(!outside.exists());
	assert_eq!(fs::read_to_string(&denied).expect("host denied file"), "denied-secret");
}

fn compile(spec: SandboxSpec) -> omp_sandbox::Plan {
	Runner::for_backend(Backend::Bubblewrap)
		.compile(&spec)
		.expect("Bubblewrap plan")
}

fn assert_missing(spec: &SandboxSpec, capability: Capability) {
	let error = Runner::for_backend(Backend::Bubblewrap)
		.compile(spec)
		.expect_err("strict unsupported capability");
	assert!(matches!(
		error,
		SandboxError::BackendCapabilities { backend: Backend::Bubblewrap, missing }
			if missing.contains(capability)
	));
}

fn assert_caveat(plan: &omp_sandbox::Plan, capability: Capability) {
	assert!(
		plan
			.caveats()
			.iter()
			.any(|caveat| caveat.capability == Some(capability))
	);
}

fn assert_enforced_subset(plan: &omp_sandbox::Plan) {
	assert!(
		plan
			.enforced()
			.difference(Backend::Bubblewrap.capabilities())
			.is_empty()
	);
}

fn has_pair(argv: &[std::ffi::OsString], option: &str, value: &Path) -> bool {
	argv
		.windows(2)
		.any(|window| window[0] == option && Path::new(&window[1]) == value)
}

fn has_mount(argv: &[std::ffi::OsString], option: &str, source: &Path, target: &Path) -> bool {
	argv.windows(3).any(|window| {
		window[0] == option && Path::new(&window[1]) == source && Path::new(&window[2]) == target
	})
}

fn mount_index(argv: &[std::ffi::OsString], option: &str, target: &Path) -> usize {
	argv
		.windows(3)
		.position(|window| {
			window[0] == option && Path::new(&window[1]) == target && Path::new(&window[2]) == target
		})
		.expect("mount target")
}

fn mount_source<'a>(argv: &'a [std::ffi::OsString], option: &str, target: &Path) -> &'a Path {
	argv
		.windows(3)
		.find(|window| window[0] == option && Path::new(&window[2]) == target)
		.map(|window| Path::new(&window[1]))
		.expect("mount target")
}

fn executable() -> &'static Path {
	#[cfg(target_os = "linux")]
	return Path::new("/bin/true");
	#[cfg(target_os = "macos")]
	return Path::new("/usr/bin/true");
	#[cfg(windows)]
	return Path::new(r"C:\Windows\System32\cmd.exe");
	#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
	return Path::new("/bin/true");
}
