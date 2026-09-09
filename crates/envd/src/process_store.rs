//! Atomic detached-process metadata and the exclusive envd durable-owner lease.

use std::{
	cmp,
	fs::{self, File, OpenOptions},
	io::{self, BufReader, BufWriter, Seek as _, Write as _},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::process_identity::{IdentityError, ProcessIdentity};

/// Current on-disk metadata schema revision.
pub const PROCESS_STORE_VERSION: u32 = 1;
/// Maximum terminal records returned after active records.
pub const RECENT_TERMINAL_LIMIT: usize = 10;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Versioned durable envd state written as one atomic snapshot.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProcessStoreSnapshot {
	/// On-disk schema revision.
	pub version:                  u32,
	/// Exclusive durable owner recorded with the snapshot.
	pub daemon:                   ProcessIdentity,
	/// Named process generations known to the owner.
	pub processes:                Vec<ProcessRecord>,
	/// Most recent shutdown acknowledgement committed before its wire reply.
	#[serde(default)]
	pub shutdown_acknowledgement: Option<ShutdownAcknowledgement>,
}

impl ProcessStoreSnapshot {
	/// Creates an empty snapshot for the current daemon.
	pub const fn new(daemon: ProcessIdentity) -> Self {
		Self {
			version: PROCESS_STORE_VERSION,
			daemon,
			processes: Vec::new(),
			shutdown_acknowledgement: None,
		}
	}

	/// Returns active records oldest-to-newest, followed by at most ten newest
	/// terminal records.
	pub fn ordered_records(&self) -> Vec<&ProcessRecord> {
		let mut active = Vec::new();
		let mut terminal = Vec::new();
		for record in &self.processes {
			if record.phase.is_active() {
				active.push(record);
			} else {
				terminal.push(record);
			}
		}
		active.sort_unstable_by_key(|record| record.started_order);
		terminal.sort_unstable_by_key(|record| cmp::Reverse(record.recent_order));
		terminal.truncate(RECENT_TERMINAL_LIMIT);
		active.extend(terminal);
		active
	}
}

/// Durable proof that shutdown reached graceful process handling.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ShutdownAcknowledgement {
	/// Unix time at which shutdown was accepted.
	pub accepted_at_ms: u64,
	/// Managed processes sent through process-tree cancellation.
	pub stopped:        u32,
	/// Verified detached persistent processes deliberately spared.
	pub spared:         u32,
}
/// Durable metadata for one named process generation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ProcessRecord {
	/// User-visible unique process name.
	pub name:        Str,
	/// Protobuf-encoded process specification used for restart and recovery.
	#[serde(default)]
	pub spec_wire:   Vec<u8>,
	/// Protobuf-encoded readiness probes used for restart and recovery.
	#[serde(default)]
	pub ready_wire:  Vec<Vec<u8>>,
	/// Protobuf-encoded terminal execution status retained across owner restart.
	#[serde(default)]
	pub status_wire: Vec<u8>,
	/// Directory containing the process log files.
	#[serde(default)]
	pub process_dir: PathBuf,

	/// Monotone envd generation for stale-command fencing.
	pub generation:           u64,
	/// Verified operating-system identity.
	pub identity:             ProcessIdentity,
	/// Whether this process is eligible to survive daemon shutdown.
	pub detached:             bool,
	/// Whether restart policy persists across owner restart.
	pub persist:              bool,
	/// Current lifecycle phase.
	pub phase:                ProcessPhase,
	/// Absolute first retained output byte.
	pub log_start_offset:     u64,
	/// Absolute byte after the last retained output byte.
	pub log_end_offset:       u64,
	/// Number of completed log rotations.
	pub log_rotations:        u32,
	/// Whether a supervised replacement is durably scheduled.
	#[serde(default)]
	pub restart_pending:      bool,
	/// Total supervised restarts for this named generation.
	pub restart_count:        u32,
	/// Consecutive failures not reset by healthy uptime.
	pub consecutive_failures: u32,
	/// Bounded restart decisions retained for diagnosis.
	pub restart_history:      Vec<RestartRecord>,
	/// Monotone key used for oldest-first active ordering.
	pub started_order:        u64,
	/// Monotone key updated at terminal transition for newest-first recency.
	pub recent_order:         u64,
}

