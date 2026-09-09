use std::{ffi::OsString, path::Path};

use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::{NetworkMode, ResourceKind, SandboxError, SandboxOperation, SandboxSpec, WriteMode};

pub const CPU_PERIOD_MICROS: u64 = 100_000;

#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
pub enum GvisorPlaceholder {
	#[strum(serialize = "<omp:gvisor-bundle>")]
	Bundle,
	#[strum(serialize = "<omp:gvisor-rootfs>")]
	Rootfs,
	#[strum(serialize = "<omp:gvisor-netns>")]
	NetworkNamespace,
}

impl GvisorPlaceholder {
	pub(crate) fn value(self) -> &'static str {
		self.into()
	}
}

#[derive(Clone, Debug)]
pub struct GvisorOciPlan {
	pub(crate) id:                    String,
	pub(crate) runtime_flags:         Vec<OsString>,
	pub(crate) denied_syscalls:       Vec<&'static str>,
	pub(crate) needs_filesystem_view: bool,
	#[cfg(target_os = "linux")]
	pub(crate) network:               NetworkMode,
	pub(crate) write:                 WriteMode,
}

impl GvisorOciPlan {
	pub(crate) fn new(spec: &SandboxSpec, runtime_flags: Vec<OsString>) -> Self {
		let mut denied_syscalls = Vec::with_capacity(5);
		if spec.network == NetworkMode::Outbound {
			denied_syscalls.extend(["listen", "accept", "accept4"]);
		}
		if spec.no_exec {
			denied_syscalls.extend(["execve", "execveat"]);
		}
		Self {
			id: spec.stable_id("omp-sandbox-gvisor").to_string(),
			runtime_flags,
			denied_syscalls,
			needs_filesystem_view: needs_filesystem_view(spec),
			#[cfg(target_os = "linux")]
			network: spec.network,
			write: spec.write,
		}
	}

	pub(crate) fn argv(&self, runtime: OsString) -> Vec<OsString> {
		let mut argv = Vec::with_capacity(self.runtime_flags.len() + 7);
		argv.push(runtime);
		argv.extend(self.runtime_flags.iter().cloned());
		if !self.denied_syscalls.is_empty() {
			argv.push("--oci-seccomp".into());
		}
		argv.extend([
			OsString::from("run"),
			OsString::from("--bundle"),
			OsString::from(GvisorPlaceholder::Bundle.value()),
			OsString::from(&self.id),
		]);
		argv
	}
}

pub const fn needs_filesystem_view(spec: &SandboxSpec) -> bool {
	!spec.readable.is_empty()
		|| !spec.read_deny.is_empty()
		|| !spec.write_deny.is_empty()
		|| !spec.unix_sockets.is_empty()
		|| matches!(spec.write, WriteMode::Scoped | WriteMode::Overlay)
}

