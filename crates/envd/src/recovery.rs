//! Startup recovery and bounded stale envd runtime reclamation.

use std::{
	fs, io,
	path::{Path, PathBuf},
	time::{Duration, SystemTime},
};

use super::process_store::{DaemonLease, ProcessStore};

/// Grace period before a dead runtime directory is eligible for reclamation.
pub const STALE_RUNTIME_GRACE: Duration = Duration::from_secs(5 * 60);
/// Maximum candidates examined by one startup sweep.
pub const STALE_RUNTIME_SWEEP_LIMIT: usize = 64;

/// Result of one bounded stale-runtime sweep.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SweepSummary {
	/// Candidate directories examined.
	pub examined: usize,
	/// Dead runtime directories removed.
	pub removed:  usize,
}

/// Removes old runtime directories only after acquiring their abandoned owner
/// lease and proving that no persisted active process identity remains live.
///
/// Candidates newer than five minutes, live leases, malformed metadata, and
/// verified active detached processes are conservatively retained.
#[tracing::instrument(
	name = "stale_runtime_sweep",
	level = "debug",
	skip_all,
	fields(root = %root.display())
)]
pub fn sweep_stale_runtime_dirs(root: &Path) -> io::Result<SweepSummary> {
	let mut candidates = match fs::read_dir(root) {
		Ok(entries) => entries
			.filter_map(Result::ok)
			.filter_map(|entry| {
				entry
					.file_type()
					.ok()
					.filter(|kind| kind.is_dir())
					.map(|_| entry.path())
			})
			.collect::<Vec<_>>(),
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(SweepSummary::default()),
		Err(error) => return Err(error),
	};
	candidates.sort_unstable();
	candidates.truncate(STALE_RUNTIME_SWEEP_LIMIT);
	let now = SystemTime::now();
	let mut summary = SweepSummary::default();
	for candidate in candidates {
		summary.examined += 1;
		if !older_than_grace(&candidate, now)? {
			continue;
		}
		let Some(lease) = reclaimable(&candidate) else {
			continue;
		};
		let quarantine =
			root.join(format!(".reclaiming-{}-{}", std::process::id(), summary.examined));
		fs::rename(&candidate, &quarantine)?;
		drop(lease);
		fs::remove_dir_all(quarantine)?;
		summary.removed += 1;
		tracing::info!(
			path = %candidate.display(),
			examined = summary.examined,
			"stale environment runtime reclaimed",
		);
	}
	Ok(summary)
}

fn older_than_grace(path: &Path, now: SystemTime) -> io::Result<bool> {
	let modified = fs::metadata(path)?.modified()?;
	Ok(now.duration_since(modified).unwrap_or_default() >= STALE_RUNTIME_GRACE)
}

fn reclaimable(candidate: &Path) -> Option<DaemonLease> {
	let lease_path = if candidate.join("processes").is_dir() {
		candidate.join("processes").join("envd.lease")
	} else {
		candidate.join("envd.lease")
	};
	let Ok(lease) = DaemonLease::acquire(&lease_path) else {
		return None;
	};
	let stores = [candidate.join("meta.json"), candidate.join("processes").join("meta.json")];
	let safe = stores
		.into_iter()
		.all(|path| snapshot_has_no_live_processes(path));
	safe.then_some(lease)
}

fn snapshot_has_no_live_processes(path: PathBuf) -> bool {
	match ProcessStore::new(path).load() {
		Ok(Some(snapshot)) => snapshot
			.processes
			.iter()
			.filter(|record| record.phase.is_active())
			.all(|record| record.identity.verify().is_ok_and(|live| !live)),
		Ok(None) => true,
		Err(_) => false,
	}
}
