//! Structural search and rewrite over files and in-memory sources.
//!
//! [`discover`] lists the candidate files below a root through pi-walker's
//! walker; [`find`] streams each file's matches, [`find_page`] keeps one
//! ordered page of matches across files, and [`rewrite`] stages replacements
//! per file and writes them only after the whole pass succeeded.
//! [`find_source`] and [`rewrite_source`] run the same matching on a string.
//!
//! Every file is parsed in its own language (an explicit language overrides
//! extensions), patterns are compiled once per discovered language, and
//! per-file problems (unknown languages, unreadable files, syntax errors,
//! patterns invalid in one language) become warnings instead of failing the
//! run. Languages whose on-demand grammar is not installed are skipped and
//! reported in [`Report::missing_grammars`].

use std::{
	collections::{BTreeMap, BTreeSet, BinaryHeap, HashMap, HashSet},
	fmt, io,
	num::NonZero,
	ops::ControlFlow,
	path::{Path, PathBuf},
	pin::{Pin, pin},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Context, Poll},
	thread,
};

pub use ast_grep_core::MatchStrictness;
use ast_grep_core::{
	AstGrep, Node, NodeMatch, Pattern,
	meta_var::MetaVariable,
	source::Edit,
	tree_sitter::{LanguageExt, StrDoc},
};
use futures::{Stream, StreamExt, stream};
use pi_vfs::Fs;
use pi_walker::{
	FileType, exec,
	glob::Selector,
	walk::{self, Action, WalkError},
};
use tokio_util::sync::CancellationToken;

use crate::{
	language::{SupportLang, grammar::LanguageGrammar},
	ops,
};

#[cfg(test)]
mod tests;

/// A parsed source.
type Ast = AstGrep<StrDoc<SupportLang>>;

/// Why a search or rewrite ended without a result.
#[derive(Debug)]
pub enum Error {
	/// The cancellation token of an in-memory search fired.
	Stopped,
	/// A directory root could not be walked.
	Root {
		/// The root as walked.
		path:  PathBuf,
		/// What failed.
		error: io::Error,
	},
	/// The request cannot run; the text is the user-facing reason.
	Invalid(String),
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Stopped => f.write_str("search stopped"),
			Self::Root { path, error } => write!(f, "{}: {error}", path.display()),
			Self::Invalid(reason) => f.write_str(reason),
		}
	}
}

impl std::error::Error for Error {
	fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
		match self {
			Self::Root { error, .. } => Some(error),
			Self::Stopped | Self::Invalid(_) => None,
		}
	}
}

impl From<WalkError> for Error {
	fn from(err: WalkError) -> Self {
		let WalkError::Root { path, error } = err;
		Self::Root { path, error }
	}
}

/// A signal that running work should stop.
trait Cancelled {
	fn cancelled(&self) -> bool;
}

impl Cancelled for CancellationToken {
	fn cancelled(&self) -> bool {
		self.is_cancelled()
	}
}

/// The flag one async call shares with its tasks; its [`HaltGuard`] raises it
/// when the call ends or its future is dropped.
#[derive(Clone, Default)]
struct HaltFlag(Arc<AtomicBool>);

impl HaltFlag {
	fn guard(&self) -> HaltGuard {
		HaltGuard(self.clone())
	}
}

impl Cancelled for HaltFlag {
	fn cancelled(&self) -> bool {
		self.0.load(Ordering::Relaxed)
	}
}

/// Raises its [`HaltFlag`] on drop.
struct HaltGuard(HaltFlag);

impl Drop for HaltGuard {
	fn drop(&mut self) {
		self.0.0.store(true, Ordering::Relaxed);
	}
}

/// [`Error::Stopped`] once `halt` fires.
fn check(halt: &impl Cancelled) -> Result<(), Error> {
	if halt.cancelled() {
		Err(Error::Stopped)
	} else {
		Ok(())
	}
}

/// Worker count of a per-file pool and the files it keeps in flight.
fn pool() -> (usize, usize) {
	let workers = thread::available_parallelism().map_or(1, NonZero::get);
	(workers, workers * 4)
}

/// Which files below a directory root [`discover`] keeps.
#[derive(Clone, Debug, Default)]
pub struct Discover {
	/// Keep only files this selects; directories it cannot select below are
	/// not entered.
	pub include:      Option<Selector>,
	/// Leave out files and directories (with their subtrees) this selects.
	pub exclude:      Option<Selector>,
	/// Include dot-prefixed entries.
	pub hidden:       bool,
	/// Honour `.ignore`, `.gitignore`, `.git/info/exclude`, and git's global
	/// excludes.
	pub gitignore:    bool,
	/// Descend into `node_modules`.
	pub node_modules: bool,
	/// Follow symlinks to files and directories.
	pub follow_links: bool,
	/// Walking threads; `None` picks the walker's default.
	pub workers:      Option<usize>,
	/// Keep files whose name maps to no language (an explicit language will
	/// parse them).
	pub any_file:     bool,
}

/// A file to search.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
	/// Absolute path in the filesystem's spelling, read and written through.
	pub path:    PathBuf,
	/// Path shown in results: walk-relative and `/`-separated below a
	/// directory root, the file name for a file root.
	pub display: String,
}

