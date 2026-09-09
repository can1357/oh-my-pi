//! Daemon-owned project client-presence leases.

#[cfg(not(any(unix, windows)))]
use std::process;
use std::{
	collections::HashMap,
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_core::{Str, Ulid};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Failure to maintain daemon-owned client presence.
#[derive(Debug, Error)]
pub enum PresenceError {
	/// The private client directory could not be created.
	#[error("failed to create daemon client-presence directory at {path}")]
	CreateDirectory {
		/// Directory that could not be created.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// The private client directory could not be read.
	#[error("failed to read daemon client-presence directory at {path}")]
	ReadDirectory {
		/// Directory that could not be read.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A client-presence record could not be read.
	#[error("failed to read daemon client-presence record at {path}")]
	ReadRecord {
		/// Record that could not be read.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A client-presence record could not be encoded.
	#[error("failed to encode daemon client-presence record")]
	Encode(#[source] serde_json::Error),
	/// The registering process was already absent.
	#[error("client process {pid} is not live")]
	ClientNotLive {
		/// Process identifier rejected by the daemon.
		pid: u32,
	},
	/// An atomic client-presence update failed.
	#[error("failed to atomically persist daemon client presence")]
	Persist(#[source] io::Error),
	/// A released or stale client-presence record could not be removed.
	#[error("failed to remove daemon client-presence record at {path}")]
	Remove {
		/// Record that could not be removed.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresenceRecord {
	id:          Str,
	client_id:   Str,
	pid:         u32,
	kind:        Str,
	project_dir: PathBuf,
}

struct PresenceState {
	clients_dir: PathBuf,
	project_dir: PathBuf,
	leases:      Mutex<HashMap<Str, PathBuf>>,
}

/// Shared daemon authority for all presence records in one project scope.
#[derive(Clone)]
pub(crate) struct PresenceRegistry {
	state: Arc<PresenceState>,
}

impl PresenceRegistry {
	pub(crate) fn new(state_dir: &Path, project_dir: &Path) -> Self {
		Self {
			state: Arc::new(PresenceState {
				clients_dir: state_dir.join("clients"),
				project_dir: project_dir.to_path_buf(),
				leases:      Mutex::new(HashMap::new()),
			}),
		}
	}

	pub(crate) fn register(
		&self,
		client_id: Str,
		pid: u32,
		kind: Str,
	) -> Result<PresenceLease, PresenceError> {
		if !process_is_live(pid) {
			return Err(PresenceError::ClientNotLive { pid });
		}
		let mut leases = self.state.leases.lock();
		self.ensure_directory()?;
		self.expire_stale_locked(&mut leases)?;
		let id = Str::from(format!("{pid}-{}", Ulid::generate()));
		let path = self.state.clients_dir.join(format!("{id}.json"));
		let record = PresenceRecord {
			id: id.clone(),
			client_id,
			pid,
			kind,
			project_dir: self.state.project_dir.clone(),
		};
		let encoded = serde_json::to_string(&record).map_err(PresenceError::Encode)?;
		crate::atomic_replace(&path, &encoded).map_err(PresenceError::Persist)?;
		leases.insert(id.clone(), path);
		Ok(PresenceLease { registry: self.clone(), id: Some(id) })
	}

	fn ensure_directory(&self) -> Result<(), PresenceError> {
		fs::create_dir_all(&self.state.clients_dir).map_err(|source| {
			PresenceError::CreateDirectory { path: self.state.clients_dir.clone(), source }
		})?;
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			fs::set_permissions(&self.state.clients_dir, fs::Permissions::from_mode(0o700)).map_err(
				|source| PresenceError::CreateDirectory {
					path: self.state.clients_dir.clone(),
					source,
				},
			)?;
		}
		Ok(())
	}

	fn expire_stale_locked(&self, leases: &mut HashMap<Str, PathBuf>) -> Result<(), PresenceError> {
		let entries = match fs::read_dir(&self.state.clients_dir) {
			Ok(entries) => entries,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(source) => {
				return Err(PresenceError::ReadDirectory {
					path: self.state.clients_dir.clone(),
					source,
				});
			},
		};
		for entry in entries {
			let entry = entry.map_err(|source| PresenceError::ReadDirectory {
				path: self.state.clients_dir.clone(),
				source,
			})?;
			let path = entry.path();
			if !entry
				.file_type()
				.map_err(|source| PresenceError::ReadRecord { path: path.clone(), source })?
				.is_file()
			{
				continue;
			}
			let stale = match fs::read(&path) {
				Ok(bytes) => serde_json::from_slice::<PresenceRecord>(&bytes)
					.map_or(true, |record| !process_is_live(record.pid)),
				Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
				Err(source) => {
					return Err(PresenceError::ReadRecord { path: path.clone(), source });
				},
			};
			if stale {
				remove_file(&path)?;
				leases.retain(|_, lease_path| lease_path != &path);
			}
		}
		Ok(())
	}

	fn release(&self, id: &Str) -> Result<(), PresenceError> {
		let mut leases = self.state.leases.lock();
		let Some(path) = leases.get(id) else {
			return Ok(());
		};
		remove_file(path)?;
		leases.remove(id);
		Ok(())
	}
}

/// Connection-owned registration removed on explicit release or disconnect.
#[must_use]
pub(crate) struct PresenceLease {
	registry: PresenceRegistry,
	id:       Option<Str>,
}

impl PresenceLease {
	pub(crate) fn id(&self) -> &Str {
		self
			.id
			.as_ref()
			.expect("an active presence lease has an id")
	}

	pub(crate) fn release(mut self) -> Result<(), PresenceError> {
		let Some(id) = self.id.as_ref() else {
			return Ok(());
		};
		self.registry.release(id)?;
		self.id = None;
		Ok(())
	}
}

impl Drop for PresenceLease {
	fn drop(&mut self) {
		if let Some(id) = self.id.take() {
			let _ = self.registry.release(&id);
		}
	}
}

fn remove_file(path: &Path) -> Result<(), PresenceError> {
	match fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(source) => Err(PresenceError::Remove { path: path.to_path_buf(), source }),
	}
}

#[cfg(unix)]
fn process_is_live(pid: u32) -> bool {
	let Ok(pid) = i32::try_from(pid) else {
		return false;
	};
	// SAFETY: signal zero performs only a process-existence/permission probe.
	unsafe {
		libc::kill(pid, 0) == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
	}
}

#[cfg(windows)]
fn process_is_live(pid: u32) -> bool {
	use windows_sys::Win32::{
		Foundation::CloseHandle,
		System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
	};
	// SAFETY: the returned process handle is checked and immediately closed.
	let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if handle.is_null() {
		false
	} else {
		// SAFETY: `handle` is a live owned process handle.
		unsafe { CloseHandle(handle) };
		true
	}
}

#[cfg(not(any(unix, windows)))]
fn process_is_live(pid: u32) -> bool {
	pid == process::id()
}

#[cfg(test)]
mod tests {
	use std::process;

	use omp_core::sf;

	use super::*;

	fn records(directory: &Path) -> Vec<PresenceRecord> {
		let mut records = fs::read_dir(directory)
			.expect("presence directory")
			.map(|entry| {
				let path = entry.expect("presence entry").path();
				serde_json::from_slice::<PresenceRecord>(&fs::read(path).expect("presence record"))
					.expect("valid presence JSON")
			})
			.collect::<Vec<_>>();
		records.sort_by(|left, right| left.id.cmp(&right.id));
		records
	}

	#[test]
	fn register_writes_pi_compatible_presence_record() {
		let state = tempfile::tempdir().expect("state directory");
		let project = tempfile::tempdir().expect("project directory");
		let registry = PresenceRegistry::new(state.path(), project.path());
		let lease = registry
			.register(sf!("client-a"), process::id(), sf!("interactive"))
			.expect("register presence");

		let records = records(&state.path().join("clients"));
		assert_eq!(records.len(), 1);
		assert_eq!(records[0].client_id, sf!("client-a"));
		assert_eq!(records[0].pid, process::id());
		assert_eq!(records[0].kind, sf!("interactive"));
		assert_eq!(records[0].project_dir, project.path());
		assert_eq!(records[0].id, *lease.id());
	}

	#[test]
	fn explicit_release_removes_presence_record() {
		let state = tempfile::tempdir().expect("state directory");
		let project = tempfile::tempdir().expect("project directory");
		let registry = PresenceRegistry::new(state.path(), project.path());
		let lease = registry
			.register(sf!("client-a"), process::id(), sf!("print"))
			.expect("register presence");

		lease.release().expect("release presence");
		assert!(records(&state.path().join("clients")).is_empty());
	}

	#[test]
	fn registration_expires_stale_pid_records() {
		let state = tempfile::tempdir().expect("state directory");
		let project = tempfile::tempdir().expect("project directory");
		let clients = state.path().join("clients");
		fs::create_dir_all(&clients).expect("clients directory");
		let stale = PresenceRecord {
			id:          sf!("stale"),
			client_id:   sf!("dead-client"),
			pid:         u32::MAX,
			kind:        sf!("rpc"),
			project_dir: project.path().to_path_buf(),
		};
		crate::atomic_replace(
			&clients.join("stale.json"),
			&serde_json::to_string(&stale).expect("encode stale record"),
		)
		.expect("write stale record");
		let registry = PresenceRegistry::new(state.path(), project.path());
		let _live = registry
			.register(sf!("client-a"), process::id(), sf!("rpc"))
			.expect("register live presence");

		let records = records(&clients);
		assert_eq!(records.len(), 1);
		assert_eq!(records[0].client_id, sf!("client-a"));
	}

	#[test]
	fn two_live_clients_coexist() {
		let state = tempfile::tempdir().expect("state directory");
		let project = tempfile::tempdir().expect("project directory");
		let registry = PresenceRegistry::new(state.path(), project.path());
		let _first = registry
			.register(sf!("client-a"), process::id(), sf!("interactive"))
			.expect("register first presence");
		let _second = registry
			.register(sf!("client-b"), process::id(), sf!("rpc"))
			.expect("register second presence");

		let records = records(&state.path().join("clients"));
		assert_eq!(records.len(), 2);
		assert!(
			records
				.iter()
				.any(|record| record.client_id == sf!("client-a"))
		);
		assert!(
			records
				.iter()
				.any(|record| record.client_id == sf!("client-b"))
		);
	}
}
