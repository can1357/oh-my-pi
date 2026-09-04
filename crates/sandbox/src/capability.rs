use std::fmt;

use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

/// Sandbox implementation selected for a compiled plan.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
pub enum Backend {
	/// Apple's Seatbelt profile runner.
	#[strum(serialize = "seatbelt")]
	#[serde(rename = "seatbelt")]
	Seatbelt,
	/// Linux Bubblewrap namespace isolation.
	#[strum(serialize = "bubblewrap")]
	#[serde(rename = "bubblewrap")]
	Bubblewrap,
	/// Linux gVisor confinement through runsc.
	#[strum(serialize = "gvisor")]
	#[serde(rename = "gvisor")]
	Gvisor,
	/// Linux Landlock filesystem and seccomp confinement.
	#[strum(serialize = "landlock")]
	#[serde(rename = "landlock")]
	Landlock,
	/// Disposable Docker storage with the default runtime.
	#[strum(serialize = "docker-ephemeral")]
	#[serde(rename = "docker-ephemeral")]
	DockerEphemeral,
	/// Disposable Docker storage forced through the runsc runtime.
	#[strum(serialize = "docker-runsc-ephemeral")]
	#[serde(rename = "docker-runsc-ephemeral")]
	DockerRunscEphemeral,
	/// Windows low-privilege `AppContainer` confinement.
	#[strum(serialize = "appcontainer")]
	#[serde(rename = "appcontainer")]
	AppContainer,
}

/// One enforceable sandbox guarantee.
#[repr(u8)]
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
pub enum Capability {
	/// Scrub inherited environment variables before launch.
	#[strum(serialize = "env.scrub")]
	#[serde(rename = "env.scrub")]
	EnvScrub,
	/// Read broadly except explicitly denied paths.
	#[strum(serialize = "fs.read.deny")]
	#[serde(rename = "fs.read.deny")]
	FsReadDeny,
	/// Read the host filesystem broadly.
	#[strum(serialize = "fs.read.host")]
	#[serde(rename = "fs.read.host")]
	FsReadHost,
	/// Restrict host reads to explicit scopes and backend runtime paths.
	#[strum(serialize = "fs.read.scope")]
	#[serde(rename = "fs.read.scope")]
	FsReadScope,
	/// Deny host writes globally or beneath explicit carve-out paths.
	#[strum(serialize = "fs.write.deny")]
	#[serde(rename = "fs.write.deny")]
	FsWriteDeny,
	/// Permit backend-ephemeral writes without modifying configured host inputs.
	#[strum(serialize = "fs.write.ephemeral")]
	#[serde(rename = "fs.write.ephemeral")]
	FsWriteEphemeral,
	/// Persist writes only under explicit scopes and opted-in temporary roots.
	#[strum(serialize = "fs.write.scope")]
	#[serde(rename = "fs.write.scope")]
	FsWriteScope,
	/// Prevent access to host local IPC endpoints.
	#[strum(serialize = "ipc.restrict")]
	#[serde(rename = "ipc.restrict")]
	IpcRestrict,
	/// Serve syscalls through a user-space kernel.
	#[strum(serialize = "kernel.isolation")]
	#[serde(rename = "kernel.isolation")]
	KernelIsolation,
	/// Restrict macOS Mach service lookups.
	#[strum(serialize = "mach.restrict")]
	#[serde(rename = "mach.restrict")]
	MachRestrict,
	/// Deny external and non-local network access.
	#[strum(serialize = "net.disable")]
	#[serde(rename = "net.disable")]
	NetDisable,
	/// Permit network access.
	#[strum(serialize = "net.enable")]
	#[serde(rename = "net.enable")]
	NetEnable,
	/// Permit outbound connections while blocking TCP server setup.
	#[strum(serialize = "net.outbound")]
	#[serde(rename = "net.outbound")]
	NetOutbound,
	/// Forbid creating a new program image after launch.
	#[strum(serialize = "proc.no_exec")]
	#[serde(rename = "proc.no_exec")]
	ProcNoExec,
	/// Limit CPU use to a fraction of the host's logical cores.
	#[strum(serialize = "res.cpu")]
	#[serde(rename = "res.cpu")]
	ResCpu,
	/// Limit the sandbox memory footprint.
	#[strum(serialize = "res.memory")]
	#[serde(rename = "res.memory")]
	ResMemory,
	/// Limit the sandbox process or task count.
	#[strum(serialize = "res.pids")]
	#[serde(rename = "res.pids")]
	ResPids,
}