/// The files below `root` (an absolute host path or `scheme://` URL) that
/// `opts` keeps, in path order.
///
/// A file root is its own only candidate (when its name maps to a language
/// or [`Discover::any_file`] is set); the globs do not apply to it.
///
/// # Errors
/// [`Error::Invalid`] when `root` does not exist or is neither file nor
/// directory, [`Error::Root`] when it cannot be walked. Dropping the future
/// cancels the walk.
pub async fn discover(fs: &Fs, root: &Path, opts: &Discover) -> Result<Vec<Candidate>, Error> {
	let root = pi_walker::fs::canonical(fs, root.to_path_buf()).await;
	let metadata = fs
		.metadata(&root)
		.await
		.map_err(|err| Error::Invalid(format!("Path not found: {err}")))?;
	let any_file = opts.any_file;
	if metadata.is_file() {
		if !any_file && SupportLang::from_path(&root).is_none() {
			return Ok(Vec::new());
		}
		let display = pi_vfs::file_name(&root)
			.and_then(|name| name.to_str().map(str::to_string))
			.unwrap_or_else(|| root.to_string_lossy().into_owned());
		return Ok(vec![Candidate { path: root, display }]);
	}
	if !metadata.is_dir() {
		return Err(Error::Invalid(format!(
			"Search path must be a file or directory: {}",
			root.display()
		)));
	}

	let walk_fs = pi_walker::Fs::new(fs, &root);
	let walk_opts = walk::Options {
		hidden: opts.hidden,
		gitignore: opts.gitignore,
		skip_git: true,
		skip_node_modules: !opts.node_modules,
		follow_links: opts.follow_links,
		workers: opts.workers,
		cache: true,
		..Default::default()
	};
	let include = opts.include.clone();
	let exclude = opts.exclude.clone();
	let collection = walk::collect(&walk_fs, &root, &walk_opts, true, move |_, entry| {
		let excluded = |path: &[u8]| {
			exclude
				.as_ref()
				.is_some_and(|exclude| exclude.matches(path))
		};
		match entry.file_type {
			FileType::Dir
				if excluded(entry.path)
					|| include
						.as_ref()
						.is_some_and(|include| include.prunes(entry.path)) =>
			{
				Action::SkipDir
			},
			FileType::File
				if include
					.as_ref()
					.is_none_or(|include| include.matches(entry.path))
					&& !excluded(entry.path)
					&& (any_file || SupportLang::from_path(entry.rel_path()).is_some()) =>
			{
				Action::Continue
			},
			_ => Action::Skip,
		}
	})
	.await?;
	Ok(collection
		.iter()
		.map(|entry| Candidate {
			path:    walk_fs.join(&root, entry.path),
			display: entry.path_lossy().into_owned(),
		})
		.collect())
}

/// A source position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Pos {
	/// 0-based line.
	pub line:   usize,
	/// 0-based column in characters.
	pub column: usize,
}

/// A source range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Span {
	/// Start byte offset.
	pub start:     usize,
	/// End byte offset (exclusive).
	pub end:       usize,
	/// Position of `start`.
	pub start_pos: Pos,
	/// Position of `end`.
	pub end_pos:   Pos,
}

impl Span {
	fn of(node: &Node<'_, StrDoc<SupportLang>>) -> Self {
		let range = node.range();
		let start = node.start_pos();
		let end = node.end_pos();
		Self {
			start:     range.start,
			end:       range.end,
			start_pos: Pos { line: start.line(), column: start.column(node) },
			end_pos:   Pos { line: end.line(), column: end.column(node) },
		}
	}
}

/// Text a meta-variable captured.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
	/// Captured source text.
	pub text: String,
	/// Where it was captured.
	pub span: Span,
}

impl Capture {
	fn of(node: &Node<'_, StrDoc<SupportLang>>) -> Self {
		Self { text: node.text().into_owned(), span: Span::of(node) }
	}
}

/// A match's meta-variable bindings.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Captures {
	/// `$NAME` bindings.
	pub single: BTreeMap<String, Capture>,
	/// `$$$NAME` bindings, one capture per node.
	pub multi:  BTreeMap<String, Vec<Capture>>,
}

impl Captures {
	fn of(matched: &NodeMatch<'_, StrDoc<SupportLang>>) -> Self {
		let env = matched.get_env();
		let mut captures = Self::default();
		for variable in env.get_matched_variables() {
			match variable {
				MetaVariable::Capture(name, _) => {
					if let Some(node) = env.get_match(&name) {
						captures.single.insert(name, Capture::of(node));
					}
				},
				MetaVariable::MultiCapture(name) => {
					let nodes = env.get_multiple_matches(&name);
					captures
						.multi
						.insert(name, nodes.iter().map(Capture::of).collect());
				},
				_ => {},
			}
		}
		captures
	}
}

/// One pattern match.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
	/// Matched range.
	pub span:     Span,
	/// Matched source text.
	pub text:     String,
	/// Meta-variable bindings, when [`Query::captures`] asked for them.
	pub captures: Option<Captures>,
}

impl Match {
	fn of(matched: &NodeMatch<'_, StrDoc<SupportLang>>, captures: bool) -> Self {
		Self {
			span:     Span::of(matched.get_node()),
			text:     matched.text().into_owned(),
			captures: captures.then(|| Captures::of(matched)),
		}
	}
}

/// What to search for.
#[derive(Clone)]
pub struct Query<'a> {
	/// Patterns, matched independently (OR).
	pub patterns:   &'a [String],
	/// Language alias every file is parsed as; `None` infers it per file
	/// from the file name.
	pub lang:       Option<&'a str>,
	/// Node kind the patterns are parsed as, for fragments.
	pub selector:   Option<&'a str>,
	/// How closely patterns must match.
	pub strictness: MatchStrictness,
	/// Collect meta-variable bindings.
	pub captures:   bool,
}

/// Diagnostics of a file search or rewrite.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Report {
	/// Files examined (unknown-language files included, files of missing
	/// grammars not).
	pub files_searched:   usize,
	/// Pattern, language, read, and syntax problems, in order.
	pub warnings:         Vec<String>,
	/// Languages skipped because their on-demand grammar is not installed.
	pub missing_grammars: Vec<&'static str>,
}

