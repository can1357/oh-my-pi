use std::path::Path;

use omp_core::Str;
use strum::IntoStaticStr;

#[cfg(not(windows))]
use crate::ProbeFailure;
use crate::{
	Backend, BackendStatus, Capability, CapabilitySet, Caveat, DegradationPolicy,
	FilesystemVirtualizationKind, NetworkMode, Plan, SandboxError, SandboxSpec, WriteMode,
};

const EPHEMERAL_ROOT: &str = "@OMP_APP_CONTAINER_EPHEMERAL_ROOT@";
#[cfg(any(windows, test))]
const INTERNET_CLIENT_SID: u32 = 85;
#[cfg(any(windows, test))]
const INTERNET_CLIENT_SERVER_SID: u32 = 86;
#[cfg(any(windows, test))]
const PRIVATE_NETWORK_CLIENT_SERVER_SID: u32 = 87;
#[cfg(any(windows, test))]
const CPU_RATE_MAX: u32 = 10_000;

#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
pub enum CapabilitySid {
	#[strum(serialize = "WinCapabilityInternetClientSid")]
	InternetClient,
	#[strum(serialize = "WinCapabilityInternetClientServerSid")]
	InternetClientServer,
	#[strum(serialize = "WinCapabilityPrivateNetworkClientServerSid")]
	PrivateNetworkClientServer,
}

impl CapabilitySid {
	#[cfg(any(windows, test))]
	pub(crate) const fn well_known_type(self) -> u32 {
		match self {
			Self::InternetClient => INTERNET_CLIENT_SID,
			Self::InternetClientServer => INTERNET_CLIENT_SERVER_SID,
			Self::PrivateNetworkClientServer => PRIVATE_NETWORK_CLIENT_SERVER_SID,
		}
	}
}