/// Durable lifecycle phase used for recovery admission and ordering.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProcessPhase {
	/// Launch metadata is reserved but no child is admitted yet.
	Starting,
	/// Child is live and readiness conditions remain pending.
	WaitingReady,
	/// Child is live and ready or has no readiness conditions.
	Running,
	/// Child exited normally.
	Exited,
	/// Child was intentionally stopped.
	Stopped,
	/// Child failed to start or exited unsuccessfully.
	Failed,
}

impl ProcessPhase {
	/// Returns whether the phase may still own a live process.
	pub(crate) const fn is_active(self) -> bool {
		matches!(self, Self::Starting | Self::WaitingReady | Self::Running)
	}

	/// Returns whether the phase records a settled generation.
	pub(crate) const fn is_terminal(self) -> bool {
		!self.is_active()
	}
}

/// One restart decision retained in process metadata.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct RestartRecord {
	/// Unix timestamp of the decision.
	pub at_ms:         u64,
	/// Previous exit code, absent when launch itself failed.
	pub exit_code:     Option<i32>,
	/// Scheduled delay before the next generation.
	pub delay_ms:      u64,
	/// Consecutive failure count after this decision.
	pub failure_count: u32,
}

/// Atomic JSON snapshot owner.
#[derive(Clone, Debug)]
pub struct ProcessStore {
	path: PathBuf,
}

impl ProcessStore {
	/// Returns the directory containing all named-process runtime state.
	pub fn process_root(&self) -> PathBuf {
		self
			.path
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.to_owned()
	}

	/// Uses `path` as the complete versioned metadata file.
	pub fn new(path: impl Into<PathBuf>) -> Self {
		Self { path: path.into() }
	}

	/// Loads and revision-checks the durable snapshot, or returns `None` when
	/// absent.
	pub fn load(&self) -> Result<Option<ProcessStoreSnapshot>, StoreError> {
		let file = match File::open(&self.path) {
			Ok(file) => file,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(error) => return Err(StoreError::Io(error)),
		};
		let snapshot: ProcessStoreSnapshot =
			serde_json::from_reader(BufReader::new(file)).map_err(StoreError::Decode)?;
		if snapshot.version != PROCESS_STORE_VERSION {
			return Err(StoreError::UnsupportedVersion {
				actual:    snapshot.version,
				supported: PROCESS_STORE_VERSION,
			});
		}
		Ok(Some(snapshot))
	}

	/// Commits shutdown handling before the corresponding wire acknowledgement.
	pub fn record_shutdown(
		&self,
		acknowledgement: ShutdownAcknowledgement,
	) -> Result<(), StoreError> {
		let mut snapshot = self.load()?.unwrap_or(ProcessStoreSnapshot::new(
			ProcessIdentity::current().map_err(StoreError::Identity)?,
		));
		snapshot.shutdown_acknowledgement = Some(acknowledgement);
		self.save(&snapshot)
	}

	/// Writes a complete temp snapshot, fsyncs it, atomically renames it, then
	/// fsyncs its directory.
	pub fn save(&self, snapshot: &ProcessStoreSnapshot) -> Result<(), StoreError> {
		if snapshot.version != PROCESS_STORE_VERSION {
			return Err(StoreError::UnsupportedVersion {
				actual:    snapshot.version,
				supported: PROCESS_STORE_VERSION,
			});
		}
		let parent = self.path.parent().unwrap_or_else(|| Path::new("."));
		fs::create_dir_all(parent).map_err(StoreError::Io)?;
		let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let temp = parent.join(format!(".process-meta.{}.{}.tmp", std::process::id(), sequence));
		let file = OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&temp)
			.map_err(StoreError::Io)?;
		let mut writer = BufWriter::new(file);
		if let Err(error) = serde_json::to_writer(&mut writer, snapshot) {
			let _ = fs::remove_file(&temp);
			return Err(StoreError::Encode(error));
		}
		writer.flush().map_err(StoreError::Io)?;
		writer.get_ref().sync_all().map_err(StoreError::Io)?;
		drop(writer);
		if let Err(error) = atomic_replace(&temp, &self.path) {
			let _ = fs::remove_file(&temp);
			return Err(StoreError::Io(error));
		}
		sync_parent(parent).map_err(StoreError::Io)
	}
}
#[cfg(unix)]
fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
	fs::rename(source, target)
}