/// The matches in one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileMatches {
	/// Absolute path the file was read from.
	pub path:     PathBuf,
	/// Display path ([`Candidate::display`]).
	pub display:  String,
	/// Language the file was parsed as.
	pub language: SupportLang,
	/// File contents.
	pub source:   String,
	/// Matches in position order.
	pub matches:  Vec<Match>,
}

/// The per-file results behind a [`Finder`], in candidate order.
type Scans = Pin<Box<dyn Stream<Item = Result<Scanned<Vec<Match>>, Error>> + Send>>;

/// A running file search: yields every file with a match in candidate order.
///
/// Files are read and matched concurrently on tasks of the current runtime;
/// dropping the finder cancels the search.
pub struct Finder {
	tasks:            Scans,
	files_searched:   usize,
	warnings:         Vec<String>,
	missing_grammars: Vec<&'static str>,
	_guard:           HaltGuard,
}

impl Finder {
	/// Diagnostics of the search; complete once the stream has ended.
	#[must_use]
	pub fn report(self) -> Report {
		Report {
			files_searched:   self.files_searched,
			warnings:         self.warnings,
			missing_grammars: self.missing_grammars,
		}
	}
}

impl Stream for Finder {
	type Item = Result<FileMatches, Error>;

	fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
		let this = self.get_mut();
		loop {
			let scanned = match this.tasks.as_mut().poll_next(cx) {
				Poll::Pending => return Poll::Pending,
				Poll::Ready(None) => return Poll::Ready(None),
				Poll::Ready(Some(Err(error))) => return Poll::Ready(Some(Err(error))),
				Poll::Ready(Some(Ok(scanned))) => scanned,
			};
			let Scanned { candidate, warnings, parsed } = scanned;
			this.warnings.extend(warnings);
			if let Some((language, source, matches)) = parsed
				&& !matches.is_empty()
			{
				return Poll::Ready(Some(Ok(FileMatches {
					path: candidate.path,
					display: candidate.display,
					language,
					source,
					matches,
				})));
			}
		}
	}
}

/// Searches `candidates`; the returned [`Finder`] yields every file with a
/// match in candidate order, and dropping it cancels the search. Must be
/// called within a tokio runtime.
#[must_use]
pub fn find(fs: &Fs, candidates: Vec<Candidate>, query: &Query<'_>) -> Finder {
	let captures = query.captures;
	let job = move |ast: &Ast, patterns: &[&Pattern], halt: &HaltFlag| -> Result<_, Error> {
		let mut matches = Vec::new();
		for pattern in patterns {
			check(halt)?;
			for matched in ast.root().find_all((*pattern).clone()) {
				check(halt)?;
				matches.push(Match::of(&matched, captures));
			}
		}
		matches.sort_by_key(|matched| matched.span);
		Ok(matches)
	};
	let halt = HaltFlag::default();
	let guard = halt.guard();
	let prepared = resolve(candidates, query.lang);
	let (compiled, warnings) = compile_query(query, &prepared.languages);
	let files_searched = prepared.files.len();
	let compiled: Arc<[CompiledPattern]> = compiled.into();
	let job = Arc::new(job);
	let fs = fs.clone();
	let (workers, window) = pool();
	let tasks = exec::ordered(
		stream::iter(prepared.files),
		workers,
		window,
		|| (),
		move |(), resolved| {
			let task =
				scan_file(fs.clone(), resolved, Arc::clone(&compiled), Arc::clone(&job), halt.clone());
			async move { ((), task.await) }
		},
	);
	Finder {
		tasks: Box::pin(tasks),
		files_searched,
		warnings,
		missing_grammars: prepared.missing_grammars.into_iter().collect(),
		_guard: guard,
	}
}

/// A window of ordered matches.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Page {
	/// Leading matches skipped.
	pub offset: usize,
	/// Most matches kept after `offset`.
	pub limit:  usize,
}

/// A match of [`find_page`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
	/// Display path of the matching file.
	pub display: String,
	/// The match.
	pub matched: Match,
}

/// One page of matches across files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FindPage {
	/// The page, ordered by file, then position.
	pub hits:               Vec<Hit>,
	/// Matches found before paging.
	pub total_matches:      usize,
	/// Files with at least one match.
	pub files_with_matches: usize,
	/// Matches beyond the page exist.
	pub limit_reached:      bool,
	/// Diagnostics.
	pub report:             Report,
}

/// Searches `candidates`, keeping only the `page` of matches ordered by file
/// (candidate order), then position.
///
/// Files are read and matched concurrently on tasks of the current runtime;
/// dropping the future cancels the search.
///
/// # Errors
/// [`Error::Invalid`] when a search task is aborted.
pub async fn find_page(
	fs: &Fs,
	candidates: Vec<Candidate>,
	query: &Query<'_>,
	page: Page,
) -> Result<FindPage, Error> {
	let mut window = Window::new(page);
	let mut displays = Vec::new();
	let mut files_with_matches = 0;
	let captures = query.captures;
	let job = move |ast: &Ast, patterns: &[&Pattern], halt: &HaltFlag| -> Result<_, Error> {
		let mut local = Window::new(page);
		for pattern in patterns {
			check(halt)?;
			for matched in ast.root().find_all((*pattern).clone()) {
				check(halt)?;
				local.offer(0, &matched, captures);
			}
		}
		Ok(local)
	};
	let report = scan(fs, candidates, query, job, |candidate, _, _, local| {
		let before = window.total;
		window.absorb(displays.len(), local);
		if window.total > before {
			files_with_matches += 1;
		}
		displays.push(candidate.display);
		Ok(ControlFlow::Continue(()))
	})
	.await?;
	let total_matches = window.total;
	let (retained, limit_reached) = window.into_page();
	let hits = retained
		.into_iter()
		.map(|retained| Hit {
			display: displays[retained.key.file].clone(),
			matched: retained.matched,
		})
		.collect();
	Ok(FindPage { hits, total_matches, files_with_matches, limit_reached, report })
}

