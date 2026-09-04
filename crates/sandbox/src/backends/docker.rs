use std::{
	env,
	ffi::{OsStr, OsString},
	fs,
	io::{self, Write as _},
	path::{Path, PathBuf},
	process::{Command, Output},
	sync::Arc,
};

use omp_core::CowBytes;
use serde::Deserialize;
use tempfile::{Builder, NamedTempFile};

use crate::{
	Backend, BackendStatus, Capability, CapabilitySet, Caveat, DegradationPolicy, EnvironmentSource,
	FilesystemVirtualizationKind, NetworkMode, Plan, PreparedSandbox, ProbeFailure, SandboxError,
	SandboxOperation, SandboxSpec, WriteMode,
	paths::{os_string_bytes, path_under_any},
	runtime::docker::{DockerArtifact, DockerPrepared},
};

const DOCKER_ENV: &str = "OMP_SANDBOX_DOCKER";
const IMAGE_ENV: &str = "OMP_SANDBOX_DOCKER_IMAGE";
const RUNTIME_ENV: &str = "OMP_SANDBOX_DOCKER_RUNTIME";
const RUNSC_RUNTIME_ENV: &str = "OMP_SANDBOX_DOCKER_RUNSC_RUNTIME";
const ENV_FILE_PLACEHOLDER: &str = "<omp-sandbox-docker-env-file>";
const SECCOMP_PLACEHOLDER: &str = "<omp-sandbox-docker-outbound-seccomp>";
// Docker's default profile with listen/accept/accept4 removed from its
// allowlist.
const OUTBOUND_SECCOMP: &[u8] = include_bytes!("docker/outbound-seccomp.json");

#[derive(Deserialize)]
struct ImageInspect {
	#[serde(rename = "Id")]
	id:     String,
	#[serde(rename = "Config", default)]
	config: ImageConfig,
}

#[derive(Default, Deserialize)]
struct ImageConfig {
	#[serde(rename = "Volumes", default)]
	volumes: Option<std::collections::BTreeMap<String, serde_json::Value>>,
}

pub fn compile(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	compile_for(Backend::DockerEphemeral, spec, program, requested, enforced)
}

pub fn compile_runsc(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	compile_for(Backend::DockerRunscEphemeral, spec, program, requested, enforced)
}

