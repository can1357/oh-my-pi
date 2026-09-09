#[cfg(target_os = "linux")]
use std::process::Command;
use std::{env, ffi::OsString, path::Path};

#[cfg(target_os = "linux")]
use omp_core::CowBytes;
use omp_core::Str;

use super::gvisor_oci::{GvisorOciPlan, needs_filesystem_view, needs_oci, preview_config};
#[cfg(target_os = "linux")]
use crate::SandboxOperation;
use crate::{
	Backend, BackendStatus, Capability, CapabilitySet, Caveat, DegradationPolicy,
	FilesystemVirtualizationKind, NetworkMode, Plan, ProbeFailure, SandboxError, SandboxSpec,
	WriteMode, paths::path_under_any,
};

const RUNSC_ENV: &str = "OMP_SANDBOX_RUNSC";
#[cfg(target_os = "linux")]
const DIAGNOSTIC_LIMIT: usize = 4096;

pub fn runtime() -> OsString {
	env::var_os(RUNSC_ENV).unwrap_or_else(|| OsString::from("runsc"))
}

pub fn compile(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	mut enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	enforced = enforced.union(CapabilitySet::one(Capability::KernelIsolation));
	let has_future_deny = spec.read_deny.iter().any(|path| !path.exists());
	if has_future_deny {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsReadDeny));
		if spec.degradation == DegradationPolicy::Reject
			&& !spec.tolerated.contains(Capability::FsReadDeny)
		{
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::Gvisor,
				missing: CapabilitySet::one(Capability::FsReadDeny),
			});
		}
	}
	let has_future_write_deny = spec.write_deny.iter().any(|path| !path.exists());
	let has_unmounted_write_deny = spec
		.write_deny
		.iter()
		.any(|path| !path_under_any(path, &spec.writable));
	if has_future_write_deny || has_unmounted_write_deny {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsWriteDeny));
		if spec.degradation == DegradationPolicy::Reject
			&& !spec.tolerated.contains(Capability::FsWriteDeny)
		{
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::Gvisor,
				missing: CapabilitySet::one(Capability::FsWriteDeny),
			});
		}
	}
	let filesystem_view = needs_filesystem_view(spec);
	if filesystem_view && enforced.contains(Capability::IpcRestrict) {
		enforced = enforced.difference(CapabilitySet::one(Capability::IpcRestrict));
		if spec.degradation == DegradationPolicy::Reject
			&& !spec.tolerated.contains(Capability::IpcRestrict)
		{
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::Gvisor,
				missing: CapabilitySet::one(Capability::IpcRestrict),
			});
		}
	}

	let flags = runtime_flags(spec);
	let mut plan = if needs_oci(spec) {
		let oci = GvisorOciPlan::new(spec, flags);
		let argv = oci.argv(runtime());
		let mut plan = Plan::new(Backend::Gvisor, requested, enforced, argv, true);
		plan.set_profile(preview_config(spec, program, &oci)?);
		plan
	} else {
		let mut argv = Vec::with_capacity(flags.len() + spec.args.len() + 4);
		argv.push(runtime());
		argv.extend(flags);
		argv.push("do".into());
		// This terminator is a confinement boundary: without it a hostile argv[0]
		// can be parsed as a runsc flag and weaken the selected policy.
		argv.push("--".into());
		argv.push(program.as_os_str().to_owned());
		argv.extend(spec.args.iter().cloned());
		Plan::new(Backend::Gvisor, requested, enforced, argv, true)
	};

	if filesystem_view {
		plan.add_caveat(Caveat::capability(
			Capability::IpcRestrict,
			"gVisor host filesystem scopes can expose host IPC endpoints",
		));
	}
	if !spec.readable.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadScope,
			"gVisor also exposes the executable, dynamic loader, and library closure read-only",
		));
	}
	if !spec.read_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadDeny,
			"gVisor masks existing denied paths; alternate hardlinks and mount paths remain readable",
		));
		if has_future_deny {
			plan.add_caveat(Caveat::capability(
				Capability::FsReadDeny,
				"gVisor cannot pre-mount a read-deny mask for a path that does not yet exist",
			));
		}
	}
	if !spec.write_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsWriteDeny,
			"gVisor remounts existing denied write subtrees read-only inside writable bind mounts",
		));
		if has_future_write_deny {
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteDeny,
				"gVisor cannot pre-mount a read-only carve-out for a path that does not yet exist",
			));
		}
		if has_unmounted_write_deny {
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteDeny,
				"gVisor cannot carve a rootfs or temporary path read-only without replacing it with a \
				 host bind mount",
			));
		}
	}
	if spec.network == NetworkMode::Outbound {
		plan.add_caveat(Caveat::capability(
			Capability::NetOutbound,
			"gVisor outbound mode denies listen, accept, and accept4 for every socket family; UDP \
			 bind may still succeed and outbound is not an egress filter",
		));
	}
	if needs_oci(spec) && spec.network == NetworkMode::Enabled {
		plan.add_caveat(Caveat::capability(
			Capability::NetEnable,
			"gVisor exposes enabled-network listeners to the host over the point-to-point veth",
		));
	}
	if spec.resources.cpu_cores().is_some() {
		plan.add_caveat(Caveat::capability(
			Capability::ResCpu,
			"gVisor applies the CPU ceiling through the host cgroup",
		));
	}
	if spec.resources.memory_bytes().is_some() {
		plan.add_caveat(Caveat::capability(
			Capability::ResMemory,
			"gVisor applies equal memory and swap ceilings through the host cgroup",
		));
	}
	if spec.resources.pids().is_some() {
		plan.add_caveat(Caveat::capability(
			Capability::ResPids,
			"gVisor applies the process ceiling through the host pids cgroup",
		));
	}
	if env::var_os(RUNSC_ENV).is_some() {
		plan.add_caveat(Caveat::capability(
			Capability::KernelIsolation,
			Str::from(format!("kernel isolation assumes {RUNSC_ENV} names a genuine gVisor runsc")),
		));
	}
	match spec.write {
		WriteMode::Ephemeral => {
			plan.set_filesystem(FilesystemVirtualizationKind::MemoryOverlay);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"gVisor --overlay2=all:memory keeps non-persistent writes off host disk",
			));
		},
		WriteMode::Overlay => {
			plan.set_filesystem(FilesystemVirtualizationKind::RootOverlay);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"gVisor --overlay2=root:memory redirects writes outside persistent bind mounts",
			));
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteScope,
				"gVisor writable bind mounts still consume host disk and have no disk quota",
			));
		},
		WriteMode::Scoped => {
			plan.set_filesystem(FilesystemVirtualizationKind::ScopedDeny);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteScope,
				"gVisor scoped writes are bind-mount based and have no disk quota",
			));
		},
		WriteMode::Deny => {},
	}
	Ok(plan)
}