/// Matches of [`find_source`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceMatches {
	/// The page, in position order.
	pub matches:       Vec<Match>,
	/// Matches found before paging.
	pub total_matches: usize,
	/// Matches beyond the page exist.
	pub limit_reached: bool,
	/// Pattern and syntax problems.
	pub warnings:      Vec<String>,
}

/// Searches `source` as `language`, keeping the `page` of matches in position
/// order; [`Query::lang`] is ignored.
///
/// # Errors
/// [`Error::Invalid`] when the language's grammar cannot load,
/// [`Error::Stopped`].
pub fn find_source(
	source: &str,
	language: SupportLang,
	query: &Query<'_>,
	page: Page,
	cancel: &CancellationToken,
) -> Result<SourceMatches, Error> {
	load_grammar(language)?;
	let mut warnings = Vec::new();
	let mut patterns = Vec::with_capacity(query.patterns.len());
	for pattern in query.patterns {
		check(cancel)?;
		match ops::compile_pattern(pattern, query.selector, &query.strictness, language) {
			Ok(compiled) => {
				warnings.extend(error_node_warning(pattern, &compiled, language));
				patterns.push(compiled);
			},
			Err(err) => warnings.push(format!("{pattern}: {err}")),
		}
	}

	let mut window = Window::new(page);
	if !patterns.is_empty() {
		let ast = language.ast_grep(source);
		if has_parse_error(&ast) {
			warnings.push("parse error (syntax tree contains error nodes)".to_string());
		}
		for pattern in &patterns {
			check(cancel)?;
			for matched in ast.root().find_all(pattern.clone()) {
				check(cancel)?;
				window.offer(0, &matched, query.captures);
			}
		}
	}
	let total_matches = window.total;
	let (retained, limit_reached) = window.into_page();
	Ok(SourceMatches {
		matches: retained
			.into_iter()
			.map(|retained| retained.matched)
			.collect(),
		total_matches,
		limit_reached,
		warnings,
	})
}

/// What [`rewrite`] does with the replacements it computes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
	/// Report the changes only.
	Preview,
	/// Also compute each touched file's new contents.
	Render,
	/// Render, then write every touched file once the whole pass succeeded.
	Write,
}

/// A structural rewrite.
#[derive(Clone)]
pub struct Rewrite<'a> {
	/// `(pattern, replacement template)` rules, applied in order.
	pub rules:               &'a [(String, String)],
	/// Language alias every file is parsed as; `None` infers it per file.
	pub lang:                Option<&'a str>,
	/// Node kind the patterns are parsed as, for fragments.
	pub selector:            Option<&'a str>,
	/// How closely patterns must match.
	pub strictness:          MatchStrictness,
	/// Most replacements across all files.
	pub max_replacements:    usize,
	/// Most files changed.
	pub max_files:           usize,
	/// Fail on the first unparsable file or pattern instead of skipping it
	/// with a warning.
	pub fail_on_parse_error: bool,
	/// Drop a match overlapping an edit already kept in its file instead of
	/// failing the render on the ambiguous overlap.
	pub skip_overlaps:       bool,
	/// What to do with the replacements.
	pub mode:                Mode,
}

/// One replacement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
	/// Replaced range.
	pub span:           Span,
	/// Replaced text.
	pub before:         String,
	/// Replacement text.
	pub after:          String,
	/// Bytes deleted.
	pub deleted_length: usize,
}

/// The replacements in one file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEdit {
	/// Absolute path the file was read from (and is written to).
	pub path:     PathBuf,
	/// Display path ([`Candidate::display`]).
	pub display:  String,
	/// Language the file was parsed as.
	pub language: SupportLang,
	/// Original contents.
	pub source:   String,
	/// Replacements, rule by rule in match order.
	pub changes:  Vec<Change>,
	/// New contents ([`Mode::Render`] and [`Mode::Write`]).
	pub content:  Option<String>,
}

/// Outcome of [`rewrite`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Edited {
	/// Files with replacements, in candidate order.
	pub files:         Vec<FileEdit>,
	/// [`Rewrite::max_replacements`] or [`Rewrite::max_files`] stopped the
	/// pass.
	pub limit_reached: bool,
	/// Diagnostics.
	pub report:        Report,
}