fn compile_for(
	backend: Backend,
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	mut enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	let image = env::var_os(IMAGE_ENV).ok_or_else(|| SandboxError::BackendUnavailable {
		backend,
		failure: Arc::new(ProbeFailure::Configuration { backend, variable: IMAGE_ENV }),
	})?;
	let docker = env::var_os(DOCKER_ENV).unwrap_or_else(|| OsString::from("docker"));
	let runtime = runtime_for(backend);
	if backend == Backend::DockerRunscEphemeral {
		enforced = enforced.union(CapabilitySet::one(Capability::KernelIsolation));
	}
	let readable = &spec.readable;
	let writable = &spec.writable;
	let has_future_write_deny = spec.write_deny.iter().any(|path| !path.exists());
	let has_unmounted_write_deny = spec
		.write_deny
		.iter()
		.any(|path| !path_under_any(path, writable));
	if has_future_write_deny || has_unmounted_write_deny {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsWriteDeny));
		if spec.degradation == DegradationPolicy::Reject
			&& !spec.tolerated.contains(Capability::FsWriteDeny)
		{
			return Err(SandboxError::BackendCapabilities {
				backend,
				missing: CapabilitySet::one(Capability::FsWriteDeny),
			});
		}
	}

	if let Some(dir) = &spec.dir
		&& !path_under_any(dir, readable)
		&& !path_under_any(dir, writable)
	{
		return Err(SandboxError::InvalidMountPath { backend, path: dir.clone() });
	}

	let mut argv = vec![
		docker,
		OsString::from("run"),
		OsString::from("--rm"),
		OsString::from("--name"),
		OsString::from(spec.stable_id("omp-sandbox").as_str()),
		OsString::from("--ipc"),
		OsString::from("private"),
		OsString::from("--cap-drop"),
		OsString::from("ALL"),
		OsString::from("--security-opt"),
		OsString::from("no-new-privileges"),
	];
	if let Some(runtime) = runtime {
		argv.extend([OsString::from("--runtime"), runtime]);
	}
	if spec.write != WriteMode::Ephemeral {
		argv.push(OsString::from("--read-only"));
	}
	match spec.write {
		WriteMode::Deny | WriteMode::Ephemeral => {
			push_pair(&mut argv, "--tmpfs", OsStr::new("/tmp"));
			push_pair(&mut argv, "--tmpfs", OsStr::new("/run"));
		},
		WriteMode::Scoped | WriteMode::Overlay if spec.allow_temp => {
			push_pair(&mut argv, "--tmpfs", OsStr::new("/tmp"));
		},
		WriteMode::Scoped | WriteMode::Overlay => {},
	}

	for path in readable {
		if !path_under_any(path, writable) {
			push_mount(&mut argv, backend, path, path, true)?;
		}
	}
	for path in writable {
		push_mount(&mut argv, backend, path, path, false)?;
	}
	for path in &spec.unix_sockets {
		if !path_under_any(path, readable) && !path_under_any(path, writable) {
			push_mount(&mut argv, backend, path, path, true)?;
		}
	}
	for path in spec
		.write_deny
		.iter()
		.filter(|path| path.exists() && path_under_any(path, writable))
	{
		push_mount(&mut argv, backend, path, path, true)?;
	}
	if let Some(dir) = &spec.dir {
		push_pair(&mut argv, "--workdir", dir.as_os_str());
	}
	if let Some(cpus) = spec.resources.cpu_cores() {
		push_pair(&mut argv, "--cpus", OsStr::new(&cpus.to_string()));
	}
	if let Some(memory) = spec.resources.memory_bytes() {
		let memory = memory.to_string();
		push_pair(&mut argv, "--memory", OsStr::new(&memory));
		push_pair(&mut argv, "--memory-swap", OsStr::new(&memory));
	}
	if let Some(pids) = spec.resources.pids() {
		push_pair(&mut argv, "--pids-limit", OsStr::new(&pids.to_string()));
	}
	match spec.network {
		NetworkMode::Disabled => push_pair(&mut argv, "--network", OsStr::new("none")),
		NetworkMode::Enabled => {},
		NetworkMode::Outbound => push_pair(
			&mut argv,
			"--security-opt",
			OsStr::new("seccomp=<omp-sandbox-docker-outbound-seccomp>"),
		),
	}
	if !matches!(spec.environment.source(), EnvironmentSource::Inherit) || spec.environment.scrubs()
	{
		push_pair(&mut argv, "--env-file", OsStr::new(ENV_FILE_PLACEHOLDER));
	}
	argv.push(image);
	argv.push(program.as_os_str().to_owned());
	argv.extend(spec.args.iter().cloned());

	let bound_host_paths =
		!readable.is_empty() || !writable.is_empty() || !spec.unix_sockets.is_empty();
	let mut semantic_missing = CapabilitySet::empty();
	if bound_host_paths && enforced.contains(Capability::IpcRestrict) {
		semantic_missing = semantic_missing.union(CapabilitySet::one(Capability::IpcRestrict));
	}
	if spec.write == WriteMode::Overlay && enforced.contains(Capability::FsWriteEphemeral) {
		semantic_missing = semantic_missing.union(CapabilitySet::one(Capability::FsWriteEphemeral));
	}
	if spec.degradation == DegradationPolicy::Reject {
		let fatal = semantic_missing.difference(spec.tolerated);
		if !fatal.is_empty() {
			return Err(SandboxError::BackendCapabilities { backend, missing: fatal });
		}
	}
	enforced = enforced.difference(semantic_missing);

	let mut plan = Plan::new(backend, requested, enforced, argv, true);
	plan.add_caveat(Caveat::general(
		"Docker executes the command inside the configured image; host paths exist only through \
		 declared bind mounts",
	));
	plan.add_caveat(Caveat::general(
		"Docker preserves the image default user; all Linux capabilities are dropped and privilege \
		 escalation is disabled",
	));
	if backend == Backend::DockerRunscEphemeral {
		plan.add_caveat(Caveat::general(
			"Docker runsc preparation verifies that the forced runtime is registered with the active \
			 daemon",
		));
	} else if env::var_os(RUNTIME_ENV).as_deref() == Some(OsStr::new("runsc")) {
		plan.add_caveat(Caveat::general(
			"docker-ephemeral uses runsc when configured but kernel.isolation is declared only by \
			 docker-runsc-ephemeral",
		));
	}
	if !readable.is_empty() {
		plan.add_caveat(Caveat::general(
			"Docker read scopes expose declared host paths as read-only binds while container image \
			 paths remain readable",
		));
	}
	if !spec.read_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadDeny,
			"Docker read-deny masks apply only within container and mounted paths; broad host reads \
			 are never exposed",
		));
	}
	if !spec.write_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsWriteDeny,
			"Docker overlays existing denied write subtrees with read-only bind mounts",
		));
		if has_future_write_deny {
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteDeny,
				"Docker cannot pre-mount a read-only carve-out for a path that does not yet exist",
			));
		}
		if has_unmounted_write_deny {
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteDeny,
				"Docker cannot carve an image or temporary path read-only without replacing it with a \
				 host bind mount",
			));
		}
	}
	if matches!(spec.write, WriteMode::Scoped | WriteMode::Overlay) {
		plan.add_caveat(Caveat::general(
			"Docker scoped writes are mount based; hardlinks and nested host mounts under writable \
			 paths can affect objects outside the lexical scope",
		));
	}
	if spec.network == NetworkMode::Outbound {
		plan.add_caveat(Caveat::general(
			"Docker outbound mode denies listen, accept, and accept4 with the default seccomp floor; \
			 UDP bind and Unix stream servers remain possible",
		));
		plan.add_caveat(Caveat::general(
			"Docker outbound mode is not an egress filter and does not restrict destination-based \
			 exfiltration",
		));
	}
	if semantic_missing.contains(Capability::IpcRestrict) {
		plan.add_caveat(Caveat::capability(
			Capability::IpcRestrict,
			"Host bind mounts can expose Unix sockets or FIFOs despite Docker's private IPC namespace",
		));
	}
	if spec.write == WriteMode::Overlay {
		plan.set_filesystem(FilesystemVirtualizationKind::ScopedDeny);
		if semantic_missing.contains(Capability::FsWriteEphemeral) {
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"Docker overlay mode persists declared writable binds and denies other writes rather \
				 than redirecting them",
			));
		}
	} else if spec.write == WriteMode::Ephemeral {
		plan.set_filesystem(FilesystemVirtualizationKind::MemoryOverlay);
		plan.add_caveat(Caveat::general(
			"Docker discards its writable container layer with --rm; declared host binds are not \
			 copied into that layer",
		));
	}
	if spec.degradation == DegradationPolicy::AllowCaveats && spec.no_exec {
		plan.add_caveat(Caveat::capability(
			Capability::ProcNoExec,
			"Docker does not prevent the sandboxed process from executing another image",
		));
	}
	Ok(plan)
}

