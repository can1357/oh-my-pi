//! Non-blocking, advisory release checks for interactive startup.
//!
//! The checker is an observer-side concern: it reads archived convars, talks
//! only to the fixed official manifest endpoints owned by `update_cmd`, and
//! posts a typed host action. It never mutates configuration, sessions, or the
//! executable.

use std::{
	fs::{self, File, OpenOptions},
	io,
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;

use crate::{
	settings::{CL_STARTUP_CHECK_UPDATE, CL_UPDATE_CHANNEL, UpdateChannel},
	update_cmd,
};

/// Network and cache cadence. Cached availability is still presented on each
/// eligible launch; only the official metadata request is rate-limited.
const CHECK_CADENCE: Duration = Duration::from_secs(6 * 60 * 60);
/// Bounded request budget for the startup check.
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
/// Cache files contain three scalar fields. Refuse oversized or hand-edited
/// input before allocating for it.
const MAX_CACHE_BYTES: u64 = 4 * 1024;
const CACHE_SCHEMA: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct CachedCheck {
	schema:        u8,
	checked_at_ms: u64,
	latest:        Option<Str>,
}

enum Due {
	Fresh(Option<Str>),
	Busy,
	Lease(Lease),
}

struct Lease {
	_lock:  File,
	state:  PathBuf,
	now_ms: u64,
}

impl Lease {
	fn complete(self, latest: Option<Str>) -> io::Result<()> {
		let state = CachedCheck { schema: CACHE_SCHEMA, checked_at_ms: self.now_ms, latest };
		let encoded = toml::to_string(&state).map_err(io::Error::other)?;
		// The file is advisory and guarded by the channel lease. A torn
		// cache is ignored on the next startup rather than recovered as
		// authoritative state.
		fs::write(&self.state, encoded)
	}
}

/// Cancels the metadata request when the interactive host stops or startup
/// fails. Dropping a Tokio handle alone detaches it, so this guard aborts it.
#[must_use]
pub(crate) struct StartupUpdateTask(JoinHandle<()>);

impl Drop for StartupUpdateTask {
	fn drop(&mut self) {
		self.0.abort();
	}
}

/// Starts the interactive-only update check without joining it to startup.
///
/// Print, RPC, and ACP adapters never call this function. A piped default
/// launch is promoted to print before this boundary, while a gateway-backed
/// interactive host remains eligible because the notice belongs to its local
/// observer.
pub(crate) fn schedule(ctx: Arc<omp_con::Ctx>) -> Option<StartupUpdateTask> {
	if !eligible(true, CL_STARTUP_CHECK_UPDATE.get(&ctx)) {
		return None;
	}
	let channel = CL_UPDATE_CHANNEL.get(&ctx);
	Some(StartupUpdateTask(tokio::spawn(async move {
		let Ok(root) = update_cmd::update_cache_dir() else {
			return;
		};
		let Ok(now_ms) = unix_millis(SystemTime::now()) else {
			return;
		};
		let latest = match acquire_due(&root, channel, now_ms, CHECK_CADENCE) {
			Ok(Due::Fresh(latest)) => latest,
			Ok(Due::Busy) | Err(_) => return,
			Ok(Due::Lease(lease)) => {
				let latest = update_cmd::fetch_startup_release_manifest(channel, FETCH_TIMEOUT).await;
				let _ = lease.complete(latest.clone());
				latest
			},
		};
		let Some(latest) = latest else {
			return;
		};
		// A settings edit while the request was in flight wins. Never show a
		// disabled check or a result from the channel the user left.
		if !CL_STARTUP_CHECK_UPDATE.get(&ctx) || CL_UPDATE_CHANNEL.get(&ctx) != channel {
			return;
		}
		if !update_cmd::compare_versions(latest.as_str(), env!("CARGO_PKG_VERSION")).is_gt() {
			return;
		}
		let channel: &'static str = channel.into();
		let Some(update) = omp_chat::notices::update::UpdateAvailable::new(latest, channel) else {
			return;
		};
		if let Some(mailbox) = ctx.user::<omp_chat::HostMailbox>() {
			mailbox.post(omp_chat::HostAction::UpdateAvailable(update));
		}
	})))
}

const fn eligible(interactive: bool, enabled: bool) -> bool {
	interactive && enabled
}

fn acquire_due(
	root: &Path,
	channel: UpdateChannel,
	now_ms: u64,
	cadence: Duration,
) -> io::Result<Due> {
	fs::create_dir_all(root)?;
	let channel_name: &'static str = channel.into();
	let lock = OpenOptions::new()
		.create(true)
		.read(true)
		.write(true)
		.open(root.join(format!("startup-check-{channel_name}.lock")))?;
	if !try_lock(&lock)? {
		return Ok(Due::Busy);
	}
	let state_path = root.join(format!("startup-check-{channel_name}.toml"));
	if let Some(cache) = read_cache(&state_path)? {
		let cadence_ms = u64::try_from(cadence.as_millis()).unwrap_or(u64::MAX);
		if cache.schema == CACHE_SCHEMA
			&& cache.checked_at_ms <= now_ms
			&& now_ms - cache.checked_at_ms < cadence_ms
		{
			match cache.latest {
				None => return Ok(Due::Fresh(None)),
				Some(version) => {
					if let Some(version) = update_cmd::validate_startup_release(channel, version) {
						return Ok(Due::Fresh(Some(version)));
					}
				},
			}
		}
	}
	Ok(Due::Lease(Lease { _lock: lock, state: state_path, now_ms }))
}

fn read_cache(path: &Path) -> io::Result<Option<CachedCheck>> {
	let metadata = match fs::metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error),
	};
	if metadata.len() > MAX_CACHE_BYTES {
		return Ok(None);
	}
	let text = fs::read_to_string(path)?;
	Ok(toml::from_str(&text).ok())
}

