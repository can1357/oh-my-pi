//! Workspace traversal, candidate discovery, and cancellable regex search.

use std::{
	convert::Infallible,
	fmt::Display,
	io,
	ops::ControlFlow,
	path::{Path, PathBuf},
	sync::atomic::{AtomicBool, AtomicU64, Ordering},
	time::Duration,
};

use bytes::Bytes;
use omp_core::Str;
use omp_walker::{
	EntryMeta, FileCandidate, WalkDecision, WalkError, WalkOutcome, WalkRequest, WalkStatus,
};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::grep::{
	CompiledGrep, GrepControl, GrepMatchRef, GrepSink, GrepStreamError, GrepStreamStatus,
	RegexOptions, StreamOptions,
};

mod operations;

use std::{fs, num, thread};

pub use operations::{WorkspaceOperationError, WorkspaceOperations, WorktreeMerge};

const SEARCH_CHANNEL_DEPTH: usize = 16;
const SEARCH_POLL_INTERVAL: Duration = Duration::from_millis(10);

const CANCELLED: &str = "workspace operation cancelled";

/// One regex match in a workspace file.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchMatch {
	/// Walk-relative path using `/` separators.
	pub(crate) path:        Str,
	/// One-based source line containing the match start.
	pub(crate) line:        u64,
	/// Zero-based byte offset of the match start in the complete file.
	pub(crate) byte_offset: u64,
	/// Zero-based byte offset immediately after the regex match.
	pub(crate) match_end:   u64,
	/// Exact bytes of the matching line, excluding its line-feed delimiter.
	pub(crate) line_bytes:  Bytes,
}

/// Case handling for a workspace regex.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum WorkspaceSearchCase {
	/// Preserve the regex pattern's byte case.
	#[default]
	Sensitive,
	/// Match ASCII and Unicode case-insensitively.
	Insensitive,
}

/// Borrowed controls for one workspace regex search.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WorkspaceSearchOptions<'pattern> {
	/// Regex pattern compiled once for every candidate file.
	pub pattern: &'pattern str,
	/// Case handling applied while compiling `pattern`.
	pub case:    WorkspaceSearchCase,
	/// Maximum number of matches emitted across the complete workspace.
	pub limit:   Option<u64>,
}

impl<'pattern> WorkspaceSearchOptions<'pattern> {
	/// Creates an unlimited case-sensitive regex search.
	pub const fn new(pattern: &'pattern str) -> Self {
		Self { pattern, case: WorkspaceSearchCase::Sensitive, limit: None }
	}
}

/// Statistics from one streamed workspace search.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WorkspaceSearchOutcome {
	/// Candidate files actually searched before the operation stopped.
	pub files_scanned:     u64,
	/// Matches delivered to the workspace sink.
	pub matches:           u64,
	/// Oversized candidates that could not be searched through a bounded prefix.
	pub skipped_oversized: u64,
	/// Whether the configured global match limit stopped the operation.
	pub limited:           bool,
	/// Whether the caller's sink requested an early successful stop.
	pub stopped:           bool,
}

