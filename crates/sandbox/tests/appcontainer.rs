//! `AppContainer` plan, ACL, environment, and resource-limit contracts.

use std::{ffi::OsString, path::PathBuf};

use omp_sandbox::{
	Backend, Capability, DegradationPolicy, EnvironmentSource, FilesystemVirtualizationKind,
	NetworkMode, ResourceLimits, Runner, SandboxSpec, WriteMode,
};
#[cfg(windows)]
use omp_sandbox::{OutputMode, RunOptions, SandboxError, SandboxInput, SandboxOperation};

fn executable() -> PathBuf {
	std::env::current_exe().expect("test executable path")
}

#[test]
fn network_capability_sids_are_exact() {
	let root = tempfile::tempdir().unwrap();
	for (mode, expected, absent) in [
		(NetworkMode::Disabled, &[][..], &["WinCapabilityInternetClientSid"][..]),
		(
			NetworkMode::Enabled,
			&["WinCapabilityInternetClientServerSid", "WinCapabilityPrivateNetworkClientServerSid"][..],
			&["WinCapabilityInternetClientSid"][..],
		),
		(
			NetworkMode::Outbound,
			&["WinCapabilityInternetClientSid"][..],
			&["WinCapabilityInternetClientServerSid", "WinCapabilityPrivateNetworkClientServerSid"][..],
		),
	] {
		let mut spec = SandboxSpec::new(executable());
		spec.allow_read(root.path()).unwrap();
		spec.set_network(mode);
		if mode != NetworkMode::Disabled {
			spec.set_degradation(DegradationPolicy::AllowCaveats);
		}
		let plan = Runner::for_backend(Backend::AppContainer)
			.compile(&spec)
			.unwrap();
		let profile = plan.profile().unwrap();
		for &fragment in expected {
			assert!(profile.contains(fragment), "missing {fragment}:\n{profile}");
		}
		for &fragment in absent {
			assert!(!profile.contains(fragment), "unexpected {fragment}:\n{profile}");
		}
		assert!(profile.contains("all application packages: opt-out"));
		assert!(
			plan
				.enforced()
				.difference(Backend::AppContainer.capabilities())
				.is_empty()
		);
	}
}

#[test]
fn plan_preview_is_secret_free_and_environment_shape_is_deferred() {
	let root = tempfile::tempdir().unwrap();
	let secret = "OMP_APP_CONTAINER_SECRET=do-not-leak-in-plan";
	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(root.path()).unwrap();
	spec.set_environment(EnvironmentSource::Exact(vec![OsString::from(secret)]));
	spec.deny_env("DROP_*").unwrap();
	let plan = Runner::for_backend(Backend::AppContainer)
		.compile(&spec)
		.unwrap();
	assert!(
		plan
			.argv()
			.iter()
			.all(|arg| !arg.to_string_lossy().contains(secret))
	);
	assert!(!plan.profile().unwrap().contains(secret));
	assert!(plan.enforced().contains(Capability::EnvScrub));
}

#[test]
fn preview_orders_acl_denies_before_read_and_write_allows() {
	let root = tempfile::tempdir().unwrap();
	let denied = root.path().join("future-secret");
	let writable = root.path().join("writable");
	std::fs::create_dir(&writable).unwrap();
	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(root.path()).unwrap();
	spec.deny_read(&denied).unwrap();
	spec
		.set_write(WriteMode::Scoped)
		.allow_write(&writable)
		.unwrap();
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = Runner::for_backend(Backend::AppContainer)
		.compile(&spec)
		.unwrap();
	let profile = plan.profile().unwrap();
	let deny = profile.find("read deny:").unwrap();
	let read = profile.find("read grants:").unwrap();
	let write = profile.find("write grants:").unwrap();
	assert!(deny < read && read < write, "{profile}");
	assert!(profile.contains(denied.to_string_lossy().as_ref()));
	assert!(profile.contains(writable.to_string_lossy().as_ref()));
}

#[test]
fn ephemeral_preview_requests_workspace_copy() {
	let root = tempfile::tempdir().unwrap();
	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(root.path()).unwrap();
	spec.set_dir(root.path()).unwrap();
	spec.set_write(WriteMode::Ephemeral);
	let plan = Runner::for_backend(Backend::AppContainer)
		.compile(&spec)
		.unwrap();
	assert_eq!(plan.filesystem_virtualization(), Some(FilesystemVirtualizationKind::WorkspaceClone));
	assert!(
		plan
			.profile()
			.unwrap()
			.contains("@OMP_APP_CONTAINER_EPHEMERAL_ROOT@")
	);
	assert!(plan.enforced().contains(Capability::FsWriteEphemeral));
}

#[test]
fn job_limits_and_child_policy_are_visible_without_runtime_values() {
	let root = tempfile::tempdir().unwrap();
	let limits = ResourceLimits::new(Some(1.5), Some(512 << 20), Some(3)).unwrap();
	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(root.path()).unwrap();
	spec.set_no_exec(true).set_resource_limits(limits);
	let plan = Runner::for_backend(Backend::AppContainer)
		.compile(&spec)
		.unwrap();
	let profile = plan.profile().unwrap();
	assert!(profile.contains("child process policy: restricted"));
	assert!(profile.contains("cpu limit: 1.5 cores"));
	assert!(profile.contains("memory limit: 536870912 bytes"));
	assert!(profile.contains("process limit: 3"));
	for capability in
		[Capability::ProcNoExec, Capability::ResCpu, Capability::ResMemory, Capability::ResPids]
	{
		assert!(plan.enforced().contains(capability));
	}
}