/// Rewrites `candidates` in order.
///
/// Files with syntax errors are skipped (or fail the run); in [`Mode::Write`]
/// nothing is written unless every file rendered. Files are read and matched
/// concurrently on tasks of the current runtime and consumed in candidate
/// order; dropping the future cancels the pass.
///
/// # Errors
/// [`Error::Invalid`] for a parse failure under
/// [`Rewrite::fail_on_parse_error`], an ambiguous overlap, a failed write, or
/// an aborted rewrite task.
pub async fn rewrite(
	fs: &Fs,
	candidates: Vec<Candidate>,
	rewrite: &Rewrite<'_>,
) -> Result<Edited, Error> {
	let halt = HaltFlag::default();
	let _guard = halt.guard();
	let prepared = resolve(candidates, rewrite.lang);
	let mut report = Report {
		files_searched:   prepared.files.len(),
		warnings:         Vec::new(),
		missing_grammars: prepared.missing_grammars.iter().copied().collect(),
	};
	let warnings = &mut report.warnings;

	let mut rules = Vec::with_capacity(rewrite.rules.len());
	for (pattern, template) in rewrite.rules {
		let by_lang =
			compile_for(pattern, &prepared.languages, rewrite.selector, &rewrite.strictness, warnings);
		// A pattern that parses in no discovered language is a genuine pattern
		// error; failing in only some languages of a mixed tree is expected
		// and surfaces per skipped file below.
		if !prepared.languages.is_empty() && by_lang.values().all(Result::is_err) {
			let mut errors = by_lang
				.iter()
				.filter_map(|(key, result)| Some((key, result.as_ref().err()?)));
			if rewrite.fail_on_parse_error {
				let (_, err) = errors
					.next()
					.expect("compile failure recorded for every language");
				return Err(Error::Invalid(format!("{pattern}: {err}")));
			}
			for (key, err) in errors {
				warnings.push(if prepared.languages.len() > 1 {
					format!("{pattern} ({key}): {err}")
				} else {
					format!("{pattern}: {err}")
				});
			}
			continue;
		}
		rules.push(CompiledRule { pattern: pattern.clone(), template: template.clone(), by_lang });
	}
	let rules: Arc<[CompiledRule]> = rules.into();
	// Compile diagnostics precede file diagnostics.
	warnings.sort();

	let mut files = Vec::new();
	let mut total = 0;
	let mut limit_reached = false;
	if !rules.is_empty() {
		let job = Arc::new(RewriteJob {
			fs: fs.clone(),
			rules,
			budget: rewrite.max_replacements,
			skip_overlaps: rewrite.skip_overlaps,
			halt: halt.clone(),
		});
		let (workers, window) = pool();
		let mut tasks = pin!(exec::ordered(
			stream::iter(prepared.files),
			workers,
			window,
			|| (),
			move |(), resolved| {
				let job = Arc::clone(&job);
				async move { ((), job.run(resolved).await) }
			},
		));
		while let Some(rewritten) = tasks.next().await {
			let Rewritten { candidate, warnings: found, step } = rewritten?;
			warnings.extend(found);
			let fail = rewrite.fail_on_parse_error;
			let (language, source, mut staged) = match step {
				Step::Unchanged => continue,
				Step::Skip(issue) => {
					skip(fail, warnings, issue)?;
					continue;
				},
				Step::Staged { language, source, staged } => (language, source, staged),
			};
			// Tasks stage against the whole budget; keep only what is left of it.
			let remaining = rewrite.max_replacements.saturating_sub(total);
			if staged.changes.len() > remaining {
				staged.changes.truncate(remaining);
				staged.edits.truncate(remaining);
				staged.limit_reached = true;
			}
			limit_reached |= staged.limit_reached;
			if staged.changes.is_empty() {
				if staged.limit_reached {
					break;
				}
				continue;
			}
			if files.len() >= rewrite.max_files {
				limit_reached = true;
				break;
			}
			total += staged.changes.len();
			let content = match rewrite.mode {
				Mode::Preview => None,
				Mode::Render | Mode::Write => Some(render(&source, &staged.edits)?),
			};
			files.push(FileEdit {
				path: candidate.path,
				display: candidate.display,
				language,
				source,
				changes: staged.changes,
				content,
			});
			if staged.limit_reached {
				break;
			}
		}
	}

	if rewrite.mode == Mode::Write {
		for file in &files {
			if let Some(content) = &file.content
				&& *content != file.source
			{
				fs.write(&file.path, content).await.map_err(|err| {
					Error::Invalid(format!("Failed to write {}: {err}", file.path.display()))
				})?;
			}
		}
	}
	Ok(Edited { files, limit_reached, report })
}

/// What every task of one [`rewrite`] pass shares.
struct RewriteJob {
	fs:            Fs,
	rules:         Arc<[CompiledRule]>,
	budget:        usize,
	skip_overlaps: bool,
	halt:          HaltFlag,
}

/// A file's rewrite task outcome, in the order [`rewrite`] replays it.
struct Rewritten {
	candidate: Candidate,
	/// Rule diagnostics recorded before `step`.
	warnings:  Vec<String>,
	step:      Step,
}

/// How a file's rewrite task ended.
enum Step {
	/// No rule runs on the file.
	Unchanged,
	/// The file cannot be rewritten; the text is the diagnostic.
	Skip(String),
	/// Replacements staged against the whole replacement budget.
	Staged { language: SupportLang, source: String, staged: Staged },
}

impl RewriteJob {
	/// Reads, parses, and stages one file.
	async fn run(&self, resolved: Resolved) -> Result<Rewritten, Error> {
		check(&self.halt)?;
		let Resolved { candidate, language } = resolved;
		let mut warnings = Vec::new();
		let step = self.step(&candidate, language, &mut warnings).await?;
		Ok(Rewritten { candidate, warnings, step })
	}

	async fn step(
		&self,
		candidate: &Candidate,
		language: Result<SupportLang, String>,
		warnings: &mut Vec<String>,
	) -> Result<Step, Error> {
		let language = match language {
			Ok(language) => language,
			Err(error) => return Ok(Step::Skip(format!("{}: {error}", candidate.display))),
		};
		let key = language.canonical_name();
		let mut runnable = Vec::new();
		for rule in self.rules.iter() {
			check(&self.halt)?;
			match rule.by_lang.get(key) {
				Some(Ok(pattern)) => runnable.push((rule.template.as_str(), pattern)),
				Some(Err(error)) => {
					warnings.push(format!("{}: {}: {error}", rule.pattern, candidate.display));
				},
				None => {},
			}
		}
		if runnable.is_empty() {
			return Ok(Step::Unchanged);
		}
		let source = match self.fs.read_to_string(&candidate.path).await {
			Ok(source) => source,
			Err(err) => return Ok(Step::Skip(format!("{}: {err}", candidate.display))),
		};
		let ast = language.ast_grep(&source);
		if has_parse_error(&ast) {
			let issue =
				format!("{}: parse error (syntax tree contains error nodes)", candidate.display);
			return Ok(Step::Skip(issue));
		}
		let staged = stage(
			&ast,
			&runnable,
			self.budget,
			self.skip_overlaps,
			Some(candidate.display.as_str()),
			&self.halt,
		)?;
		Ok(Step::Staged { language, source, staged })
	}
}