/// Purely compiles the inspectable `AppContainer` preview. Environment values
/// are deliberately absent; they are resolved only during runtime preparation.
pub fn compile(
	spec: &SandboxSpec,
	program: &Path,
	requested: CapabilitySet,
	mut enforced: CapabilitySet,
) -> Result<Plan, SandboxError> {
	if spec.write == WriteMode::Overlay {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsWriteEphemeral));
	}
	let has_future_write_deny = spec.write_deny.iter().any(|path| !path.exists());
	if has_future_write_deny {
		enforced = enforced.difference(CapabilitySet::one(Capability::FsWriteDeny));
		if spec.degradation == DegradationPolicy::Reject {
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::AppContainer,
				missing: CapabilitySet::one(Capability::FsWriteDeny),
			});
		}
	}
	let capability_sids = capability_sids(spec.network);
	let loses_ipc = !capability_sids.is_empty() && enforced.contains(Capability::IpcRestrict);
	if loses_ipc {
		if spec.degradation == DegradationPolicy::Reject {
			return Err(SandboxError::BackendCapabilities {
				backend: Backend::AppContainer,
				missing: CapabilitySet::one(Capability::IpcRestrict),
			});
		}
		enforced = enforced.difference(CapabilitySet::one(Capability::IpcRestrict));
	}
	let mut plan = Plan::new(
		Backend::AppContainer,
		requested,
		enforced,
		std::iter::once(program.as_os_str().to_owned())
			.chain(spec.args.iter().cloned())
			.collect(),
		false,
	);
	if loses_ipc {
		plan.add_caveat(Caveat::capability(
			Capability::IpcRestrict,
			"network capability SIDs can reach host IPC endpoints that grant those capabilities",
		));
	}

	match spec.network {
		NetworkMode::Disabled => plan.add_caveat(Caveat::capability(
			Capability::NetDisable,
			"AppContainer blocks loopback as well as external network access",
		)),
		NetworkMode::Outbound => plan.add_caveat(Caveat::capability(
			Capability::NetOutbound,
			"InternetClient permits unrestricted Internet egress but withholds private-network and \
			 server capabilities; this is not an egress destination filter",
		)),
		NetworkMode::Enabled => {},
	}

	if spec.readable.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadHost,
			"AppContainer provides only executable and working-directory launch grants, not broad \
			 host reads",
		));
	} else {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadScope,
			"read grants are additive ACLs and cannot revoke ambient ALL APPLICATION PACKAGES access",
		));
	}
	if !spec.read_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsReadDeny,
			"temporary deny ACEs are applied only to existing paths whose DACL can be changed",
		));
	}
	if !spec.write_deny.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::FsWriteDeny,
			"temporary write-deny ACEs make existing carve-out paths read-only while the process runs",
		));
		if has_future_write_deny {
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteDeny,
				"AppContainer cannot apply a write-deny ACE to a path that does not yet exist",
			));
		}
	}
	if !spec.unix_sockets.is_empty() {
		plan.add_caveat(Caveat::general(
			"Unix-domain socket allowances are not meaningful to AppContainer",
		));
	}
	if !spec.mach_services.is_empty() {
		plan.add_caveat(Caveat::capability(
			Capability::MachRestrict,
			"Mach service allowances are available only to Seatbelt",
		));
	}

	match spec.write {
		WriteMode::Deny => plan.add_caveat(Caveat::capability(
			Capability::FsWriteDeny,
			"derive-only lowbox storage cannot revoke ambient writes already granted to ALL \
			 APPLICATION PACKAGES",
		)),
		WriteMode::Scoped => plan.add_caveat(Caveat::capability(
			Capability::FsWriteScope,
			"scoped writes use temporary path ACLs; hardlinks can expose the same file through \
			 another path",
		)),
		WriteMode::Ephemeral => {
			plan.set_filesystem(FilesystemVirtualizationKind::WorkspaceClone);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"ephemeral writes use a private full-byte workspace copy removed after process exit",
			));
		},
		WriteMode::Overlay => {
			plan.set_filesystem(FilesystemVirtualizationKind::ScopedDeny);
			plan.add_caveat(Caveat::capability(
				Capability::FsWriteEphemeral,
				"AppContainer has no shadow overlay; writes outside persistent scopes are denied",
			));
		},
	}
	if spec.no_exec {
		plan.add_caveat(Caveat::capability(
			Capability::ProcNoExec,
			"PROCESS_CREATION_CHILD_PROCESS_RESTRICTED blocks every child process, including \
			 same-image creation, but not an out-of-process broker",
		));
	}
	if spec.resources.cpu_cores().is_some() {
		plan.add_caveat(Caveat::capability(
			Capability::ResCpu,
			"CPU is a Job Object hard cap expressed as a share of all logical processors",
		));
	}
	if spec.resources.memory_bytes().is_some() {
		plan.add_caveat(Caveat::capability(
			Capability::ResMemory,
			"memory is a whole-job commit cap; file-backed mappings and working-set growth can \
			 exceed it",
		));
	}

	plan.set_profile(render_profile(spec, program, &capability_sids));
	Ok(plan)
}

pub fn probe() -> BackendStatus {
	#[cfg(windows)]
	{
		return crate::runtime::windows::probe_appcontainer();
	}
	#[cfg(not(windows))]
	{
		BackendStatus::unavailable(Backend::AppContainer, ProbeFailure::WrongHost {
			backend: Backend::AppContainer,
			os:      std::env::consts::OS,
		})
	}
}

pub fn capability_sids(network: NetworkMode) -> Vec<CapabilitySid> {
	match network {
		NetworkMode::Disabled => Vec::new(),
		NetworkMode::Enabled => {
			vec![CapabilitySid::InternetClientServer, CapabilitySid::PrivateNetworkClientServer]
		},
		NetworkMode::Outbound => vec![CapabilitySid::InternetClient],
	}
}