pub fn probe(backend: Backend) -> BackendStatus {
	let Some(image) = env::var_os(IMAGE_ENV) else {
		return BackendStatus::unavailable(backend, ProbeFailure::Configuration {
			backend,
			variable: IMAGE_ENV,
		});
	};
	let docker = env::var_os(DOCKER_ENV).unwrap_or_else(|| OsString::from("docker"));
	let runtime = runtime_for(backend);
	let info = match if runtime.is_some() {
		Command::new(&docker)
			.args([OsStr::new("info"), OsStr::new("--format"), OsStr::new("{{json .Runtimes}}")])
			.output()
	} else {
		Command::new(&docker).arg("info").output()
	} {
		Ok(output) if output.status.success() => output,
		Ok(output) => return rejected_status(backend, output),
		Err(source) => {
			return BackendStatus::unavailable(backend, ProbeFailure::Start {
				backend,
				operation: SandboxOperation::Probe,
				source,
			});
		},
	};
	if let Some(runtime) = runtime
		&& !runtime_info_has(&info.stdout, &runtime)
	{
		let mut diagnostic = info.stdout;
		diagnostic.truncate(4096);
		return BackendStatus::unavailable(backend, ProbeFailure::Rejected {
			backend,
			operation: SandboxOperation::Probe,
			status: Some(0),
			diagnostic: diagnostic.into(),
		});
	}
	match Command::new(docker)
		.args([OsStr::new("image"), OsStr::new("inspect"), &image])
		.output()
	{
		Ok(output) if output.status.success() => BackendStatus::available(backend),
		Ok(output) => rejected_status(backend, output),
		Err(source) => BackendStatus::unavailable(backend, ProbeFailure::Start {
			backend,
			operation: SandboxOperation::Probe,
			source,
		}),
	}
}

