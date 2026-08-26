//! Transcript loading and live-chain reconstruction.

#[cfg(not(unix))]
use std::time;
use std::{
	fs::{self, File, Metadata},
	io::{self, BufRead as _, BufReader, Seek as _, SeekFrom},
	iter::FusedIterator,
	path::{Path, PathBuf},
};

use omp_core::sparse_set::SparseSet;
use serde_json::value::{RawValue, to_raw_value};

use super::{
	codec::{Error, Header, read_atomic_group, read_header, read_line},
	event::{Event, Kind},
	raweq::raw_eq,
};

/// One indexed durable event in a loaded transcript.
#[derive(Debug, Clone)]
pub enum Entry {
	/// A decoded event, including verbatim unknown events.
	Ok(Box<Event>),
	/// A malformed legacy line retained at its durable event index.
	Tombstone(Box<RawValue>),
}
/// Equality is byte equality of stored JSON text, preserving verbatim round
/// trips.
impl PartialEq for Entry {
	fn eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Ok(a), Self::Ok(b)) => a == b,
			(Self::Tombstone(a), Self::Tombstone(b)) => raw_eq(a, b),
			_ => false,
		}
	}
}

impl Eq for Entry {}

/// Reusable live-chain membership and ordering over durable event indexes.
///
/// Membership uses one bit per durable event while the retained order preserves
/// the splice ordering required by compact and prompt-rewrite events. Clearing
/// and recomputing the set retains both allocations.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LiveSet {
	bits:  SparseSet<u64>,
	order: Vec<u64>,
}

impl LiveSet {
	/// Creates an empty live set.
	pub const fn new() -> Self {
		Self { bits: SparseSet::new(), order: Vec::new() }
	}

	/// Returns the number of live physical event indexes.
	pub const fn len(&self) -> usize {
		self.order.len()
	}

	/// Returns whether no physical event index is live.
	pub const fn is_empty(&self) -> bool {
		self.order.is_empty()
	}

	/// Returns whether a physical event index belongs to the live chain.
	pub fn contains(&self, index: u64) -> bool {
		self.bits.contains(index)
	}

	/// Returns the reusable membership bitmap's capacity in bits.
	pub const fn capacity(&self) -> usize {
		self.bits.capacity()
	}

	/// Returns the reusable ordered chain's element capacity.
	pub const fn chain_capacity(&self) -> usize {
		self.order.capacity()
	}

	/// Iterates live physical event indexes in reconstructed chain order.
	pub fn iter(
		&self,
	) -> impl DoubleEndedIterator<Item = u64> + ExactSizeIterator + FusedIterator + Clone + '_ {
		self.order.iter().copied()
	}

	fn clear(&mut self) {
		self.bits.clear();
		self.order.clear();
	}

	fn push(&mut self, index: u64) {
		self.bits.insert(index);
		self.order.push(index);
	}

	fn extend(&mut self, indexes: impl IntoIterator<Item = u64>) {
		for index in indexes {
			self.push(index);
		}
	}

	fn rebuild_membership(&mut self) {
		self.bits.clear();
		for &index in &self.order {
			self.bits.insert(index);
		}
	}

	fn rewind(&mut self, target: Option<u64>) -> bool {
		let Some(target) = target else {
			let changed = !self.order.is_empty();
			self.clear();
			return changed;
		};
		if let Some(position) = self.order.iter().position(|candidate| *candidate == target) {
			if position + 1 == self.order.len() {
				return false;
			}
			self.order.truncate(position + 1);
			self.rebuild_membership();
		} else {
			self.clear();
			self.push(target);
		}
		true
	}

	fn compact(&mut self, summary: u64, first_kept: u64) {
		if let Some(position) = self
			.order
			.iter()
			.position(|candidate| *candidate == first_kept)
		{
			self.order.rotate_left(position);
			self.order.truncate(self.order.len() - position);
			self.order.insert(0, summary);
			self.rebuild_membership();
		} else {
			self.clear();
			self.push(summary);
		}
	}
}

