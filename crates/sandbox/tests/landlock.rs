//! Landlock fallback plan and honest-degradation contracts.

use std::path::Path;

use omp_sandbox::{
	Backend, Capability, DegradationPolicy, NetworkMode, Runner, SandboxError, SandboxSpec,
	WriteMode,
};
use tempfile::tempdir;

#[test]
fn helper_argv_contract_carries_owned_policy_artifacts() {
	let target = executable();
	let mut spec = SandboxSpec::new(target);
	spec.tolerate_missing(Capability::IpcRestrict);
	let plan = Runner::for_backend(Backend::Landlock)
		.compile(&spec)
		.expect("Landlock plan");
	let argv = plan.argv();
	assert_eq!(argv[1], omp_sandbox::HIDDEN_CHILD_ARG);
	assert_eq!(argv[2], "@omp-sandbox-bpf@");
	assert_eq!(argv[3], "--landlock");
	assert_eq!(argv[4], "@omp-sandbox-landlock-policy@");
	assert_eq!(argv[5], "--");
	assert_eq!(Path::new(&argv[6]), target);
	assert!(plan.enforced().contains(Capability::NetDisable));
	assert!(plan.enforced().contains(Capability::FsWriteDeny));
	assert!(!plan.enforced().contains(Capability::IpcRestrict));
	assert!(
		plan.caveats().iter().any(|caveat| {
			caveat.capability.is_none() && caveat.message.as_str().contains("/proc")
		})
	);
}

#[test]
fn backend_never_claims_namespace_guarantees() {
	let capabilities = Backend::Landlock.capabilities();
	assert!(!capabilities.contains(Capability::IpcRestrict));
	assert!(!capabilities.contains(Capability::KernelIsolation));
}

#[cfg(unix)]
#[test]
fn pathname_socket_allowance_fails_closed_without_exact_enforcement() {
	use std::os::unix::net::UnixListener;

	let root = tempdir().expect("socket root");
	let socket = root.path().join("service.sock");
	let _listener = UnixListener::bind(&socket).expect("Unix listener");
	let mut spec = SandboxSpec::new(executable());
	spec.allow_unix_socket(&socket).expect("socket allowance");
	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let error = Runner::for_backend(Backend::Landlock)
		.compile(&spec)
		.expect_err("exact Unix-socket grant must fail closed");
	assert!(matches!(error, omp_sandbox::SandboxError::EnforcementUnavailable {
		backend:   Backend::Landlock,
		authority: "Unix-domain socket path grants",
	}));
}

#[test]
fn nested_write_deny_is_rejected_or_reported_without_false_claim() {
	let root = tempdir().expect("write root");
	let denied = root.path().join("denied");
	std::fs::create_dir(&denied).expect("denied directory");
	let mut spec = SandboxSpec::new(executable());
	spec.set_write(WriteMode::Scoped);
	spec.allow_write(root.path()).expect("write root");
	spec.deny_write(&denied).expect("nested write denial");
	let error = Runner::for_backend(Backend::Landlock)
		.compile(&spec)
		.expect_err("additive Landlock rules cannot subtract a child");
	assert!(matches!(
		error,
		SandboxError::BackendCapabilities { backend: Backend::Landlock, missing }
			if missing.contains(Capability::FsWriteDeny)
	));

	spec.set_degradation(DegradationPolicy::AllowCaveats);
	let plan = Runner::for_backend(Backend::Landlock)
		.compile(&spec)
		.expect("degraded write plan");
	assert!(!plan.enforced().contains(Capability::FsWriteDeny));
	assert!(plan.enforced().contains(Capability::FsWriteScope));
}

#[test]
fn outbound_mode_is_seccomp_backed_without_namespace_claims() {
	let mut spec = SandboxSpec::new(executable());
	spec.set_network(NetworkMode::Outbound);
	spec.tolerate_missing(Capability::IpcRestrict);
	let plan = Runner::for_backend(Backend::Landlock)
		.compile(&spec)
		.expect("outbound Landlock plan");
	assert!(plan.enforced().contains(Capability::NetOutbound));
	assert!(!plan.enforced().contains(Capability::IpcRestrict));
}

#[cfg(not(target_os = "linux"))]
#[test]
fn abi_probe_is_absent_off_linux() {
	assert_eq!(omp_sandbox::landlock_abi(), None);
	assert!(!omp_sandbox::backend_status(Backend::Landlock).is_available());
}

fn executable() -> &'static Path {
	if cfg!(windows) {
		Path::new("C:\\Windows\\System32\\cmd.exe")
	} else {
		Path::new("/bin/echo")
	}
}