pub fn prepare(
	plan: &Plan,
	spec: &SandboxSpec,
	prepared: &mut PreparedSandbox,
) -> Result<DockerPrepared, SandboxError> {
	let backend = plan.backend();
	let docker = prepared
		.program
		.clone()
		.ok_or(SandboxError::EmptyPlanArgv { backend })?;
	let name = option_value(&prepared.args, "--name")
		.ok_or(SandboxError::MissingPlanPlaceholder { backend, placeholder: "--name" })?
		.to_owned();

	if let Some(runtime) = option_value(&prepared.args, "--runtime") {
		validate_runtime(backend, &docker, runtime)?;
	} else if backend == Backend::DockerRunscEphemeral {
		return Err(SandboxError::MissingPlanPlaceholder { backend, placeholder: "--runtime" });
	}

	let image_index = run_image_index(&prepared.args)
		.ok_or(SandboxError::MissingPlanPlaceholder { backend, placeholder: "<docker-image>" })?;
	let image = prepared.args[image_index].clone();
	let inspect = backend_output(
		backend,
		Command::new(&docker)
			.args([OsStr::new("image"), OsStr::new("inspect"), &image])
			.output(),
	)?;
	let images: Vec<ImageInspect> = serde_json::from_slice(&inspect.stdout).map_err(|source| {
		SandboxError::BackendJson { backend, operation: SandboxOperation::Prepare, source }
	})?;
	let inspected = images
		.first()
		.filter(|value| !value.id.is_empty())
		.ok_or_else(|| {
			let mut diagnostic = inspect.stdout.clone();
			diagnostic.truncate(4096);
			SandboxError::BackendCommand {
				backend,
				operation: SandboxOperation::Prepare,
				status: Some(0),
				diagnostic: diagnostic.into(),
			}
		})?;
	if has_flag(&prepared.args, "--read-only") {
		let writable = writable_destinations(&prepared.args);
		for volume in inspected
			.config
			.volumes
			.iter()
			.flat_map(|volumes| volumes.keys())
		{
			let volume = clean_container_path(volume);
			if !path_under_scopes(&volume, &writable) {
				return Err(SandboxError::ImageVolumeWrite {
					backend,
					image: OsString::from(&inspected.id),
					path: PathBuf::from(volume),
				});
			}
		}
	}
	prepared.args[image_index] = OsString::from(&inspected.id);

	let mut artifacts = Vec::new();
	if prepared.args.iter().any(|arg| arg == ENV_FILE_PLACEHOLDER) {
		let entries = prepared.environment.take().unwrap_or_default();
		let mut file = secure_temp_file("omp-sandbox-docker-env-")?;
		write_env_file(file.as_file_mut(), &entries).map_err(|source| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: file.path().to_path_buf(),
			source,
		})?;
		replace_arg(&mut prepared.args, ENV_FILE_PLACEHOLDER, file.path().as_os_str());
		artifacts.push(DockerArtifact::File(Some(file)));
		prepared.environment = None;
	}
	if prepared
		.args
		.iter()
		.any(|arg| arg.to_string_lossy().contains(SECCOMP_PLACEHOLDER))
	{
		let mut file = secure_temp_file("omp-sandbox-docker-seccomp-")?;
		file
			.write_all(OUTBOUND_SECCOMP)
			.map_err(|source| SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: file.path().to_path_buf(),
				source,
			})?;
		replace_substring(&mut prepared.args, SECCOMP_PLACEHOLDER, file.path().as_os_str());
		artifacts.push(DockerArtifact::File(Some(file)));
	}
	materialize_read_deny(backend, &mut prepared.args, &spec.read_deny, &mut artifacts)?;

	Ok(DockerPrepared::new(backend, docker, name, artifacts))
}