/// Classification of a damaged physical JSONL record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiagnosticKind {
	/// A newline-terminated record could not be decoded.
	Malformed,
	/// End-of-file interrupted a record before its newline.
	Truncated,
}

/// Bounded reader diagnostic retaining stable physical and byte positions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReadDiagnostic {
	/// Zero-based physical event index.
	pub event_index: u64,
	/// Byte offset at which the damaged record begins.
	pub byte_offset: u64,
	/// Number of source bytes in the damaged record.
	pub byte_len:    u64,
	/// Damage classification.
	pub kind:        DiagnosticKind,
}

/// Aggregate counters from one bounded JSONL scan.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ReadCounters {
	/// Newline-terminated malformed records.
	pub malformed: u64,
	/// Unterminated trailing records.
	pub truncated: u64,
}

/// A loaded transcript with durable event indexes preserved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Log {
	header:      Header,
	events:      Vec<Entry>,
	diagnostics: Vec<ReadDiagnostic>,
}

/// A transcript log paired with the live chain folded from it.
///
/// The pairing is constructed once, so a caller cannot present a live chain
/// that belongs to a different log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveLog {
	log:  Log,
	live: LiveSet,
}

impl LiveLog {
	/// Returns the physical event log.
	pub const fn log(&self) -> &Log {
		&self.log
	}

	/// Returns the live chain folded from the log.
	pub const fn live(&self) -> &LiveSet {
		&self.live
	}
}

impl Log {
	/// Returns the line-zero identity header.
	pub const fn header(&self) -> &Header {
		&self.header
	}

	/// Returns the number of durable events, including tombstones.
	pub const fn len(&self) -> usize {
		self.events.len()
	}

	/// Returns structured diagnostics in physical source order.
	pub fn diagnostics(&self) -> &[ReadDiagnostic] {
		&self.diagnostics
	}

	/// Returns damage counters without rescanning journal bytes.
	pub fn counters(&self) -> ReadCounters {
		let mut counters = ReadCounters::default();
		for diagnostic in &self.diagnostics {
			match diagnostic.kind {
				DiagnosticKind::Malformed => counters.malformed = counters.malformed.saturating_add(1),
				DiagnosticKind::Truncated => counters.truncated = counters.truncated.saturating_add(1),
			}
		}
		counters
	}

	/// Returns whether the transcript contains no event lines.
	pub const fn is_empty(&self) -> bool {
		self.events.is_empty()
	}

	/// Returns the entry at a durable event index.
	pub fn get(&self, index: u64) -> Option<&Entry> {
		usize::try_from(index)
			.ok()
			.and_then(|index| self.events.get(index))
	}

	/// Recomputes live-chain membership into caller-owned reusable storage.
	///
	/// Ordinary events chain implicitly from the previous event. A rewind
	/// truncates the working chain to its target (or to the root), replacing
	/// the 6.1 million explicit parent pointers that 5,257 rewinds represented
	/// in the measured corpus. Reset begins a new chain boundary. Compact
	/// places its summary before the suffix beginning at `first_kept`, so the
	/// summary stands in for the discarded prefix. Amend and label events
	/// annotate a target but remain on the current chain; they do not navigate
	/// to that target. Tombstones behave as opaque ordinary events so their
	/// indexes remain addressable. No by-id or parent map is built.
	pub fn live_into(&self, out: &mut LiveSet) {
		out.clear();
		self.fold_from(0, out);
	}

	/// Recomputes live-chain membership through an inclusive physical
	/// checkpoint into caller-owned reusable storage.
	///
	/// This applies the same reset, rewind, compaction, turn-publication, and
	/// prompt-rewrite rules as [`Self::live_into`]. Returns `false` without
	/// modifying `out` when `checkpoint` is not present in this log.
	pub fn live_through_into(&self, checkpoint: u64, out: &mut LiveSet) -> bool {
		let Ok(checkpoint) = usize::try_from(checkpoint) else {
			return false;
		};
		if checkpoint >= self.events.len() {
			return false;
		}
		out.clear();
		for index in 0..=checkpoint {
			self.fold_entry(index, out);
		}
		true
	}