/// Workspace traversal or search failed.
#[derive(Debug, Error)]
pub enum WorkspaceError {
	/// The caller cancelled the operation.
	#[error("workspace operation was cancelled")]
	Cancelled,
	/// The requested walker root escapes the owned workspace.
	#[error("workspace request root is outside the owned workspace")]
	OutsideWorkspace,
	/// A regex search was requested with an empty pattern.
	#[error("search pattern must not be empty")]
	EmptyPattern,
	/// Workspace traversal failed.
	#[error("workspace walk failed: {0}")]
	Walk(Str),
	/// Regex compilation or matching failed.
	#[error("workspace grep failed: {0}")]
	Grep(#[source] crate::grep::GrepError),
	/// A scoped search worker exited without reporting its result.
	#[error("workspace search worker stopped unexpectedly")]
	SearchWorkerStopped,
	/// The owned workspace root could not be opened.
	#[error("workspace root cannot be opened: {0}")]
	Root(#[source] io::Error),
	/// The requested traversal root could not be opened.
	#[error("workspace request root cannot be opened: {0}")]
	RequestRoot(#[source] io::Error),
}

/// Concrete env-side owner of one canonical walker workspace.
#[derive(Clone, Debug)]
pub struct WorkspaceHost {
	root: PathBuf,
}

impl WorkspaceHost {
	/// Opens a workspace rooted at a canonical existing path.
	pub fn open(root: impl AsRef<Path>) -> Result<Self, WorkspaceError> {
		let root = fs::canonicalize(root).map_err(WorkspaceError::Root)?;
		Ok(Self { root })
	}

	/// Returns the canonical workspace root.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Starts a walker request that cannot escape this host's workspace.
	pub fn request(&self) -> WalkRequest {
		WalkRequest::new(self.root.clone())
	}

	/// Runs a walker collection with a cancellation heartbeat.
	pub fn walk(
		&self,
		request: &WalkRequest,
		cancel: &CancellationToken,
	) -> Result<WalkOutcome, WorkspaceError> {
		self.check_request(request)?;
		request
			.collect_with_heartbeat(|| cancellation_heartbeat(cancel))
			.map_err(map_walk_error)
	}

	/// Streams checked walker entries without collecting them.
	///
	/// The request owns all ignore, filter, ordering, and limit behavior. The
	/// borrowed entry is valid only for the duration of the sink callback.
	pub fn walk_stream(
		&self,
		request: &WalkRequest,
		cancel: &CancellationToken,
		mut sink: impl for<'entry> FnMut(EntryMeta<'entry>) -> ControlFlow<()>,
	) -> Result<WalkStatus, WorkspaceError> {
		self.check_request(request)?;
		let status = request
			.for_each_entry_with_heartbeat(
				|| cancellation_heartbeat(cancel),
				|entry| {
					Ok(match sink(entry) {
						ControlFlow::Continue(()) => WalkDecision::Include,
						ControlFlow::Break(()) => WalkDecision::Stop,
					})
				},
				|_| Ok(WalkDecision::Include),
			)
			.map_err(map_walk_error)?;
		if cancel.is_cancelled() {
			Err(WorkspaceError::Cancelled)
		} else {
			Ok(status)
		}
	}

	/// Collects regular-file candidates with a cancellation heartbeat.
	pub fn candidates(
		&self,
		request: &WalkRequest,
		cancel: &CancellationToken,
	) -> Result<Vec<FileCandidate>, WorkspaceError> {
		self.check_request(request)?;
		request
			.collect_file_candidates_with_heartbeat(|| cancellation_heartbeat(cancel))
			.map_err(map_walk_error)
	}

	/// Collects regex matches for callers that own a complete result.
	///
	/// This convenience path is implemented over [`Self::search_stream`].
	pub fn search(
		&self,
		request: &WalkRequest,
		options: &WorkspaceSearchOptions<'_>,
		cancel: &CancellationToken,
	) -> Result<Vec<SearchMatch>, WorkspaceError> {
		let mut matches = Vec::new();
		self.search_stream(request, options, cancel, |matched| {
			matches.push(matched);
			ControlFlow::Continue(())
		})?;
		Ok(matches)
	}

	/// Streams regex matches in deterministic path-and-offset order.
	///
	/// Matching runs concurrently across a bounded window of sorted candidates.
	/// Each worker has a bounded channel, so a slow earlier file backpressures
	/// later files without buffering the complete workspace result.
	pub fn search_stream(
		&self,
		request: &WalkRequest,
		options: &WorkspaceSearchOptions<'_>,
		cancel: &CancellationToken,
		mut sink: impl FnMut(SearchMatch) -> ControlFlow<()>,
	) -> Result<WorkspaceSearchOutcome, WorkspaceError> {
		self.check_request(request)?;
		if options.pattern.is_empty() {
			return Err(WorkspaceError::EmptyPattern);
		}
		let matcher = CompiledGrep::new(options.pattern, RegexOptions {
			ignore_case: options.case == WorkspaceSearchCase::Insensitive,
			multiline:   false,
		})
		.map_err(WorkspaceError::Grep)?;
		if cancel.is_cancelled() {
			return Err(WorkspaceError::Cancelled);
		}
		if options.limit == Some(0) {
			return Ok(WorkspaceSearchOutcome { limited: true, ..Default::default() });
		}

		let mut candidates = request
			.collect_file_candidates_with_heartbeat(|| cancellation_heartbeat(cancel))
			.map_err(map_walk_error)?;
		candidates.sort_unstable_by(|left, right| left.relative.cmp(&right.relative));

		let mut outcome = WorkspaceSearchOutcome::default();
		let in_flight = thread::available_parallelism()
			.map_or(1, num::NonZeroUsize::get)
			.clamp(1, 8);
		search_candidates_ordered(
			&candidates,
			&matcher,
			options.limit,
			in_flight,
			cancel,
			&mut sink,
			&mut outcome,
		)?;
		if cancel.is_cancelled() {
			Err(WorkspaceError::Cancelled)
		} else {
			Ok(outcome)
		}
	}

	fn check_request(&self, request: &WalkRequest) -> Result<(), WorkspaceError> {
		let root = fs::canonicalize(request.root()).map_err(WorkspaceError::RequestRoot)?;
		if root.starts_with(&self.root) {
			Ok(())
		} else {
			Err(WorkspaceError::OutsideWorkspace)
		}
	}
}

fn cancellation_heartbeat(cancel: &CancellationToken) -> Result<(), &'static str> {
	if cancel.is_cancelled() {
		Err(CANCELLED)
	} else {
		Ok(())
	}
}

fn map_walk_error<E: Display>(error: WalkError<E>) -> WorkspaceError {
	match error {
		WalkError::Interrupted(message) if message.to_string() == CANCELLED => {
			WorkspaceError::Cancelled
		},
		other => WorkspaceError::Walk(Str::from(other.to_string())),
	}
}

enum SearchWorkerEvent {
	Match(SearchMatch),
	Complete(Result<(), WorkspaceError>),
}

struct ChannelGrepSink<'a> {
	path:             Str,
	cancel:           &'a CancellationToken,
	stop:             &'a AtomicBool,
	remaining:        &'a AtomicU64,
	has_limit:        bool,
	sender:           &'a flume::Sender<SearchWorkerEvent>,
	line_byte_offset: Option<u64>,
	line_bytes:       Bytes,
}