const CAPABILITIES: [Capability; 17] = [
	Capability::EnvScrub,
	Capability::FsReadDeny,
	Capability::FsReadHost,
	Capability::FsReadScope,
	Capability::FsWriteDeny,
	Capability::FsWriteEphemeral,
	Capability::FsWriteScope,
	Capability::IpcRestrict,
	Capability::KernelIsolation,
	Capability::MachRestrict,
	Capability::NetDisable,
	Capability::NetEnable,
	Capability::NetOutbound,
	Capability::ProcNoExec,
	Capability::ResCpu,
	Capability::ResMemory,
	Capability::ResPids,
];

const DESCRIPTIONS: [&str; 17] = [
	"scrub inherited environment variables by name pattern before launch",
	"read broadly except denied sensitive paths",
	"read the host filesystem broadly",
	"restrict host/user filesystem reads to an allowlist plus backend runtime paths",
	"deny host writes globally or beneath explicit read-only carve-out paths",
	"permit backend ephemeral writes; configured host inputs stay untouched",
	"permit writes under listed paths plus opt-in temp roots; listed-path writes persist",
	"no host local IPC endpoint reachable",
	"serve syscalls from a user-space kernel; shield host kernel",
	"restrict Mach service lookups (Seatbelt-only)",
	"deny network access; some backends additionally block loopback (see caveats)",
	"permit network access",
	"permit outbound connections; block inbound TCP listeners; not a domain/CIDR allowlist",
	"forbid executing another program image",
	"limit CPU usage to a fraction of the host's cores",
	"limit the sandbox's memory footprint",
	"limit the sandbox's process/task count",
];

impl Capability {
	/// Describes the guarantee represented by this capability.
	#[must_use]
	pub const fn description(self) -> &'static str {
		DESCRIPTIONS[self as usize]
	}

	const fn bit(self) -> u32 {
		1_u32 << self as u8
	}
}

/// Allocation-free set of sandbox capabilities.
#[derive(Clone, Copy, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CapabilitySet(u32);

impl CapabilitySet {
	/// Creates an empty set.
	#[must_use]
	pub const fn empty() -> Self {
		Self(0)
	}

	/// Creates a set containing one capability.
	#[must_use]
	pub const fn one(capability: Capability) -> Self {
		Self(capability.bit())
	}

	/// Reports whether this set contains a capability.
	#[must_use]
	pub const fn contains(self, capability: Capability) -> bool {
		self.0 & capability.bit() != 0
	}

	/// Returns capabilities present in either set.
	#[must_use]
	pub const fn union(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}

	/// Returns capabilities present in both sets.
	#[must_use]
	pub const fn intersection(self, other: Self) -> Self {
		Self(self.0 & other.0)
	}

	/// Returns capabilities present in this set but absent from `other`.
	#[must_use]
	pub const fn difference(self, other: Self) -> Self {
		Self(self.0 & !other.0)
	}

	/// Reports whether the set contains no capabilities.
	#[must_use]
	pub const fn is_empty(self) -> bool {
		self.0 == 0
	}

	/// Returns the number of capabilities in the set.
	#[must_use]
	pub const fn len(self) -> usize {
		self.0.count_ones() as usize
	}

	/// Iterates over capabilities in lexical serialized-name order.
	pub fn iter(self) -> impl ExactSizeIterator<Item = Capability> {
		CapabilityIter { remaining: self.0 }
	}

	pub(crate) const fn from_bits(bits: u32) -> Self {
		Self(bits)
	}

	pub(crate) const fn bits(self) -> u32 {
		self.0
	}
}

impl FromIterator<Capability> for CapabilitySet {
	fn from_iter<T: IntoIterator<Item = Capability>>(capabilities: T) -> Self {
		capabilities
			.into_iter()
			.fold(Self::empty(), |set, capability| set.union(Self::one(capability)))
	}
}

impl fmt::Debug for CapabilitySet {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.debug_set().entries(self.iter()).finish()
	}
}

impl fmt::Display for CapabilitySet {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		for (index, capability) in self.iter().enumerate() {
			if index != 0 {
				formatter.write_str(", ")?;
			}
			fmt::Display::fmt(&capability, formatter)?;
		}
		Ok(())
	}
}

struct CapabilityIter {
	remaining: u32,
}

impl Iterator for CapabilityIter {
	type Item = Capability;