	/// Reconstructs the current live chain with one forward fold.
	///
	/// Callers making repeated projections should retain a [`LiveSet`] and use
	/// [`Self::live_into`] instead.
	pub fn live(&self) -> Vec<u64> {
		let mut live = LiveSet::new();
		self.live_into(&mut live);
		live.order
	}

	/// Iterates live custom events of one declared kind, oldest physical event
	/// first.
	///
	/// The iterator borrows a previously computed [`LiveSet`], so repeated
	/// projections perform no presence-tracking allocation.
	pub fn custom<'a>(
		&'a self,
		live: &'a LiveSet,
		kind: &'a str,
	) -> impl DoubleEndedIterator<Item = (u64, &'a Event)> + FusedIterator + 'a {
		self
			.events
			.iter()
			.enumerate()
			.filter_map(move |(index, entry)| {
				let index = u64::try_from(index).expect("event indexes fit in u64");
				match entry {
					Entry::Ok(event)
						if live.contains(index)
							&& matches!(
								&event.kind,
								Kind::Custom(custom) if custom.kind() == kind
							) =>
					{
						Some((index, event.as_ref()))
					},
					_ => None,
				}
			})
	}

	fn fold_from(&self, start: usize, out: &mut LiveSet) {
		for index in start..self.events.len() {
			self.fold_entry(index, out);
		}
	}

	fn fold_entry(&self, index: usize, live: &mut LiveSet) -> bool {
		let physical_index = u64::try_from(index).expect("event indexes fit in u64");
		match &self.events[index] {
			Entry::Ok(event) => match event.as_ref() {
				Event { kind: Kind::Item(record), .. } if record.turn_id.is_some() => false,
				Event { kind: Kind::TurnReceipt(receipt), .. } => {
					let complete = receipt.item_events.len() == receipt.outcome.output.len()
						&& receipt.item_events.iter().zip(&receipt.outcome.output).all(
							|(item_index, expected)| {
								matches!(
									self.get(*item_index),
									Some(Entry::Ok(item_event))
										if matches!(
											&item_event.kind,
											Kind::Item(record)
												if record.turn_id.as_ref() == Some(&receipt.turn_id)
													&& &record.item == expected
										)
								)
							},
						);
					if complete && !receipt.item_events.is_empty() {
						live.extend(receipt.item_events.iter().copied());
						true
					} else {
						false
					}
				},
				Event { kind: Kind::Rewind { to }, .. } => live.rewind(*to),
				Event { kind: Kind::Reset, .. } => {
					live.clear();
					live.push(physical_index);
					true
				},
				Event { kind: Kind::Compact { first_kept, .. }, .. } => {
					live.compact(physical_index, *first_kept);
					true
				},
				Event { kind: Kind::PromptRewriteIntent(_) | Kind::PromptRewriteStage(_), .. } => false,
				Event { kind: Kind::PromptRewriteCommit(commit), .. } => {
					let Some(Entry::Ok(intent_event)) = self.get(commit.intent) else {
						return false;
					};
					let Kind::PromptRewriteIntent(intent) = &intent_event.kind else {
						return false;
					};
					if commit.head_events.len() != intent.head.len() {
						return false;
					}
					let complete =
						commit
							.head_events
							.iter()
							.enumerate()
							.all(|(ordinal, stage_index)| {
								matches!(
									self.get(*stage_index),
									Some(Entry::Ok(stage_event))
										if matches!(
											&stage_event.kind,
											Kind::PromptRewriteStage(stage)
												if stage.intent == commit.intent
													&& stage.ordinal == ordinal as u64
													&& stage.item == intent.head[ordinal]
										)
								)
							});
					if !complete {
						return false;
					}
					let replacement = commit
						.head_events
						.iter()
						.chain(&intent.preserved_tail)
						.copied();
					if live.iter().eq(replacement.clone()) {
						return false;
					}
					live.clear();
					live.extend(replacement);
					true
				},
				_ => {
					live.push(physical_index);
					true
				},
			},
			Entry::Tombstone(_) => {
				live.push(physical_index);
				true
			},
		}
	}
}