fn runtime_for(backend: Backend) -> Option<OsString> {
	match backend {
		Backend::DockerEphemeral => env::var_os(RUNTIME_ENV).filter(|value| !value.is_empty()),
		Backend::DockerRunscEphemeral => Some(
			env::var_os(RUNSC_RUNTIME_ENV)
				.filter(|value| !value.is_empty())
				.unwrap_or_else(|| OsString::from("runsc")),
		),
		_ => None,
	}
}

fn rejected_status(backend: Backend, output: Output) -> BackendStatus {
	let mut diagnostic = output.stderr;
	diagnostic.truncate(4096);
	BackendStatus::unavailable(backend, ProbeFailure::Rejected {
		backend,
		operation: SandboxOperation::Probe,
		status: output.status.code(),
		diagnostic: diagnostic.into(),
	})
}

fn backend_output(backend: Backend, output: io::Result<Output>) -> Result<Output, SandboxError> {
	let output = output.map_err(|source| SandboxError::BackendIo {
		backend,
		operation: SandboxOperation::Prepare,
		source,
	})?;
	if output.status.success() {
		Ok(output)
	} else {
		let mut diagnostic = output.stderr;
		diagnostic.truncate(4096);
		Err(SandboxError::BackendCommand {
			backend,
			operation: SandboxOperation::Prepare,
			status: output.status.code(),
			diagnostic: CowBytes::from(diagnostic),
		})
	}
}

fn validate_runtime(backend: Backend, docker: &OsStr, runtime: &OsStr) -> Result<(), SandboxError> {
	let output = backend_output(
		backend,
		Command::new(docker)
			.args([OsStr::new("info"), OsStr::new("--format"), OsStr::new("{{json .Runtimes}}")])
			.output(),
	)?;
	if runtime_info_has(&output.stdout, runtime) {
		Ok(())
	} else {
		let mut diagnostic = output.stdout;
		diagnostic.truncate(4096);
		Err(SandboxError::BackendCommand {
			backend,
			operation: SandboxOperation::Prepare,
			status: Some(0),
			diagnostic: diagnostic.into(),
		})
	}
}

fn runtime_info_has(data: &[u8], runtime: &OsStr) -> bool {
	let Ok(runtimes) =
		serde_json::from_slice::<std::collections::BTreeMap<String, serde_json::Value>>(data)
	else {
		return false;
	};
	runtime
		.to_str()
		.is_some_and(|runtime| runtimes.contains_key(runtime))
}

fn push_pair(argv: &mut Vec<OsString>, option: &str, value: &OsStr) {
	argv.extend([OsString::from(option), value.to_owned()]);
}

