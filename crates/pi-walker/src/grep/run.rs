//! [`super::grep`] orchestration on tokio: root classification, the file-root
//! search (one walk whose workers also read and scan each directory's files,
//! [`walk::walk_sink`]), the budgeted ordered search (a path-ordered [`Tree`]
//! feeding a pool whose results come back in path order, [`exec::ordered`]),
//! and pi's result aggregation. Each worker keeps its scratch buffers and
//! filesystem session across files. Dropping the grep future raises the halt
//! flag and aborts the workers.

use std::{
	io,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use futures::{Stream, StreamExt, stream};
use grep_matcher::Matcher;
use parking_lot::Mutex;
use tokio::{runtime::Handle, sync::mpsc};

use super::{
	Engine, GrepError, GrepOptions, GrepResult, MAX_FILE_BYTES, Match, Mode,
	scan::{Batches, ScanOutcome, ScanParams, Scanner, scan_reader},
	types::TypeFilter,
};
use crate::{
	exec,
	fs::{Detail, Dir, File, FileInfo, FileType, Fs, Session},
	glob::Selector,
	walk::{self, Action, Entry, Event, Follow, Order, Tree, TreeOptions, WalkError, Worker},
};

/// Largest batch sent to the sink.
const SINK_BATCH: usize = 1024;

/// Error text when the sink's receiver is gone.
const SINK_CLOSED: &str = "grep sink closed";
/// How long a file root's search may take to stop once the deadline
/// passes before it is abandoned.
const FILE_STOP_GRACE: std::time::Duration = std::time::Duration::from_secs(1);
/// How often a provider read that has not returned checks the halt flag.
const HALT_POLL: std::time::Duration = std::time::Duration::from_millis(10);

/// Which entries a directory search reads.
struct PathFilter {
	scope:   Option<Selector>,
	exclude: Option<Selector>,
	types:   Option<TypeFilter>,
}

impl PathFilter {
	/// A directory is pruned when excluded or out of scope.
	fn prunes_dir(&self, path: &[u8]) -> bool {
		self.exclude.as_ref().is_some_and(|ex| ex.matches(path))
			|| self.scope.as_ref().is_some_and(|scope| scope.prunes(path))
	}

	/// Whether the regular file at `path` (named `name`) is searched.
	fn keeps_file(&self, path: &[u8], name: &[u8]) -> bool {
		self.types.as_ref().is_none_or(|types| types.matches(name))
			&& self.scope.as_ref().is_none_or(|scope| scope.matches(path))
			&& !self.exclude.as_ref().is_some_and(|ex| ex.matches(path))
	}
}

/// One search's shared, read-only state.
struct Search<'s, M> {
	matcher:   &'s M,
	multiline: bool,
	spans:     bool,
	params:    ScanParams,
}

/// A searched file with matches.
struct FileHit {
	path:          String,
	matches:       Vec<Match>,
	count:         u64,
	limit_reached: bool,
	oversized:     bool,
}

/// A matching file's units toward a budget: collected matches (content),
/// matches (count), or the file (files-with-matches).
const fn units(mode: Mode, count: u64, collected: u64) -> u64 {
	match mode {
		Mode::Content => collected,
		Mode::Count => count,
		Mode::FilesWithMatches => 1,
	}
}

impl<M: Matcher> Search<'_, M> {
	/// Scans `buf`; a search error counts as a searched file without
	/// matches, as in pi.
	fn scan(&self, scanner: &mut Scanner, buf: &[u8], matches: &mut Vec<Match>) -> ScanOutcome {
		scanner
			.scan(self.matcher, self.multiline, self.spans, buf, &self.params, matches)
			.unwrap_or_else(|_| {
				matches.clear();
				ScanOutcome::default()
			})
	}
}

/// Per-thread search scratch.
#[derive(Default)]
struct Scratch {
	scanner: Scanner,
	buf:     Vec<u8>,
}

/// Appends `matches` to `out` with `path` attached (cloned for all but the
/// last).
fn attach(path: String, matches: impl Iterator<Item = Match>, out: &mut Vec<Match>) {
	let mut matches = matches.peekable();
	while let Some(mut m) = matches.next() {
		if matches.peek().is_none() {
			m.path = path;
			out.push(m);
			return;
		}
		m.path.clone_from(&path);
		out.push(m);
	}
}

/// The entry a matching file contributes outside content mode.
fn file_entry(mode: Mode, path: String, count: u64) -> Match {
	Match {
		path,
		line: 0,
		text: String::new(),
		before: Vec::new(),
		after: Vec::new(),
		truncated: false,
		column: None,
		count: (mode == Mode::Count).then_some(count),
	}
}

/// One file's results as sink batches: content matches in batches of at most
/// [`SINK_BATCH`], otherwise one entry.
fn batches(mode: Mode, path: &str, matches: Vec<Match>, count: u64) -> Vec<Vec<Match>> {
	if mode != Mode::Content {
		return vec![vec![file_entry(mode, path.to_owned(), count)]];
	}
	let mut out = Vec::new();
	let mut rest = matches.into_iter().peekable();
	while rest.peek().is_some() {
		out.push(
			rest
				.by_ref()
				.take(SINK_BATCH)
				.map(|mut m| {
					path.clone_into(&mut m.path);
					m
				})
				.collect(),
		);
	}
	out
}

/// A search's sink, shared with its tasks: a streamed file sends its matches
/// from the task reading it, in batches as they are found, besides the
/// batches of the files held in memory. Every send is counted and none is
/// made once the result is taken, so the result's totals are exactly what
/// the receiver was sent.
struct Outlet {
	/// Upgraded for each send: the search's own future holds the only
	/// lasting sender, so the receiver sees the end once it returns.
	sender: mpsc::WeakSender<Vec<Match>>,
	sent:   Mutex<Sent>,
	/// Raised when the receiver is gone, so the rest of the search stops.
	halt:   Arc<AtomicBool>,
}

/// What an [`Outlet`] sent.
#[derive(Default)]
struct Sent {
	/// The result was taken: nothing more is sent.
	closed:             bool,
	/// A send found the receiver gone.
	failed:             bool,
	total_matches:      u64,
	files_with_matches: u64,
	limit_reached:      bool,
}

impl Outlet {
	fn new(sink: &mpsc::Sender<Vec<Match>>, halt: Arc<AtomicBool>) -> Self {
		Self { sender: sink.downgrade(), sent: Mutex::default(), halt }
	}

