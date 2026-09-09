//! Bank diagnostics and retryable SQLite cleanup.

use std::{
	fs, io,
	path::{Path, PathBuf},
	thread,
	time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::{
	Result,
	store::{BankStore, IndexGeneration, IntegrityReport, StoreCounts},
};

const REMOVE_RETRIES: usize = 40;
const REMOVE_RETRY_DELAY: Duration = Duration::from_millis(25);

/// Diagnostics for one scoped bank.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct BankDiagnostic {
	/// Bank identifier.
	pub bank:           String,
	/// Non-secret database target.
	pub database:       PathBuf,
	/// Database byte size.
	pub database_bytes: u64,
	/// Durable row counts.
	pub counts:         StoreCounts,
	/// SQLite and derived-index health.
	pub integrity:      IntegrityReport,
}

/// Collects complete diagnostics for one bank.
pub fn inspect(store: &BankStore) -> Result<BankDiagnostic> {
	let database_bytes = fs::metadata(store.path()).map_or(0, |value| value.len());
	Ok(BankDiagnostic {
		bank: store.bank().to_string(),
		database: store.path().to_path_buf(),
		database_bytes,
		counts: store.counts()?,
		integrity: store.integrity()?,
	})
}

/// Whether every authoritative and derived index check is healthy.
pub fn healthy(report: &BankDiagnostic) -> bool {
	report.integrity.integrity.as_str() == "ok"
		&& report.integrity.vector_current
		&& report.integrity.graph_current
}

/// Returns generation health without opening raw database paths to callers.
pub const fn generations(report: &BankDiagnostic) -> IndexGeneration {
	report.integrity.generations
}

/// Removes a SQLite database together with WAL and shared-memory sidecars.
///
/// Windows may retain transient locks after the last handle closes. Permission,
/// would-block, and directory-not-empty failures are retried for the
/// one-second window.
pub fn remove_database_files(path: &Path) -> Result<()> {
	for suffix in ["", "-wal", "-shm"] {
		let target = if suffix.is_empty() {
			path.to_path_buf()
		} else {
			PathBuf::from(format!("{}{suffix}", path.display()))
		};
		remove_with_retry(&target)?;
	}
	Ok(())
}

fn remove_with_retry(path: &Path) -> Result<()> {
	for attempt in 0..=REMOVE_RETRIES {
		match fs::remove_file(path) {
			Ok(()) => return Ok(()),
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
			Err(error)
				if attempt < REMOVE_RETRIES
					&& matches!(
						error.kind(),
						std::io::ErrorKind::PermissionDenied
							| std::io::ErrorKind::WouldBlock
							| std::io::ErrorKind::DirectoryNotEmpty
					) =>
			{
				thread::sleep(REMOVE_RETRY_DELAY);
			},
			Err(error) => return Err(error.into()),
		}
	}
	unreachable!("retry loop returns on its final attempt")
}
