#[cfg(unix)]
use std::fs;
use std::{
	ffi::{OsStr, OsString},
	path::{Path, PathBuf},
};

/// Minimal host runtime roots required to execute ordinary system programs in
/// restricted-read sandboxes.
#[cfg(target_os = "macos")]
pub const RUNTIME_READ_ROOTS: &[&str] = &["/bin", "/usr/bin", "/usr/lib", "/lib", "/System"];
/// Minimal host runtime roots required to execute ordinary system programs in
/// restricted-read sandboxes.
#[cfg(target_os = "linux")]
pub const RUNTIME_READ_ROOTS: &[&str] = &["/bin", "/usr/bin", "/usr/lib", "/lib"];
/// Minimal host runtime roots required to execute ordinary system programs in
/// restricted-read sandboxes.
#[cfg(target_os = "windows")]
pub const RUNTIME_READ_ROOTS: &[&str] = &["C:\\Windows\\System32"];
/// Minimal host runtime roots required to execute ordinary system programs in
/// restricted-read sandboxes.
#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
pub const RUNTIME_READ_ROOTS: &[&str] = &[];

use omp_core::{Hash32, Str};
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};

use crate::{
	Capability, CapabilitySet, EnvironmentPolicy, EnvironmentSource, SandboxError, SpecViolation,
	paths::{
		absolute_lexical, canonicalize_deny, canonicalize_existing, insert_path, os_string_bytes,
		path_under_any, temp_roots,
	},
};

/// Network access granted to a sandboxed process tree.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
pub enum NetworkMode {
	/// Deny external and non-local network access.
	#[default]
	#[strum(serialize = "disable")]
	#[serde(rename = "disable")]
	Disabled,
	/// Permit network access inherited from the host.
	#[strum(serialize = "enable")]
	#[serde(rename = "enable")]
	Enabled,
	/// Permit outbound connections while blocking TCP server setup.
	#[strum(serialize = "outbound")]
	#[serde(rename = "outbound")]
	Outbound,
}

/// Filesystem write semantics requested for a sandbox.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
pub enum WriteMode {
	/// Deny all host filesystem writes.
	#[default]
	#[strum(serialize = "none")]
	#[serde(rename = "none")]
	Deny,
	/// Persist writes only under explicitly writable scopes.
	#[strum(serialize = "scope")]
	#[serde(rename = "scope")]
	Scoped,
	/// Permit writes in a private copy or disposable backend layer.
	#[strum(serialize = "ephemeral")]
	#[serde(rename = "ephemeral")]
	Ephemeral,
	/// Persist scoped writes and redirect other writes to an ephemeral layer
	/// when supported.
	#[strum(serialize = "overlay")]
	#[serde(rename = "overlay")]
	Overlay,
}

/// Handling for requested guarantees a backend cannot enforce exactly.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Serialize,
	Deserialize,
)]
pub enum DegradationPolicy {
	/// Reject plans missing any requested guarantee.
	#[default]
	#[strum(serialize = "reject")]
	#[serde(rename = "reject")]
	Reject,
	/// Permit explicit caveats while never advertising a missing guarantee.
	#[strum(serialize = "allow-caveats")]
	#[serde(rename = "allow-caveats")]
	AllowCaveats,
}

/// Validated optional resource ceilings for one sandbox process tree.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ResourceLimits {
	cpu_cores:    Option<f64>,
	memory_bytes: Option<u64>,
	pids:         Option<u32>,
}

impl ResourceLimits {
	/// Validates resource ceilings, treating zero values and `None` as
	/// unlimited.
	pub fn new(
		cpu_cores: Option<f64>,
		memory_bytes: Option<u64>,
		pids: Option<u32>,
	) -> Result<Self, SandboxError> {
		let cpu_cores = match cpu_cores {
			None | Some(0.0) => None,
			Some(value) if value.is_finite() && value > 0.0 => Some(value),
			Some(value) => return Err(SandboxError::InvalidCpuLimit { value }),
		};
		Ok(Self {
			cpu_cores,
			memory_bytes: memory_bytes.filter(|value| *value != 0),
			pids: pids.filter(|value| *value != 0),
		})
	}

	/// Returns the CPU-core ceiling, or `None` when unlimited.
	#[must_use]
	pub const fn cpu_cores(self) -> Option<f64> {
		self.cpu_cores
	}

	/// Returns the memory-byte ceiling, or `None` when unlimited.
	#[must_use]
	pub const fn memory_bytes(self) -> Option<u64> {
		self.memory_bytes
	}