fn push_mount(
	argv: &mut Vec<OsString>,
	backend: Backend,
	source: &Path,
	destination: &Path,
	readonly: bool,
) -> Result<(), SandboxError> {
	let Some(source_text) = source.to_str() else {
		return Err(SandboxError::InvalidMountPath { backend, path: source.to_path_buf() });
	};
	let Some(destination_text) = destination.to_str() else {
		return Err(SandboxError::InvalidMountPath { backend, path: destination.to_path_buf() });
	};
	if source_text.contains(',')
		|| source_text.contains('\r')
		|| source_text.contains('\n')
		|| destination_text.contains(',')
		|| destination_text.contains('\r')
		|| destination_text.contains('\n')
	{
		return Err(SandboxError::InvalidMountPath { backend, path: source.to_path_buf() });
	}
	let mut mount = format!("type=bind,src={source_text},dst={destination_text}");
	if readonly {
		mount.push_str(",readonly");
	}
	push_pair(argv, "--mount", OsStr::new(&mount));
	Ok(())
}

fn option_value<'a>(argv: &'a [OsString], option: &str) -> Option<&'a OsStr> {
	argv
		.windows(2)
		.find(|pair| pair[0] == option)
		.map(|pair| pair[1].as_os_str())
}

fn has_flag(argv: &[OsString], flag: &str) -> bool {
	let end = run_image_index(argv).unwrap_or(argv.len());
	argv[..end].iter().any(|arg| arg == flag)
}

fn run_image_index(argv: &[OsString]) -> Option<usize> {
	if argv.first()? != "run" {
		return None;
	}
	let mut index = 1;
	while index < argv.len() {
		let arg = argv[index].to_string_lossy();
		if arg == "--" {
			return (index + 1 < argv.len()).then_some(index + 1);
		}
		if arg == "--rm" || arg == "--read-only" {
			index += 1;
			continue;
		}
		if arg.starts_with("--") {
			if arg.contains('=') {
				index += 1;
			} else if option_takes_value(&arg) {
				index += 2;
			} else {
				index += 1;
			}
			continue;
		}
		return Some(index);
	}
	None
}

fn option_takes_value(option: &str) -> bool {
	matches!(
		option,
		"--name"
			| "--ipc"
			| "--cap-drop"
			| "--runtime"
			| "--tmpfs"
			| "--mount"
			| "--workdir"
			| "--cpus"
			| "--memory"
			| "--memory-swap"
			| "--pids-limit"
			| "--network"
			| "--security-opt"
			| "--env-file"
	)
}

fn writable_destinations(argv: &[OsString]) -> Vec<String> {
	let mut destinations = Vec::new();
	let end = run_image_index(argv).unwrap_or(argv.len());
	let mut index = 0;
	while index + 1 < end {
		match argv[index].to_str() {
			Some("--tmpfs") => destinations.push(clean_container_path(
				argv[index + 1]
					.to_string_lossy()
					.split(':')
					.next()
					.unwrap_or_default(),
			)),
			Some("--mount") => {
				let mount = argv[index + 1].to_string_lossy();
				if mount_writable(&mount)
					&& let Some(destination) = mount_destination(&mount)
				{
					destinations.push(destination);
				}
			},
			_ => {},
		}
		index += 1;
	}
	destinations
}

fn mount_writable(mount: &str) -> bool {
	let mut bind = false;
	for part in mount.split(',') {
		if matches!(part, "readonly" | "ro" | "readonly=true" | "ro=true" | "readonly=1" | "ro=1") {
			return false;
		}
		if matches!(part, "type=bind" | "type=volume" | "type=tmpfs") {
			bind = true;
		}
	}
	bind
}

fn mount_destination(mount: &str) -> Option<String> {
	mount.split(',').find_map(|part| {
		["dst=", "destination=", "target="]
			.into_iter()
			.find_map(|prefix| part.strip_prefix(prefix))
			.map(clean_container_path)
	})
}

fn clean_container_path(path: &str) -> String {
	let mut components = Vec::new();
	for component in path.split('/') {
		match component {
			"" | "." => {},
			".." => {
				components.pop();
			},
			value => components.push(value),
		}
	}
	format!("/{}", components.join("/"))
}

