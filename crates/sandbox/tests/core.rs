//! Core sandbox capability, specification, and preparation contracts.

use std::{ffi::OsString, fs, path::Path};

use omp_sandbox::{
	Backend, Capability, CapabilitySet, CommandWrapper, DegradationPolicy, EnvironmentSource,
	NetworkMode, ResourceLimits, Runner, SandboxError, SandboxSpec, SpecViolation, WriteMode,
	core_environment_names, portable_capabilities, validate_env_pattern,
};
use tempfile::tempdir;

#[test]
fn capability_sets_are_sorted_and_closed_under_algebra() {
	let left = [Capability::NetEnable, Capability::EnvScrub]
		.into_iter()
		.collect::<CapabilitySet>();
	let right = [Capability::FsWriteDeny, Capability::NetEnable]
		.into_iter()
		.collect::<CapabilitySet>();
	assert_eq!(left.union(right).iter().collect::<Vec<_>>(), [
		Capability::EnvScrub,
		Capability::FsWriteDeny,
		Capability::NetEnable
	],);
	assert_eq!(left.intersection(right).iter().collect::<Vec<_>>(), [Capability::NetEnable]);
	assert_eq!(left.difference(right).iter().collect::<Vec<_>>(), [Capability::EnvScrub]);
}

#[test]
fn portable_capabilities_and_backend_names_are_stable() {
	assert_eq!(portable_capabilities().iter().collect::<Vec<_>>(), [
		Capability::EnvScrub,
		Capability::FsReadScope,
		Capability::FsWriteDeny,
		Capability::FsWriteEphemeral,
		Capability::FsWriteScope,
		Capability::IpcRestrict,
		Capability::NetDisable,
		Capability::NetEnable,
		Capability::NetOutbound,
		Capability::ResCpu,
		Capability::ResMemory,
		Capability::ResPids,
	],);
	assert_eq!(
		Backend::all()
			.map(|backend| backend.to_string())
			.collect::<Vec<_>>(),
		[
			"appcontainer",
			"bubblewrap",
			"docker-ephemeral",
			"docker-runsc-ephemeral",
			"gvisor",
			"landlock",
			"seatbelt",
		],
	);
	assert!(
		!Backend::Landlock
			.capabilities()
			.contains(Capability::IpcRestrict)
	);
	assert!(
		!Backend::Landlock
			.capabilities()
			.contains(Capability::KernelIsolation)
	);
}

#[test]
fn resource_limits_reject_nonfinite_and_negative_cpu_values() {
	for value in [-1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
		assert!(matches!(
			ResourceLimits::new(Some(value), None, None),
			Err(SandboxError::InvalidCpuLimit { .. })
		));
	}
	let unlimited = ResourceLimits::new(Some(0.0), Some(0), Some(0)).expect("zero is unlimited");
	assert_eq!(unlimited.cpu_cores(), None);
	assert_eq!(unlimited.memory_bytes(), None);
	assert_eq!(unlimited.pids(), None);
}

#[test]
fn strict_compilation_enforces_outbound_networking() {
	let mut spec = scoped_spec();
	spec.set_network(NetworkMode::Outbound);
	let plan = Runner::for_backend(Backend::Bubblewrap)
		.compile(&spec)
		.expect("Bubblewrap enforces outbound-only networking");
	assert!(plan.enforced().contains(Capability::NetOutbound));
}

#[test]
fn deterministic_ids_cover_arguments_and_environment_without_leaking_values() {
	let mut first = scoped_spec();
	first
		.set_environment(EnvironmentSource::Exact(vec![OsString::from("TOKEN=secret-value")]))
		.arg("one")
		.set_degradation(DegradationPolicy::AllowCaveats);
	let first_plan = Runner::for_backend(Backend::Gvisor)
		.compile(&first)
		.expect("gVisor plan");
	let second_plan = Runner::for_backend(Backend::Gvisor)
		.compile(&first)
		.expect("equal gVisor plan");
	assert_eq!(plan_id(&first_plan), plan_id(&second_plan));
	assert!(
		!first_plan
			.argv()
			.iter()
			.any(|argument| argument.to_string_lossy().contains("secret-value"))
	);

	let mut changed = first;
	changed.arg("two");
	let changed_plan = Runner::for_backend(Backend::Gvisor)
		.compile(&changed)
		.expect("changed gVisor plan");
	assert_ne!(plan_id(&first_plan), plan_id(&changed_plan));
}