/// Outcome of incrementally refreshing a transcript reader.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RefreshReport {
	/// What changed since the previous refresh.
	pub state:         RefreshState,
	/// Durable index that the next committed event will receive.
	pub next_index:    u64,
	/// Byte offset where a writer may append after repairing any torn tail.
	pub append_offset: u64,
	/// Number of incomplete bytes after `append_offset`.
	pub tail_bytes:    u64,
}

/// Classification of bytes observed by an incremental refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshState {
	/// The file contains no bytes beyond the prior complete-line watermark.
	Unchanged,
	/// One or more complete bytes were consumed without an incomplete tail.
	Advanced {
		/// Number of newly parsed physical event lines.
		records: u64,
	},
	/// Bytes remain after the last complete line and must be repaired before an
	/// append.
	TornTail {
		/// Number of complete event lines parsed before the incomplete tail.
		records: u64,
	},
}

/// Incremental reader for one append-only transcript.
///
/// The reader retains decoded events, live-chain storage, and the byte offset
/// immediately after the last complete line. Refreshes parse only bytes at or
/// beyond that watermark.
/// Maximum retained scratch allocation for ordinary JSONL records. Individual
/// valid records may grow beyond this bound, but the buffer is dropped rather
/// than retained after such a record.
pub const READ_BUFFER_BYTES: usize = 64 * 1024;
/// Default cooperative batch boundary for long scans.
pub const VISIT_BATCH_ENTRIES: usize = 8_192;

/// Incremental bounded reader for one append-only transcript.
pub struct Reader {
	path:              PathBuf,
	file:              Option<File>,
	identity:          Option<FileIdentity>,
	watermark:         u64,
	header_terminated: bool,
	tail_bytes:        u64,
	tail_diagnostic:   Option<ReadDiagnostic>,
	view:              LiveLog,
}