/// Records `issue` as a warning, or fails with it when `fail` is set.
fn skip(fail: bool, warnings: &mut Vec<String>, issue: String) -> Result<(), Error> {
	if fail {
		return Err(Error::Invalid(issue));
	}
	warnings.push(issue);
	Ok(())
}

/// Outcome of [`rewrite_source`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceEdit {
	/// Replacements, rule by rule in match order.
	pub changes:  Vec<Change>,
	/// The rewritten source.
	pub content:  String,
	/// Pattern and syntax problems.
	pub warnings: Vec<String>,
}

/// Rewrites `source` as `language`.
///
/// [`Rewrite::lang`], [`Rewrite::max_files`], and [`Rewrite::mode`] are
/// ignored. A source with syntax errors is left unchanged with a warning (or
/// fails under [`Rewrite::fail_on_parse_error`]).
///
/// # Errors
/// [`Error::Invalid`] when the grammar cannot load, for a parse failure under
/// [`Rewrite::fail_on_parse_error`], or an ambiguous overlap;
/// [`Error::Stopped`].
pub fn rewrite_source(
	source: &str,
	language: SupportLang,
	rewrite: &Rewrite<'_>,
	cancel: &CancellationToken,
) -> Result<SourceEdit, Error> {
	load_grammar(language)?;
	let mut warnings = Vec::new();
	let mut rules = Vec::with_capacity(rewrite.rules.len());
	for (pattern, template) in rewrite.rules {
		check(cancel)?;
		match ops::compile_pattern(pattern, rewrite.selector, &rewrite.strictness, language) {
			Ok(compiled) => {
				warnings.extend(error_node_warning(pattern, &compiled, language));
				rules.push((template.as_str(), compiled));
			},
			Err(err) if rewrite.fail_on_parse_error => {
				return Err(Error::Invalid(format!("{pattern}: {err}")));
			},
			Err(err) => warnings.push(format!("{pattern}: {err}")),
		}
	}
	let unchanged = |warnings: Vec<String>| SourceEdit {
		changes: Vec::new(),
		content: source.to_string(),
		warnings,
	};
	if rules.is_empty() {
		return Ok(unchanged(warnings));
	}
	let ast = language.ast_grep(source);
	if has_parse_error(&ast) {
		let issue = "parse error (syntax tree contains error nodes)".to_string();
		if rewrite.fail_on_parse_error {
			return Err(Error::Invalid(issue));
		}
		warnings.push(issue);
		return Ok(unchanged(warnings));
	}
	let runnable: Vec<_> = rules
		.iter()
		.map(|(template, pattern)| (*template, pattern))
		.collect();
	let staged =
		stage(&ast, &runnable, rewrite.max_replacements, rewrite.skip_overlaps, None, cancel)?;
	let content = render(source, &staged.edits)?;
	Ok(SourceEdit { changes: staged.changes, content, warnings })
}

/// A candidate with its language, or why it has none.
struct Resolved {
	candidate: Candidate,
	language:  Result<SupportLang, String>,
}

/// Candidates with their languages, the distinct languages to compile
/// patterns for (by canonical name), and the languages skipped because their
/// on-demand grammar is not installed.
struct Prepared {
	files:            Vec<Resolved>,
	languages:        BTreeMap<&'static str, SupportLang>,
	missing_grammars: BTreeSet<&'static str>,
}

fn resolve(candidates: Vec<Candidate>, lang: Option<&str>) -> Prepared {
	let mut files = Vec::with_capacity(candidates.len());
	let mut languages = BTreeMap::new();
	let mut missing_grammars = BTreeSet::new();
	let mut installed = HashMap::new();
	for candidate in candidates {
		match ops::resolve_language(lang, &candidate.path) {
			Ok(language) => {
				let available = *installed.entry(language).or_insert_with(|| {
					language
						.wasm_grammar()
						.is_none_or(|grammar| grammar.is_installed())
				});
				if !available {
					missing_grammars.insert(language.canonical_name());
					continue;
				}
				languages
					.entry(language.canonical_name())
					.or_insert(language);
				files.push(Resolved { candidate, language: Ok(language) });
			},
			Err(err) => files.push(Resolved { candidate, language: Err(err.to_string()) }),
		}
	}
	Prepared { files, languages, missing_grammars }
}

/// `pattern` compiled for every language (by canonical name), or why it does
/// not compile there; ERROR-node warnings go to `warnings`.
fn compile_for(
	pattern: &str,
	languages: &BTreeMap<&'static str, SupportLang>,
	selector: Option<&str>,
	strictness: &MatchStrictness,
	warnings: &mut Vec<String>,
) -> BTreeMap<&'static str, Result<Pattern, String>> {
	let mut compiled = BTreeMap::new();
	for (&key, &language) in languages {
		let result = ops::compile_pattern(pattern, selector, strictness, language)
			.inspect(|compiled| warnings.extend(error_node_warning(pattern, compiled, language)))
			.map_err(|err| err.to_string());
		compiled.insert(key, result);
	}
	compiled
}

/// A search pattern compiled for every discovered language.
struct CompiledPattern {
	pattern: String,
	by_lang: BTreeMap<&'static str, Result<Pattern, String>>,
}

/// A rewrite rule compiled for every discovered language. A rule that fails
/// to parse in one language of a mixed tree skips that language's files
/// instead of failing the run.
struct CompiledRule {
	pattern:  String,
	template: String,
	by_lang:  BTreeMap<&'static str, Result<Pattern, String>>,
}

