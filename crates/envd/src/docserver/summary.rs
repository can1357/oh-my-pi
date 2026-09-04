//! Cached structural summaries over immutable document snapshots.

use std::{collections::VecDeque, path::Path, str, sync::Arc};

use omp_ast::{
	SupportLang,
	summary::{SummaryResult as AstSummary, SummarySettings as AstSettings, summarize_source},
};
use omp_core::{Str, sf};
use parking_lot::{Mutex, MutexGuard};
use tokio::task;
use tokio_util::sync::CancellationToken;

use crate::docserver::types::{DocumentKind, DocumentPresence, DocumentSnapshot};

/// Maximum exact-byte snapshot size accepted by the structural summarizer.
pub const MAX_SUMMARY_BYTES: usize = 2 * 1024 * 1024;
/// Maximum number of original source lines accepted by the structural
/// summarizer.
pub const MAX_SUMMARY_LINES: u32 = 80_000;
/// Maximum number of content-and-settings results retained by a service.
pub const SUMMARY_CACHE_CAPACITY: usize = 48;

/// Rendering convention for kept source lines.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, PartialEq)]
pub enum SummaryRenderMode {
	/// Prefix kept lines with `LINE:` and merged brace lines with `START-END:`.
	#[default]
	Hashline,
	/// Prefix kept lines with `LINE|` and merged brace lines with `START-END|`.
	Numbered,
	/// Render kept lines without coordinate prefixes.
	Plain,
}

/// Eligibility, parser, and rendering settings for one summary request.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct SummaryOptions {
	/// Minimum total source lines required before parsing.
	pub min_total_lines:    u32,
	/// Minimum node size eligible for body or literal elision.
	pub min_body_lines:     u32,
	/// Minimum block-comment size eligible for elision.
	pub min_comment_lines:  u32,
	/// Target visible-line count for breadth-first unfolding; zero disables it.
	pub unfold_until_lines: u32,
	/// Hard visible-line ceiling for breadth-first unfolding.
	pub unfold_limit_lines: u32,
	/// Whether Markdown-family and plain-text paths may be parsed.
	pub enable_prose:       bool,
	/// Optional language alias which takes precedence over path inference.
	pub language:           Option<Str>,
	/// Kept-line rendering convention.
	pub render_mode:        SummaryRenderMode,
}

impl Default for SummaryOptions {
	fn default() -> Self {
		Self {
			min_total_lines:    100,
			min_body_lines:     4,
			min_comment_lines:  6,
			unfold_until_lines: 50,
			unfold_limit_lines: 100,
			enable_prose:       false,
			language:           None,
			render_mode:        SummaryRenderMode::Hashline,
		}
	}
}

/// A 1-based inclusive source-line range.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SummaryLineRange {
	/// First original source line in the range.
	pub start_line: u32,
	/// Last original source line in the range.
	pub end_line:   u32,
}

/// One ordered kept or elided region using original 1-based inclusive lines.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SummarySegment {
	/// Verbatim source lines retained in the summary.
	Kept {
		/// First original source line in the segment.
		start_line: u32,
		/// Last original source line in the segment.
		end_line:   u32,
		/// Verbatim retained text, without coordinate prefixes.
		text:       String,
	},
	/// Source lines hidden by a structural fold.
	Elided {
		/// First original source line hidden by the fold.
		start_line: u32,
		/// Last original source line hidden by the fold.
		end_line:   u32,
	},
}

impl SummarySegment {
	/// Returns the first original source line in this segment.
	pub const fn start_line(&self) -> u32 {
		match self {
			Self::Kept { start_line, .. } | Self::Elided { start_line, .. } => *start_line,
		}
	}

	/// Returns the last original source line in this segment.
	pub const fn end_line(&self) -> u32 {
		match self {
			Self::Kept { end_line, .. } | Self::Elided { end_line, .. } => *end_line,
		}
	}
}

/// Rendered views and recovery coordinates for a structural summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedSummary {
	/// Model-facing text in the requested coordinate convention.
	pub text:          String,
	/// Human-facing text without line prefixes.
	pub display_text:  String,
	/// Source ranges whose contents were omitted, in original coordinates.
	pub elided_ranges: Vec<SummaryLineRange>,
	/// Number of original source lines omitted from the rendered text.
	pub elided_lines:  u32,
}