fn path_under_scopes(path: &str, scopes: &[String]) -> bool {
	scopes.iter().any(|scope| {
		path == scope
			|| scope == "/"
			|| path
				.strip_prefix(scope)
				.is_some_and(|tail| tail.starts_with('/'))
	})
}

fn secure_temp_file(prefix: &str) -> Result<NamedTempFile, SandboxError> {
	let file =
		Builder::new()
			.prefix(prefix)
			.tempfile()
			.map_err(|source| SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: env::temp_dir(),
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

fn write_env_file(file: &mut fs::File, entries: &[OsString]) -> io::Result<()> {
	for entry in entries {
		let bytes = os_string_bytes(entry);
		if bytes.contains(&b'\n') || bytes.contains(&b'\r') {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"Docker environment entries cannot contain newlines",
			));
		}
		file.write_all(&bytes)?;
		file.write_all(b"\n")?;
	}
	file.flush()
}

fn replace_arg(argv: &mut [OsString], placeholder: &str, value: &OsStr) {
	for arg in argv {
		if arg == placeholder {
			*arg = value.to_owned();
		}
	}
}

fn replace_substring(argv: &mut [OsString], placeholder: &str, value: &OsStr) {
	let value = value.to_string_lossy();
	for arg in argv {
		if arg.to_string_lossy().contains(placeholder) {
			*arg = OsString::from(arg.to_string_lossy().replace(placeholder, &value));
		}
	}
}

fn materialize_read_deny(
	backend: Backend,
	argv: &mut Vec<OsString>,
	read_deny: &[PathBuf],
	artifacts: &mut Vec<DockerArtifact>,
) -> Result<(), SandboxError> {
	if read_deny.is_empty() {
		return Ok(());
	}
	let directory = Builder::new()
		.prefix("omp-sandbox-docker-read-deny-")
		.tempdir()
		.map_err(|source| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: env::temp_dir(),
			source,
		})?;
	let mut mounts = Vec::new();
	for (index, denied) in read_deny.iter().enumerate() {
		let metadata = match fs::symlink_metadata(denied) {
			Ok(metadata) => metadata,
			Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
			Err(source) => {
				return Err(SandboxError::Artifact {
					operation: SandboxOperation::Prepare,
					path: denied.clone(),
					source,
				});
			},
		};
		let mask = directory.path().join(format!("mask-{index}"));
		if metadata.is_dir() {
			fs::create_dir(&mask).map_err(|source| SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: mask.clone(),
				source,
			})?;
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt as _;
				fs::set_permissions(&mask, fs::Permissions::from_mode(0o700)).map_err(|source| {
					SandboxError::Artifact {
						operation: SandboxOperation::Prepare,
						path: mask.clone(),
						source,
					}
				})?;
			}
		} else {
			let file = fs::OpenOptions::new()
				.create_new(true)
				.write(true)
				.open(&mask)
				.map_err(|source| SandboxError::Artifact {
					operation: SandboxOperation::Prepare,
					path: mask.clone(),
					source,
				})?;
			drop(file);
			#[cfg(unix)]
			{
				use std::os::unix::fs::PermissionsExt as _;
				fs::set_permissions(&mask, fs::Permissions::from_mode(0o600)).map_err(|source| {
					SandboxError::Artifact {
						operation: SandboxOperation::Prepare,
						path: mask.clone(),
						source,
					}
				})?;
			}
		}
		push_mount(&mut mounts, backend, &mask, denied, true)?;
	}
	if mounts.is_empty() {
		return Ok(());
	}
	let image = run_image_index(argv)
		.ok_or(SandboxError::MissingPlanPlaceholder { backend, placeholder: "<docker-image>" })?;
	argv.splice(image..image, mounts);
	artifacts.push(DockerArtifact::Directory(Some(directory)));
	Ok(())
}