/// Compiles every pattern of `query` for `languages`; the sorted compile
/// warnings come second.
fn compile_query(
	query: &Query<'_>,
	languages: &BTreeMap<&'static str, SupportLang>,
) -> (Vec<CompiledPattern>, Vec<String>) {
	let mut warnings = Vec::new();
	let mut compiled = Vec::with_capacity(query.patterns.len());
	for pattern in query.patterns {
		let by_lang =
			compile_for(pattern, languages, query.selector, &query.strictness, &mut warnings);
		compiled.push(CompiledPattern { pattern: pattern.clone(), by_lang });
	}
	warnings.sort();
	(compiled, warnings)
}

/// What a [`scan`] task found in one file.
struct Scanned<T> {
	candidate: Candidate,
	/// Problems met before the file was parsed or matched.
	warnings:  Vec<String>,
	/// Language, contents, and `job` output; `None` when no pattern runs on the
	/// file.
	parsed:    Option<(SupportLang, String, T)>,
}

/// Reads and parses `resolved`, then runs `job` over the patterns that apply
/// to its language. Per-file problems become warnings.
async fn scan_file<T, J>(
	fs: Fs,
	resolved: Resolved,
	compiled: Arc<[CompiledPattern]>,
	job: Arc<J>,
	halt: HaltFlag,
) -> Result<Scanned<T>, Error>
where
	T: Send + 'static,
	J: Fn(&Ast, &[&Pattern], &HaltFlag) -> Result<T, Error> + Send + Sync + 'static,
{
	check(&halt)?;
	let Resolved { candidate, language } = resolved;
	let mut warnings = Vec::new();
	let language = match language {
		Ok(language) => language,
		Err(error) => {
			for pattern in compiled.iter() {
				warnings.push(format!("{}: {}: {error}", pattern.pattern, candidate.display));
			}
			return Ok(Scanned { candidate, warnings, parsed: None });
		},
	};
	let source = match fs.read_to_string(&candidate.path).await {
		Ok(source) => source,
		Err(err) => {
			for pattern in compiled.iter() {
				warnings.push(format!("{}: {}: {err}", pattern.pattern, candidate.display));
			}
			return Ok(Scanned { candidate, warnings, parsed: None });
		},
	};
	let key = language.canonical_name();
	let mut runnable = Vec::new();
	for pattern in compiled.iter() {
		match pattern.by_lang.get(key) {
			Some(Ok(compiled)) => runnable.push(compiled),
			Some(Err(error)) => {
				warnings.push(format!("{}: {}: {error}", pattern.pattern, candidate.display));
			},
			None => {},
		}
	}
	if runnable.is_empty() {
		return Ok(Scanned { candidate, warnings, parsed: None });
	}
	let ast = language.ast_grep(&source);
	if has_parse_error(&ast) {
		warnings
			.push(format!("{}: parse error (syntax tree contains error nodes)", candidate.display));
	}
	let found = job(&ast, &runnable, &halt)?;
	Ok(Scanned { candidate, warnings, parsed: Some((language, source, found)) })
}

/// Resolves and compiles, then reads and parses every file that has a
/// runnable pattern on the current runtime, runs `job` over its patterns, and
/// hands the outputs to `visit` in candidate order until it breaks. Per-file
/// problems become warnings.
async fn scan<T, J>(
	fs: &Fs,
	candidates: Vec<Candidate>,
	query: &Query<'_>,
	job: J,
	mut visit: impl FnMut(Candidate, SupportLang, String, T) -> Result<ControlFlow<()>, Error>,
) -> Result<Report, Error>
where
	T: Send + 'static,
	J: Fn(&Ast, &[&Pattern], &HaltFlag) -> Result<T, Error> + Send + Sync + 'static,
{
	let halt = HaltFlag::default();
	let _guard = halt.guard();
	let prepared = resolve(candidates, query.lang);
	let (compiled, mut warnings) = compile_query(query, &prepared.languages);

	let files_searched = prepared.files.len();
	let compiled: Arc<[CompiledPattern]> = compiled.into();
	let job = Arc::new(job);
	let (workers, window) = pool();
	let scan_fs = fs.clone();
	let scan_halt = halt.clone();
	let mut tasks = pin!(exec::ordered(
		stream::iter(prepared.files),
		workers,
		window,
		|| (),
		move |(), resolved| {
			let task = scan_file(
				scan_fs.clone(),
				resolved,
				Arc::clone(&compiled),
				Arc::clone(&job),
				scan_halt.clone(),
			);
			async move { ((), task.await) }
		},
	));
	while let Some(scanned) = tasks.next().await {
		let Scanned { candidate, warnings: found, parsed } = scanned?;
		warnings.extend(found);
		let Some((language, source, output)) = parsed else {
			continue;
		};
		if visit(candidate, language, source, output)?.is_break() {
			break;
		}
	}
	Ok(Report {
		files_searched,
		warnings,
		missing_grammars: prepared.missing_grammars.into_iter().collect(),
	})
}

/// Replacements staged for one source.
struct Staged {
	changes:       Vec<Change>,
	edits:         Vec<Edit<String>>,
	/// The replacement budget ran out.
	limit_reached: bool,
}