	/// Sends `batch`, which stands for `matches` of one file's matches
	/// (`first` when no batch of the file was sent before), once the channel
	/// has room. `Ok(false)` when nothing more may be sent: the search's
	/// result was taken.
	async fn send(&self, batch: Vec<Match>, matches: u64, first: bool) -> Result<bool, GrepError> {
		let Some(sender) = self.sender.upgrade() else {
			return Ok(false);
		};
		let Ok(permit) = sender.reserve().await else {
			self.sent.lock().failed = true;
			self.halt.store(true, Ordering::Relaxed);
			return Err(GrepError::Sink(SINK_CLOSED.to_owned()));
		};
		let mut sent = self.sent.lock();
		if sent.closed {
			return Ok(false);
		}
		sent.total_matches = sent.total_matches.saturating_add(matches);
		sent.files_with_matches += u64::from(first);
		permit.send(batch);
		Ok(true)
	}

	/// Counts the rest of a matching file: `unsent` matches found but not
	/// sent (the one past its cap), whether its cap stopped it, and the file
	/// itself unless a batch already `counted` it.
	fn finish(&self, unsent: u64, limit_reached: bool, counted: bool) {
		let mut sent = self.sent.lock();
		if !sent.closed {
			sent.total_matches = sent.total_matches.saturating_add(unsent);
			sent.limit_reached |= limit_reached;
			sent.files_with_matches += u64::from(!counted);
		}
	}

	/// Sends a matching file's results held in memory ([`batches`]): `count`
	/// matches, `matches` of them collected.
	async fn deliver(
		&self,
		mode: Mode,
		path: &str,
		matches: Vec<Match>,
		count: u64,
		limit_reached: bool,
	) -> Result<(), GrepError> {
		let collected = matches.len() as u64;
		let mut counted = false;
		for batch in batches(mode, path, matches, count) {
			let units = if mode == Mode::Content {
				batch.len() as u64
			} else {
				count
			};
			if !self.send(batch, units, !counted).await? {
				return Ok(());
			}
			counted = true;
		}
		let unsent = if mode == Mode::Content {
			count.saturating_sub(collected)
		} else {
			0
		};
		self.finish(unsent, limit_reached, counted);
		Ok(())
	}

	/// Takes the search's result: `result` with the totals of what was sent,
	/// or the sink's failure. Nothing is sent after.
	fn close(&self, result: Result<GrepResult, GrepError>) -> Result<GrepResult, GrepError> {
		let mut sent = self.sent.lock();
		sent.closed = true;
		if sent.failed {
			return Err(GrepError::Sink(SINK_CLOSED.to_owned()));
		}
		result.map(|result| GrepResult {
			total_matches: sent.total_matches,
			files_with_matches: sent.files_with_matches,
			limit_reached: sent.limit_reached,
			..result
		})
	}
}

/// A streamed file's way to its search's [`Outlet`] in content mode: its
/// matches go out in batches of [`SINK_BATCH`], with `path` set, while it is
/// read.
struct Feed<'a> {
	outlet:  &'a Outlet,
	path:    &'a str,
	/// A batch was sent, counting the file as matching.
	counted: bool,
}

impl<'a> Feed<'a> {
	const fn new(outlet: &'a Outlet, path: &'a str) -> Self {
		Self { outlet, path, counted: false }
	}

	/// Sends one batch; fails once nothing more may be sent, which ends the
	/// file's scan.
	async fn send(&mut self, mut batch: Vec<Match>) -> io::Result<()> {
		for m in &mut batch {
			self.path.clone_into(&mut m.path);
		}
		let matches = batch.len() as u64;
		match self.outlet.send(batch, matches, !self.counted).await {
			Ok(true) => {
				self.counted = true;
				Ok(())
			},
			Ok(false) | Err(_) => Err(io::Error::other(SINK_CLOSED)),
		}
	}

	/// Sends the matches the scan still holds (at most a batch) and counts the
	/// rest of the file.
	async fn finish(mut self, held: Vec<Match>, outcome: &ScanOutcome) {
		if !held.is_empty() && self.send(held).await.is_err() {
			return;
		}
		if outcome.count > 0 {
			self
				.outlet
				.finish(outcome.count - outcome.collected, outcome.limit_reached, self.counted);
		}
	}
}

/// The smaller of two optional caps.
fn min_some(a: Option<u64>, b: Option<u64>) -> Option<u64> {
	match (a, b) {
		(Some(a), Some(b)) => Some(a.min(b)),
		(a, b) => a.or(b),
	}
}

/// What a file root is searched over.
enum Haystack {
	/// Its bytes (at most [`MAX_FILE_BYTES`]).
	Bytes,
	/// The open file, streamed in full.
	Stream(File),
}