fn runtime_flags(spec: &SandboxSpec) -> Vec<OsString> {
	let mut flags = Vec::with_capacity(2);
	match spec.network {
		NetworkMode::Disabled => flags.push("--network=none".into()),
		NetworkMode::Enabled => flags.push("--network=sandbox".into()),
		NetworkMode::Outbound => {},
	}
	match spec.write {
		WriteMode::Ephemeral => flags.push("--overlay2=all:memory".into()),
		WriteMode::Overlay => flags.push("--overlay2=root:memory".into()),
		WriteMode::Deny | WriteMode::Scoped => {},
	}
	flags
}

pub fn probe() -> BackendStatus {
	#[cfg(not(target_os = "linux"))]
	{
		BackendStatus::unavailable(Backend::Gvisor, ProbeFailure::WrongHost {
			backend: Backend::Gvisor,
			os:      std::env::consts::OS,
		})
	}
	#[cfg(target_os = "linux")]
	probe_output(
		Command::new(runtime())
			.args(["do", "--", "/bin/true"])
			.output(),
	)
}

#[cfg(target_os = "linux")]
pub(crate) fn probe_oci_seccomp() -> BackendStatus {
	let output = match Command::new(runtime()).arg("features").output() {
		Ok(output) => output,
		Err(source) => {
			return BackendStatus::unavailable(Backend::Gvisor, ProbeFailure::Start {
				backend: Backend::Gvisor,
				operation: SandboxOperation::Probe,
				source,
			});
		},
	};
	if output.status.success()
		&& (String::from_utf8_lossy(&output.stdout).contains("oci-seccomp")
			|| String::from_utf8_lossy(&output.stderr).contains("oci-seccomp"))
	{
		BackendStatus::available(Backend::Gvisor)
	} else {
		let mut diagnostic = output.stdout;
		diagnostic.extend(output.stderr);
		rejected(output.status.code(), diagnostic)
	}
}
pub fn check_requirements(spec: &SandboxSpec) -> Result<BackendStatus, SandboxError> {
	let status = probe();
	if !status.is_available() || !needs_oci(spec) {
		return Ok(status);
	}
	#[cfg(target_os = "linux")]
	{
		return crate::runtime::gvisor::probe_requirements(spec);
	}
	#[cfg(not(target_os = "linux"))]
	Ok(status)
}

#[cfg(target_os = "linux")]
fn probe_output(output: std::io::Result<std::process::Output>) -> BackendStatus {
	match output {
		Ok(output) if output.status.success() => BackendStatus::available(Backend::Gvisor),
		Ok(output) => rejected(output.status.code(), output.stderr),
		Err(source) => BackendStatus::unavailable(Backend::Gvisor, ProbeFailure::Start {
			backend: Backend::Gvisor,
			operation: SandboxOperation::Probe,
			source,
		}),
	}
}

#[cfg(target_os = "linux")]
fn rejected(status: Option<i32>, mut diagnostic: Vec<u8>) -> BackendStatus {
	diagnostic.truncate(DIAGNOSTIC_LIMIT);
	BackendStatus::unavailable(Backend::Gvisor, ProbeFailure::Rejected {
		backend: Backend::Gvisor,
		operation: SandboxOperation::Probe,
		status,
		diagnostic: CowBytes::from(diagnostic),
	})
}