#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path) -> io::Result<()> {
	use std::os::windows::ffi::OsStrExt as _;

	use windows_sys::Win32::Storage::FileSystem::{
		MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
	};

	let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
	let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
	// SAFETY: both UTF-16 paths are NUL-terminated and remain live for the call.
	if unsafe {
		MoveFileExW(
			source.as_ptr(),
			target.as_ptr(),
			MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
		)
	} == 0
	{
		Err(io::Error::last_os_error())
	} else {
		Ok(())
	}
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
	File::open(parent).and_then(|directory| directory.sync_all())
}

#[cfg(windows)]
fn sync_parent(_parent: &Path) -> io::Result<()> {
	Ok(())
}

/// Held operating-system lock proving this envd is the sole durable owner.
pub struct DaemonLease {
	_file:        File,
	/// Identity written into the locked lease file.
	pub identity: ProcessIdentity,
}

impl DaemonLease {
	/// Acquires a non-blocking exclusive lock and records the verified daemon
	/// identity.
	pub fn acquire(path: &Path) -> Result<Self, LeaseError> {
		if let Some(parent) = path.parent() {
			fs::create_dir_all(parent).map_err(LeaseError::Io)?;
		}
		let mut file = OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.open(path)
			.map_err(LeaseError::Io)?;
		lock_exclusive(&file)?;
		let identity = ProcessIdentity::current()?;
		file.set_len(0).map_err(LeaseError::Io)?;
		file.rewind().map_err(LeaseError::Io)?;
		serde_json::to_writer(&mut file, &identity).map_err(LeaseError::Encode)?;
		file.flush().map_err(LeaseError::Io)?;
		file.sync_all().map_err(LeaseError::Io)?;
		Ok(Self { _file: file, identity })
	}
}

#[cfg(unix)]
fn lock_exclusive(file: &File) -> Result<(), LeaseError> {
	use std::os::fd::AsRawFd as _;
	// SAFETY: flock operates on the valid owned descriptor and stores no pointer.
	let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
	if result == 0 {
		Ok(())
	} else {
		let error = io::Error::last_os_error();
		if matches!(error.raw_os_error(), Some(code) if code == libc::EWOULDBLOCK || code == libc::EAGAIN)
		{
			Err(LeaseError::AlreadyOwned)
		} else {
			Err(LeaseError::Io(error))
		}
	}
}

#[cfg(windows)]
fn lock_exclusive(file: &File) -> Result<(), LeaseError> {
	use std::{mem::zeroed, os::windows::io::AsRawHandle as _};

	use windows_sys::Win32::{
		Foundation::{ERROR_LOCK_VIOLATION, GetLastError},
		Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx},
		System::IO::OVERLAPPED,
	};
	// SAFETY: OVERLAPPED is an integer/handle record valid when zeroed.
	let mut overlapped = unsafe { zeroed::<OVERLAPPED>() };
	// SAFETY: handle is valid for the held File and OVERLAPPED remains live for
	// this synchronous call.
	let ok = unsafe {
		LockFileEx(
			file.as_raw_handle(),
			LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
			0,
			u32::MAX,
			u32::MAX,
			&raw mut overlapped,
		)
	};
	if ok != 0 {
		Ok(())
	} else if unsafe { GetLastError() } == ERROR_LOCK_VIOLATION {
		Err(LeaseError::AlreadyOwned)
	} else {
		Err(LeaseError::Io(io::Error::last_os_error()))
	}
}