impl GrepSink for ChannelGrepSink<'_> {
	type Error = Infallible;

	fn control(&mut self) -> Result<GrepControl, Self::Error> {
		Ok(if self.cancel.is_cancelled() {
			GrepControl::Cancel
		} else if self.stop.load(Ordering::Acquire)
			|| (self.has_limit && self.remaining.load(Ordering::Acquire) == 0)
		{
			GrepControl::Stop
		} else {
			GrepControl::Continue
		})
	}

	fn matched(&mut self, matched: GrepMatchRef<'_>) -> Result<GrepControl, Self::Error> {
		if self.cancel.is_cancelled() {
			return Ok(GrepControl::Cancel);
		}
		if self.stop.load(Ordering::Acquire)
			|| (self.has_limit && self.remaining.load(Ordering::Acquire) == 0)
		{
			return Ok(GrepControl::Stop);
		}
		if self.line_byte_offset != Some(matched.line_byte_offset) {
			self.line_byte_offset = Some(matched.line_byte_offset);
			self.line_bytes = Bytes::copy_from_slice(matched.line_bytes);
		}
		let event = SearchWorkerEvent::Match(SearchMatch {
			path:        self.path.clone(),
			line:        matched.line_number,
			byte_offset: matched.byte_offset,
			match_end:   matched.match_end,
			line_bytes:  self.line_bytes.clone(),
		});
		Ok(if self.sender.send(event).is_ok() {
			GrepControl::Continue
		} else {
			GrepControl::Stop
		})
	}
}