	/// Returns the process-count ceiling, or `None` when unlimited.
	#[must_use]
	pub const fn pids(self) -> Option<u32> {
		self.pids
	}

	pub(crate) const fn is_empty(self) -> bool {
		self.cpu_cores.is_none() && self.memory_bytes.is_none() && self.pids.is_none()
	}
}

/// Backend-independent description of one confined command.
#[derive(Clone, Debug)]
pub struct SandboxSpec {
	pub(crate) program:        OsString,
	pub(crate) args:           Vec<OsString>,
	pub(crate) dir:            Option<PathBuf>,
	pub(crate) environment:    EnvironmentPolicy,
	pub(crate) network:        NetworkMode,
	pub(crate) write:          WriteMode,
	pub(crate) readable:       Vec<PathBuf>,
	pub(crate) read_deny:      Vec<PathBuf>,
	pub(crate) read_override:  Vec<PathBuf>,
	pub(crate) writable:       Vec<PathBuf>,
	pub(crate) write_deny:     Vec<PathBuf>,
	pub(crate) write_override: Vec<PathBuf>,
	pub(crate) unix_sockets:   Vec<PathBuf>,
	pub(crate) proxy_port:     Option<u16>,
	pub(crate) proxy_socket:   Option<PathBuf>,
	pub(crate) allow_temp:     bool,
	pub(crate) supervised:     bool,
	pub(crate) no_exec:        bool,
	pub(crate) mach_services:  Vec<Str>,
	pub(crate) resources:      ResourceLimits,
	pub(crate) degradation:    DegradationPolicy,
	pub(crate) tolerated:      CapabilitySet,
}

impl SandboxSpec {
	/// Creates a deny-network, deny-write specification for `program`.
	#[must_use]
	pub fn new(program: impl Into<OsString>) -> Self {
		Self {
			program:        program.into(),
			args:           Vec::new(),
			dir:            None,
			environment:    EnvironmentPolicy::inherit(),
			network:        NetworkMode::Disabled,
			write:          WriteMode::Deny,
			readable:       Vec::new(),
			read_deny:      Vec::new(),
			read_override:  Vec::new(),
			writable:       Vec::new(),
			write_deny:     Vec::new(),
			write_override: Vec::new(),
			unix_sockets:   Vec::new(),
			proxy_port:     None,
			proxy_socket:   None,
			allow_temp:     false,
			supervised:     true,
			no_exec:        false,
			mach_services:  Vec::new(),
			resources:      ResourceLimits::default(),
			degradation:    DegradationPolicy::Reject,
			tolerated:      CapabilitySet::empty(),
		}
	}

	/// Appends one command argument.
	pub fn arg(&mut self, arg: impl Into<OsString>) -> &mut Self {
		self.args.push(arg.into());
		self
	}

	/// Appends command arguments in iteration order.
	pub fn args<I, S>(&mut self, args: I) -> &mut Self
	where
		I: IntoIterator<Item = S>,
		S: Into<OsString>,
	{
		self.args.extend(args.into_iter().map(Into::into));
		self
	}

	/// Sets and canonicalizes the existing working directory.
	pub fn set_dir(&mut self, dir: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		self.dir = Some(canonicalize_existing(dir.as_ref())?);
		Ok(self)
	}

	/// Replaces the environment source without changing allow or deny patterns.
	pub fn set_environment(&mut self, source: EnvironmentSource) -> &mut Self {
		self.environment.set_source(source);
		self
	}

	/// Starts children from the platform-core name set instead of the full
	/// inherited environment.
	pub fn set_env_core(&mut self, core: bool) -> &mut Self {
		self.environment.set_source(if core {
			EnvironmentSource::Core
		} else {
			EnvironmentSource::Inherit
		});
		self
	}

	/// Injects or overrides one variable after environment filtering.
	pub fn env_set(&mut self, key: impl AsRef<str>, value: impl AsRef<str>) -> &mut Self {
		self.environment.set_override(key.as_ref(), value.as_ref());
		self
	}

	/// Adds a validated environment-name allow pattern.
	pub fn allow_env(&mut self, pattern: impl AsRef<str>) -> Result<&mut Self, SandboxError> {
		self.environment.add_allow(pattern)?;
		Ok(self)
	}

	/// Adds a validated environment-name deny pattern applied after allow
	/// patterns.
	pub fn deny_env(&mut self, pattern: impl AsRef<str>) -> Result<&mut Self, SandboxError> {
		self.environment.add_deny(pattern)?;
		Ok(self)
	}

	/// Sets the network policy.
	pub const fn set_network(&mut self, network: NetworkMode) -> &mut Self {
		self.network = network;
		self
	}