/// Searches the file root of `shared`. With an outlet, its results go there
/// (counted by it) instead of into the result.
async fn file_root<M: Matcher + Sync>(
	search: &Search<'_, M>,
	shared: &Shared,
	mut session: Session,
) -> Result<GrepResult, GrepError> {
	let (root, opts, outlet) = (shared.root.as_path(), &shared.opts, shared.outlet.as_ref());
	if let Some(types) = &shared.filter.types {
		let name = pi_vfs::file_name(root);
		if !name.is_some_and(|name| types.matches(name.as_encoded_bytes())) {
			return Ok(GrepResult::default());
		}
	}
	let skipped = GrepResult { skipped_oversized: 1, ..GrepResult::default() };
	let Ok((mut file, info)) = session.open_file(root).await else {
		return Ok(GrepResult::default());
	};
	let mut buf = Vec::new();
	// Multiline mode holds the file in memory: a large one is searched over
	// its first MAX_FILE_BYTES and reported as partial.
	let mut truncated = false;
	let haystack = if info.size > MAX_FILE_BYTES {
		if search.multiline {
			if file.read_into(&mut buf, MAX_FILE_BYTES).await.is_err() {
				return Ok(skipped);
			}
			truncated = true;
			Haystack::Bytes
		} else {
			Haystack::Stream(file)
		}
	} else {
		if file.read_into(&mut buf, MAX_FILE_BYTES + 1).await.is_err() {
			return Ok(GrepResult::default());
		}
		if buf.len() as u64 <= MAX_FILE_BYTES {
			Haystack::Bytes
		} else if search.multiline {
			buf.truncate(MAX_FILE_BYTES as usize);
			truncated = true;
			Haystack::Bytes
		} else {
			match session.open_file(root).await {
				Ok((file, _)) => Haystack::Stream(file),
				Err(_) => return Ok(skipped),
			}
		}
	};
	drop(session);

	// One file either matches or not: report it once, as a directory walk
	// does.
	let fast = opts.mode == Mode::FilesWithMatches && opts.max_count.is_none() && opts.offset == 0;
	let params = if fast {
		ScanParams { cap: Some(1), probe: false, ..search.params }
	} else {
		search.params
	};
	let path = root.to_string_lossy().into_owned();
	let mut matches = Vec::new();
	// A streamed file's matches go to the outlet as they are found.
	let mut sent = false;
	let outcome = match haystack {
		Haystack::Bytes => Scanner::default()
			.scan(search.matcher, search.multiline, search.spans, &buf, &params, &mut matches)
			.map_err(|err| GrepError::Search(err.to_string()))?,
		Haystack::Stream(file) => {
			let feed = outlet
				.filter(|_| params.content)
				.map(|outlet| Feed::new(outlet, &path));
			sent = feed.is_some();
			let streamed = stream_file(search, shared, file, &params, &mut matches, feed).await;
			// A stream stopped before the end (the deadline, a line too long to
			// stream) keeps what it matched, and the file is named as partial,
			// as in a directory search.
			truncated |= streamed.stopped.is_some();
			streamed.outcome
		},
	};
	let partial_files = if truncated {
		vec![path.clone()]
	} else {
		Vec::new()
	};
	if outcome.count == 0 {
		return Ok(GrepResult { files_searched: 1, partial_files, ..GrepResult::default() });
	}
	let (total, limit_reached) = if fast {
		(1, false)
	} else {
		(
			outcome.count,
			outcome.limit_reached || opts.max_count.is_some_and(|max| outcome.collected >= max),
		)
	};
	let mut result = GrepResult {
		matches: Vec::new(),
		total_matches: total,
		files_with_matches: 1,
		files_searched: 1,
		limit_reached,
		skipped_oversized: 0,
		timed_out: false,
		partial_files,
	};
	if let Some(outlet) = outlet {
		if !sent {
			outlet
				.deliver(opts.mode, &path, matches, total, limit_reached)
				.await?;
		}
		return Ok(result);
	}
	if opts.mode == Mode::Content {
		attach(path, matches.into_iter(), &mut result.matches);
	} else {
		result
			.matches
			.push(file_entry(opts.mode, path, outcome.count));
	}
	Ok(result)
}

/// A file over [`MAX_FILE_BYTES`] as grep-searcher's synchronous reader: a
/// native file read directly, a provider file through its asynchronous
/// reads. A provider read that has not returned ends once the search is
/// halted (checked every [`HALT_POLL`]) or its deadline passes, so a read
/// that never returns cannot hold the search, or the thread scanning it,
/// past either; one that outlasts the deadline marks the search `expired`
/// and halts it, as [`before_deadline`] does. A provider read blocks the
/// thread, so a provider file is only read this way on the blocking pool
/// ([`stream_blocking`]).
struct FileReader<'a> {
	file:     &'a mut File,
	handle:   Handle,
	deadline: Option<tokio::time::Instant>,
	expired:  &'a AtomicBool,
	halt:     &'a AtomicBool,
}

impl io::Read for FileReader<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if let Some(mut native) = self.file.native_reader() {
			return io::Read::read(&mut native, buf);
		}
		let (halt, expired, deadline) = (self.halt, self.expired, self.deadline);
		let read = self.file.read(buf);
		let halted = async {
			while !halt.load(Ordering::Relaxed) {
				tokio::time::sleep(HALT_POLL).await;
			}
		};
		let deadline_passed = async {
			match deadline {
				Some(deadline) => tokio::time::sleep_until(deadline).await,
				None => std::future::pending().await,
			}
		};
		self.handle.block_on(async {
			tokio::select! {
				read = read => read,
				() = halted => Err(io::Error::other("grep stopped")),
				() = deadline_passed => {
					expired.store(true, Ordering::Relaxed);
					halt.store(true, Ordering::Relaxed);
					Err(io::Error::other("grep deadline passed"))
				},
			}
		})
	}
}

/// Searches `file`, over [`MAX_FILE_BYTES`], line by line through
/// grep-searcher's bounded reader (lines up to 64 MiB) until it ends or the
/// search is halted, so no file is ever held whole. A native file without
/// `feed` is scanned inline; a provider file, whose reads wait on the
/// provider, or a scan with `feed`, whose batches wait on the receiver, runs
/// on the blocking pool ([`stream_blocking`]). The deadline does not cut a
/// stream off: it stops at the halt flag or at a provider read that outlasts
/// the deadline, and what it matched stands.
async fn stream_file<M: Matcher + Sync>(
	search: &Search<'_, M>,
	shared: &Shared,
	mut file: File,
	params: &ScanParams,
	matches: &mut Vec<Match>,
	feed: Option<Feed<'_>>,
) -> Streamed {
	if feed.is_none()
		&& let Some(reader) = file.native_reader()
	{
		let reader = Halting { reader, halt: &shared.halt };
		let (outcome, stopped) = scan_reader(search.matcher, reader, params, matches, None);
		return Streamed { outcome, stopped };
	}
	stream_blocking(shared, file, *params, matches, feed).await
}

/// [`stream_file`] on the blocking pool. With `feed`, each full batch goes to
/// the outlet while the file is read: the scan hands it to this task over a
/// one-batch channel and this task waits for room, so at most a few batches
/// of the file exist at once and `matches` stays empty. Without, every match
/// lands in `matches`.
async fn stream_blocking(
	shared: &Shared,
	mut file: File,
	params: ScanParams,
	matches: &mut Vec<Match>,
	mut feed: Option<Feed<'_>>,
) -> Streamed {
	let (tx, mut rx) = mpsc::channel(1);
	let fed = feed.is_some();
	let engine = Arc::clone(&shared.engine);
	let (halt, expired) = (Arc::clone(&shared.halt), Arc::clone(&shared.expired));
	let (handle, deadline) = (Handle::current(), shared.opts.deadline);
	let scan = tokio::task::spawn_blocking(move || {
		let reader = FileReader { file: &mut file, handle, deadline, expired: &expired, halt: &halt };
		let reader = Halting { reader, halt: &halt };
		let mut send = |batch: Vec<Match>| {
			tx.blocking_send(batch)
				.map_err(|_| io::Error::other(SINK_CLOSED))
		};
		let batches = if fed {
			Some(Batches { size: SINK_BATCH, send: &mut send })
		} else {
			None
		};
		let mut held = Vec::new();
		let (outcome, stopped) = match &*engine {
			Engine::Rust(m) => scan_reader(m, reader, &params, &mut held, batches),
			Engine::Pcre(m) => scan_reader(m, reader, &params, &mut held, batches),
		};
		(outcome, stopped, held)
	});
	if let Some(feed) = &mut feed {
		while let Some(batch) = rx.recv().await {
			if feed.send(batch).await.is_err() {
				// Nothing more may be sent: the scan stops at its next batch.
				break;
			}
		}
	}
	drop(rx);
	let (outcome, stopped, mut held) = match scan.await {
		Ok(scanned) => scanned,
		Err(join) if join.is_panic() => std::panic::resume_unwind(join.into_panic()),
		Err(_) => (ScanOutcome::default(), Some(io::Error::other("grep stopped")), Vec::new()),
	};
	match feed {
		Some(feed) => feed.finish(held, &outcome).await,
		None if matches.is_empty() => *matches = held,
		None => matches.append(&mut held),
	}
	Streamed { outcome, stopped }
}