/// A successfully parsed summary containing at least one structural elision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentSummary {
	/// Canonical parser language name.
	pub language:    Str,
	/// Total original source lines.
	pub total_lines: u32,
	/// Ordered structural regions in original source coordinates.
	pub segments:    Vec<SummarySegment>,
	/// Requested rendering of the structural regions.
	pub rendered:    RenderedSummary,
}

/// Why a caller must fall back to an ordinary snapshot read.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SummaryUnavailableReason {
	/// The immutable snapshot is classified as binary.
	Binary,
	/// The document is currently absent.
	MissingDocument,
	/// The exact snapshot exceeds [`MAX_SUMMARY_BYTES`].
	TooLarge,
	/// The source exceeds [`MAX_SUMMARY_LINES`].
	TooManyLines,
	/// The source has fewer lines than the requested minimum.
	BelowMinimumLines,
	/// A prose path was not explicitly opted into summarization.
	ProseDisabled,
	/// No supported language could be inferred from the override or path.
	UnsupportedLanguage,
	/// The source is empty.
	Empty,
	/// The selected parser reported a syntax error.
	SyntaxError,
	/// Parsing succeeded but found no honest structural elision.
	NoElisions,
	/// The parser could not be initialized or its blocking task failed.
	ParserFailure,
}

/// Cached metadata for an unavailable summary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SummaryFallback {
	/// Explicit reason the structural result is unavailable.
	pub reason:      SummaryUnavailableReason,
	/// Total original lines when counting was applicable.
	pub total_lines: u32,
	/// Canonical inferred language, when one was selected.
	pub language:    Option<Str>,
	/// Whether tree-sitter completed a syntax-valid parse.
	pub parsed:      bool,
}

/// Result of an asynchronous summary request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SummaryOutcome {
	/// A parsed and structurally elided result, shared directly from the cache.
	Available(Arc<DocumentSummary>),
	/// An explicit, cached instruction to use an ordinary snapshot read.
	Fallback(Arc<SummaryFallback>),
	/// The request was cancelled before its result could be installed.
	Cancelled,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct CacheKey {
	content_hash: [u8; 32],
	missing:      bool,
	binary:       bool,
	language:     Option<Str>,
	prose_path:   bool,
	options:      SummaryOptions,
}

#[derive(Clone, Debug)]
enum CachedSummary {
	Available(Arc<DocumentSummary>),
	Fallback(Arc<SummaryFallback>),
}

impl CachedSummary {
	fn outcome(&self) -> SummaryOutcome {
		match self {
			Self::Available(summary) => SummaryOutcome::Available(Arc::clone(summary)),
			Self::Fallback(fallback) => SummaryOutcome::Fallback(Arc::clone(fallback)),
		}
	}
}

#[derive(Debug, Default)]
struct SummaryCache {
	entries: VecDeque<(CacheKey, CachedSummary)>,
}

impl SummaryCache {
	fn get(&mut self, key: &CacheKey) -> Option<CachedSummary> {
		let index = self
			.entries
			.iter()
			.position(|(candidate, _)| candidate == key)?;
		let entry = self
			.entries
			.remove(index)
			.expect("located cache entry exists");
		let value = entry.1.clone();
		self.entries.push_back(entry);
		Some(value)
	}

	fn insert(&mut self, key: CacheKey, value: CachedSummary) {
		if let Some(index) = self
			.entries
			.iter()
			.position(|(candidate, _)| candidate == &key)
		{
			self.entries.remove(index);
		}
		while self.entries.len() >= SUMMARY_CACHE_CAPACITY {
			self.entries.pop_front();
		}
		self.entries.push_back((key, value));
	}
}

/// Session-independent, bounded cache and asynchronous AST summary executor.
#[derive(Clone, Debug, Default)]
pub struct SummaryService {
	cache: Arc<Mutex<SummaryCache>>,
}

impl SummaryService {
	/// Creates an empty 48-entry summary service.
	pub fn new() -> Self {
		Self::default()
	}

