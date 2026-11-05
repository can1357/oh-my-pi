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
use tokio::sync::mpsc;

use super::{
	Engine, GrepError, GrepOptions, GrepResult, MAX_FILE_BYTES, Match, Mode,
	scan::{STREAM_LINE_LIMIT, ScanOutcome, ScanParams, Scanner, scan_reader},
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

async fn file_root<M: Matcher + Sync>(
	search: &Search<'_, M>,
	mut session: Session,
	root: &Path,
	opts: &GrepOptions,
	sink: Option<&mpsc::Sender<Vec<Match>>>,
	types: Option<&TypeFilter>,
	halt: &AtomicBool,
) -> Result<GrepResult, GrepError> {
	if let Some(types) = types {
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
	let haystack = if info.size > MAX_FILE_BYTES {
		if search.multiline {
			if file.read_into(&mut buf, MAX_FILE_BYTES).await.is_err() {
				return Ok(skipped);
			}
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
	let mut matches = Vec::new();
	let outcome = match haystack {
		Haystack::Bytes => Scanner::default()
			.scan(search.matcher, search.multiline, search.spans, &buf, &params, &mut matches)
			.map_err(|err| GrepError::Search(err.to_string()))?,
		Haystack::Stream(mut file) => {
			let streamed = stream_file(search.matcher, &mut file, &params, &mut matches, halt).await;
			streamed.map_err(|err| {
				GrepError::Search(format!(
					"{err} (a line longer than {} MiB cannot be searched; use read for this file)",
					STREAM_LINE_LIMIT / (1024 * 1024)
				))
			})?
		},
	};
	if outcome.count == 0 {
		return Ok(GrepResult { files_searched: 1, ..GrepResult::default() });
	}
	let path = root.to_string_lossy().into_owned();
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
	};
	if let Some(sink) = sink {
		for batch in batches(opts.mode, &path, matches, outcome.count) {
			sink
				.send(batch)
				.await
				.map_err(|_| GrepError::Sink(SINK_CLOSED.to_owned()))?;
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

/// Searches `file` line by line: a native file through grep-searcher's
/// bounded reader (lines up to [`STREAM_LINE_LIMIT`]), ending once `halt`
/// is raised; a provider file read in full.
async fn stream_file<M: Matcher + Sync>(
	matcher: &M,
	file: &mut File,
	params: &ScanParams,
	matches: &mut Vec<Match>,
	halt: &AtomicBool,
) -> io::Result<ScanOutcome> {
	if let Some(reader) = file.native_reader() {
		return scan_reader(matcher, Halting { reader, halt }, params, matches);
	}
	let mut buf = Vec::new();
	file.read_into(&mut buf, u64::MAX).await?;
	Scanner::default()
		.scan(matcher, false, false, &buf, params, matches)
		.map_err(|err| io::Error::other(err.to_string()))
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
	/// Searched; matches when `Some`.
	Searched(Option<(FileHit, u64)>),
	/// Over [`MAX_FILE_BYTES`]: searched in the second pass.
	Defer,
	/// Unreadable.
	Skipped,
	/// Over [`MAX_FILE_BYTES`] and unreadable.
	SkippedOversized,
}

/// Searches the candidate at walk-relative `rel` for a budgeted pass: in full
/// (deferring files over [`MAX_FILE_BYTES`]) or, with `prefix`, over that
/// prefix.
async fn search_candidate<M: Matcher + Sync>(
	search: &Search<'_, M>,
	shared: &Shared,
	scratch: &mut Scratch,
	session: &mut Session,
	rel: &[u8],
	prefix: bool,
) -> Outcome {
	let unreadable = if prefix {
		Outcome::SkippedOversized
	} else {
		Outcome::Skipped
	};
	let Ok((mut file, info)) = open_candidate(shared, session, rel).await else {
		return unreadable;
	};
	if !prefix && info.size > MAX_FILE_BYTES {
		return Outcome::Defer;
	}
	let limit = if prefix {
		MAX_FILE_BYTES
	} else {
		MAX_FILE_BYTES + 1
	};
	if file.read_into(&mut scratch.buf, limit).await.is_err() {
		return unreadable;
	}
	drop(file);
	if !prefix && scratch.buf.len() as u64 > MAX_FILE_BYTES {
		return Outcome::Defer;
	}
	let mut matches = Vec::new();
	let outcome = search.scan(&mut scratch.scanner, &scratch.buf, &mut matches);
	if outcome.count == 0 {
		return Outcome::Searched(None);
	}
	let hit = FileHit {
		path: String::from_utf8_lossy(rel).into_owned(),
		matches,
		count: outcome.count,
		limit_reached: outcome.limit_reached,
		oversized: prefix,
	};
	Outcome::Searched(Some((hit, outcome.collected)))
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
}

impl Budget {
	/// Takes the outcome of the candidate at `rel`, in path order; returns
	/// whether `need` units are settled and the search can stop.
	fn take(&mut self, rel: Vec<u8>, outcome: Outcome) -> bool {
		match outcome {
			Outcome::Searched(hit) => {
				self.searched += 1;
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

/// Raises the halt flag when the grep future is dropped, so spawned tasks
/// stop before their next file.
struct HaltOnDrop(Arc<AtomicBool>);

impl Drop for HaltOnDrop {
	fn drop(&mut self) {
		self.0.store(true, Ordering::Relaxed);
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
	// returns even if a search task outlives it.
	let sink = opts.sink.take();
	let halt = Arc::new(AtomicBool::new(false));
	let _halt = HaltOnDrop(halt.clone());
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
	});
	if file_type == Some(FileType::File) {
		// Its own task: a streamed native file is searched by a synchronous
		// reader, so this future stays free to be dropped (raising the halt
		// flag the reader checks) while it runs.
		let task = Arc::clone(&shared);
		let searched = tokio::spawn(async move {
			with_search!(&task, |search| file_root(
				&search,
				session,
				&task.root,
				&task.opts,
				sink.as_ref(),
				task.filter.types.as_ref(),
				&task.halt
			)
			.await)
		});
		return searched
			.await
			.unwrap_or_else(|join| std::panic::resume_unwind(join.into_panic()));
	}
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
		Some(max) if max > 0 => budgeted(shared, wopts, max).await,
		_ => unbounded(shared, wopts, sink).await,
	}
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
/// absolute path.
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
	for candidate in candidates {
		if shared.halted() {
			break;
		}
		let opened = match dir {
			Some(dir) => session.open_file_at(dir, candidate.name()).await,
			None => session.open_file(worker.abs_rel(&candidate.rel)).await,
		};
		let Ok((mut file, info)) = opened else {
			continue;
		};
		let mut oversized = info.size > MAX_FILE_BYTES;
		let limit = if oversized {
			MAX_FILE_BYTES
		} else {
			MAX_FILE_BYTES + 1
		};
		if file.read_into(&mut scratch.buf, limit).await.is_err() {
			found.oversized += u64::from(oversized);
			continue;
		}
		drop(file);
		if scratch.buf.len() as u64 > MAX_FILE_BYTES {
			scratch.buf.truncate(MAX_FILE_BYTES as usize);
			oversized = true;
		}
		found.searched += 1;
		let mut matches = Vec::new();
		let outcome = search.scan(&mut scratch.scanner, &scratch.buf, &mut matches);
		if outcome.count > 0 {
			found.hits.push(FileHit {
				path: String::from_utf8_lossy(&candidate.rel).into_owned(),
				matches,
				count: outcome.count,
				limit_reached: outcome.limit_reached,
				oversized,
			});
		}
	}
	found
}

/// Searches every candidate of one walk, each directory's files on the
/// walker worker that listed it; results merge into path order, files over
/// [`MAX_FILE_BYTES`] (searched over that prefix) last. With a sink, each
/// file's batches are sent as the directories' searches complete.
async fn unbounded(
	shared: Arc<Shared>,
	wopts: walk::Options,
	sink: Option<mpsc::Sender<Vec<Match>>>,
) -> Result<GrepResult, GrepError> {
	let mut walked =
		walk::walk_sink(&shared.fs, &shared.root, &wopts, SearchSink { shared: Arc::clone(&shared) })
			.await
			.map_err(GrepError::Walk)?;
	let (mut searched, mut oversized) = (0, 0);
	let mut hits = Vec::new();
	let mut streamed = GrepResult::default();
	while let Some(batch) = walked.next().await {
		for found in batch.items {
			searched += found.searched;
			oversized += found.oversized;
			let Some(sink) = &sink else {
				hits.extend(found.hits);
				continue;
			};
			for hit in found.hits {
				streamed.files_with_matches += 1;
				streamed.total_matches += hit.count;
				streamed.limit_reached |= hit.limit_reached;
				for batch in batches(shared.mode, &hit.path, hit.matches, hit.count) {
					sink
						.send(batch)
						.await
						.map_err(|_| GrepError::Sink(SINK_CLOSED.to_owned()))?;
				}
			}
		}
	}
	if sink.is_some() {
		streamed.files_searched = searched;
		streamed.skipped_oversized = oversized;
		return Ok(streamed);
	}
	hits.sort_unstable_by(|a, b| (a.oversized, &a.path).cmp(&(b.oversized, &b.path)));
	Ok(aggregate(hits, &shared.opts, searched, oversized))
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
	while let Some((rel, outcome)) = results.next().await {
		if budget.take(rel, outcome) {
			break;
		}
	}
	drop(results);
	if !budget.settled
		&& let Some(error) = failure.lock().take()
	{
		return Err(GrepError::Walk(error));
	}
	let deferred = std::mem::take(&mut budget.deferred);
	if !budget.settled && !deferred.is_empty() {
		let mut results = search_in_order(&shared, stream::iter(deferred), workers, window, true);
		while let Some((rel, outcome)) = results.next().await {
			if budget.take(rel, outcome) {
				break;
			}
		}
	}
	Ok(aggregate(budget.hits, &shared.opts, budget.searched, budget.oversized))
}