/// What a streamed search found, and the error that stopped it before the
/// end, if any: the counts cover the lines read before it.
struct Streamed {
	outcome: ScanOutcome,
	stopped: Option<io::Error>,
}

/// A reader that fails once the search is halted.
struct Halting<'a, R> {
	reader: R,
	halt:   &'a AtomicBool,
}

impl<R: io::Read> io::Read for Halting<'_, R> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.halt.load(Ordering::Relaxed) {
			return Err(io::Error::other("grep stopped"));
		}
		self.reader.read(buf)
	}
}

/// One candidate's outcome in a budgeted pass.
enum Outcome {
	/// Searched; matches when `Some`. `true` when only part of the file was
	/// searched (see [`scan_oversized`]).
	Searched(Option<(FileHit, u64)>, bool),
	/// Over [`MAX_FILE_BYTES`]: searched in the second pass.
	Defer,
	/// Unreadable.
	Skipped,
	/// Over [`MAX_FILE_BYTES`] and unreadable.
	SkippedOversized,
}

/// Searches the candidate at walk-relative `rel` for a budgeted pass: in full
/// (deferring files over [`MAX_FILE_BYTES`]) or, with `prefix`, over that
/// prefix. `None` once the deadline passes while it is opened or read into
/// memory.
async fn search_candidate<M: Matcher + Sync>(
	search: &Search<'_, M>,
	shared: &Shared,
	scratch: &mut Scratch,
	session: &mut Session,
	rel: &[u8],
	prefix: bool,
) -> Option<Outcome> {
	let unreadable = if prefix {
		Outcome::SkippedOversized
	} else {
		Outcome::Skipped
	};
	let Ok((mut file, info)) = before_deadline(shared, open_candidate(shared, session, rel)).await?
	else {
		return Some(unreadable);
	};
	if !prefix && info.size > MAX_FILE_BYTES {
		return Some(Outcome::Defer);
	}
	let mut matches = Vec::new();
	let (outcome, partial) = if prefix {
		match scan_oversized(search, shared, scratch, file, &mut matches, None).await {
			Large::Scanned(outcome, partial) => (outcome, partial),
			Large::Unreadable => return Some(unreadable),
			Large::TimedOut => return None,
		}
	} else {
		let read = file.read_into(&mut scratch.buf, MAX_FILE_BYTES + 1);
		if before_deadline(shared, read).await?.is_err() {
			return Some(unreadable);
		}
		drop(file);
		if scratch.buf.len() as u64 > MAX_FILE_BYTES {
			return Some(Outcome::Defer);
		}
		(search.scan(&mut scratch.scanner, &scratch.buf, &mut matches), false)
	};
	if outcome.count == 0 {
		return Some(Outcome::Searched(None, partial));
	}
	let hit = FileHit {
		path: String::from_utf8_lossy(rel).into_owned(),
		matches,
		count: outcome.count,
		limit_reached: outcome.limit_reached,
		oversized: prefix,
	};
	Some(Outcome::Searched(Some((hit, outcome.collected)), partial))
}

/// How a file over [`MAX_FILE_BYTES`] was searched.
enum Large {
	/// Its outcome, and whether only part of it was searched.
	Scanned(ScanOutcome, bool),
	Unreadable,
	/// The deadline passed while its prefix was read into memory.
	TimedOut,
}

/// Searches a file over [`MAX_FILE_BYTES`] in full, streamed line by line
/// ([`stream_file`]; with `feed`, its matches sent as they are found).
/// Multiline mode holds the file in memory, so it searches only the first
/// [`MAX_FILE_BYTES`] and leaves `feed` unused; a line too long to stream ends
/// the stream early. Either way the file is reported as partial.
async fn scan_oversized<M: Matcher + Sync>(
	search: &Search<'_, M>,
	shared: &Shared,
	scratch: &mut Scratch,
	mut file: File,
	matches: &mut Vec<Match>,
	feed: Option<Feed<'_>>,
) -> Large {
	if !search.multiline {
		let streamed = stream_file(search, shared, file, &search.params, matches, feed).await;
		return Large::Scanned(streamed.outcome, streamed.stopped.is_some());
	}
	match before_deadline(shared, file.read_into(&mut scratch.buf, MAX_FILE_BYTES)).await {
		None => Large::TimedOut,
		Some(Err(_)) => Large::Unreadable,
		Some(Ok(())) => {
			Large::Scanned(search.scan(&mut scratch.scanner, &scratch.buf, matches), true)
		},
	}
}

/// The settled prefix of a budgeted search.
struct Budget {
	mode:      Mode,
	need:      u64,
	units:     u64,
	settled:   bool,
	hits:      Vec<FileHit>,
	/// Oversized candidates (walk-relative paths) for the prefix pass.
	deferred:  Vec<Vec<u8>>,
	searched:  u64,
	oversized: u64,
	/// Files searched only in part.
	partial:   Vec<String>,
}

impl Budget {
	/// Takes the outcome of the candidate at `rel`, in path order; returns
	/// whether `need` units are settled and the search can stop.
	fn take(&mut self, rel: Vec<u8>, outcome: Outcome) -> bool {
		match outcome {
			Outcome::Searched(hit, partial) => {
				self.searched += 1;
				if partial {
					self
						.partial
						.push(String::from_utf8_lossy(&rel).into_owned());
				}
				if let Some((hit, collected)) = hit {
					self.units = self
						.units
						.saturating_add(units(self.mode, hit.count, collected));
					self.hits.push(hit);
				}
			},
			Outcome::Defer => self.deferred.push(rel),
			Outcome::Skipped => {},
			Outcome::SkippedOversized => self.oversized += 1,
		}
		self.settled = self.units >= self.need;
		self.settled
	}
}