impl Reader {
	/// Opens a transcript and parses its complete physical lines with bounded
	/// `BufRead` scratch rather than loading the whole file.
	pub fn open(path: &Path) -> Result<Self, Error> {
		let file = File::open(path)?;
		let identity = file_identity(&file.metadata()?);
		let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, file);
		let mut line = Vec::new();
		let header_bytes = reader.read_until(b'\n', &mut line)?;
		if header_bytes == 0 {
			return Err(Error::MissingHeader);
		}
		let header_terminated = line.last() == Some(&b'\n');
		if header_terminated {
			line.pop();
		}
		let header = read_header(&line)?;
		let mut watermark = u64::try_from(header_bytes).expect("file offsets fit in u64");
		let mut events = Vec::new();
		let mut diagnostics = Vec::new();
		let mut tail_bytes = 0_u64;
		let mut tail_diagnostic = None;
		let mut event_index = 0_u64;
		loop {
			line.clear();
			let offset = watermark;
			let read = reader.read_until(b'\n', &mut line)?;
			if read == 0 {
				break;
			}
			if line.last() != Some(&b'\n') {
				tail_bytes = u64::try_from(read).expect("file offsets fit in u64");
				tail_diagnostic = Some(ReadDiagnostic {
					event_index,
					byte_offset: offset,
					byte_len: tail_bytes,
					kind: DiagnosticKind::Truncated,
				});
				break;
			}
			line.pop();
			let appended = push_record_at(
				&mut events,
				&mut diagnostics,
				&line,
				event_index,
				offset,
				DiagnosticKind::Malformed,
			);
			let Some(appended) = appended else {
				tail_bytes = reader.get_ref().metadata()?.len().saturating_sub(offset);
				tail_diagnostic = Some(ReadDiagnostic {
					event_index,
					byte_offset: offset,
					byte_len: tail_bytes,
					kind: DiagnosticKind::Truncated,
				});
				break;
			};
			watermark =
				watermark.saturating_add(u64::try_from(read).expect("file offsets fit in u64"));
			event_index =
				event_index.saturating_add(u64::try_from(appended).expect("event count fits in u64"));
		}
		let file = reader.into_inner();
		let log = Log { header, events, diagnostics };
		let mut live = LiveSet::new();
		log.live_into(&mut live);
		Ok(Self {
			path: path.to_owned(),
			file: Some(file),
			identity: Some(identity),
			watermark,
			header_terminated,
			tail_bytes,
			tail_diagnostic,
			view: LiveLog { log, live },
		})
	}

	/// Parses complete lines appended since the previous refresh.
	/// Creates a fileless reader paired with
	/// [`crate::transcript::Writer::create_lazy`].
	pub fn pending(path: &Path, header: Header) -> Self {
		Self {
			path:              path.to_owned(),
			file:              None,
			identity:          None,
			watermark:         0,
			header_terminated: false,
			tail_bytes:        0,
			tail_diagnostic:   None,
			view:              LiveLog {
				log:  Log { header, events: Vec::new(), diagnostics: Vec::new() },
				live: LiveSet::new(),
			},
		}
	}

	///
	/// Replacement or truncation below the complete-line watermark returns an
	/// error without changing the decoded log or live set.
	pub fn refresh(&mut self) -> Result<RefreshReport, Error> {
		if self.file.is_none() {
			let opened = match Self::open(&self.path) {
				Ok(opened) => opened,
				Err(Error::Io(source)) if source.kind() == io::ErrorKind::NotFound => {
					return Ok(self.report(RefreshState::Unchanged));
				},
				Err(error) => return Err(error),
			};
			if opened.view.log.header != self.view.log.header {
				return Err(changed_file("materialized transcript header changed"));
			}
			let records = opened.next_index();
			*self = opened;
			return Ok(self.report(RefreshState::Advanced { records }));
		}
		let path_metadata = fs::metadata(&self.path)?;
		if Some(file_identity(&path_metadata)) != self.identity {
			return Err(changed_file("transcript path was replaced"));
		}
		let file_len = self
			.file
			.as_ref()
			.expect("pending reader handled above")
			.metadata()?
			.len();
		if file_len < self.watermark {
			return Err(changed_file("transcript was truncated below the read watermark"));
		}
		if file_len == self.watermark {
			self.tail_bytes = 0;
			self.tail_diagnostic = None;
			return Ok(self.report(RefreshState::Unchanged));
		}
		let first_event_index = self.next_index();
		self
			.file
			.as_mut()
			.expect("pending reader handled above")
			.seek(SeekFrom::Start(self.watermark))?;
		let mut reader = BufReader::with_capacity(
			READ_BUFFER_BYTES,
			self.file.as_mut().expect("pending reader handled above"),
		);
		let mut line = Vec::new();
		let mut consumed = 0_u64;
		let mut records = 0_u64;
		let mut entries = Vec::new();
		let mut diagnostics = Vec::new();
		let mut header_terminated = self.header_terminated;
		self.tail_bytes = 0;
		self.tail_diagnostic = None;

		if !header_terminated {
			let read = reader.read_until(b'\n', &mut line)?;
			if line.as_slice() != b"\n" {
				self.tail_bytes = u64::try_from(read).expect("file offsets fit in u64");
				self.tail_diagnostic = Some(ReadDiagnostic {
					event_index: first_event_index,
					byte_offset: self.watermark,
					byte_len:    self.tail_bytes,
					kind:        DiagnosticKind::Truncated,
				});
				return Ok(self.report(RefreshState::TornTail { records: 0 }));
			}
			consumed = 1;
			header_terminated = true;
		}

		loop {
			line.clear();
			let offset = self.watermark.saturating_add(consumed);
			let read = reader.read_until(b'\n', &mut line)?;
			if read == 0 {
				break;
			}
			if line.last() != Some(&b'\n') {
				self.tail_bytes = u64::try_from(read).expect("file offsets fit in u64");
				self.tail_diagnostic = Some(ReadDiagnostic {
					event_index: first_event_index.saturating_add(records),
					byte_offset: offset,
					byte_len:    self.tail_bytes,
					kind:        DiagnosticKind::Truncated,
				});
				break;
			}
			line.pop();
			let appended = push_record_at(
				&mut entries,
				&mut diagnostics,
				&line,
				first_event_index.saturating_add(records),
				offset,
				DiagnosticKind::Malformed,
			);
			let Some(appended) = appended else {
				self.tail_bytes = file_len.saturating_sub(offset);
				self.tail_diagnostic = Some(ReadDiagnostic {
					event_index: first_event_index.saturating_add(records),
					byte_offset: offset,
					byte_len:    self.tail_bytes,
					kind:        DiagnosticKind::Truncated,
				});
				break;
			};
			consumed = consumed.saturating_add(u64::try_from(read).expect("file offsets fit in u64"));
			records =
				records.saturating_add(u64::try_from(appended).expect("event count fits in u64"));
		}

		let path_metadata = fs::metadata(&self.path)?;
		if Some(file_identity(&path_metadata)) != self.identity {
			return Err(changed_file("transcript path was replaced during refresh"));
		}
		let first_new = self.view.log.events.len();
		self.view.log.events.extend(entries);
		self.view.log.diagnostics.extend(diagnostics);
		self.view.log.fold_from(first_new, &mut self.view.live);
		self.watermark = self.watermark.saturating_add(consumed);
		self.header_terminated = header_terminated;
		let state = if self.tail_bytes != 0 {
			RefreshState::TornTail { records }
		} else {
			RefreshState::Advanced { records }
		};
		Ok(self.report(state))
	}

	/// Returns the decoded transcript and its live-chain projection.
	pub const fn live_log(&self) -> &LiveLog {
		&self.view
	}

	/// Returns the decoded transcript prefix.
	pub const fn log(&self) -> &Log {
		self.view.log()
	}

	/// Returns the live-chain projection for the decoded prefix.
	pub const fn live(&self) -> &LiveSet {
		self.view.live()
	}

	/// Iterates permanent malformed diagnostics followed by the current torn
	/// tail diagnostic, when present.
	pub fn diagnostics(&self) -> impl Iterator<Item = ReadDiagnostic> + '_ {
		self
			.view
			.log
			.diagnostics
			.iter()
			.copied()
			.chain(self.tail_diagnostic)
	}

	/// Returns damage counters for the decoded prefix and current tail.
	pub fn counters(&self) -> ReadCounters {
		let mut counters = self.view.log.counters();
		if self.tail_diagnostic.is_some() {
			counters.truncated = counters.truncated.saturating_add(1);
		}
		counters
	}

	/// Returns the durable index assigned to the next committed event.
	pub fn next_index(&self) -> u64 {
		u64::try_from(self.view.log.len()).expect("event indexes fit in u64")
	}

	/// Returns the complete-line byte watermark.
	pub const fn append_offset(&self) -> u64 {
		self.watermark
	}

	/// Returns whether bytes remain after the complete-line watermark.
	pub const fn has_torn_tail(&self) -> bool {
		self.tail_bytes != 0
	}

	/// Returns the incomplete byte count after the complete-line watermark.
	pub const fn tail_bytes(&self) -> u64 {
		self.tail_bytes
	}

	fn report(&self, state: RefreshState) -> RefreshReport {
		RefreshReport {
			state,
			next_index: self.next_index(),
			append_offset: self.append_offset(),
			tail_bytes: self.tail_bytes(),
		}
	}
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
	device: u64,
	inode:  u64,
}

