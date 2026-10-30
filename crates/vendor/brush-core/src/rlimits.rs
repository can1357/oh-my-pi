//! Resource limits the shell applies to the external commands it spawns.
//!
//! The shell runs inside its host process and subshells are clones rather than
//! forks, so `ulimit` must never call `setrlimit` on the host: the change
//! would outlive the subshell and cap the host itself. Limits are kept as
//! shell state instead (cloned into subshells) and applied in each external
//! child between fork and exec.

/// Per-shell resource limit overrides.
#[derive(Clone, Debug, Default)]
pub struct ResourceLimits {
	#[cfg(unix)]
	overrides: Vec<(rlimit::Resource, u64, u64)>,
}

#[cfg(unix)]
impl ResourceLimits {
	/// Returns the `(soft, hard)` limit external commands receive for
	/// `resource`: the shell's override if one is set, else the host's.
	///
	/// # Errors
	///
	/// Returns the host `getrlimit` error when no override is set.
	pub fn get(&self, resource: rlimit::Resource) -> std::io::Result<(u64, u64)> {
		match self.overrides.iter().find(|(r, ..)| *r == resource) {
			Some(&(_, soft, hard)) => Ok((soft, hard)),
			None => resource.get(),
		}
	}

	/// Sets the `(soft, hard)` limit external commands receive for `resource`.
	///
	/// Rejects what `setrlimit` would reject in the child, so the error
	/// surfaces here instead of failing every later spawn: a soft limit above
	/// the hard one, and (without root) a hard limit above the current one.
	///
	/// # Errors
	///
	/// `InvalidInput` for `soft > hard`, `PermissionDenied` for raising the
	/// hard limit unprivileged.
	pub fn set(&mut self, resource: rlimit::Resource, soft: u64, hard: u64) -> std::io::Result<()> {
		if !resource.is_supported() {
			return Err(std::io::ErrorKind::Unsupported.into());
		}
		if soft > hard {
			return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
		}
		let (_, current_hard) = self.get(resource)?;
		if hard > current_hard && !nix::unistd::geteuid().is_root() {
			return Err(std::io::Error::from_raw_os_error(libc::EPERM));
		}
		match self.overrides.iter_mut().find(|(r, ..)| *r == resource) {
			Some(entry) => *entry = (resource, soft, hard),
			None => self.overrides.push((resource, soft, hard)),
		}
		Ok(())
	}

	/// Applies the overrides to the calling process. Only for a forked child
	/// before exec: allocation-free and async-signal-safe.
	pub(crate) fn apply_in_child(&self) -> std::io::Result<()> {
		for &(resource, soft, hard) in &self.overrides {
			resource.set(soft, hard)?;
		}
		Ok(())
	}

	/// Returns whether no override is set.
	pub(crate) fn is_empty(&self) -> bool {
		self.overrides.is_empty()
	}
}