/// pi's `aggregate_parallel_results`: applies `offset` and `max_count` to
/// path-ordered hits and totals them.
fn aggregate(hits: Vec<FileHit>, opts: &GrepOptions, searched: u64, oversized: u64) -> GrepResult {
	let (offset, max_count) = (opts.offset, opts.max_count);
	let mut result = GrepResult {
		files_searched: searched,
		skipped_oversized: oversized,
		..GrepResult::default()
	};
	let mut skipped = 0u64;
	let mut emitted = 0u64;
	for hit in hits {
		let file_start = result.total_matches;
		result.files_with_matches += 1;
		result.total_matches = result.total_matches.saturating_add(hit.count);
		match opts.mode {
			Mode::Content => {
				let len = hit.matches.len() as u64;
				let skip = offset.saturating_sub(skipped).min(len);
				skipped += skip;
				let available = len - skip;
				let selected =
					max_count.map_or(available, |max| max.saturating_sub(emitted).min(available));
				if selected < available {
					result.limit_reached = true;
				}
				if selected > 0 {
					let selection = hit
						.matches
						.into_iter()
						.skip(skip as usize)
						.take(selected as usize);
					attach(hit.path, selection, &mut result.matches);
					emitted += selected;
				}
				if hit.limit_reached && skipped >= offset {
					result.limit_reached = true;
				}
			},
			Mode::Count => {
				let skip = offset.saturating_sub(file_start).min(hit.count);
				let available = hit.count - skip;
				if available == 0 {
					continue;
				}
				let remaining = max_count.map_or(available, |max| max.saturating_sub(emitted));
				if remaining == 0 {
					result.limit_reached = true;
					continue;
				}
				result
					.matches
					.push(file_entry(Mode::Count, hit.path, hit.count));
				let selected = available.min(remaining);
				emitted = emitted.saturating_add(selected);
				if selected < available {
					result.limit_reached = true;
				}
			},
			Mode::FilesWithMatches => {
				if skipped < offset {
					skipped += 1;
					continue;
				}
				if max_count.is_some_and(|max| emitted >= max) {
					result.limit_reached = true;
					continue;
				}
				result
					.matches
					.push(file_entry(Mode::FilesWithMatches, hit.path, hit.count));
				emitted += 1;
			},
		}
	}
	if max_count.is_some_and(|max| emitted >= max) {
		result.limit_reached = true;
	}
	if max_count == Some(0) {
		result.limit_reached = result.files_with_matches > 0;
	}
	result
}

/// Stops the spawned tasks when the grep future ends or is dropped: raises
/// the halt flag, so they stop before their next file or read, and closes
/// the outlet, so they send nothing more.
struct StopOnDrop(Arc<Shared>);

impl Drop for StopOnDrop {
	fn drop(&mut self) {
		self.0.halt.store(true, Ordering::Relaxed);
		if let Some(outlet) = &self.0.outlet {
			outlet.sent.lock().closed = true;
		}
	}
}

/// Everything a search task needs, owned so tasks can be spawned.
struct Shared {
	engine:    Arc<Engine>,
	multiline: bool,
	spans:     bool,
	mode:      Mode,
	params:    ScanParams,
	fs:        Fs,
	root:      PathBuf,
	filter:    PathFilter,
	opts:      GrepOptions,
	halt:      Arc<AtomicBool>,
	/// A file's search hit the deadline (an open or read into memory cut off,
	/// or a provider read in a stream that outlasted it): the result is
	/// partial however the search's own race with the deadline came out.
	expired:   Arc<AtomicBool>,
	/// The sink, when the results are streamed.
	outlet:    Option<Outlet>,
}

/// A search worker's state, kept across the files it searches.
type WorkerState = (Scratch, Session);

impl Shared {
	/// A new search worker's state.
	fn worker(&self) -> WorkerState {
		(Scratch::default(), walk::take_session(&self.fs))
	}

	fn halted(&self) -> bool {
		self.halt.load(Ordering::Relaxed)
	}
}

/// Runs `$body` with `$search` bound to a [`Search`] over the engine's
/// concrete matcher, so scanning stays monomorphised per engine.
macro_rules! with_search {
	($shared:expr, | $search:ident | $body:expr) => {{
		let shared: &Shared = $shared;
		match &*shared.engine {
			Engine::Rust(m) => {
				let $search = Search {
					matcher:   m,
					multiline: shared.multiline,
					spans:     shared.spans,
					params:    shared.params,
				};
				$body
			},
			Engine::Pcre(m) => {
				let $search = Search {
					matcher:   m,
					multiline: shared.multiline,
					spans:     shared.spans,
					params:    shared.params,
				};
				$body
			},
		}
	}};
}

/// See [`super::grep`].
pub async fn grep(fs: &Fs, root: &Path, mut opts: GrepOptions) -> Result<GrepResult, GrepError> {
	if opts.sink.is_some() && (opts.max_count.is_some() || opts.offset != 0) {
		return Err(GrepError::StreamLimits);
	}
	let glob = opts
		.glob
		.as_deref()
		.map(str::trim)
		.filter(|glob| !glob.is_empty());
	let filter = PathFilter {
		scope:   glob
			.map(|glob| Selector::scope(glob, opts.recursive))
			.transpose()
			.map_err(GrepError::Glob)?,
		exclude: Selector::exclude(&opts.exclude).map_err(GrepError::Exclude)?,
		types:   opts.file_type.as_deref().and_then(TypeFilter::new),
	};
	let mut session = fs.session();
	let file_type = session
		.stat(root, true)
		.await
		.map_err(GrepError::NotFound)?
		.file_type;
	let content = opts.mode == Mode::Content;
	let mut params = ScanParams {
		content,
		before: if content { opts.before } else { 0 },
		after: if content { opts.after } else { 0 },
		max_columns: opts.max_columns,
		offset: 0,
		cap: None,
		probe: true,
	};
	match file_type {
		Some(FileType::File) => {
			params.offset = opts.offset;
			params.cap = match opts.mode {
				Mode::Content => min_some(opts.max_count, opts.max_count_per_file),
				Mode::Count => None,
				Mode::FilesWithMatches => Some(1),
			};
		},
		Some(FileType::Dir) => {
			// Each file applies the offset fresh, so it widens the cap; files
			// mode needs only the first match.
			params.cap = match opts.mode {
				Mode::Content => min_some(
					opts.max_count.map(|max| max.saturating_add(opts.offset)),
					opts.max_count_per_file,
				),
				Mode::Count => None,
				Mode::FilesWithMatches => Some(1),
			};
			params.probe = opts.mode != Mode::FilesWithMatches;
		},
		_ => return Ok(GrepResult::default()),
	}
	// The sink stays with this future, so every sender is gone once it
	// returns even if a search task outlives it: the tasks send through the
	// outlet, which only borrows it for each send.
	let sink = opts.sink.take();
	let halt = Arc::new(AtomicBool::new(false));
	let outlet = sink
		.as_ref()
		.map(|sink| Outlet::new(sink, Arc::clone(&halt)));
	let shared = Arc::new(Shared {
		engine: opts.engine.clone(),
		multiline: opts.multiline,
		spans: opts.engine.spans_lines(),
		mode: opts.mode,
		params,
		fs: fs.clone(),
		root: root.to_path_buf(),
		filter,
		opts,
		halt,
		expired: Arc::new(AtomicBool::new(false)),
		outlet,
	});
	let _stop = StopOnDrop(Arc::clone(&shared));
	let result = if file_type == Some(FileType::File) {
		search_file(&shared, session).await
	} else {
		drop(session);
		let wopts = walk::Options {
			hidden: shared.opts.walk.hidden,
			gitignore: shared.opts.walk.gitignore,
			skip_git: true,
			skip_node_modules: !shared
				.filter
				.scope
				.as_ref()
				.is_some_and(Selector::mentions_node_modules),
			follow_links: false,
			detail: Detail::Minimal,
			max_depth: shared.filter.scope.as_ref().and_then(Selector::max_depth),
			workers: shared.opts.walk.workers,
			cache: shared.opts.walk.cache,
			..walk::Options::default()
		};
		match shared.opts.max_count {
			Some(max) if max > 0 => budgeted(Arc::clone(&shared), wopts, max).await,
			_ => unbounded(Arc::clone(&shared), wopts).await,
		}
	};
	let result = match &shared.outlet {
		Some(outlet) => outlet.close(result),
		None => result,
	};
	drop(sink);
	result
}