#[cfg(windows)]
#[tokio::test]
async fn appcontainer_live_scopes_ephemerality_and_child_restriction() {
	use std::{fs, process::Command};

	if std::env::var_os("OMP_SANDBOX_WINDOWS_CHILD").is_some() {
		let mode = std::env::var("OMP_SANDBOX_WINDOWS_CHILD").unwrap();
		match mode.as_str() {
			"scoped" => {
				fs::write(std::env::var_os("OMP_ALLOWED").unwrap(), b"ok").unwrap();
				assert!(fs::write(std::env::var_os("OMP_DENIED").unwrap(), b"denied").is_err());
			},
			"ephemeral" => fs::write("ephemeral.txt", b"private").unwrap(),
			"child" => assert!(Command::new(executable()).arg("--help").status().is_err()),
			other => panic!("unknown child mode {other}"),
		}
		return;
	}
	if std::env::var_os("OMP_SANDBOX_WINDOWS_E2E").is_none() {
		return;
	}

	let workspace = tempfile::tempdir().unwrap();
	let outside = tempfile::tempdir().unwrap();
	let allowed = workspace.path().join("allowed.txt");
	let denied = outside.path().join("denied.txt");
	let child_args =
		["--exact", "appcontainer_live_scopes_ephemerality_and_child_restriction", "--nocapture"];

	let mut scoped = SandboxSpec::new(executable());
	scoped.args(child_args).set_dir(workspace.path()).unwrap();
	scoped.allow_read(workspace.path()).unwrap();
	scoped
		.set_write(WriteMode::Scoped)
		.allow_write(workspace.path())
		.unwrap();
	scoped.set_environment(EnvironmentSource::Exact(vec![
		OsString::from("OMP_SANDBOX_WINDOWS_CHILD=scoped"),
		OsString::from(format!("OMP_ALLOWED={}", allowed.display())),
		OsString::from(format!("OMP_DENIED={}", denied.display())),
	]));
	let output = Runner::for_backend(Backend::AppContainer)
		.run(&scoped, capture_options())
		.await
		.unwrap();
	assert_eq!(output.exit.code, Some(0), "{}", String::from_utf8_lossy(&output.stderr));
	assert_eq!(fs::read(&allowed).unwrap(), b"ok");
	assert!(!denied.exists());

	let mut ephemeral = SandboxSpec::new(executable());
	ephemeral
		.args(child_args)
		.set_dir(workspace.path())
		.unwrap();
	ephemeral.allow_read(workspace.path()).unwrap();
	ephemeral.set_write(WriteMode::Ephemeral);
	ephemeral.set_environment(EnvironmentSource::Exact(vec![OsString::from(
		"OMP_SANDBOX_WINDOWS_CHILD=ephemeral",
	)]));
	let output = Runner::for_backend(Backend::AppContainer)
		.run(&ephemeral, capture_options())
		.await
		.unwrap();
	assert_eq!(output.exit.code, Some(0), "{}", String::from_utf8_lossy(&output.stderr));
	assert!(!workspace.path().join("ephemeral.txt").exists());

	let mut restricted = SandboxSpec::new(executable());
	restricted
		.args(child_args)
		.allow_read(workspace.path())
		.unwrap();
	restricted.set_no_exec(true);
	restricted
		.set_resource_limits(ResourceLimits::new(Some(1.0), Some(512 << 20), Some(1)).unwrap());
	restricted.set_environment(EnvironmentSource::Exact(vec![OsString::from(
		"OMP_SANDBOX_WINDOWS_CHILD=child",
	)]));
	let output = Runner::for_backend(Backend::AppContainer)
		.run(&restricted, capture_options())
		.await
		.unwrap();
	assert_eq!(output.exit.code, Some(0), "{}", String::from_utf8_lossy(&output.stderr));

	let reparse_root = tempfile::tempdir().unwrap();
	let target = outside.path().join("target.txt");
	fs::write(&target, b"outside").unwrap();
	std::os::windows::fs::symlink_file(&target, reparse_root.path().join("escape")).unwrap();
	let mut reparse = SandboxSpec::new(executable());
	reparse.allow_read(reparse_root.path()).unwrap();
	let error = Runner::for_backend(Backend::AppContainer)
		.run(&reparse, capture_options())
		.await
		.unwrap_err();
	assert!(matches!(error, SandboxError::BackendPath {
		backend: Backend::AppContainer,
		operation: SandboxOperation::Prepare,
		..
	}));
}

#[cfg(windows)]
fn capture_options() -> RunOptions {
	RunOptions {
		input:   SandboxInput::Null,
		stdout:  OutputMode::Capture,
		stderr:  OutputMode::Capture,
		timeout: Some(std::time::Duration::from_secs(30)),
	}
}