	/// Routes IP connections through a trusted loopback proxy. A Unix socket,
	/// when supplied, is the sole host-side relay endpoint exposed to a Linux
	/// network namespace.
	pub fn set_proxy_endpoint(
		&mut self,
		port: u16,
		unix_socket: Option<&Path>,
	) -> Result<&mut Self, SandboxError> {
		if port == 0 {
			return Err(SpecViolation::ProxyPortZero.into());
		}
		self.proxy_port = Some(port);
		self.proxy_socket = unix_socket.map(Path::to_path_buf);
		Ok(self)
	}

	/// Sets filesystem write semantics.
	pub const fn set_write(&mut self, write: WriteMode) -> &mut Self {
		self.write = write;
		self
	}

	/// Adds and canonicalizes an existing readable path.
	pub fn allow_read(&mut self, path: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		insert_path(&mut self.readable, canonicalize_existing(path.as_ref())?);
		Ok(self)
	}

	/// Adds a read-deny path, allowing a normalized future descendant of an
	/// existing ancestor.
	pub fn deny_read(&mut self, path: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		insert_path(&mut self.read_deny, canonicalize_deny(path.as_ref())?);
		Ok(self)
	}

	/// Reopens one existing nested scope after ordinary read denials.
	pub fn allow_read_override(
		&mut self,
		path: impl AsRef<Path>,
	) -> Result<&mut Self, SandboxError> {
		insert_path(&mut self.read_override, canonicalize_existing(path.as_ref())?);
		Ok(self)
	}

	/// Adds and canonicalizes an existing writable path.
	pub fn allow_write(&mut self, path: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		insert_path(&mut self.writable, canonicalize_existing(path.as_ref())?);
		Ok(self)
	}

	/// Reopens one existing nested scope after ordinary write denials.
	pub fn allow_write_override(
		&mut self,
		path: impl AsRef<Path>,
	) -> Result<&mut Self, SandboxError> {
		insert_path(&mut self.write_override, canonicalize_existing(path.as_ref())?);
		Ok(self)
	}

	/// Carves a read-only subtree out of otherwise writable scopes.
	///
	/// Both the absolute lexical path and its canonical target are retained so
	/// a symlink entry and the object it resolves to can be protected
	/// independently.
	pub fn deny_write(&mut self, path: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		let path = path.as_ref();
		insert_path(&mut self.write_deny, absolute_lexical(path)?);
		insert_path(&mut self.write_deny, canonicalize_deny(path)?);
		Ok(self)
	}

	/// Adds only the normalized lexical spelling of a protected write entry.
	///
	/// This is for an in-scope symlink entry whose target is outside the write
	/// scope: protecting the target would incorrectly expand a scoped deny into
	/// a deny outside its enforceable scope.
	pub fn deny_write_lexical(&mut self, path: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		insert_path(&mut self.write_deny, absolute_lexical(path.as_ref())?);
		Ok(self)
	}

	/// Allows connection to one existing Unix-domain socket without enabling IP
	/// networking. The socket is also readable so restricted filesystem
	/// profiles can resolve the endpoint during `connect`.
	pub fn allow_unix_socket(&mut self, path: impl AsRef<Path>) -> Result<&mut Self, SandboxError> {
		let path = canonicalize_existing(path.as_ref())?;
		#[cfg(unix)]
		{
			use std::os::unix::fs::FileTypeExt as _;

			if !fs::metadata(&path)
				.map_err(|source| SandboxError::Canonicalize { path: path.clone(), source })?
				.file_type()
				.is_socket()
			{
				return Err(SandboxError::NotUnixSocket { path });
			}
		}
		insert_path(&mut self.readable, path.clone());
		insert_path(&mut self.unix_sockets, path);
		Ok(self)
	}

	/// Opts temporary roots into scoped or overlay writes.
	pub const fn set_allow_temp(&mut self, allow: bool) -> &mut Self {
		self.allow_temp = allow;
		self
	}

	/// Detaches the sandboxed tree from supervisor lifetime when set to `false`.
	pub const fn set_supervised(&mut self, supervised: bool) -> &mut Self {
		self.supervised = supervised;
		self
	}

	/// Requests that the initial command may not execute a replacement image.
	pub const fn set_no_exec(&mut self, no_exec: bool) -> &mut Self {
		self.no_exec = no_exec;
		self
	}