#[cfg(not(unix))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
	created: Option<time::SystemTime>,
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> FileIdentity {
	use std::os;

	use os::unix::fs::MetadataExt as _;

	FileIdentity { device: metadata.dev(), inode: metadata.ino() }
}

#[cfg(not(unix))]
fn file_identity(metadata: &Metadata) -> FileIdentity {
	FileIdentity { created: metadata.created().ok() }
}

fn changed_file(message: &'static str) -> Error {
	Error::Io(io::Error::new(io::ErrorKind::InvalidData, message))
}

/// Result of a bounded transcript visitation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VisitReport {
	/// Decoded line-zero header.
	pub header:      Header,
	/// Number of durable events visited.
	pub records:     u64,
	/// Damage counters observed during the scan.
	pub counters:    ReadCounters,
	/// Structured damaged-record diagnostics.
	pub diagnostics: Vec<ReadDiagnostic>,
}

/// Loads a transcript while preserving every durable event index.
///
/// Input is consumed one JSONL record at a time; no whole-file byte buffer is
/// allocated.
pub fn load(path: &Path) -> Result<Log, Error> {
	let mut events = Vec::new();
	let report = visit_batched(
		path,
		VISIT_BATCH_ENTRIES,
		|_, entry| {
			events.push(entry);
			true
		},
		|| {},
	)?;
	Ok(Log { header: report.header, events, diagnostics: report.diagnostics })
}