fn unix_millis(now: SystemTime) -> io::Result<u64> {
	let millis = now
		.duration_since(UNIX_EPOCH)
		.map_err(io::Error::other)?
		.as_millis();
	u64::try_from(millis).map_err(io::Error::other)
}

#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<bool> {
	use std::os::fd::AsRawFd as _;

	// SAFETY: `file` owns a valid descriptor and flock stores no borrowed pointer.
	let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
	if result == 0 {
		return Ok(true);
	}
	let error = io::Error::last_os_error();
	if error.raw_os_error() == Some(libc::EWOULDBLOCK) || error.raw_os_error() == Some(libc::EAGAIN)
	{
		Ok(false)
	} else {
		Err(error)
	}
}

#[cfg(windows)]
fn try_lock(file: &File) -> io::Result<bool> {
	use std::{mem::zeroed, os::windows::io::AsRawHandle as _};

	use windows_sys::Win32::{
		Foundation::{ERROR_LOCK_VIOLATION, GetLastError},
		Storage::FileSystem::{LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY, LockFileEx},
		System::IO::OVERLAPPED,
	};

	// SAFETY: OVERLAPPED is an integer/handle record valid when zeroed.
	let mut overlapped = unsafe { zeroed::<OVERLAPPED>() };
	// SAFETY: the File owns a valid handle and OVERLAPPED remains live for
	// this synchronous, nonblocking call.
	let locked = unsafe {
		LockFileEx(
			file.as_raw_handle(),
			LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
			0,
			u32::MAX,
			u32::MAX,
			&raw mut overlapped,
		)
	};
	if locked != 0 {
		Ok(true)
	} else if unsafe { GetLastError() } == ERROR_LOCK_VIOLATION {
		Ok(false)
	} else {
		Err(io::Error::last_os_error())
	}
}

#[cfg(not(any(unix, windows)))]
fn try_lock(_file: &File) -> io::Result<bool> {
	Ok(true)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[derive(Clone, Copy)]
	enum Adapter {
		Interactive,
		Print,
		Rpc,
		Acp,
	}

	impl Adapter {
		const fn interactive(self) -> bool {
			matches!(self, Self::Interactive)
		}
	}

	#[tokio::test]
	async fn dropping_guard_cancels_the_background_request() {
		struct Dropped(flume::Sender<()>);
		impl Drop for Dropped {
			fn drop(&mut self) {
				let _ = self.0.send(());
			}
		}

		let (started_tx, started_rx) = flume::bounded(1);
		let (dropped_tx, dropped_rx) = flume::bounded(1);
		let handle = tokio::spawn(async move {
			let _dropped = Dropped(dropped_tx);
			let _ = started_tx.send(());
			std::future::pending::<()>().await;
		});
		started_rx.recv_async().await.expect("task started");
		drop(StartupUpdateTask(handle));
		tokio::time::timeout(Duration::from_secs(1), dropped_rx.recv_async())
			.await
			.expect("cancellation deadline")
			.expect("task dropped");
	}

	#[test]
	fn automatic_check_is_enabled_only_for_interactive_chat() {
		for (adapter, allowed) in [
			(Adapter::Interactive, true),
			(Adapter::Print, false),
			(Adapter::Rpc, false),
			(Adapter::Acp, false),
		] {
			assert_eq!(eligible(adapter.interactive(), true), allowed);
		}
		assert!(!eligible(true, false), "the archived opt-out wins");
	}

	#[test]
	fn due_checks_are_channel_scoped_coalesced_and_cached() {
		let root = tempfile::tempdir().expect("cache");
		let now = 1_000_000;
		let Due::Lease(stable) =
			acquire_due(root.path(), UpdateChannel::Stable, now, CHECK_CADENCE).expect("first lease")
		else {
			panic!("first stable check must be due");
		};
		assert!(matches!(
			acquire_due(root.path(), UpdateChannel::Stable, now, CHECK_CADENCE).expect("coalesce"),
			Due::Busy
		));
		let version = Str::new_static("999.0.0");
		stable
			.complete(Some(version.clone()))
			.expect("persist cache");

		let Due::Fresh(cached) = acquire_due(
			root.path(),
			UpdateChannel::Stable,
			now + u64::try_from(CHECK_CADENCE.as_millis()).expect("cadence fits") - 1,
			CHECK_CADENCE,
		)
		.expect("fresh cache") else {
			panic!("stable cache must suppress a request inside the cadence");
		};
		assert_eq!(cached, Some(version));
		let Due::Lease(canary) =
			acquire_due(root.path(), UpdateChannel::Canary, now, CHECK_CADENCE).expect("canary lease")
		else {
			panic!("channels must have independent leases");
		};
		canary.complete(None).expect("persist failed attempt");
		assert!(matches!(
			acquire_due(root.path(), UpdateChannel::Canary, now + 1, CHECK_CADENCE)
				.expect("failed-attempt cadence"),
			Due::Fresh(None)
		));
	}

	#[test]
	fn invalid_cached_version_never_reaches_the_host() {
		let root = tempfile::tempdir().expect("cache");
		let channel = "stable";
		let state = CachedCheck {
			schema:        CACHE_SCHEMA,
			checked_at_ms: 50,
			latest:        Some(Str::new_static("1.2.3\nforged")),
		};
		fs::write(
			root.path().join(format!("startup-check-{channel}.toml")),
			toml::to_string(&state).expect("encode"),
		)
		.expect("write");
		assert!(matches!(
			acquire_due(root.path(), UpdateChannel::Stable, 51, CHECK_CADENCE).expect("cache"),
			Due::Lease(_)
		));
	}
}