pub fn needs_oci(spec: &SandboxSpec) -> bool {
	spec.network == NetworkMode::Outbound
		|| spec.no_exec
		|| needs_filesystem_view(spec)
		|| !spec.resources.is_empty()
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OciConfig {
	pub(crate) oci_version: String,
	pub(crate) process:     OciProcess,
	pub(crate) root:        OciRoot,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub(crate) mounts:      Vec<OciMount>,
	pub(crate) linux:       OciLinux,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OciProcess {
	pub(crate) terminal:          bool,
	pub(crate) args:              Vec<String>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	pub(crate) env:               Vec<String>,
	pub(crate) cwd:               String,
	pub(crate) no_new_privileges: bool,
	pub(crate) capabilities:      OciCapabilities,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct OciCapabilities {
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub(crate) bounding:    Vec<String>,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub(crate) effective:   Vec<String>,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub(crate) inheritable: Vec<String>,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub(crate) permitted:   Vec<String>,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub(crate) ambient:     Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciRoot {
	pub(crate) path:     String,
	pub(crate) readonly: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OciMount {
	pub(crate) destination: String,
	#[serde(rename = "type")]
	pub(crate) kind:        String,
	pub(crate) source:      String,
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub(crate) options:     Vec<String>,
}

impl OciMount {
	pub(crate) fn proc() -> Self {
		Self {
			destination: "/proc".into(),
			kind:        "proc".into(),
			source:      "proc".into(),
			options:     Vec::new(),
		}
	}
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciLinux {
	pub(crate) namespaces: Vec<OciNamespace>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(crate) seccomp:    Option<OciSeccomp>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(crate) resources:  Option<OciResources>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciNamespace {
	#[serde(rename = "type")]
	pub(crate) kind: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(crate) path: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OciSeccomp {
	pub(crate) default_action: String,
	pub(crate) syscalls:       Vec<OciSeccompSyscall>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OciSeccompSyscall {
	pub(crate) names:     Vec<String>,
	pub(crate) action:    String,
	pub(crate) errno_ret: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciResources {
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(crate) cpu:    Option<OciCpu>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(crate) memory: Option<OciMemory>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub(crate) pids:   Option<OciPids>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciCpu {
	pub(crate) quota:  i64,
	pub(crate) period: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciMemory {
	pub(crate) limit: i64,
	pub(crate) swap:  i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OciPids {
	pub(crate) limit: i64,
}

pub fn config(
	spec: &SandboxSpec,
	program: &Path,
	plan: &GvisorOciPlan,
	rootfs: &Path,
	mounts: Vec<OciMount>,
	netns: Option<&Path>,
	environment: &[OsString],
) -> OciConfig {
	let mut args = Vec::with_capacity(spec.args.len() + 1);
	args.push(program.to_string_lossy().into_owned());
	args.extend(
		spec
			.args
			.iter()
			.map(|arg| arg.to_string_lossy().into_owned()),
	);
	let namespaces = ["pid", "mount", "ipc", "uts"]
		.into_iter()
		.map(|kind| OciNamespace { kind: kind.into(), path: None })
		.chain(netns.map(|path| OciNamespace {
			kind: "network".into(),
			path: Some(path.to_string_lossy().into_owned()),
		}))
		.collect();
	let seccomp = (!plan.denied_syscalls.is_empty()).then(|| OciSeccomp {
		default_action: "SCMP_ACT_ALLOW".into(),
		syscalls:       vec![OciSeccompSyscall {
			names:     plan
				.denied_syscalls
				.iter()
				.map(|name| (*name).into())
				.collect(),
			action:    "SCMP_ACT_ERRNO".into(),
			errno_ret: 1,
		}],
	});
	OciConfig {
		oci_version: "1.0.2".into(),
		process:     OciProcess {
			terminal: false,
			args,
			env: environment
				.iter()
				.map(|entry| entry.to_string_lossy().into_owned())
				.collect(),
			cwd: spec
				.dir
				.as_deref()
				.unwrap_or_else(|| Path::new("/"))
				.to_string_lossy()
				.into_owned(),
			no_new_privileges: true,
			capabilities: OciCapabilities::default(),
		},
		root:        OciRoot {
			path:     rootfs.to_string_lossy().into_owned(),
			readonly: plan.needs_filesystem_view || plan.write == WriteMode::Deny,
		},
		mounts:      std::iter::once(OciMount::proc()).chain(mounts).collect(),
		linux:       OciLinux { namespaces, seccomp, resources: resources(spec) },
	}
}

pub fn preview_config(
	spec: &SandboxSpec,
	program: &Path,
	plan: &GvisorOciPlan,
) -> Result<String, SandboxError> {
	validate_resources(spec)?;
	let rootfs = if plan.needs_filesystem_view {
		Path::new(GvisorPlaceholder::Rootfs.value())
	} else {
		Path::new("/")
	};
	let netns = Path::new(GvisorPlaceholder::NetworkNamespace.value());
	let config = config(spec, program, plan, rootfs, Vec::new(), Some(netns), &[]);
	serde_json::to_string_pretty(&config)
		.map(|json| format!("{json}\n"))
		.map_err(|source| SandboxError::BackendJson {
			backend: crate::Backend::Gvisor,
			operation: SandboxOperation::Compile,
			source,
		})
}
pub fn validate_resources(spec: &SandboxSpec) -> Result<(), SandboxError> {
	if let Some(cores) = spec.resources.cpu_cores()
		&& cores * CPU_PERIOD_MICROS as f64 > i64::MAX as f64
	{
		return Err(SandboxError::InvalidResourceLimit {
			resource: ResourceKind::Cpu,
			value:    cores.ceil().min(u64::MAX as f64) as u64,
		});
	}
	if let Some(value) = spec.resources.memory_bytes()
		&& value > i64::MAX as u64
	{
		return Err(SandboxError::InvalidResourceLimit { resource: ResourceKind::Memory, value });
	}
	Ok(())
}

pub fn resources(spec: &SandboxSpec) -> Option<OciResources> {
	if spec.resources.is_empty() {
		return None;
	}
	let cpu = spec.resources.cpu_cores().map(|cores| {
		let quota = (cores * CPU_PERIOD_MICROS as f64).round().max(1.0) as i64;
		OciCpu { quota, period: CPU_PERIOD_MICROS }
	});
	let memory = spec.resources.memory_bytes().map(|bytes| {
		let value = bytes as i64;
		OciMemory { limit: value, swap: value }
	});
	let pids = spec
		.resources
		.pids()
		.map(|limit| OciPids { limit: i64::from(limit) });
	Some(OciResources { cpu, memory, pids })
}