	/// Allows one exact macOS Mach service lookup.
	pub fn allow_mach_service(
		&mut self,
		service: impl AsRef<str>,
	) -> Result<&mut Self, SandboxError> {
		let service = service.as_ref();
		if service.trim().is_empty() {
			return Err(SpecViolation::EmptyMachService.into());
		}
		let service = Str::from(service);
		match self.mach_services.binary_search(&service) {
			Ok(_) => {},
			Err(index) => self.mach_services.insert(index, service),
		}
		Ok(self)
	}

	/// Replaces validated resource ceilings.
	pub const fn set_resource_limits(&mut self, limits: ResourceLimits) -> &mut Self {
		self.resources = limits;
		self
	}

	/// Accepts one requested capability going unenforced under
	/// [`DegradationPolicy::Reject`].
	///
	/// The capability stays requested: backends that can enforce it still do,
	/// while a backend unable to enforce it records a caveat instead of
	/// failing compilation. Every other missing guarantee still rejects.
	pub const fn tolerate_missing(&mut self, capability: Capability) -> &mut Self {
		self.tolerated = self.tolerated.union(CapabilitySet::one(capability));
		self
	}

	/// Sets whether unsupported guarantees reject compilation or produce
	/// caveats.
	pub const fn set_degradation(&mut self, degradation: DegradationPolicy) -> &mut Self {
		self.degradation = degradation;
		self
	}

	pub(crate) fn validate(&self) -> Result<(), SandboxError> {
		if self.allow_temp && !matches!(self.write, WriteMode::Scoped | WriteMode::Overlay) {
			return Err(SpecViolation::TempWithoutWritableMode.into());
		}
		if !self.writable.is_empty() && !matches!(self.write, WriteMode::Scoped | WriteMode::Overlay)
		{
			return Err(SpecViolation::WritableWithoutWritableMode.into());
		}
		if self.write == WriteMode::Scoped && self.writable.is_empty() && !self.allow_temp {
			return Err(SpecViolation::EmptyWriteScope.into());
		}
		if self.write != WriteMode::Overlay {
			let temporary = self.allow_temp.then(temp_roots).unwrap_or_default();
			if self
				.write_deny
				.iter()
				.any(|path| !path_under_any(path, &self.writable) && !path_under_any(path, &temporary))
			{
				return Err(SpecViolation::WriteDenyOutsideScope.into());
			}
		}
		if let (Some(dir), false) = (&self.dir, self.readable.is_empty())
			&& !path_under_any(dir, &self.readable)
			&& !path_under_any(dir, &self.writable)
		{
			return Err(SpecViolation::DirectoryOutsideScope.into());
		}
		Ok(())
	}