/// Loads a transcript and folds its live chain in one pass.
pub fn load_live(path: &Path) -> Result<LiveLog, Error> {
	let log = load(path)?;
	let mut live = LiveSet::new();
	log.live_into(&mut live);
	Ok(LiveLog { log, live })
}

/// Visits physical event records using bounded `BufRead` scratch.
///
/// `yield_batch` runs after each `batch_entries` records, allowing async owners
/// to cooperatively yield without coupling storage to one executor. Returning
/// `false` from `visit` stops after the current record.
pub fn visit_batched(
	path: &Path,
	batch_entries: usize,
	mut visit: impl FnMut(u64, Entry) -> bool,
	mut yield_batch: impl FnMut(),
) -> Result<VisitReport, Error> {
	let file = File::open(path)?;
	let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, file);
	let mut line = Vec::new();
	let header_read = reader.read_until(b'\n', &mut line)?;
	if header_read == 0 {
		return Err(Error::MissingHeader);
	}
	if line.last() == Some(&b'\n') {
		line.pop();
	}
	let header = read_header(&line)?;
	let mut offset = u64::try_from(header_read).expect("file offsets fit in u64");
	let mut records = 0_u64;
	let mut diagnostics = Vec::new();
	let batch_entries = batch_entries.max(1);
	'records: loop {
		line.clear();
		let read = reader.read_until(b'\n', &mut line)?;
		if read == 0 {
			break;
		}
		let terminated = line.last() == Some(&b'\n');
		if terminated {
			line.pop();
		} else if read_atomic_group(&line).is_some() {
			diagnostics.push(ReadDiagnostic {
				event_index: records,
				byte_offset: offset,
				byte_len:    u64::try_from(line.len()).expect("record length fits in u64"),
				kind:        DiagnosticKind::Truncated,
			});
			break;
		}
		let damage = if terminated {
			DiagnosticKind::Malformed
		} else {
			DiagnosticKind::Truncated
		};
		let mut entries = Vec::with_capacity(1);
		let appended = push_record_at(&mut entries, &mut diagnostics, &line, records, offset, damage);
		if appended.is_none() {
			diagnostics.push(ReadDiagnostic {
				event_index: records,
				byte_offset: offset,
				byte_len:    u64::try_from(read).expect("record length fits in u64"),
				kind:        DiagnosticKind::Truncated,
			});
			break;
		}
		offset = offset.saturating_add(u64::try_from(read).expect("file offsets fit in u64"));
		for entry in entries {
			let index = records;
			records = records.saturating_add(1);
			let keep_going = visit(index, entry);
			if usize::try_from(records).is_ok_and(|records| records % batch_entries == 0) {
				yield_batch();
			}
			if !keep_going {
				break 'records;
			}
		}
		if !terminated {
			break;
		}
	}
	let mut counters = ReadCounters::default();
	for diagnostic in &diagnostics {
		match diagnostic.kind {
			DiagnosticKind::Malformed => counters.malformed = counters.malformed.saturating_add(1),
			DiagnosticKind::Truncated => counters.truncated = counters.truncated.saturating_add(1),
		}
	}
	Ok(VisitReport { header, records, counters, diagnostics })
}

