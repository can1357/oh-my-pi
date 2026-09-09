#![cfg(unix)]
//! Docker plan, preparation, and opt-in live runtime contracts.

use std::{
	ffi::{OsStr, OsString},
	fs,
	os::unix::fs::{MetadataExt as _, PermissionsExt as _},
	path::{Path, PathBuf},
	process::Command,
	time::Duration,
};

use omp_sandbox::{
	Backend, Capability, DegradationPolicy, EnvironmentSource, NetworkMode, OutputMode,
	ResourceLimits, RunOptions, Runner, SandboxError, SandboxSpec, WriteMode,
};
use tempfile::TempDir;
use tokio::sync::Mutex;

static ENV_LOCK: Mutex<()> = Mutex::const_new(());

struct EnvRestore(Vec<(&'static str, Option<OsString>)>);

impl EnvRestore {
	fn set(values: &[(&'static str, &OsStr)]) -> Self {
		let old = values
			.iter()
			.map(|(name, _)| (*name, std::env::var_os(name)))
			.collect();
		for (name, value) in values {
			// SAFETY: every Docker test serializes environment mutation through ENV_LOCK.
			unsafe { std::env::set_var(name, value) };
		}
		Self(old)
	}
}

impl Drop for EnvRestore {
	fn drop(&mut self) {
		for (name, value) in self.0.drain(..).rev() {
			// SAFETY: the ENV_LOCK guard outlives this restoration guard.
			unsafe {
				if let Some(value) = value {
					std::env::set_var(name, value);
				} else {
					std::env::remove_var(name);
				}
			}
		}
	}
}

fn argv(plan: &omp_sandbox::Plan) -> Vec<String> {
	plan
		.argv()
		.iter()
		.map(|arg| arg.to_string_lossy().into_owned())
		.collect()
}

fn value_after<'a>(argv: &'a [String], option: &str) -> &'a str {
	let index = argv
		.iter()
		.position(|arg| arg == option)
		.expect("missing Docker option");
	argv.get(index + 1).expect("missing Docker option value")
}

fn assert_pair(argv: &[String], option: &str, value: &str) {
	assert!(
		argv
			.windows(2)
			.any(|pair| pair[0] == option && pair[1] == value),
		"missing {option} {value}: {argv:?}",
	);
}

fn assert_honest(plan: &omp_sandbox::Plan) {
	assert!(
		plan
			.enforced()
			.difference(plan.backend().capabilities())
			.is_empty()
	);
}

#[test]
fn docker_plans_are_hardened_deterministic_and_secret_free() {
	let _lock = ENV_LOCK.blocking_lock();
	let root = TempDir::new().expect("temp root");
	let readable = root.path().join("readable");
	let writable = root.path().join("writable");
	fs::create_dir(&readable).expect("readable directory");
	fs::create_dir(&writable).expect("writable directory");
	let _env = EnvRestore::set(&[
		("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("example.test/omp:latest")),
		("OMP_SANDBOX_DOCKER", OsStr::new("docker-custom")),
		("OMP_SANDBOX_DOCKER_RUNTIME", OsStr::new("runc-custom")),
	]);

	let mut spec = SandboxSpec::new("/bin/echo");
	spec
		.arg("hello")
		.set_network(NetworkMode::Outbound)
		.set_write(WriteMode::Scoped)
		.set_environment(EnvironmentSource::Exact(vec![OsString::from("TOKEN=top-secret")]))
		.set_resource_limits(ResourceLimits::new(Some(1.5), Some(67_108_864), Some(23)).unwrap())
		.set_degradation(DegradationPolicy::AllowCaveats);
	spec.allow_read(&readable).unwrap();
	spec.allow_write(&writable).unwrap();
	spec.set_dir(&writable).unwrap();

	let runner = Runner::for_backend(Backend::DockerEphemeral);
	let first = runner.compile(&spec).expect("compile Docker plan");
	let second = runner
		.compile(&spec)
		.expect("compile deterministic Docker plan");
	let args = argv(&first);
	assert_eq!(args, argv(&second));
	assert_eq!(args[0], "docker-custom");
	assert_eq!(args[1], "run");
	assert_pair(&args, "--ipc", "private");
	assert_pair(&args, "--cap-drop", "ALL");
	assert_pair(&args, "--security-opt", "no-new-privileges");
	assert_pair(&args, "--runtime", "runc-custom");
	assert_pair(&args, "--cpus", "1.5");
	assert_pair(&args, "--memory", "67108864");
	assert_pair(&args, "--memory-swap", "67108864");
	assert_pair(&args, "--pids-limit", "23");
	assert_pair(&args, "--security-opt", "seccomp=<omp-sandbox-docker-outbound-seccomp>");
	assert_pair(&args, "--env-file", "<omp-sandbox-docker-env-file>");
	assert!(args.iter().any(|arg| arg == "--read-only"));
	assert!(
		!args
			.iter()
			.any(|arg| matches!(arg.as_str(), "--user" | "-u"))
	);
	assert!(!args.iter().any(|arg| arg.contains("top-secret")));
	assert!(value_after(&args, "--name").starts_with("omp-sandbox-"));
	assert_eq!(value_after(&args, "--name").len(), "omp-sandbox-".len() + 16);
	assert_honest(&first);
	assert!(!first.enforced().contains(Capability::IpcRestrict));
	assert!(
		first
			.caveats()
			.iter()
			.any(|caveat| caveat.capability == Some(Capability::IpcRestrict))
	);
}

#[test]
fn docker_write_and_network_modes_map_exactly() {
	let _lock = ENV_LOCK.blocking_lock();
	let _env = EnvRestore::set(&[
		("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("alpine:latest")),
		("OMP_SANDBOX_DOCKER_RUNTIME", OsStr::new("")),
	]);
	let runner = Runner::for_backend(Backend::DockerEphemeral);

	let mut deny = SandboxSpec::new("/bin/true");
	deny.set_degradation(DegradationPolicy::AllowCaveats);
	let deny_plan = runner.compile(&deny).unwrap();
	let deny_args = argv(&deny_plan);
	assert_pair(&deny_args, "--network", "none");
	assert_pair(&deny_args, "--tmpfs", "/tmp");
	assert_pair(&deny_args, "--tmpfs", "/run");
	assert!(deny_args.iter().any(|arg| arg == "--read-only"));
	assert_honest(&deny_plan);

	let mut ephemeral = SandboxSpec::new("/bin/true");
	ephemeral
		.set_write(WriteMode::Ephemeral)
		.set_network(NetworkMode::Enabled)
		.set_degradation(DegradationPolicy::AllowCaveats);
	let ephemeral_plan = runner.compile(&ephemeral).unwrap();
	let ephemeral_args = argv(&ephemeral_plan);
	assert!(!ephemeral_args.iter().any(|arg| arg == "--read-only"));
	assert!(
		!ephemeral_args
			.windows(2)
			.any(|pair| pair[0] == "--network" && pair[1] == "none"),
	);
	assert!(
		ephemeral_plan
			.enforced()
			.contains(Capability::FsWriteEphemeral)
	);
	assert_honest(&ephemeral_plan);
}

#[test]
fn docker_runsc_forces_only_the_configured_registered_runtime() {
	let _lock = ENV_LOCK.blocking_lock();
	let _env = EnvRestore::set(&[
		("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("alpine:latest")),
		("OMP_SANDBOX_DOCKER_RUNSC_RUNTIME", OsStr::new("runsc-custom")),
	]);
	let mut spec = SandboxSpec::new("/bin/true");
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = Runner::for_backend(Backend::DockerRunscEphemeral)
		.compile(&spec)
		.unwrap();
	let args = argv(&plan);
	assert_pair(&args, "--runtime", "runsc-custom");
	assert!(plan.enforced().contains(Capability::KernelIsolation));
	assert!(
		!Backend::DockerEphemeral
			.capabilities()
			.contains(Capability::KernelIsolation)
	);
	assert!(
		Backend::DockerRunscEphemeral
			.capabilities()
			.contains(Capability::KernelIsolation)
	);
	assert_honest(&plan);
}

#[test]
fn docker_overlay_is_rejected_strictly_and_caveated_honestly() {
	let _lock = ENV_LOCK.blocking_lock();
	let root = TempDir::new().unwrap();
	let _env = EnvRestore::set(&[("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("alpine"))]);
	let mut spec = SandboxSpec::new("/bin/true");
	spec.set_write(WriteMode::Overlay);
	spec.allow_write(root.path()).unwrap();
	let error = Runner::for_backend(Backend::DockerEphemeral)
		.compile(&spec)
		.unwrap_err();
	assert!(
		matches!(error, SandboxError::BackendCapabilities { backend: Backend::DockerEphemeral, missing } if missing.contains(Capability::FsWriteEphemeral))
	);

	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = Runner::for_backend(Backend::DockerEphemeral)
		.compile(&spec)
		.unwrap();
	assert!(!plan.enforced().contains(Capability::FsWriteEphemeral));
	assert!(plan.enforced().contains(Capability::FsWriteScope));
	assert!(
		plan
			.caveats()
			.iter()
			.any(|caveat| caveat.capability == Some(Capability::FsWriteEphemeral))
	);
	assert_honest(&plan);
}

#[test]
fn docker_mounted_workdir_uses_component_boundaries() {
	let _lock = ENV_LOCK.blocking_lock();
	let root = TempDir::new().unwrap();
	let work = root.path().join("work");
	let worker = root.path().join("worker");
	fs::create_dir(&work).unwrap();
	fs::create_dir(&worker).unwrap();
	let _env = EnvRestore::set(&[("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("alpine"))]);
	let mut spec = SandboxSpec::new("/bin/true");
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	spec.allow_read(&work).unwrap();
	spec.set_dir(&worker).unwrap();
	assert!(
		Runner::for_backend(Backend::DockerEphemeral)
			.compile(&spec)
			.is_err()
	);
}

fn fake_docker(root: &Path) -> PathBuf {
	let path = root.join("docker-fake");
	fs::write(
		&path,
		br#"#!/bin/sh
if [ "$1" = "info" ]; then
  printf '%s\n' '{"runc":{},"runsc":{},"runsc-custom":{}}'
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  printf '%s\n' "$OMP_TEST_DOCKER_INSPECT"
  exit 0
fi
if [ "$1" = "rm" ]; then
  exit 0
fi
exit 97
"#,
	)
	.unwrap();
	fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
	path
}

#[test]
fn docker_prepare_locks_image_materializes_private_files_and_owns_cleanup() {
	let _lock = ENV_LOCK.blocking_lock();
	let root = TempDir::new().unwrap();
	let docker = fake_docker(root.path());
	let denied = root.path().join("secret");
	fs::write(&denied, b"secret").unwrap();
	let inspect = r#"[{"Id":"sha256:immutable","Config":{"Volumes":{}}}]"#;
	let _env = EnvRestore::set(&[
		("OMP_SANDBOX_DOCKER", docker.as_os_str()),
		("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("alpine:latest")),
		("OMP_SANDBOX_DOCKER_RUNTIME", OsStr::new("")),
		("OMP_TEST_DOCKER_INSPECT", OsStr::new(inspect)),
	]);
	let mut spec = SandboxSpec::new("/bin/true");
	spec
		.set_network(NetworkMode::Outbound)
		.set_environment(EnvironmentSource::Exact(vec![OsString::from("TOKEN=private-value")]))
		.set_degradation(DegradationPolicy::AllowCaveats);
	spec.deny_read(&denied).unwrap();
	let runner = Runner::for_backend(Backend::DockerEphemeral);
	let plan = runner.compile(&spec).unwrap();
	assert!(!argv(&plan).iter().any(|arg| arg.contains("private-value")));
	let prepared = runner.prepare(plan, &spec).unwrap();
	let args: Vec<String> = prepared
		.args()
		.iter()
		.map(|arg| arg.to_string_lossy().into_owned())
		.collect();
	assert!(args.iter().any(|arg| arg == "sha256:immutable"));
	assert!(!args.iter().any(|arg| arg.contains("<omp-sandbox")));
	assert!(prepared.environment().is_none());

	let env_path = PathBuf::from(value_after(&args, "--env-file"));
	let seccomp_path = args
		.windows(2)
		.find(|pair| pair[0] == "--security-opt" && pair[1].starts_with("seccomp="))
		.map(|pair| PathBuf::from(pair[1].trim_start_matches("seccomp=")))
		.unwrap();
	assert_eq!(fs::metadata(&env_path).unwrap().mode() & 0o777, 0o600);
	assert_eq!(fs::metadata(&seccomp_path).unwrap().mode() & 0o777, 0o600);
	assert_eq!(fs::read(&env_path).unwrap(), b"TOKEN=private-value\n");
	let profile: serde_json::Value =
		serde_json::from_slice(&fs::read(&seccomp_path).unwrap()).unwrap();
	assert_eq!(profile["defaultAction"], "SCMP_ACT_ERRNO");
	let encoded = profile.to_string();
	assert!(!encoded.contains("\"listen\""));
	assert!(!encoded.contains("\"accept\""));
	assert!(!encoded.contains("\"accept4\""));
	assert!(encoded.contains("\"bind\""));
	let image_index = args
		.iter()
		.position(|arg| arg == "sha256:immutable")
		.unwrap();
	let denied_text = denied.to_string_lossy();
	let mask_index = args
		.iter()
		.position(|arg| arg.contains(denied_text.as_ref()))
		.unwrap();
	assert!(mask_index < image_index);

	drop(prepared);
	assert!(!env_path.exists());
	assert!(!seccomp_path.exists());
}

#[test]
fn docker_runsc_prepare_rejects_an_unregistered_runtime() {
	let _lock = ENV_LOCK.blocking_lock();
	let root = TempDir::new().unwrap();
	let docker = fake_docker(root.path());
	let inspect = r#"[{"Id":"sha256:immutable","Config":{"Volumes":{}}}]"#;
	let _env = EnvRestore::set(&[
		("OMP_SANDBOX_DOCKER", docker.as_os_str()),
		("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("alpine:latest")),
		("OMP_SANDBOX_DOCKER_RUNSC_RUNTIME", OsStr::new("missing-runsc")),
		("OMP_TEST_DOCKER_INSPECT", OsStr::new(inspect)),
	]);
	let mut spec = SandboxSpec::new("/bin/true");
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let runner = Runner::for_backend(Backend::DockerRunscEphemeral);
	let plan = runner.compile(&spec).unwrap();
	let error = match runner.prepare(plan, &spec) {
		Ok(_) => panic!("unregistered runsc runtime unexpectedly accepted"),
		Err(error) => error,
	};
	assert!(matches!(
		error,
		SandboxError::BackendUnavailable { backend: Backend::DockerRunscEphemeral, .. }
			| SandboxError::BackendCommand { backend: Backend::DockerRunscEphemeral, .. }
	));
}

#[test]
fn docker_prepare_rejects_undeclared_writable_image_volumes() {
	let _lock = ENV_LOCK.blocking_lock();
	let root = TempDir::new().unwrap();
	let docker = fake_docker(root.path());
	let inspect = r#"[{"Id":"sha256:immutable","Config":{"Volumes":{"/data":{}}}}]"#;
	let _env = EnvRestore::set(&[
		("OMP_SANDBOX_DOCKER", docker.as_os_str()),
		("OMP_SANDBOX_DOCKER_IMAGE", OsStr::new("volume-image:latest")),
		("OMP_SANDBOX_DOCKER_RUNTIME", OsStr::new("")),
		("OMP_TEST_DOCKER_INSPECT", OsStr::new(inspect)),
	]);
	let mut spec = SandboxSpec::new("/bin/true");
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let runner = Runner::for_backend(Backend::DockerEphemeral);
	let plan = runner.compile(&spec).unwrap();
	let error = match runner.prepare(plan, &spec) {
		Ok(_) => panic!("writable image volume unexpectedly accepted"),
		Err(error) => error,
	};
	assert!(
		matches!(error, SandboxError::ImageVolumeWrite { backend: Backend::DockerEphemeral, image, path } if image == OsString::from("sha256:immutable") && path == Path::new("/data"))
	);
}

#[tokio::test(flavor = "current_thread")]
async fn docker_live_ephemeral_environment_and_outbound_listen_contract() {
	if std::env::var_os("OMP_SANDBOX_DOCKER_E2E").as_deref() != Some(OsStr::new("1")) {
		return;
	}
	let _lock = ENV_LOCK.lock().await;
	let mut layer = SandboxSpec::new("/bin/sh");
	layer
		.args([
			"-c",
			"test \"$VISIBLE\" = ok && test -z \"$SECRET\" && echo payload >/omp-layer && cat \
			 /omp-layer",
		])
		.set_environment(EnvironmentSource::Exact(vec![OsString::from("VISIBLE=ok")]))
		.set_write(WriteMode::Ephemeral)
		.set_degradation(DegradationPolicy::AllowCaveats);
	let runner = Runner::for_backend(Backend::DockerEphemeral);
	let output = runner
		.run(&layer, RunOptions {
			stdout: OutputMode::Capture,
			stderr: OutputMode::Capture,
			..RunOptions::default()
		})
		.await
		.expect("Docker ephemeral live run");
	assert_eq!(output.exit.code, Some(0), "stderr={:?}", output.stderr);
	assert_eq!(output.stdout.as_ref(), b"payload\n");

	let mut absent = SandboxSpec::new("/bin/sh");
	absent
		.args(["-c", "test ! -e /omp-layer"])
		.set_write(WriteMode::Ephemeral)
		.set_degradation(DegradationPolicy::AllowCaveats);
	let output = runner
		.run(&absent, RunOptions::default())
		.await
		.expect("second Docker layer");
	assert_eq!(output.exit.code, Some(0));

	let mut listen = SandboxSpec::new("/usr/bin/python3");
	listen
		.args(["-c", "import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen()"])
		.set_network(NetworkMode::Outbound)
		.set_degradation(DegradationPolicy::AllowCaveats);
	let output = runner
		.run(&listen, RunOptions { stderr: OutputMode::Capture, ..RunOptions::default() })
		.await
		.expect("Docker outbound live run");
	assert_ne!(output.exit.code, Some(0), "seccomp unexpectedly permitted listen");

	let mut sleeper = SandboxSpec::new("/bin/sh");
	sleeper
		.args(["-c", "sleep 60"])
		.set_write(WriteMode::Ephemeral)
		.set_degradation(DegradationPolicy::AllowCaveats);
	let sleeper_plan = runner.compile(&sleeper).expect("compile timeout plan");
	let sleeper_args = argv(&sleeper_plan);
	let container_name = value_after(&sleeper_args, "--name").to_owned();
	let error = runner
		.run(&sleeper, RunOptions {
			timeout: Some(Duration::from_millis(250)),
			..RunOptions::default()
		})
		.await
		.expect_err("Docker timeout must terminate the container");
	assert!(matches!(error, SandboxError::Timeout { backend: Backend::DockerEphemeral }));
	let docker = std::env::var_os("OMP_SANDBOX_DOCKER").unwrap_or_else(|| OsString::from("docker"));
	let inspect = Command::new(docker)
		.args(["container", "inspect", container_name.as_str()])
		.output()
		.expect("inspect timed-out container");
	assert!(!inspect.status.success(), "timed-out Docker container still exists");
}