	/// Summarizes one immutable snapshot without consulting the filesystem.
	///
	/// `path` is used only for prose eligibility and language inference. Parsing
	/// and line counting run on Tokio's blocking pool, and cancellation prevents
	/// a detached blocking result from entering the cache.
	pub async fn summarize(
		&self,
		snapshot: Arc<DocumentSnapshot>,
		path: &Path,
		options: SummaryOptions,
		cancellation: &CancellationToken,
	) -> SummaryOutcome {
		if cancellation.is_cancelled() {
			return SummaryOutcome::Cancelled;
		}

		let prose_path = is_prose_summary_path(path);
		let inferred_language = infer_language(options.language.as_deref(), path);
		let key = CacheKey {
			content_hash: *snapshot.head().revision().content_hash(),
			missing: snapshot.head().presence() == DocumentPresence::Missing,
			binary: matches!(snapshot.head().kind(), DocumentKind::Binary),
			language: inferred_language.clone(),
			prose_path,
			options: options.clone(),
		};
		let cached = self.cache().get(&key);
		if let Some(value) = cached {
			return value.outcome();
		}

		let immediate = if snapshot.head().presence() == DocumentPresence::Missing {
			Some(fallback(
				SummaryUnavailableReason::MissingDocument,
				0,
				inferred_language.clone(),
				false,
			))
		} else if matches!(snapshot.head().kind(), DocumentKind::Binary) {
			Some(fallback(SummaryUnavailableReason::Binary, 0, inferred_language.clone(), false))
		} else if snapshot.content().len() > MAX_SUMMARY_BYTES {
			Some(fallback(SummaryUnavailableReason::TooLarge, 0, inferred_language.clone(), false))
		} else if prose_path && !options.enable_prose {
			Some(fallback(
				SummaryUnavailableReason::ProseDisabled,
				0,
				inferred_language.clone(),
				false,
			))
		} else if inferred_language.is_none() {
			Some(fallback(SummaryUnavailableReason::UnsupportedLanguage, 0, None, false))
		} else {
			None
		};
		if let Some(value) = immediate {
			self.cache().insert(key, value.clone());
			return value.outcome();
		}

		let snapshot_for_parse = Arc::clone(&snapshot);
		let language = inferred_language.expect("unsupported language returned above");
		let parse_options = options;
		let task = task::spawn_blocking(move || {
			parse_snapshot(&snapshot_for_parse, &language, &parse_options)
		});
		let value = tokio::select! {
			biased;
			() = cancellation.cancelled() => return SummaryOutcome::Cancelled,
			joined = task => match joined {
				Ok(value) => value,
				Err(_) => fallback(SummaryUnavailableReason::ParserFailure, 0, key.language.clone(), false),
			},
		};
		if cancellation.is_cancelled() {
			return SummaryOutcome::Cancelled;
		}
		self.cache().insert(key, value.clone());
		value.outcome()
	}

	fn cache(&self) -> MutexGuard<'_, SummaryCache> {
		self.cache.lock()
	}
}

fn infer_language(language: Option<&str>, path: &Path) -> Option<Str> {
	if let Some(language) = language
		.map(str::trim)
		.filter(|language| !language.is_empty())
	{
		return SupportLang::from_alias(language).map(|lang| sf!(lang.canonical_name()));
	}
	SupportLang::from_path(path).map(|lang| sf!(lang.canonical_name()))
}

fn is_prose_summary_path(path: &Path) -> bool {
	path
		.extension()
		.and_then(|extension| extension.to_str())
		.is_some_and(|extension| {
			matches!(
				extension.to_ascii_lowercase().as_str(),
				"md" | "markdown" | "mdx" | "mdc" | "mkd" | "mdown" | "txt"
			)
		})
}

fn count_lines(source: &str) -> u32 {
	if source.is_empty() {
		0
	} else {
		source
			.as_bytes()
			.iter()
			.fold(1_u32, |count, byte| count + u32::from(*byte == b'\n'))
	}
}

fn fallback(
	reason: SummaryUnavailableReason,
	total_lines: u32,
	language: Option<Str>,
	parsed: bool,
) -> CachedSummary {
	CachedSummary::Fallback(Arc::new(SummaryFallback { reason, total_lines, language, parsed }))
}

