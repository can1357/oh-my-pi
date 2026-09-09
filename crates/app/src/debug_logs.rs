//! Bounded backwards reader for dated and per-process debug logs.

use std::{
	fs,
	fs::File,
	io,
	io::{Read, Seek, SeekFrom},
	path::{Path, PathBuf},
	process,
	time::SystemTime,
};

use omp_observability::redact::redact_sensitive_credentials;
use thiserror::Error;

/// Maximum bytes returned by one viewer page.
pub const DEFAULT_CHUNK_BYTES: usize = 256 * 1024;

/// Stable backwards cursor into a sorted log-file inventory.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Cursor {
	/// Index into the source's oldest-to-newest file list.
	pub file:   usize,
	/// Exclusive byte offset within that file.
	pub offset: u64,
}

/// One bounded backwards page.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LogChunk {
	/// Sanitized complete lines in chronological order.
	pub lines:                    Vec<String>,
	/// Cursor for loading older material.
	pub older:                    Option<Cursor>,
	/// First line at or after the current process start, when present.
	pub current_process_boundary: Option<usize>,
}

/// Log-source discovery or bounded read failure.
#[derive(Debug, Error)]
pub enum Error {
	/// Log directory enumeration failed.
	#[error("cannot enumerate debug logs in {path}")]
	Enumerate {
		/// Log directory.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A selected log file could not be read.
	#[error("cannot read debug log {path}")]
	Read {
		/// Selected file.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
}

/// Dated/PID log inventory read newest-first without loading entire files.
pub struct LogSource {
	files:            Vec<PathBuf>,
	process_start_ms: u64,
	process_pid:      u32,
}

impl LogSource {
	/// Discovers regular `.log` files beneath one bounded directory level.
	pub fn discover(directory: &Path, process_start: SystemTime) -> Result<Self, Error> {
		let entries = fs::read_dir(directory)
			.map_err(|source| Error::Enumerate { path: directory.to_path_buf(), source })?;
		let mut files = Vec::new();
		for entry in entries.filter_map(Result::ok) {
			let path = entry.path();
			if path.is_file() && path.extension().is_some_and(|extension| extension == "log") {
				files.push(path);
			} else if path.is_dir()
				&& let Ok(children) = fs::read_dir(path)
			{
				files.extend(
					children
						.filter_map(Result::ok)
						.map(|child| child.path())
						.filter(|child| {
							child.is_file()
								&& child
									.extension()
									.is_some_and(|extension| extension == "log")
						}),
				);
			}
		}
		files.sort_unstable();
		let process_start_ms = process_start
			.duration_since(SystemTime::UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as u64;
		Ok(Self { files, process_start_ms, process_pid: process::id() })
	}

	/// Returns the newest cursor, if any log exists.
	pub fn newest(&self) -> Result<Option<Cursor>, Error> {
		let Some((file, path)) = self.files.iter().enumerate().next_back() else {
			return Ok(None);
		};
		let offset = path
			.metadata()
			.map_err(|source| Error::Read { path: path.clone(), source })?
			.len();
		Ok(Some(Cursor { file, offset }))
	}

	/// Reads complete lines backwards up to `max_bytes`, crossing dated files.
	pub fn read_older(&self, cursor: Cursor, max_bytes: usize) -> Result<LogChunk, Error> {
		if self.files.is_empty() {
			return Ok(LogChunk {
				lines:                    Vec::new(),
				older:                    None,
				current_process_boundary: None,
			});
		}
		let budget = max_bytes.clamp(1, DEFAULT_CHUNK_BYTES);
		let mut file_index = cursor.file.min(self.files.len().saturating_sub(1));
		let mut offset = cursor.offset;
		let mut blocks = Vec::new();
		let mut remaining = budget;
		let older;
		loop {
			let path = &self.files[file_index];
			let file_len = path
				.metadata()
				.map_err(|source| Error::Read { path: path.clone(), source })?
				.len();
			offset = offset.min(file_len);
			let take = usize::try_from(offset.min(remaining as u64)).unwrap_or(remaining);
			let start = offset.saturating_sub(take as u64);
			let mut file =
				File::open(path).map_err(|source| Error::Read { path: path.clone(), source })?;
			file
				.seek(SeekFrom::Start(start))
				.map_err(|source| Error::Read { path: path.clone(), source })?;
			let mut bytes = vec![0; take];
			file
				.read_exact(&mut bytes)
				.map_err(|source| Error::Read { path: path.clone(), source })?;
			let prefix = if start > 0 {
				bytes
					.iter()
					.position(|byte| *byte == b'\n')
					.map_or(0, |position| position + 1)
			} else {
				0
			};
			blocks.push((start, bytes));
			remaining -= take;
			if remaining == 0 || (start == 0 && file_index == 0) {
				let next_offset = if remaining == 0 {
					start.saturating_add(prefix as u64)
				} else {
					start
				};
				older = (next_offset > 0 || file_index > 0)
					.then_some(Cursor { file: file_index, offset: next_offset });
				break;
			}
			file_index -= 1;
			offset = self.files[file_index]
				.metadata()
				.map_err(|source| Error::Read { path: self.files[file_index].clone(), source })?
				.len();
		}
		blocks.reverse();
		let mut lines = Vec::new();
		for (start, bytes) in blocks {
			let text = String::from_utf8_lossy(&bytes);
			let text = if start > 0 {
				text
					.split_once('\n')
					.map_or(text.as_ref(), |(_, complete)| complete)
			} else {
				text.as_ref()
			};
			lines.extend(
				text
					.lines()
					.filter(|line| !line.is_empty())
					.map(redact_sensitive_credentials),
			);
		}
		let current_process_boundary = lines.iter().position(|line| {
			let pid = parse_pid(line);
			(pid == Some(self.process_pid))
				|| (parse_timestamp_ms(line)
					.is_some_and(|timestamp| timestamp >= self.process_start_ms)
					&& pid.is_none())
		});
		Ok(LogChunk { lines, older, current_process_boundary })
	}
}

fn parse_pid(line: &str) -> Option<u32> {
	if let Some(pid) = serde_json::from_str::<serde_json::Value>(line)
		.ok()
		.and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
		.and_then(|pid| pid.try_into().ok())
	{
		return Some(pid);
	}
	let start = line.find('[')?.saturating_add(1);
	let end = line[start..].find(']')?.saturating_add(start);
	line[start..end].parse().ok()
}
fn parse_timestamp_ms(line: &str) -> Option<u64> {
	let value = serde_json::from_str::<serde_json::Value>(line).ok()?;
	value
		.get("timestamp_ms")
		.or_else(|| value.get("time_ms"))?
		.as_u64()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn log_source_reads_real_files_in_order_and_redacts() {
		let directory = tempfile::tempdir().expect("temp directory");
		let secret = format!("gho_{}", "A".repeat(36));
		fs::write(
			directory.path().join("omp.2026-09-03.1.log"),
			format!("first\nsecond {secret}\nthird\n"),
		)
		.expect("log fixture");
		let source =
			LogSource::discover(directory.path(), SystemTime::UNIX_EPOCH).expect("discover logs");
		let cursor = source.newest().expect("newest").expect("cursor");
		let chunk = source
			.read_older(cursor, DEFAULT_CHUNK_BYTES)
			.expect("read logs");
		assert_eq!(chunk.lines.len(), 3);
		assert_eq!(chunk.lines[0], "first");
		assert_eq!(chunk.lines[2], "third");
		assert!(!chunk.lines[1].contains(&secret));
	}
}