fn search_candidates_ordered(
	candidates: &[FileCandidate],
	matcher: &CompiledGrep,
	limit: Option<u64>,
	in_flight: usize,
	cancel: &CancellationToken,
	sink: &mut impl FnMut(SearchMatch) -> ControlFlow<()>,
	outcome: &mut WorkspaceSearchOutcome,
) -> Result<(), WorkspaceError> {
	if candidates.is_empty() {
		return Ok(());
	}
	let lane_count = in_flight.min(candidates.len());
	let has_limit = limit.is_some();
	let remaining = AtomicU64::new(limit.unwrap_or(u64::MAX));
	let files_scanned = AtomicU64::new(0);
	let skipped_oversized = AtomicU64::new(0);
	let stop = AtomicBool::new(false);
	let result = thread::scope(|scope| {
		let mut receivers = Vec::with_capacity(lane_count);
		for lane in 0..lane_count {
			let (sender, receiver) = flume::bounded(SEARCH_CHANNEL_DEPTH);
			receivers.push(receiver);
			let stop = &stop;
			let remaining = &remaining;
			let files_scanned = &files_scanned;
			let skipped_oversized = &skipped_oversized;
			scope.spawn(move || {
				for candidate in candidates.iter().skip(lane).step_by(lane_count) {
					if cancel.is_cancelled()
						|| stop.load(Ordering::Acquire)
						|| (has_limit && remaining.load(Ordering::Acquire) == 0)
					{
						break;
					}
					let max_count = has_limit.then(|| remaining.load(Ordering::Acquire));
					let mut stream_sink = ChannelGrepSink {
						path: Str::new(&candidate.relative),
						cancel,
						stop,
						remaining,
						has_limit,
						sender: &sender,
						line_byte_offset: None,
						line_bytes: Bytes::new(),
					};
					let result = matcher
						.search_file(
							&candidate.path,
							&candidate.relative,
							StreamOptions { max_count, context_before: 0, context_after: 0 },
							&mut stream_sink,
						)
						.map_err(map_grep_stream_error)
						.and_then(|summary| {
							if summary.status == GrepStreamStatus::Cancelled {
								Err(WorkspaceError::Cancelled)
							} else {
								Ok(summary)
							}
						});
					if let Ok(summary) = &result {
						files_scanned.fetch_add(summary.files_searched, Ordering::Relaxed);
						skipped_oversized.fetch_add(summary.skipped_oversized, Ordering::Relaxed);
					}
					let result = result.map(|_| ());
					let failed = result.is_err();
					if sender.send(SearchWorkerEvent::Complete(result)).is_err() || failed {
						break;
					}
				}
			});
		}

		for (index, _) in candidates.iter().enumerate() {
			let receiver = &receivers[index % lane_count];
			loop {
				if cancel.is_cancelled() {
					stop.store(true, Ordering::Release);
					return Err(WorkspaceError::Cancelled);
				}
				match receiver.recv_timeout(SEARCH_POLL_INTERVAL) {
					Ok(SearchWorkerEvent::Match(matched)) => {
						outcome.matches = outcome.matches.saturating_add(1);
						let limit_reached = has_limit && remaining.fetch_sub(1, Ordering::AcqRel) == 1;
						let sink_stopped = sink(matched).is_break();
						if sink_stopped || limit_reached {
							outcome.stopped = sink_stopped;
							outcome.limited = limit_reached;
							stop.store(true, Ordering::Release);
							return Ok(());
						}
					},
					Ok(SearchWorkerEvent::Complete(result)) => {
						result?;
						break;
					},
					Err(flume::RecvTimeoutError::Timeout) => {},
					Err(flume::RecvTimeoutError::Disconnected) => {
						stop.store(true, Ordering::Release);
						return Err(WorkspaceError::SearchWorkerStopped);
					},
				}
			}
		}
		Ok(())
	});
	outcome.files_scanned = outcome
		.files_scanned
		.saturating_add(files_scanned.load(Ordering::Relaxed));
	outcome.skipped_oversized = outcome
		.skipped_oversized
		.saturating_add(skipped_oversized.load(Ordering::Relaxed));
	result
}