/// Searches the file root in its own task: a streamed native file is
/// searched by a synchronous reader, so this future stays free to be dropped
/// (raising the halt flag the reader checks) while it runs.
async fn search_file(shared: &Arc<Shared>, session: Session) -> Result<GrepResult, GrepError> {
	let task = Arc::clone(shared);
	let mut searched = tokio::spawn(async move {
		with_search!(&task, |search| file_root(&search, &task, session).await)
	});
	let joined = match shared.opts.deadline {
		None => searched.await,
		Some(deadline) => tokio::select! {
			joined = &mut searched => joined,
			() = tokio::time::sleep_until(deadline) => {
				// Stop the reader; a native stream returns what it matched so
				// far. A read that does not return (a hung provider) is
				// abandoned.
				shared.expired.store(true, Ordering::Relaxed);
				shared.halt.store(true, Ordering::Relaxed);
				if let Ok(joined) = tokio::time::timeout(FILE_STOP_GRACE, &mut searched).await {
					joined
				} else {
					searched.abort();
					return Ok(GrepResult { timed_out: true, ..GrepResult::default() });
				}
			},
		},
	};
	// The deadline stopped the search if this future saw it pass or the task's
	// stream did (a provider read that outlasted it); the joined task's
	// writes are visible here.
	let timed_out = shared.expired.load(Ordering::Relaxed);
	joined
		.unwrap_or_else(|join| std::panic::resume_unwind(join.into_panic()))
		.map(|result| GrepResult { timed_out, ..result })
}

/// Opens the file at walk-relative `rel` for a budgeted pass, by path.
async fn open_candidate(
	shared: &Shared,
	session: &mut Session,
	rel: &[u8],
) -> io::Result<(File, FileInfo)> {
	session.open_file(&shared.fs.join(&shared.root, rel)).await
}

/// A file the unbounded walk found worth searching.
struct Candidate {
	/// Walk-relative path.
	rel: Vec<u8>,
}

impl Candidate {
	/// The final path component.
	fn name(&self) -> &[u8] {
		self.rel.rsplit(|&b| b == b'/').next().unwrap_or(&self.rel)
	}
}

/// What searching one directory's candidates found.
#[derive(Default)]
struct Found {
	hits:      Vec<FileHit>,
	searched:  u64,
	oversized: u64,
	/// Files searched only in part.
	partial:   Vec<String>,
}

impl Found {
	/// Nothing was searched or found.
	const fn is_empty(&self) -> bool {
		self.hits.is_empty() && self.searched == 0 && self.oversized == 0
	}
}

/// The unbounded search's [`walk::Sink`]: the walk's visits select the files
/// to search, and the worker that listed a directory then reads and scans
/// them with its own session and scratch, before sending the directory's
/// [`Found`]. No candidate leaves the worker that found it.
struct SearchSink {
	shared: Arc<Shared>,
}

impl walk::Sink for SearchSink {
	type Item = Candidate;
	type Out = Found;
	type State = Scratch;

	const COLLECTS: bool = false;
	const KEEPS_DIR: bool = false;

	fn state(&self) -> Scratch {
		Scratch::default()
	}

	fn visit(&self, _: &mut Worker<'_>, entry: &mut Entry<'_>, out: &mut Vec<Candidate>) -> Action {
		match entry.file_type {
			FileType::Dir => {
				if self.shared.filter.prunes_dir(entry.path) {
					Action::SkipDir
				} else {
					Action::Continue
				}
			},
			FileType::File if self.shared.filter.keeps_file(entry.path, entry.name()) => {
				out.push(Candidate { rel: entry.path.to_vec() });
				Action::Continue
			},
			_ => Action::Skip,
		}
	}

	async fn settle(
		&self,
		scratch: &mut Scratch,
		session: &mut Session,
		worker: &mut Worker<'_>,
		dir: Option<&Dir>,
		items: Vec<Candidate>,
	) -> Vec<Found> {
		let found = with_search!(&self.shared, |search| search_directory(
			&search,
			&self.shared,
			scratch,
			session,
			worker,
			dir,
			items
		)
		.await);
		if found.is_empty() {
			Vec::new()
		} else {
			vec![found]
		}
	}
}