/// Stages every `(template, pattern)` replacement in `ast`, at most `budget`
/// of them. Byte-identical edits (several rules rewriting one node the same
/// way) are staged once.
fn stage(
	ast: &Ast,
	rules: &[(&str, &Pattern)],
	budget: usize,
	skip_overlaps: bool,
	display: Option<&str>,
	halt: &impl Cancelled,
) -> Result<Staged, Error> {
	let mut staged =
		Staged { changes: Vec::new(), edits: Vec::new(), limit_reached: false };
	let mut seen = HashSet::new();
	// Kept spans by start; disjoint, so only the nearest earlier start can
	// overlap a new span.
	let mut kept = BTreeMap::new();
	'rules: for &(template, pattern) in rules {
		for matched in ast.root().find_all(pattern.clone()) {
			check(halt)?;
			let edit = matched.replace_by(template);
			if !seen.insert((edit.position, edit.deleted_length, edit.inserted_text.clone())) {
				continue;
			}
			let end = edit.position + edit.deleted_length;
			if skip_overlaps
				&& kept
					.range(..end)
					.next_back()
					.is_some_and(|(_, &kept_end)| kept_end > edit.position)
			{
				continue;
			}
			if staged.changes.len() >= budget {
				staged.limit_reached = true;
				break 'rules;
			}
			let after = String::from_utf8(edit.inserted_text.clone()).map_err(|err| {
				Error::Invalid(match display {
					Some(display) => format!("{display}: replacement text is not valid UTF-8: {err}"),
					None => format!("replacement text is not valid UTF-8: {err}"),
				})
			})?;
			kept.insert(edit.position, end);
			staged.changes.push(Change {
				span: Span::of(matched.get_node()),
				before: matched.text().into_owned(),
				after,
				deleted_length: edit.deleted_length,
			});
			staged.edits.push(edit);
		}
	}
	Ok(staged)
}

/// `source` with `edits` applied.
fn render(source: &str, edits: &[Edit<String>]) -> Result<String, Error> {
	ops::apply_edits(source, edits).map_err(|err| Error::Invalid(err.to_string()))
}

fn load_grammar(language: SupportLang) -> Result<(), Error> {
	language
		.grammar()
		.load()
		.map(drop)
		.map_err(|err| Error::Invalid(err.to_string()))
}

/// Whether the tree has syntax errors; recovery can insert missing tokens
/// without producing an ERROR node.
fn has_parse_error(ast: &Ast) -> bool {
	ast.root()
		.dfs()
		.any(|node| node.is_error() || node.is_missing())
}

/// The ast-grep CLI's "Pattern contains an ERROR node" warning for a pattern
/// that compiled although its own parse tree is rooted at an ERROR node. Such
/// a pattern matches loosely or not at all, so it is reported instead of
/// letting an empty result read as absence.
fn error_node_warning(pattern: &str, compiled: &Pattern, language: SupportLang) -> Option<String> {
	compiled.has_error().then(|| {
		// Keep the diagnostic on one bounded display line; the original
		// pattern is still used for matching.
		let mut preview = String::new();
		let mut width = 0;
		for ch in pattern.chars() {
			let escaped = ch.is_control() || (ch.is_whitespace() && ch != ' ');
			let char_width = if escaped {
				ch.escape_unicode().count()
			} else {
				xutf::width_char(ch).max(1)
			};
			if width + char_width > 48 {
				preview.push('…');
				break;
			}
			if escaped {
				preview.extend(ch.escape_unicode());
			} else {
				preview.push(ch);
			}
			width += char_width;
		}
		format!(
			"{preview}: pattern is not valid {} on its own (contains an ERROR node); matches may be \
			 missing or unexpected",
			language.canonical_name()
		)
	})
}

/// Order of a match among all matches: file (candidate order), then span,
/// then discovery order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Key {
	file:     usize,
	start:    usize,
	end:      usize,
	sequence: u64,
}

/// A match kept for the page.
#[derive(Debug, PartialEq, Eq)]
struct Retained {
	key:     Key,
	matched: Match,
}

impl Ord for Retained {
	fn cmp(&self, other: &Self) -> std::cmp::Ordering {
		self.key.cmp(&other.key)
	}
}

impl PartialOrd for Retained {
	fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
		Some(self.cmp(other))
	}
}

/// The best `offset + limit + 1` matches seen so far (one past the page, to
/// tell whether more exist); a match is materialized only when it enters.
struct Window {
	page:     Page,
	capacity: usize,
	heap:     BinaryHeap<Retained>,
	total:    usize,
	sequence: u64,
}

impl Window {
	const fn new(page: Page) -> Self {
		Self {
			page,
			capacity: page.offset.saturating_add(page.limit).saturating_add(1),
			heap: BinaryHeap::new(),
			total: 0,
			sequence: 0,
		}
	}

	/// Counts `matched` in file `file` and keeps it if it ranks in the window.
	fn offer(&mut self, file: usize, matched: &NodeMatch<'_, StrDoc<SupportLang>>, captures: bool) {
		self.total += 1;
		let range = matched.range();
		let key = Key { file, start: range.start, end: range.end, sequence: self.sequence };
		self.sequence += 1;
		if self.admits(&key) {
			self.retain(Retained { key, matched: Match::of(matched, captures) });
		}
	}

	/// Merges the window `other` of one file, ordered as file `file`: every
	/// match `other` retained that ranks here enters, and its count is added.
	fn absorb(&mut self, file: usize, other: Self) {
		self.total += other.total;
		for mut retained in other.heap {
			retained.key.file = file;
			retained.key.sequence += self.sequence;
			if self.admits(&retained.key) {
				self.retain(retained);
			}
		}
		self.sequence += other.sequence;
	}

	/// Whether a match ordered by `key` would enter the window.
	fn admits(&self, key: &Key) -> bool {
		self.heap.len() < self.capacity || self.heap.peek().is_some_and(|worst| *key < worst.key)
	}

	fn retain(&mut self, candidate: Retained) {
		if self.heap.len() < self.capacity {
			self.heap.push(candidate);
			return;
		}
		if let Some(mut worst) = self.heap.peek_mut()
			&& candidate.key < worst.key
		{
			*worst = candidate;
		}
	}

	/// The page in order, and whether matches beyond it exist.
	fn into_page(self) -> (Vec<Retained>, bool) {
		let retained = self.heap.into_sorted_vec();
		let limit_reached = retained.len().saturating_sub(self.page.offset) > self.page.limit;
		let page = retained
			.into_iter()
			.skip(self.page.offset)
			.take(self.page.limit)
			.collect();
		(page, limit_reached)
	}
}