fn map_grep_stream_error(error: GrepStreamError<Infallible>) -> WorkspaceError {
	match error {
		GrepStreamError::Grep(error) => WorkspaceError::Grep(error),
		GrepStreamError::Sink(error) => match error {},
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn request(host: &WorkspaceHost) -> WalkRequest {
		host.request().hidden(true).gitignore(false).cache(false)
	}

	#[test]
	fn regex_and_pcre2_lookaround_report_exact_offsets() {
		let workspace = tempfile::tempdir().expect("workspace");
		fs::write(workspace.path().join("regex.txt"), b"abc 123\nkey=41\n").expect("regex fixture");
		let host = WorkspaceHost::open(workspace.path()).expect("workspace host");
		let cancel = CancellationToken::new();

		let regex = host
			.search(&request(&host), &WorkspaceSearchOptions::new(r"\d+"), &cancel)
			.expect("regex search");
		assert_eq!(regex.len(), 2);
		assert_eq!((regex[0].line, regex[0].byte_offset, regex[0].match_end), (1, 4, 7));
		assert_eq!(&regex[0].line_bytes[..], b"abc 123");

		let lookaround = host
			.search(&request(&host), &WorkspaceSearchOptions::new(r"(?<=key=)\d+"), &cancel)
			.expect("PCRE2 lookaround search");
		assert_eq!(lookaround.len(), 1);
		assert_eq!(
			(lookaround[0].line, lookaround[0].byte_offset, lookaround[0].match_end),
			(2, 12, 14)
		);
	}

	#[test]
	fn zero_and_boundary_limits_stop_globally() {
		let workspace = tempfile::tempdir().expect("workspace");
		fs::write(workspace.path().join("a.txt"), b"hit hit\n").expect("first fixture");
		fs::write(workspace.path().join("b.txt"), b"hit\n").expect("second fixture");
		let host = WorkspaceHost::open(workspace.path()).expect("workspace host");
		let cancel = CancellationToken::new();

		let mut zero_seen = false;
		let zero = host
			.search_stream(
				&request(&host),
				&WorkspaceSearchOptions {
					pattern: "hit",
					case:    WorkspaceSearchCase::Sensitive,
					limit:   Some(0),
				},
				&cancel,
				|_| {
					zero_seen = true;
					ControlFlow::Continue(())
				},
			)
			.expect("zero-limit search");
		assert!(!zero_seen);
		assert_eq!(zero.matches, 0);
		assert!(zero.limited);

		let options = WorkspaceSearchOptions {
			pattern: "hit",
			case:    WorkspaceSearchCase::Sensitive,
			limit:   Some(2),
		};
		let mut limited = Vec::new();
		let boundary = host
			.search_stream(&request(&host), &options, &cancel, |matched| {
				limited.push(matched);
				ControlFlow::Continue(())
			})
			.expect("limited search");
		assert_eq!(limited.len(), 2);
		assert!(boundary.limited);
		assert_eq!(boundary.matches, 2);
		assert!(
			limited
				.iter()
				.all(|matched| matched.path.as_str() == "a.txt")
		);
		assert_eq!(
			limited
				.iter()
				.map(|matched| matched.byte_offset)
				.collect::<Vec<_>>(),
			[0, 4]
		);
	}

	#[test]
	fn cancellation_stops_matching_mid_file() {
		let workspace = tempfile::tempdir().expect("workspace");
		fs::write(workspace.path().join("many.txt"), "hit\n".repeat(100_000)).expect("large fixture");
		let host = WorkspaceHost::open(workspace.path()).expect("workspace host");
		let cancel = CancellationToken::new();
		let mut seen = 0_u64;
		let result =
			host.search_stream(&request(&host), &WorkspaceSearchOptions::new("hit"), &cancel, |_| {
				seen += 1;
				cancel.cancel();
				ControlFlow::Continue(())
			});
		assert!(matches!(result, Err(WorkspaceError::Cancelled)));
		assert_eq!(seen, 1);
	}

	#[test]
	fn parallel_matching_is_emitted_in_path_and_offset_order() {
		let workspace = tempfile::tempdir().expect("workspace");
		for index in (0..64).rev() {
			fs::write(workspace.path().join(format!("file-{index:03}.txt")), b"hit\nhit\n")
				.expect("parallel fixture");
		}
		let host = WorkspaceHost::open(workspace.path()).expect("workspace host");
		let matches = host
			.search(&request(&host), &WorkspaceSearchOptions::new("hit"), &CancellationToken::new())
			.expect("parallel search");
		assert_eq!(matches.len(), 128);
		for pair in matches.windows(2) {
			assert!(
				pair[0].path < pair[1].path
					|| (pair[0].path == pair[1].path && pair[0].byte_offset < pair[1].byte_offset)
			);
		}
	}

	#[test]
	fn search_rejects_a_request_root_outside_the_workspace() {
		let workspace = tempfile::tempdir().expect("workspace");
		let outside = tempfile::tempdir().expect("outside directory");
		fs::write(outside.path().join("escape.txt"), b"hit\n").expect("outside fixture");
		let host = WorkspaceHost::open(workspace.path()).expect("workspace host");
		let outside_request = WalkRequest::new(outside.path());
		assert!(matches!(
			host.search(
				&outside_request,
				&WorkspaceSearchOptions::new("hit"),
				&CancellationToken::new(),
			),
			Err(WorkspaceError::OutsideWorkspace)
		));
	}
}