/// Atomic process metadata failure.
#[derive(Debug, Error)]
pub enum StoreError {
	/// Filesystem operation failed.
	#[error("process metadata filesystem operation failed")]
	Io(#[source] io::Error),
	/// Snapshot serialization failed.
	#[error("process metadata serialization failed")]
	Encode(#[source] serde_json::Error),
	/// Snapshot decoding failed.
	#[error("process metadata decoding failed")]
	Decode(#[source] serde_json::Error),
	/// Current daemon identity could not be captured for a new store.
	#[error("process metadata owner identity could not be established")]
	Identity(#[source] IdentityError),
	/// On-disk schema is not supported by this binary.
	#[error("process metadata version {actual} is unsupported; expected {supported}")]
	UnsupportedVersion {
		/// On-disk version.
		actual:    u32,
		/// Current version.
		supported: u32,
	},
}

/// Exclusive durable-owner lease failure.
#[derive(Debug, Error)]
pub enum LeaseError {
	/// Another live envd holds the operating-system lease.
	#[error("another environment daemon owns the durable process lease")]
	AlreadyOwned,
	/// Lease filesystem operation failed.
	#[error("durable process lease filesystem operation failed")]
	Io(#[source] io::Error),
	/// Current process identity could not be established.
	#[error("durable process owner identity could not be established")]
	Identity(#[from] IdentityError),
	/// Lease identity serialization failed.
	#[error("durable process owner identity serialization failed")]
	Encode(#[source] serde_json::Error),
}

#[cfg(test)]
mod tests {
	use super::*;

	fn record(name: &str, phase: ProcessPhase, started: u64, recent: u64) -> ProcessRecord {
		ProcessRecord {
			name: Str::from(name),
			spec_wire: Vec::new(),
			ready_wire: Vec::new(),
			status_wire: vec![0x08, 0x01],
			process_dir: PathBuf::new(),
			generation: 1,
			identity: ProcessIdentity::current().unwrap(),
			detached: true,
			persist: true,
			phase,
			log_start_offset: 4,
			log_end_offset: 19,
			log_rotations: 1,
			restart_pending: false,
			restart_count: 2,
			consecutive_failures: 1,
			restart_history: vec![RestartRecord {
				at_ms:         7,
				exit_code:     Some(1),
				delay_ms:      1000,
				failure_count: 1,
			}],
			started_order: started,
			recent_order: recent,
		}
	}

	#[test]
	fn atomic_store_round_trip_and_ordering() {
		let directory = tempfile::tempdir().unwrap();
		let store = ProcessStore::new(directory.path().join("meta.json"));
		let daemon = ProcessIdentity::current().unwrap();
		let mut snapshot = ProcessStoreSnapshot::new(daemon);
		snapshot.shutdown_acknowledgement =
			Some(ShutdownAcknowledgement { accepted_at_ms: 42, stopped: 2, spared: 1 });
		snapshot
			.processes
			.push(record("new-active", ProcessPhase::Running, 20, 0));
		snapshot
			.processes
			.push(record("old-active", ProcessPhase::WaitingReady, 10, 0));
		for index in 0..12 {
			snapshot.processes.push(record(
				&format!("terminal-{index}"),
				ProcessPhase::Exited,
				0,
				index,
			));
		}
		store.save(&snapshot).unwrap();
		let loaded = store.load().unwrap().unwrap();
		assert_eq!(loaded, snapshot);
		let ordered = loaded.ordered_records();
		assert_eq!(ordered.len(), 12);
		assert_eq!(ordered[0].name.as_str(), "old-active");
		assert_eq!(ordered[1].name.as_str(), "new-active");
		assert_eq!(ordered[2].name.as_str(), "terminal-11");
		assert_eq!(ordered.last().unwrap().name.as_str(), "terminal-2");
	}

	#[test]
	fn daemon_lease_is_exclusive() {
		let directory = tempfile::tempdir().unwrap();
		let path = directory.path().join("envd.lease");
		let lease = DaemonLease::acquire(&path).unwrap();
		assert_eq!(lease.identity.pid, std::process::id());
		assert!(matches!(DaemonLease::acquire(&path), Err(LeaseError::AlreadyOwned)));
		drop(lease);
		assert!(DaemonLease::acquire(&path).is_ok());
	}
}