#[test]
fn deterministic_ids_include_write_deny_paths() {
	let root = tempdir().expect("writable scope");
	let denied = root.path().join("denied");
	fs::create_dir(&denied).expect("denied directory");
	let mut first = SandboxSpec::new(executable());
	first
		.set_write(WriteMode::Scoped)
		.set_degradation(DegradationPolicy::AllowCaveats);
	first.allow_write(root.path()).expect("write scope");
	let mut second = first.clone();
	second.deny_write(&denied).expect("write denial");

	let first = Runner::for_backend(Backend::Gvisor)
		.compile(&first)
		.expect("first gVisor plan");
	let second = Runner::for_backend(Backend::Gvisor)
		.compile(&second)
		.expect("second gVisor plan");
	assert_ne!(plan_id(&first), plan_id(&second));
}

#[test]
fn deterministic_ids_include_supervisor_and_environment_overrides() {
	let mut baseline = scoped_spec();
	baseline
		.env_set("OMP_TEST", "zero")
		.set_degradation(DegradationPolicy::AllowCaveats);
	let mut changed_supervisor = baseline.clone();
	changed_supervisor.set_supervised(false);
	let mut changed_environment = baseline.clone();
	changed_environment.env_set("OMP_TEST", "one");

	let runner = Runner::for_backend(Backend::Gvisor);
	let baseline = runner.compile(&baseline).expect("baseline gVisor plan");
	let changed_supervisor = runner
		.compile(&changed_supervisor)
		.expect("unsupervised gVisor plan");
	let changed_environment = runner
		.compile(&changed_environment)
		.expect("environment gVisor plan");
	assert_ne!(plan_id(&baseline), plan_id(&changed_supervisor));
	assert_ne!(plan_id(&baseline), plan_id(&changed_environment));
}

#[test]
fn explicit_empty_environment_survives_preparation() {
	let runner = Runner::for_backend(native_backend());
	if omp_sandbox::backend_status(runner.backend())
		.failure()
		.is_some()
	{
		return;
	}
	let mut spec = scoped_spec();
	spec
		.set_environment(EnvironmentSource::Exact(Vec::new()))
		.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = runner.compile(&spec).expect("native plan");
	let prepared = runner.prepare(plan, &spec).expect("prepared native plan");
	assert_eq!(prepared.environment(), Some([].as_slice()));
}

#[test]
fn deny_patterns_win_after_allow_patterns() {
	let runner = Runner::for_backend(native_backend());
	if omp_sandbox::backend_status(runner.backend())
		.failure()
		.is_some()
	{
		return;
	}
	let mut spec = scoped_spec();
	spec.set_environment(EnvironmentSource::Exact(vec![
		OsString::from("PUBLIC=kept"),
		OsString::from("SECRET=removed"),
	]));
	spec.allow_env("*").expect("allow glob");
	spec.deny_env("SECRET").expect("deny exact");
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = runner.compile(&spec).expect("native plan");
	let prepared = runner.prepare(plan, &spec).expect("prepared native plan");
	assert_eq!(prepared.environment(), Some([OsString::from("PUBLIC=kept")].as_slice()));
}

#[test]
fn environment_globs_are_case_insensitive() {
	validate_env_pattern("*KEY*").expect("valid environment pattern");
	assert!(validate_env_pattern("[").is_err());

	let mut spec = SandboxSpec::new("");
	spec.deny_env("*KEY*").expect("deny glob");
	let wrapper = CommandWrapper::environment_only(&spec);
	assert!(!wrapper.env_allowed("api_key"));
	assert!(!wrapper.env_allowed("API_KEY"));
	assert!(wrapper.env_allowed("PATH"));
}