fn render_profile(spec: &SandboxSpec, program: &Path, sids: &[CapabilitySid]) -> Str {
	let mut profile = String::from("appcontainer <per-run-derived-sid>\n");
	profile.push_str("  exe: ");
	profile.push_str(&program.to_string_lossy());
	profile.push('\n');
	if spec.write == WriteMode::Ephemeral {
		profile.push_str("  workdir: ");
		profile.push_str(EPHEMERAL_ROOT);
		profile.push('\n');
	} else if let Some(dir) = &spec.dir {
		profile.push_str("  workdir: ");
		profile.push_str(&dir.to_string_lossy());
		profile.push('\n');
	}
	profile.push_str("  capabilities:");
	if sids.is_empty() {
		profile.push_str(" none");
	} else {
		for sid in sids {
			profile.push(' ');
			let label: &'static str = (*sid).into();
			profile.push_str(label);
		}
	}
	profile.push_str("\n  all application packages: opt-out\n");
	profile.push_str("  profile storage: derive-only\n");
	profile.push_str("  read deny:");
	for path in &spec.read_deny {
		profile.push(' ');
		profile.push_str(&path.to_string_lossy());
	}
	if spec.read_deny.is_empty() {
		profile.push_str(" none");
	}
	profile.push_str("\n  write deny:");
	for path in &spec.write_deny {
		profile.push(' ');
		profile.push_str(&path.to_string_lossy());
	}
	if spec.write_deny.is_empty() {
		profile.push_str(" none");
	}
	profile.push_str("\n  read grants: ");
	profile.push_str(&program.to_string_lossy());
	for path in &spec.readable {
		profile.push(' ');
		profile.push_str(&path.to_string_lossy());
	}
	if spec.write == WriteMode::Ephemeral {
		profile.push(' ');
		profile.push_str(EPHEMERAL_ROOT);
	} else if let Some(dir) = &spec.dir {
		profile.push(' ');
		profile.push_str(&dir.to_string_lossy());
	}
	profile.push_str("\n  write grants:");
	match spec.write {
		WriteMode::Deny => profile.push_str(" none"),
		WriteMode::Ephemeral => {
			profile.push(' ');
			profile.push_str(EPHEMERAL_ROOT);
		},
		WriteMode::Scoped | WriteMode::Overlay => {
			for path in &spec.writable {
				profile.push(' ');
				profile.push_str(&path.to_string_lossy());
			}
			if spec.writable.is_empty() && !spec.allow_temp {
				profile.push_str(" none");
			}
			if spec.allow_temp {
				profile.push_str(" <host-temp-roots>");
			}
		},
	}
	profile.push('\n');
	profile.push_str(if spec.no_exec {
		"  child process policy: restricted\n"
	} else {
		"  child process policy: default\n"
	});
	if let Some(cpu) = spec.resources.cpu_cores() {
		profile.push_str(&format!("  cpu limit: {cpu} cores\n"));
	}
	if let Some(memory) = spec.resources.memory_bytes() {
		profile.push_str(&format!("  memory limit: {memory} bytes\n"));
	}
	if let Some(pids) = spec.resources.pids() {
		profile.push_str(&format!("  process limit: {pids}\n"));
	}
	profile.into()
}

#[cfg(any(windows, test))]
pub(crate) fn cpu_rate_hundredths(cpu_cores: f64, logical_processors: usize) -> u32 {
	let processors = logical_processors.max(1) as f64;
	(cpu_cores / processors * f64::from(CPU_RATE_MAX))
		.round()
		.clamp(1.0, f64::from(CPU_RATE_MAX)) as u32
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn capability_sid_numbers_match_windows_contract() {
		assert_eq!(CapabilitySid::InternetClient.well_known_type(), 85);
		assert_eq!(CapabilitySid::InternetClientServer.well_known_type(), 86);
		assert_eq!(CapabilitySid::PrivateNetworkClientServer.well_known_type(), 87);
	}

	#[test]
	fn cpu_rate_rounds_floors_and_clamps() {
		assert_eq!(cpu_rate_hundredths(8.0, 8), 10_000);
		assert_eq!(cpu_rate_hundredths(4.0, 8), 5_000);
		assert_eq!(cpu_rate_hundredths(80.0, 8), 10_000);
		assert_eq!(cpu_rate_hundredths(f64::MIN_POSITIVE, 8), 1);
	}
}