fn parse_snapshot(
	snapshot: &DocumentSnapshot,
	language: &Str,
	options: &SummaryOptions,
) -> CachedSummary {
	let Ok(source) = str::from_utf8(snapshot.content()) else {
		return fallback(SummaryUnavailableReason::Binary, 0, Some(language.clone()), false);
	};
	let total_lines = count_lines(source);
	if total_lines == 0 {
		return fallback(SummaryUnavailableReason::Empty, 0, Some(language.clone()), false);
	}
	if total_lines > MAX_SUMMARY_LINES {
		return fallback(
			SummaryUnavailableReason::TooManyLines,
			total_lines,
			Some(language.clone()),
			false,
		);
	}
	if total_lines < options.min_total_lines {
		return fallback(
			SummaryUnavailableReason::BelowMinimumLines,
			total_lines,
			Some(language.clone()),
			false,
		);
	}

	let Ok(ast) = summarize_source(source, AstSettings {
		lang:               Some(language.as_str()),
		path:               None,
		min_body_lines:     Some(options.min_body_lines),
		min_comment_lines:  Some(options.min_comment_lines),
		unfold_until_lines: Some(options.unfold_until_lines),
		unfold_limit_lines: Some(options.unfold_limit_lines),
	}) else {
		return fallback(
			SummaryUnavailableReason::ParserFailure,
			total_lines,
			Some(language.clone()),
			false,
		);
	};
	if !ast.parsed {
		return fallback(
			SummaryUnavailableReason::SyntaxError,
			total_lines,
			Some(language.clone()),
			false,
		);
	}
	if !ast.elided {
		return fallback(
			SummaryUnavailableReason::NoElisions,
			total_lines,
			Some(language.clone()),
			true,
		);
	}
	build_available(ast, options.render_mode)
}

fn build_available(ast: AstSummary, mode: SummaryRenderMode) -> CachedSummary {
	let language = Str::new(
		ast.language
			.expect("parsed summary identifies its language"),
	);
	let segments = ast
		.segments
		.into_iter()
		.map(|segment| match segment.kind.as_str() {
			"elided" => {
				SummarySegment::Elided { start_line: segment.start_line, end_line: segment.end_line }
			},
			"kept" => SummarySegment::Kept {
				start_line: segment.start_line,
				end_line:   segment.end_line,
				text:       segment.text.expect("kept AST segment contains source text"),
			},
			_ => unreachable!("omp-ast emits only kept and elided summary segments"),
		})
		.collect::<Vec<_>>();
	let rendered = render_segments(&segments, mode);
	CachedSummary::Available(Arc::new(DocumentSummary {
		language,
		total_lines: ast.total_lines,
		segments,
		rendered,
	}))
}

#[derive(Debug)]
enum RenderUnit<'a> {
	Line { line: u32, text: &'a str },
	Elided(SummaryLineRange),
	Merged { start_line: u32, end_line: u32, head_text: &'a str, tail_text: &'a str },
}