/// Searches one directory's candidates on the worker that listed it: opened
/// relative to `dir` while the walk holds the listed directory, otherwise by
/// absolute path. Files over [`MAX_FILE_BYTES`] are streamed after the
/// others, so a long stream cannot keep its smaller siblings from being
/// searched before the deadline. With an outlet, a streamed file's content
/// matches go there as they are found, not into its hit. The deadline cuts
/// off an open or a read into memory; a stream stops on its own and keeps
/// what it matched.
async fn search_directory<M: Matcher + Sync>(
	search: &Search<'_, M>,
	shared: &Shared,
	scratch: &mut Scratch,
	session: &mut Session,
	worker: &mut Worker<'_>,
	dir: Option<&Dir>,
	candidates: Vec<Candidate>,
) -> Found {
	let mut found = Found::default();
	// The first pass defers the files over MAX_FILE_BYTES, which the second
	// opens again and streams.
	let mut pending = candidates;
	let mut large = Vec::new();
	for deferring in [true, false] {
		for candidate in std::mem::take(&mut pending) {
			if shared.halted() {
				return found;
			}
			let opened = before_deadline(shared, async {
				match dir {
					Some(dir) => session.open_file_at(dir, candidate.name()).await,
					None => session.open_file(worker.abs_rel(&candidate.rel)).await,
				}
			})
			.await;
			// The deadline passed during this file: the files before it stand.
			let Some(opened) = opened else {
				return found;
			};
			let Ok((mut file, info)) = opened else {
				continue;
			};
			if deferring && info.size > MAX_FILE_BYTES {
				large.push(candidate);
				continue;
			}
			let path = String::from_utf8_lossy(&candidate.rel);
			let mut matches = Vec::new();
			let (outcome, partial, oversized, sent) = if info.size > MAX_FILE_BYTES {
				// A streamed file's content matches go to the outlet as they
				// are found.
				let feed = shared
					.outlet
					.as_ref()
					.filter(|_| search.params.content && !search.multiline)
					.map(|outlet| Feed::new(outlet, &path));
				let sent = feed.is_some();
				match scan_oversized(search, shared, scratch, file, &mut matches, feed).await {
					Large::Scanned(outcome, partial) => (outcome, partial, true, sent),
					Large::Unreadable => {
						found.oversized += 1;
						continue;
					},
					Large::TimedOut => return found,
				}
			} else {
				let read = file.read_into(&mut scratch.buf, MAX_FILE_BYTES + 1);
				match before_deadline(shared, read).await {
					None => return found,
					Some(Err(_)) => continue,
					Some(Ok(())) => {},
				}
				// A file that grew past its listed size is searched over its
				// first MAX_FILE_BYTES and reported as partial.
				let grew = scratch.buf.len() as u64 > MAX_FILE_BYTES;
				if grew {
					scratch.buf.truncate(MAX_FILE_BYTES as usize);
				}
				(search.scan(&mut scratch.scanner, &scratch.buf, &mut matches), grew, grew, false)
			};
			found.searched += 1;
			let path = path.into_owned();
			if partial {
				found.partial.push(path.clone());
			}
			if outcome.count > 0 && !sent {
				found.hits.push(FileHit {
					path,
					matches,
					count: outcome.count,
					limit_reached: outcome.limit_reached,
					oversized,
				});
			}
		}
		pending = std::mem::take(&mut large);
	}
	found
}

/// `work`'s result, or `None` once the search's deadline passes first, so a
/// file that never finishes reading cannot hold back the files searched
/// before it.
async fn before_deadline<T>(shared: &Shared, work: impl Future<Output = T>) -> Option<T> {
	let Some(deadline) = shared.opts.deadline else {
		return Some(work.await);
	};
	let finished = tokio::time::timeout_at(deadline, work).await.ok();
	if finished.is_none() {
		// Stop the walk and the other workers too.
		shared.expired.store(true, Ordering::Relaxed);
		shared.halt.store(true, Ordering::Relaxed);
	}
	finished
}

/// `stream`'s next item. Once `deadline` passes, `expired` is set, the search
/// is halted, and the items already finishing are still taken for up to
/// [`FILE_STOP_GRACE`]: each file's search stops at the deadline, so the work
/// in flight returns what it found.
async fn next_before<S: Stream + Unpin>(
	stream: &mut S,
	deadline: Option<tokio::time::Instant>,
	expired: &mut bool,
	halt: &AtomicBool,
) -> Option<S::Item> {
	let Some(deadline) = deadline else {
		return stream.next().await;
	};
	if !*expired {
		tokio::select! {
			item = stream.next() => return item,
			() = tokio::time::sleep_until(deadline) => {
				*expired = true;
				halt.store(true, Ordering::Relaxed);
			},
		}
	}
	tokio::time::timeout_at(deadline + FILE_STOP_GRACE, stream.next())
		.await
		.ok()
		.flatten()
}

/// Searches every candidate of one walk, each directory's files on the
/// walker worker that listed it; results merge into path order, files over
/// [`MAX_FILE_BYTES`] last. With an outlet, each file held in memory is sent
/// as the directories' searches complete (a streamed file's matches as they
/// are found, by its worker) and the outlet counts the totals. At the
/// deadline the walk stops and the files searched so far are the result.
async fn unbounded(shared: Arc<Shared>, wopts: walk::Options) -> Result<GrepResult, GrepError> {
	let mut walked =
		walk::walk_sink(&shared.fs, &shared.root, &wopts, SearchSink { shared: Arc::clone(&shared) })
			.await
			.map_err(GrepError::Walk)?;
	let (mut searched, mut oversized) = (0, 0);
	let mut hits = Vec::new();
	let mut partial = Vec::new();
	let mut timed_out = false;
	while let Some(batch) =
		next_before(&mut walked, shared.opts.deadline, &mut timed_out, &shared.halt).await
	{
		for found in batch.items {
			searched += found.searched;
			oversized += found.oversized;
			partial.extend(found.partial);
			let Some(outlet) = &shared.outlet else {
				hits.extend(found.hits);
				continue;
			};
			for hit in found.hits {
				outlet
					.deliver(shared.mode, &hit.path, hit.matches, hit.count, hit.limit_reached)
					.await?;
			}
		}
	}
	// Dropping the walk cancels the directories still being listed.
	drop(walked);
	let timed_out = timed_out || shared.expired.load(Ordering::Relaxed);
	if timed_out {
		// Streams still running stop at their next read.
		shared.halt.store(true, Ordering::Relaxed);
	}
	partial.sort_unstable();
	if shared.outlet.is_some() {
		return Ok(GrepResult {
			files_searched: searched,
			skipped_oversized: oversized,
			timed_out,
			partial_files: partial,
			..GrepResult::default()
		});
	}
	hits.sort_unstable_by(|a, b| (a.oversized, &a.path).cmp(&(b.oversized, &b.path)));
	Ok(GrepResult {
		timed_out,
		partial_files: partial,
		..aggregate(hits, &shared.opts, searched, oversized)
	})
}