#[test]
fn core_none_include_deny_and_set_resolve_in_policy_order() {
	assert_eq!(core_environment_names(), [
		"HOME", "PATH", "USER", "SHELL", "LOGNAME", "TERM", "TMPDIR", "LANG", "LC_*",
	]);

	let mut core = SandboxSpec::new("");
	core.set_env_core(true);
	let wrapper = CommandWrapper::environment_only(&core);
	assert_eq!(
		wrapper.resolve_env([
			("HOME", "/home/test"),
			("path", "/bin"),
			("LC_ALL", "C"),
			("SECRET", "hidden"),
		]),
		[
			(OsString::from("HOME"), OsString::from("/home/test")),
			(OsString::from("path"), OsString::from("/bin")),
			(OsString::from("LC_ALL"), OsString::from("C")),
		],
	);

	let mut none = SandboxSpec::new("");
	none.set_environment(EnvironmentSource::Exact(Vec::new()));
	assert!(
		CommandWrapper::environment_only(&none)
			.resolve_env([("PATH", "/bin")])
			.is_empty()
	);

	let mut ordered = SandboxSpec::new("");
	ordered.allow_env("*KEY*").expect("include-only glob");
	ordered.deny_env("*SECRET*").expect("deny glob");
	ordered.env_set("SECRET_KEY", "explicit");
	ordered.env_set("api_key", "override");
	let resolved = CommandWrapper::environment_only(&ordered).resolve_env([
		("api_key", "ambient"),
		("OTHER", "removed"),
		("SECRET_KEY", "removed"),
	]);
	assert_eq!(resolved, [
		(OsString::from("SECRET_KEY"), OsString::from("explicit")),
		(OsString::from("api_key"), OsString::from("override")),
	]);
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
#[test]
fn for_spec_subtracts_tolerated_capabilities_before_rejecting_backend() {
	let native = native_backend();
	if !omp_sandbox::backend_status(native).is_available() {
		return;
	}
	let mut spec = scoped_spec();
	#[cfg(target_os = "linux")]
	{
		spec.set_network(NetworkMode::Outbound);
		spec.tolerate_missing(Capability::NetOutbound);
	}
	#[cfg(target_os = "macos")]
	spec.tolerate_missing(Capability::IpcRestrict);

	Runner::for_spec(&spec).expect("native backend accepts the tolerated gap");
}

#[test]
fn path_scopes_compare_components_not_string_prefixes() {
	let directory = tempdir().expect("temp root");
	let scope = directory.path().join("work");
	let sibling = directory.path().join("worker");
	fs::create_dir(&scope).expect("scope");
	fs::create_dir(&sibling).expect("sibling");
	let mut spec = SandboxSpec::new(executable());
	spec.allow_read(&scope).expect("read scope");
	spec.set_dir(&sibling).expect("working directory");
	let error = Runner::for_backend(native_backend())
		.compile(&spec)
		.expect_err("prefix sibling must not satisfy scope");
	assert!(matches!(error, SandboxError::InvalidSpec(SpecViolation::DirectoryOutsideScope)));
}

fn scoped_spec() -> SandboxSpec {
	let executable = executable();
	let mut spec = SandboxSpec::new(executable);
	spec.allow_read(executable).expect("read executable");
	spec
}

fn executable() -> &'static Path {
	#[cfg(target_os = "macos")]
	return Path::new("/usr/bin/true");
	#[cfg(target_os = "linux")]
	return Path::new("/bin/true");
	#[cfg(windows)]
	return Path::new(r"C:\Windows\System32\cmd.exe");
	#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
	return Path::new("/bin/true");
}

fn native_backend() -> Backend {
	#[cfg(target_os = "macos")]
	return Backend::Seatbelt;
	#[cfg(target_os = "linux")]
	return Backend::Bubblewrap;
	#[cfg(windows)]
	return Backend::AppContainer;
	#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
	return Backend::Seatbelt;
}

fn plan_id(plan: &omp_sandbox::Plan) -> &str {
	plan
		.argv()
		.last()
		.expect("gVisor OCI id")
		.to_str()
		.expect("ASCII plan id")
}