fn render_segments(segments: &[SummarySegment], mode: SummaryRenderMode) -> RenderedSummary {
	let mut raw = Vec::new();
	for segment in segments {
		match segment {
			SummarySegment::Elided { start_line, end_line } => {
				raw.push(RenderUnit::Elided(SummaryLineRange {
					start_line: *start_line,
					end_line:   *end_line,
				}));
			},
			SummarySegment::Kept { start_line, text, .. } if !text.is_empty() => {
				for (offset, line) in text.split('\n').enumerate() {
					raw.push(RenderUnit::Line { line: start_line + offset as u32, text: line });
				}
			},
			SummarySegment::Kept { .. } => {},
		}
	}

	let mut units = Vec::with_capacity(raw.len());
	let mut index = 0;
	while index < raw.len() {
		if let RenderUnit::Elided(_) = &raw[index]
			&& let Some(RenderUnit::Line { line: start_line, text: head_text }) = units.last()
			&& let Some(RenderUnit::Line { line: end_line, text: tail_text }) = raw.get(index + 1)
			&& can_merge_brace_pair(head_text, tail_text)
		{
			let start_line = *start_line;
			let end_line = *end_line;
			let head_text = *head_text;
			let tail_text = *tail_text;
			units.pop();
			units.push(RenderUnit::Merged { start_line, end_line, head_text, tail_text });
			index += 2;
			continue;
		}
		units.push(match &raw[index] {
			RenderUnit::Line { line, text } => RenderUnit::Line { line: *line, text },
			RenderUnit::Elided(range) => RenderUnit::Elided(*range),
			RenderUnit::Merged { .. } => unreachable!("raw units are never merged"),
		});
		index += 1;
	}

	let mut model = Vec::with_capacity(units.len());
	let mut display = Vec::with_capacity(units.len());
	let mut elided_ranges = Vec::new();
	let mut elided_lines = 0_u32;
	for unit in units {
		match unit {
			RenderUnit::Elided(range) => {
				model.push("…".to_owned());
				display.push("…".to_owned());
				elided_lines = elided_lines.saturating_add(
					range
						.end_line
						.saturating_sub(range.start_line)
						.saturating_add(1),
				);
				elided_ranges.push(range);
			},
			RenderUnit::Merged { start_line, end_line, head_text, tail_text } => {
				let merged = format!("{} … {}", head_text.trim_end(), tail_text.trim());
				model.push(match mode {
					SummaryRenderMode::Hashline => format!("{start_line}-{end_line}:{merged}"),
					SummaryRenderMode::Numbered => format!("{start_line}-{end_line}|{merged}"),
					SummaryRenderMode::Plain => merged.clone(),
				});
				display.push(merged);
				elided_ranges.push(SummaryLineRange { start_line, end_line });
				elided_lines =
					elided_lines.saturating_add(end_line.saturating_sub(start_line).saturating_sub(1));
			},
			RenderUnit::Line { line, text } => {
				model.push(match mode {
					SummaryRenderMode::Hashline => format!("{line}:{text}"),
					SummaryRenderMode::Numbered => format!("{line}|{text}"),
					SummaryRenderMode::Plain => text.to_owned(),
				});
				display.push(text.to_owned());
			},
		}
	}
	RenderedSummary {
		text: model.join("\n"),
		display_text: display.join("\n"),
		elided_ranges,
		elided_lines,
	}
}