/// What the budgeted producer does with its next event.
enum Step {
	/// A directory to leave unvisited.
	Prune,
	/// A file to search, by walk-relative path.
	Candidate(Vec<u8>),
	/// Nothing to do.
	Other,
}

/// Candidates a search worker takes at once: one channel message per group
/// keeps cross-thread wakeups rare next to the files searched.
const CANDIDATE_GROUP: usize = 16;

/// Searches `candidates` on a pool of workers, yielding each outcome in
/// candidate order: in full (deferring files over [`MAX_FILE_BYTES`]) or,
/// with `prefix`, over that prefix. Workers take candidates in groups of up
/// to [`CANDIDATE_GROUP`]; `window` counts candidates.
fn search_in_order(
	shared: &Arc<Shared>,
	candidates: impl Stream<Item = Vec<u8>> + Send + 'static,
	workers: usize,
	window: usize,
	prefix: bool,
) -> impl Stream<Item = (Vec<u8>, Outcome)> + Send + 'static {
	let pool = Arc::clone(shared);
	let groups = candidates.ready_chunks(CANDIDATE_GROUP);
	let window = window.div_ceil(CANDIDATE_GROUP);
	exec::ordered(
		groups,
		workers,
		window,
		|| shared.worker(),
		move |mut state, group: Vec<Vec<u8>>| {
			let shared = Arc::clone(&pool);
			async move {
				let mut outcomes = Vec::with_capacity(group.len());
				for rel in group {
					if shared.halted() {
						outcomes.push((rel, Outcome::Skipped));
						continue;
					}
					let (scratch, session) = &mut state;
					let outcome = with_search!(&shared, |search| search_candidate(
						&search, &shared, scratch, session, &rel, prefix
					)
					.await);
					// The deadline passed during this file: the files before it
					// stand.
					let Some(outcome) = outcome else {
						shared.halt.store(true, Ordering::Relaxed);
						outcomes.push((rel, Outcome::Skipped));
						continue;
					};
					outcomes.push((rel, outcome));
				}
				(state, outcomes)
			}
		},
	)
	.flat_map(stream::iter)
}

/// The files of a path-ordered traversal that `shared`'s filter keeps, as
/// walk-relative paths; an unreadable root ends it with the error left in
/// `failure`.
fn candidates(
	tree: Tree,
	shared: Arc<Shared>,
	failure: Arc<Mutex<Option<WalkError>>>,
) -> impl Stream<Item = Vec<u8>> + Send + 'static {
	let abs_root = walk::absolute_root(&shared.fs, &shared.root);
	stream::unfold(
		(tree, shared, failure, abs_root),
		|(mut tree, shared, failure, abs_root)| async move {
			loop {
				if shared.halted() {
					return None;
				}
				let step = match tree.next().await {
					None => return None,
					Some(Event::Entry(entry)) => match entry.file_type {
						FileType::Dir if shared.filter.prunes_dir(entry.path) => Step::Prune,
						FileType::File if shared.filter.keeps_file(entry.path, entry.name()) => {
							Step::Candidate(entry.path.to_vec())
						},
						_ => Step::Other,
					},
					Some(Event::Error(failed)) if failed.path == abs_root => {
						let error = io::Error::new(failed.error.kind(), failed.error.to_string());
						*failure.lock() = Some(WalkError::Root { path: shared.root.clone(), error });
						return None;
					},
					Some(Event::Error(_)) => Step::Other,
				};
				match step {
					Step::Prune => tree.skip_dir(),
					Step::Candidate(rel) => return Some((rel, (tree, shared, failure, abs_root))),
					Step::Other => {},
				}
			}
		},
	)
}

/// Walks the candidates in path order and searches them from the front as
/// the walk finds them, normal files first and then (unless the budget is
/// met) the prefixes of files over [`MAX_FILE_BYTES`]; dropping the result
/// stream stops the walk and the search once the first `offset + max`
/// results are settled.
async fn budgeted(
	shared: Arc<Shared>,
	wopts: walk::Options,
	max: u64,
) -> Result<GrepResult, GrepError> {
	let window = wopts.parallelism(&shared.fs) * 16;
	let tree_opts = TreeOptions {
		hidden: wopts.hidden,
		gitignore: wopts.gitignore,
		skip_git: wopts.skip_git,
		skip_node_modules: wopts.skip_node_modules,
		follow: if wopts.follow_links {
			Follow::Always
		} else {
			Follow::Roots
		},
		order: Order::Paths,
		max_depth: wopts.max_depth,
		same_file_system: wopts.same_file_system,
		..TreeOptions::default()
	};
	let mut budget = Budget {
		mode:      shared.mode,
		need:      shared.opts.offset.saturating_add(max),
		units:     0,
		settled:   false,
		hits:      Vec::new(),
		deferred:  Vec::new(),
		searched:  0,
		oversized: 0,
		partial:   Vec::new(),
	};
	let workers = wopts.parallelism(&shared.fs);
	let tree = Tree::new(&shared.fs, &shared.root, &tree_opts)
		.await
		.map_err(GrepError::Walk)?;
	// An unreadable root fails the search, as `walk::walk` does for the
	// unbounded search; unreadable directories below it are skipped.
	let failure = Arc::new(Mutex::new(None));
	let walked = candidates(tree, Arc::clone(&shared), Arc::clone(&failure));
	let mut results = search_in_order(&shared, walked, workers, window, false);
	let deadline = shared.opts.deadline;
	let mut timed_out = false;
	while let Some((rel, outcome)) =
		next_before(&mut results, deadline, &mut timed_out, &shared.halt).await
	{
		if budget.take(rel, outcome) {
			break;
		}
	}
	drop(results);
	timed_out |= shared.expired.load(Ordering::Relaxed);
	if !budget.settled
		&& !timed_out
		&& let Some(error) = failure.lock().take()
	{
		return Err(GrepError::Walk(error));
	}
	let deferred = std::mem::take(&mut budget.deferred);
	if !budget.settled && !timed_out && !deferred.is_empty() {
		let mut results = search_in_order(&shared, stream::iter(deferred), workers, window, true);
		while let Some((rel, outcome)) =
			next_before(&mut results, deadline, &mut timed_out, &shared.halt).await
		{
			if budget.take(rel, outcome) {
				break;
			}
		}
	}
	let timed_out = timed_out || shared.expired.load(Ordering::Relaxed);
	if timed_out {
		// Streams still running stop at their next read.
		shared.halt.store(true, Ordering::Relaxed);
	}
	Ok(GrepResult {
		timed_out,
		partial_files: budget.partial,
		..aggregate(budget.hits, &shared.opts, budget.searched, budget.oversized)
	})
}