fn push_record_at(
	events: &mut Vec<Entry>,
	diagnostics: &mut Vec<ReadDiagnostic>,
	line: &[u8],
	event_index: u64,
	byte_offset: u64,
	damage: DiagnosticKind,
) -> Option<usize> {
	if let Some(group) = read_atomic_group(line) {
		return match group {
			Ok(group) => {
				let count = group.len();
				events.extend(group.into_iter().map(|event| Entry::Ok(Box::new(event))));
				Some(count)
			},
			Err(_) => None,
		};
	}
	if let Ok(event) = read_line(line) {
		events.push(Entry::Ok(Box::new(event)));
	} else {
		push_tombstone(events, diagnostics, line, event_index, byte_offset, damage);
	}
	Some(1)
}

fn push_tombstone(
	events: &mut Vec<Entry>,
	diagnostics: &mut Vec<ReadDiagnostic>,
	line: &[u8],
	event_index: u64,
	byte_offset: u64,
	damage: DiagnosticKind,
) {
	diagnostics.push(ReadDiagnostic {
		event_index,
		byte_offset,
		byte_len: u64::try_from(line.len()).expect("record length fits in u64"),
		kind: damage,
	});
	let source = String::from_utf8_lossy(line);
	let raw = to_raw_value(source.as_ref()).expect("a JSON string is always serializable");
	events.push(Entry::Tombstone(raw));
}

#[cfg(test)]
mod tests {
	use std::path::PathBuf;

	use omp_core::{Hash32, Str, sf};
	use omp_proto::inference::v1 as pb;
	use tempfile::tempdir;

	use super::{Reader, load_live};
	use crate::transcript::{Event, Header, Kind, SessionId, TitleSource, TurnReceipt, Writer};

	fn header() -> Header {
		Header {
			v:       4,
			id:      SessionId(sf!("session")),
			created: 1,
			cwd:     PathBuf::from("/tmp/work"),
		}
	}

	fn title(ts: u64, value: &str) -> Event {
		Event { ts, kind: Kind::Title { title: Str::new(value), source: TitleSource::User } }
	}

	#[test]
	fn load_live_matches_reader_live_set_with_rewind_and_incomplete_receipt() {
		let directory = tempdir().expect("temporary directory");
		let path = directory.path().join("session.jsonl");
		let mut writer = Writer::create(&path, &header()).expect("create transcript");
		writer.append(&title(1, "kept")).expect("event zero");
		writer.append(&title(2, "discarded")).expect("event one");
		writer
			.append(&Event { ts: 3, kind: Kind::Rewind { to: Some(0) } })
			.expect("rewind");
		writer
			.append(&title(4, "after-rewind"))
			.expect("event three");
		writer
			.append(&Event {
				ts:   5,
				kind: Kind::TurnReceipt(TurnReceipt {
					turn_id:            sf!("turn"),
					prompt_hash:        Hash32::new([9; 32]),
					prompt_head_events: Vec::new(),
					// Incomplete: claimed item indexes without matching outcome output.
					item_events:        vec![0],
					outcome:            pb::Outcome { output: Vec::new(), ..Default::default() },
				}),
			})
			.expect("incomplete receipt");
		drop(writer);

		let loaded = load_live(&path).expect("load_live pairs the fold");
		// Reader is the producer Journal::load refreshes under its lock guard.
		let reader = Reader::open(&path).expect("open incremental reader");
		assert_eq!(
			loaded.live(),
			reader.live_log().live(),
			"path load_live and the journal reader guard must agree on LiveSet"
		);
		assert_eq!(
			loaded.live().iter().collect::<Vec<_>>(),
			vec![0, 3],
			"rewind must drop the discarded title while the incomplete receipt stays inert"
		);
	}
}