fn can_merge_brace_pair(head_line: &str, tail_line: &str) -> bool {
	let opener = head_line.trim_end().chars().next_back();
	let closer = match opener {
		Some('{') => '}',
		Some('(') => ')',
		Some('[') => ']',
		_ => return false,
	};
	let tail = tail_line.trim();
	let mut chars = tail.chars();
	if chars.next() != Some(closer) {
		return false;
	}
	chars.all(|character| matches!(character, ';' | ',' | ')' | ']' | '}'))
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;

	use super::*;
	use crate::docserver::types::{DocumentHead, DocumentId, Revision};

	fn snapshot(sequence: u64, source: &str, kind: DocumentKind) -> Arc<DocumentSnapshot> {
		let content = Bytes::copy_from_slice(source.as_bytes());
		let revision = Revision::for_content(sequence, &content);
		let head = DocumentHead::new(
			DocumentId::from_bytes([7; 16]),
			revision,
			DocumentPresence::Present,
			kind,
			content.len() as u64,
		)
		.expect("valid head");
		Arc::new(DocumentSnapshot::new(head, content).expect("valid snapshot"))
	}

	fn foldable_source(name: &str) -> String {
		format!(
			"function {name}() {{\n  const one = 1;\n  const two = 2;\n  const three = 3;\n  return \
			 one + two + three;\n}}\n"
		)
	}

	fn test_options() -> SummaryOptions {
		SummaryOptions {
			min_total_lines: 0,
			unfold_until_lines: 0,
			unfold_limit_lines: 0,
			..SummaryOptions::default()
		}
	}

	#[tokio::test]
	async fn fallback_eligibility_is_explicit_and_cached() {
		let service = SummaryService::new();
		let cancellation = CancellationToken::new();
		let binary = snapshot(1, "bytes", DocumentKind::Binary);
		let first = service
			.summarize(
				binary.clone(),
				Path::new("asset.bin"),
				SummaryOptions::default(),
				&cancellation,
			)
			.await;
		let second = service
			.summarize(binary, Path::new("asset.bin"), SummaryOptions::default(), &cancellation)
			.await;
		let (SummaryOutcome::Fallback(first), SummaryOutcome::Fallback(second)) = (first, second)
		else {
			panic!("binary input must fall back");
		};
		assert_eq!(first.reason, SummaryUnavailableReason::Binary);
		assert!(Arc::ptr_eq(&first, &second));

		let prose = snapshot(2, "# title\n\nparagraph\n", DocumentKind::Text(None));
		let SummaryOutcome::Fallback(prose) = service
			.summarize(prose, Path::new("notes.mdx"), SummaryOptions::default(), &cancellation)
			.await
		else {
			panic!("prose must require opt-in");
		};
		assert_eq!(prose.reason, SummaryUnavailableReason::ProseDisabled);

		let unsupported = snapshot(3, "ordinary text", DocumentKind::Text(None));
		let SummaryOutcome::Fallback(unsupported) = service
			.summarize(unsupported, Path::new("unknown.zzz"), test_options(), &cancellation)
			.await
		else {
			panic!("unknown language must fall back");
		};
		assert_eq!(unsupported.reason, SummaryUnavailableReason::UnsupportedLanguage);

		let syntax_error = snapshot(4, "function broken( {", DocumentKind::Text(None));
		let SummaryOutcome::Fallback(syntax_error) = service
			.summarize(syntax_error, Path::new("broken.ts"), test_options(), &cancellation)
			.await
		else {
			panic!("syntax errors must fall back");
		};
		assert_eq!(syntax_error.reason, SummaryUnavailableReason::SyntaxError);

		let too_large_source = "x".repeat(MAX_SUMMARY_BYTES + 1);
		let too_large = snapshot(5, &too_large_source, DocumentKind::Text(None));
		let SummaryOutcome::Fallback(too_large) = service
			.summarize(too_large, Path::new("large.ts"), test_options(), &cancellation)
			.await
		else {
			panic!("oversized input must fall back");
		};
		assert_eq!(too_large.reason, SummaryUnavailableReason::TooLarge);

		let too_long_source = "\n".repeat(MAX_SUMMARY_LINES as usize);
		let too_long = snapshot(6, &too_long_source, DocumentKind::Text(None));
		let SummaryOutcome::Fallback(too_long) = service
			.summarize(too_long, Path::new("long.ts"), test_options(), &cancellation)
			.await
		else {
			panic!("overlong input must fall back");
		};
		assert_eq!(too_long.reason, SummaryUnavailableReason::TooManyLines);
	}

	#[tokio::test]
	async fn cache_identity_tracks_content_and_settings() {
		let service = SummaryService::new();
		let cancellation = CancellationToken::new();
		let source = foldable_source("cached");
		let current = snapshot(1, &source, DocumentKind::Text(None));
		let first = service
			.summarize(current.clone(), Path::new("cached.ts"), test_options(), &cancellation)
			.await;
		let second = service
			.summarize(current, Path::new("cached.ts"), test_options(), &cancellation)
			.await;
		let (SummaryOutcome::Available(first), SummaryOutcome::Available(second)) = (first, second)
		else {
			panic!("fixture must summarize");
		};
		assert!(Arc::ptr_eq(&first, &second));

		let changed = snapshot(2, &foldable_source("changed"), DocumentKind::Text(None));
		let SummaryOutcome::Available(changed) = service
			.summarize(changed, Path::new("cached.ts"), test_options(), &cancellation)
			.await
		else {
			panic!("changed fixture must summarize");
		};
		assert!(!Arc::ptr_eq(&first, &changed));

		let settings = SummaryOptions { min_body_lines: 5, ..test_options() };
		let original = snapshot(3, &source, DocumentKind::Text(None));
		let SummaryOutcome::Available(changed_settings) = service
			.summarize(original, Path::new("cached.ts"), settings, &cancellation)
			.await
		else {
			panic!("settings fixture must summarize");
		};
		assert!(!Arc::ptr_eq(&first, &changed_settings));
	}

	#[tokio::test]
	async fn bfs_settings_reveal_original_nested_lines() {
		let body = (0..30)
			.map(|index| format!("\t\"key{index}\": {index}"))
			.collect::<Vec<_>>()
			.join(",\n");
		let nested = "\t\"deps\": {\n\t\t\"a\": 1,\n\t\t\"b\": 2,\n\t\t\"c\": 3,\n\t\t\"d\": 4\n\t}";
		let source = format!("{{\n{body},\n{nested}\n}}\n");
		let service = SummaryService::new();
		let cancellation = CancellationToken::new();
		let folded = service
			.summarize(
				snapshot(1, &source, DocumentKind::Text(None)),
				Path::new("nested.json"),
				test_options(),
				&cancellation,
			)
			.await;
		let unfolded = service
			.summarize(
				snapshot(1, &source, DocumentKind::Text(None)),
				Path::new("nested.json"),
				SummaryOptions { unfold_until_lines: 20, unfold_limit_lines: 100, ..test_options() },
				&cancellation,
			)
			.await;
		let (SummaryOutcome::Available(folded), SummaryOutcome::Available(unfolded)) =
			(folded, unfolded)
		else {
			panic!("nested fixtures must summarize");
		};
		assert!(unfolded.rendered.elided_lines < folded.rendered.elided_lines);
		let kept = unfolded
			.segments
			.iter()
			.filter_map(|segment| match segment {
				SummarySegment::Kept { text, .. } => Some(text.as_str()),
				SummarySegment::Elided { .. } => None,
			})
			.collect::<Vec<_>>()
			.join("\n");
		assert!(kept.contains("\"key0\""));
		assert!(kept.contains("\"key29\""));
		assert!(kept.contains("\"deps\""));
		assert!(!kept.contains("\"a\": 1"));
	}

	#[test]
	fn brace_pairs_merge_but_non_brace_boundaries_do_not() {
		let brace = vec![
			SummarySegment::Kept {
				start_line: 1,
				end_line:   1,
				text:       "function run() {".into(),
			},
			SummarySegment::Elided { start_line: 2, end_line: 5 },
			SummarySegment::Kept { start_line: 6, end_line: 6, text: "});".into() },
		];
		let rendered = render_segments(&brace, SummaryRenderMode::Hashline);
		assert_eq!(rendered.text, "1-6:function run() { … });");
		assert_eq!(rendered.elided_ranges, vec![SummaryLineRange { start_line: 1, end_line: 6 }]);
		assert_eq!(rendered.elided_lines, 4);

		let non_brace = vec![
			SummarySegment::Kept { start_line: 10, end_line: 10, text: "def run".into() },
			SummarySegment::Elided { start_line: 11, end_line: 12 },
			SummarySegment::Kept { start_line: 13, end_line: 13, text: "end".into() },
		];
		let rendered = render_segments(&non_brace, SummaryRenderMode::Numbered);
		assert_eq!(rendered.text, "10|def run\n…\n13|end");
		assert_eq!(rendered.elided_ranges, vec![SummaryLineRange { start_line: 11, end_line: 12 }]);
	}

	#[test]
	fn rendering_keeps_original_line_numbers() {
		let segments = vec![
			SummarySegment::Kept { start_line: 7, end_line: 8, text: "alpha\nbeta".into() },
			SummarySegment::Elided { start_line: 9, end_line: 20 },
			SummarySegment::Kept { start_line: 21, end_line: 21, text: "omega".into() },
		];
		let rendered = render_segments(&segments, SummaryRenderMode::Hashline);
		assert_eq!(rendered.text, "7:alpha\n8:beta\n…\n21:omega");
		assert_eq!(rendered.elided_ranges, vec![SummaryLineRange { start_line: 9, end_line: 20 }]);
		assert_eq!(rendered.elided_lines, 12);
	}

	#[tokio::test]
	async fn cancellation_wins_before_cache_lookup_or_parse() {
		let service = SummaryService::new();
		let cancellation = CancellationToken::new();
		cancellation.cancel();
		let outcome = service
			.summarize(
				snapshot(1, &foldable_source("cancelled"), DocumentKind::Text(None)),
				Path::new("cancelled.ts"),
				SummaryOptions::default(),
				&cancellation,
			)
			.await;
		assert_eq!(outcome, SummaryOutcome::Cancelled);
	}
}
