use std::ffi::OsString;

use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{Backend, Capability, CapabilitySet};

/// One explicit limitation or semantic degradation in a compiled plan.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Caveat {
	/// Capability affected by this caveat, or `None` for contextual guidance.
	pub capability: Option<Capability>,
	/// Human-readable explanation rendered only at caller boundaries.
	pub message:    Str,
}

impl Caveat {
	/// Creates a capability-specific caveat.
	#[must_use]
	pub fn capability(capability: Capability, message: impl Into<Str>) -> Self {
		Self { capability: Some(capability), message: message.into() }
	}

	/// Creates contextual guidance not tied to one capability.
	#[must_use]
	pub fn general(message: impl Into<Str>) -> Self {
		Self { capability: None, message: message.into() }
	}
}

/// Filesystem virtualization mechanism materialized during preparation.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Serialize, Deserialize,
)]
pub enum FilesystemVirtualizationKind {
	/// Private workspace copy rooted at the requested working directory.
	#[strum(serialize = "workspace-clone")]
	#[serde(rename = "workspace-clone")]
	WorkspaceClone,
	/// In-memory overlay across the complete backend root.
	#[strum(serialize = "memory-overlay")]
	#[serde(rename = "memory-overlay")]
	MemoryOverlay,
	/// In-memory overlay outside explicitly persistent writable scopes.
	#[strum(serialize = "root-overlay")]
	#[serde(rename = "root-overlay")]
	RootOverlay,
	/// Backend denies writes outside explicitly writable scopes without
	/// redirecting them.
	#[strum(serialize = "scoped-deny")]
	#[serde(rename = "scoped-deny")]
	ScopedDeny,
}

/// Pure, inspectable compilation of a sandbox specification.
#[derive(Clone, Debug)]
pub struct Plan {
	backend:        Backend,
	requested:      CapabilitySet,
	enforced:       CapabilitySet,
	argv:           Vec<OsString>,
	profile:        Option<Str>,
	caveats:        Vec<Caveat>,
	filesystem:     Option<FilesystemVirtualizationKind>,
	command_backed: bool,
}

impl Plan {
	pub(crate) fn new(
		backend: Backend,
		requested: CapabilitySet,
		enforced: CapabilitySet,
		argv: Vec<OsString>,
		command_backed: bool,
	) -> Self {
		debug_assert!(
			enforced.difference(backend.capabilities()).is_empty(),
			"backend {backend} cannot enforce requested set {enforced:?}; capabilities={:?}",
			backend.capabilities(),
		);
		Self {
			backend,
			requested,
			enforced,
			argv,
			profile: None,
			caveats: Vec::new(),
			filesystem: None,
			command_backed,
		}
	}

	/// Returns the backend selected for this plan.
	#[must_use]
	pub const fn backend(&self) -> Backend {
		self.backend
	}

	/// Returns every guarantee requested by the specification.
	#[must_use]
	pub const fn requested(&self) -> CapabilitySet {
		self.requested
	}

	/// Returns only guarantees actually enforced by the compiled plan.
	#[must_use]
	pub const fn enforced(&self) -> CapabilitySet {
		self.enforced
	}

	/// Returns the exact launcher argv without prepared environment values.
	#[must_use]
	pub fn argv(&self) -> &[OsString] {
		&self.argv
	}

	/// Returns a generated text profile when the backend uses one.
	#[must_use]
	pub fn profile(&self) -> Option<&str> {
		self.profile.as_ref().map(Str::as_str)
	}

	/// Returns explicit semantic limitations and degradations.
	#[must_use]
	pub fn caveats(&self) -> &[Caveat] {
		&self.caveats
	}

	/// Returns the filesystem virtualization mechanism, when one is planned.
	#[must_use]
	pub const fn filesystem_virtualization(&self) -> Option<FilesystemVirtualizationKind> {
		self.filesystem
	}

	pub(crate) const fn command_backed(&self) -> bool {
		self.command_backed
	}

	pub(crate) fn set_profile(&mut self, profile: impl Into<Str>) {
		self.profile = Some(profile.into());
	}

	pub(crate) fn add_caveat(&mut self, caveat: Caveat) {
		if !self.caveats.contains(&caveat) {
			self.caveats.push(caveat);
		}
	}

	pub(crate) const fn set_filesystem(&mut self, filesystem: FilesystemVirtualizationKind) {
		self.filesystem = Some(filesystem);
	}
}