	pub(crate) fn requested_capabilities(&self) -> CapabilitySet {
		let mut capabilities = CapabilitySet::one(match self.network {
			NetworkMode::Disabled => Capability::NetDisable,
			NetworkMode::Enabled => Capability::NetEnable,
			NetworkMode::Outbound => Capability::NetOutbound,
		});
		capabilities = capabilities.union(match self.write {
			WriteMode::Deny => CapabilitySet::one(Capability::FsWriteDeny),
			WriteMode::Scoped => CapabilitySet::one(Capability::FsWriteScope),
			WriteMode::Ephemeral => CapabilitySet::one(Capability::FsWriteEphemeral),
			WriteMode::Overlay => CapabilitySet::one(Capability::FsWriteScope)
				.union(CapabilitySet::one(Capability::FsWriteEphemeral)),
		});
		capabilities = capabilities.union(CapabilitySet::one(if self.readable.is_empty() {
			Capability::FsReadHost
		} else {
			Capability::FsReadScope
		}));
		if !self.read_deny.is_empty() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::FsReadDeny));
		}
		if !self.write_deny.is_empty() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::FsWriteDeny));
		}
		if self.environment.scrubs() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::EnvScrub));
		}
		if self.unix_sockets.is_empty() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::IpcRestrict));
		}
		if self.no_exec {
			capabilities = capabilities.union(CapabilitySet::one(Capability::ProcNoExec));
		}
		if !self.mach_services.is_empty() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::MachRestrict));
		}
		if self.resources.cpu_cores().is_some() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::ResCpu));
		}
		if self.resources.memory_bytes().is_some() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::ResMemory));
		}
		if self.resources.pids().is_some() {
			capabilities = capabilities.union(CapabilitySet::one(Capability::ResPids));
		}
		capabilities
	}

	pub(crate) fn stable_id(&self, prefix: &str) -> Str {
		let mut hasher = Hash32::hasher();
		hash_bytes(&mut hasher, prefix.as_bytes());
		hash_os(&mut hasher, &self.program);
		hash_os_slice(&mut hasher, &self.args);
		hash_path(&mut hasher, self.dir.as_deref());
		match self.environment.source() {
			EnvironmentSource::Inherit => hash_bytes(&mut hasher, b"inherit"),
			EnvironmentSource::Core => hash_bytes(&mut hasher, b"core"),
			EnvironmentSource::Exact(entries) => {
				hash_bytes(&mut hasher, b"exact");
				hash_os_slice(&mut hasher, entries);
			},
		}
		for pattern in self.environment.allow_patterns() {
			hash_bytes(&mut hasher, pattern.as_bytes());
		}
		hash_bytes(&mut hasher, b"allow-end");
		for pattern in self.environment.deny_patterns() {
			hash_bytes(&mut hasher, pattern.as_bytes());
		}
		hash_bytes(&mut hasher, b"deny-end");
		for (key, value) in self.environment.overrides() {
			hash_os(&mut hasher, key);
			hash_os(&mut hasher, value);
		}
		hash_bytes(&mut hasher, b"env-set-end");
		let network: &'static str = self.network.into();
		let write: &'static str = self.write.into();
		let degradation: &'static str = self.degradation.into();
		hash_bytes(&mut hasher, network.as_bytes());
		hash_bytes(&mut hasher, write.as_bytes());
		hash_paths(&mut hasher, &self.readable);
		hash_paths(&mut hasher, &self.read_deny);
		hash_paths(&mut hasher, &self.read_override);
		hash_paths(&mut hasher, &self.writable);
		hash_paths(&mut hasher, &self.write_deny);
		hash_paths(&mut hasher, &self.write_override);
		hash_paths(&mut hasher, &self.unix_sockets);
		hash_u64(&mut hasher, u64::from(self.proxy_port.unwrap_or(0)));
		hash_path(&mut hasher, self.proxy_socket.as_deref());
		hash_bool(&mut hasher, self.allow_temp);
		hash_bool(&mut hasher, self.supervised);
		hash_bool(&mut hasher, self.no_exec);
		for service in &self.mach_services {
			hash_bytes(&mut hasher, service.as_bytes());
		}
		hash_bytes(&mut hasher, b"mach-end");
		hash_u64(&mut hasher, self.resources.cpu_cores().map_or(0, f64::to_bits));
		hash_u64(&mut hasher, self.resources.memory_bytes().unwrap_or(0));
		hash_u64(&mut hasher, u64::from(self.resources.pids().unwrap_or(0)));
		hash_bytes(&mut hasher, degradation.as_bytes());
		hash_u64(&mut hasher, u64::from(self.tolerated.bits()));
		let digest = hasher.finalize().to_hex();
		Str::from(format!("{prefix}-{}", &digest.as_str()[..16]))
	}
}

fn hash_bytes(hasher: &mut omp_core::hash32::Hasher, bytes: &[u8]) {
	hasher.update((bytes.len() as u64).to_le_bytes());
	hasher.update(bytes);
	hasher.update([0]);
}

fn hash_os(hasher: &mut omp_core::hash32::Hasher, value: &OsStr) {
	hash_bytes(hasher, &os_string_bytes(value));
}

fn hash_os_slice(hasher: &mut omp_core::hash32::Hasher, values: &[OsString]) {
	hash_u64(hasher, values.len() as u64);
	for value in values {
		hash_os(hasher, value);
	}
}

fn hash_path(hasher: &mut omp_core::hash32::Hasher, value: Option<&Path>) {
	match value {
		Some(value) => {
			hash_bool(hasher, true);
			hash_os(hasher, value.as_os_str());
		},
		None => hash_bool(hasher, false),
	}
}

fn hash_paths(hasher: &mut omp_core::hash32::Hasher, paths: &[PathBuf]) {
	hash_u64(hasher, paths.len() as u64);
	for path in paths {
		hash_os(hasher, path.as_os_str());
	}
}

fn hash_bool(hasher: &mut omp_core::hash32::Hasher, value: bool) {
	hash_bytes(hasher, &[u8::from(value)]);
}

fn hash_u64(hasher: &mut omp_core::hash32::Hasher, value: u64) {
	hash_bytes(hasher, &value.to_le_bytes());
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn proxy_endpoint_requires_nonzero_port_and_changes_stable_identity() {
		let mut first = SandboxSpec::new("/bin/true");
		assert!(matches!(
			first.set_proxy_endpoint(0, None),
			Err(SandboxError::InvalidSpec(SpecViolation::ProxyPortZero))
		));
		let before = first.stable_id("sandbox");
		first
			.set_proxy_endpoint(18443, None)
			.expect("proxy endpoint");
		assert_ne!(before, first.stable_id("sandbox"));
	}
}