	fn next(&mut self) -> Option<Self::Item> {
		if self.remaining == 0 {
			return None;
		}
		let index = self.remaining.trailing_zeros() as usize;
		self.remaining &= self.remaining - 1;
		Some(CAPABILITIES[index])
	}

	fn size_hint(&self) -> (usize, Option<usize>) {
		let remaining = self.remaining.count_ones() as usize;
		(remaining, Some(remaining))
	}
}

impl ExactSizeIterator for CapabilityIter {}

const fn set(capabilities: &[Capability]) -> CapabilitySet {
	let mut bits = 0;
	let mut index = 0;
	while index < capabilities.len() {
		bits |= capabilities[index].bit();
		index += 1;
	}
	CapabilitySet::from_bits(bits)
}

const SEATBELT: CapabilitySet = set(&[
	Capability::NetDisable,
	Capability::NetEnable,
	Capability::NetOutbound,
	Capability::FsReadHost,
	Capability::FsReadScope,
	Capability::FsReadDeny,
	Capability::FsWriteDeny,
	Capability::FsWriteScope,
	Capability::FsWriteEphemeral,
	Capability::EnvScrub,
	Capability::MachRestrict,
]);
const BUBBLEWRAP: CapabilitySet = set(&[
	Capability::EnvScrub,
	Capability::FsReadHost,
	Capability::FsReadScope,
	Capability::FsReadDeny,
	Capability::FsWriteDeny,
	Capability::FsWriteScope,
	Capability::IpcRestrict,
	Capability::NetDisable,
	Capability::NetEnable,
	Capability::NetOutbound,
]);
const LANDLOCK: CapabilitySet = crate::backends::landlock::capabilities();
const GVISOR: CapabilitySet = set(&[
	Capability::NetDisable,
	Capability::NetEnable,
	Capability::NetOutbound,
	Capability::FsReadHost,
	Capability::FsReadScope,
	Capability::FsReadDeny,
	Capability::FsWriteDeny,
	Capability::FsWriteScope,
	Capability::FsWriteEphemeral,
	Capability::EnvScrub,
	Capability::ProcNoExec,
	Capability::KernelIsolation,
	Capability::IpcRestrict,
	Capability::ResCpu,
	Capability::ResMemory,
	Capability::ResPids,
]);
const DOCKER: CapabilitySet = set(&[
	Capability::NetDisable,
	Capability::NetEnable,
	Capability::NetOutbound,
	Capability::FsWriteDeny,
	Capability::FsWriteEphemeral,
	Capability::FsReadScope,
	Capability::FsWriteScope,
	Capability::EnvScrub,
	Capability::IpcRestrict,
	Capability::ResCpu,
	Capability::ResMemory,
	Capability::ResPids,
]);
const DOCKER_RUNSC: CapabilitySet = DOCKER.union(CapabilitySet::one(Capability::KernelIsolation));
const APP_CONTAINER: CapabilitySet = set(&[
	Capability::NetDisable,
	Capability::NetEnable,
	Capability::NetOutbound,
	Capability::FsReadScope,
	Capability::FsWriteDeny,
	Capability::FsWriteEphemeral,
	Capability::FsWriteScope,
	Capability::EnvScrub,
	Capability::ProcNoExec,
	Capability::IpcRestrict,
	Capability::ResCpu,
	Capability::ResMemory,
	Capability::ResPids,
]);

impl Backend {
	/// Returns the capabilities this backend can enforce.
	#[must_use]
	pub const fn capabilities(self) -> CapabilitySet {
		match self {
			Self::Seatbelt => SEATBELT,
			Self::Bubblewrap => BUBBLEWRAP,
			Self::Gvisor => GVISOR,
			Self::Landlock => LANDLOCK,
			Self::DockerEphemeral => DOCKER,
			Self::DockerRunscEphemeral => DOCKER_RUNSC,
			Self::AppContainer => APP_CONTAINER,
		}
	}

	/// Iterates over every known backend in serialized-name order.
	pub fn all() -> impl ExactSizeIterator<Item = Self> {
		[
			Self::AppContainer,
			Self::Bubblewrap,
			Self::DockerEphemeral,
			Self::DockerRunscEphemeral,
			Self::Gvisor,
			Self::Landlock,
			Self::Seatbelt,
		]
		.into_iter()
	}
}

/// Returns capabilities supported on every host OS after optional-backend
/// selection.
#[must_use]
pub const fn portable_capabilities() -> CapabilitySet {
	set(&[
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
	])
}
