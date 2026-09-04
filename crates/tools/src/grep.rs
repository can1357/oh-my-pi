//! Regex workspace search with grouped output and pagination.

use std::{
	collections::{HashMap, HashSet},
	fmt::Write as _,
	future,
	sync::Arc,
};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt, Stream, pin_mut, select_biased};
use omp_core::{Str, sf};
use omp_edit::modes::hashline::format::format_hashline_header;
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Diag, DiagKind, DocEffects, Effects, Ev,
	IncomingParams, InterruptWaitError, ParamError, Part, ProjectionAuthorizationError,
	ProjectionSpan, PromptCaps, PromptProjection, Rev, Tool, ToolSpec, ToolTerminal, Unit,
	VisibilityReceipt,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::{
	glob::{Fault as GlobFault, WalkRequest, WalkResult},
	path::tracing_path_metadata,
	read::{
		resolver::Scheme,
		selector::{
			LineRange, ParsedSelector, line_is_in_ranges, parse_selector, parse_uri,
			split_path_and_selector, split_semicolon_targets,
		},
	},
	render::{
		TextProjection,
		paths::{GroupedTreeEventKind, PathTreeInput, build_path_tree, walk_path_tree},
		truncate::DEFAULT_MAX_COLUMN,
	},
};

const DEFAULT_FILE_LIMIT: usize = 20;
const MULTI_FILE_PER_FILE_MATCHES: usize = 20;
const SINGLE_FILE_MATCHES: usize = 200;
const INTERNAL_TOTAL_CAP: u32 = 2_000;
const NATIVE_GREP_MAX_FILE_BYTES: u32 = 4 * 1024 * 1024;
const SEARCH_GREP_TIMEOUT_MS: u32 = 30_000;

/// Model arguments for `grep@1`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// regex pattern
	pub pattern:   Str,
	/// file, directory, glob, internal URL, or "<file>:<lines>" selector to
	/// search; pass several as a semicolon-delimited list ("src; tests").
	/// Omitted -> searches the workspace root (".")
	#[schemars(description = "file, directory, glob, internal URL, or \"<file>:<lines>\" \
	                          selector to search; pass several as a semicolon-delimited list \
	                          (\"src; tests\"). Omitted -> searches the workspace root (\".\")")]
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "String")]
	pub path:      Option<Str>,
	/// case-sensitive search
	#[serde(rename = "case")]
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "bool")]
	pub case:      Option<bool>,
	/// respect gitignore
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "bool")]
	pub gitignore: Option<bool>,
	/// files to skip before collecting results — use to paginate when the prior
	/// call hit the file limit
	#[schemars(description = "files to skip before collecting results — use to paginate when the \
	                          prior call hit the file limit")]
	#[schemars(with = "Option<serde_json::Number>")]
	pub skip:      Option<f64>,
}

/// Kind of target supplied to the workspace search resource.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchRootKind {
	/// A local file, directory, or glob.
	Filesystem,
	/// A member-shaped archive target awaiting archive materialization.
	Archive,
	/// An HTTP(S) target awaiting URL materialization.
	Url,
	/// A resolver-backed internal URI awaiting bounded materialization.
	Internal,
}

/// One selector-peeled search target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchRoot {
	/// Caller spelling, retained for diagnostics.
	pub original: Str,
	/// Target with a trailing line selector removed.
	pub path:     Str,
	/// I/O route the adapter must use.
	pub kind:     SearchRootKind,
	/// Inclusive one-based match ranges, empty for an unrestricted target.
	pub ranges:   Box<[LineRange]>,
}

/// Fully specified request passed to the workspace resource after commitment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchRequest {
	/// Regular expression preserved verbatim.
	pub pattern:               Str,
	/// Semicolon-expanded, selector-peeled roots.
	pub roots:                 Vec<SearchRoot>,
	/// Whether matching ignores case.
	pub ignore_case:           bool,
	/// Whether the expression is searched across lines.
	pub multiline:             bool,
	/// Whether ignore files are respected.
	pub gitignore:             bool,
	/// Dot-prefixed candidates are always included by grep.
	pub hidden:                bool,
	/// Global native safety ceiling.
	pub max_count:             u32,
	/// Native per-file fetch budget for a single-file scope.
	pub single_file_max_count: u32,
	/// Native per-file fetch budget for a multi-file scope.
	pub multi_file_max_count:  u32,
	/// Leading context line count.
	pub context_before:        u32,
	/// Trailing context line count.
	pub context_after:         u32,
	/// Maximum retained columns in one matching line.
	pub max_columns:           u32,
	/// Native wall-clock deadline.
	pub timeout_ms:            u32,
}

/// One context line adjacent to a regex match.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ContextLine {
	/// One-based source line number.
	pub line_number: u32,
	/// Retained line text.
	pub line:        Str,
}

/// One resource match before range filtering, overlap deduplication, and
/// grouping.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchMatch {
	/// Stable canonical identity used only for overlap deduplication.
	pub source_key:     Str,
	/// Workspace-relative model-facing path.
	pub path:           Str,
	/// Index of the request root that produced this match.
	pub root_index:     u64,
	/// One-based source line number.
	pub line_number:    u32,
	/// Retained matching line text.
	pub line:           Str,
	/// Whether the native engine clipped this line at the column cap.
	pub truncated:      bool,
	/// Leading context in source order.
	pub context_before: Vec<ContextLine>,
	/// Trailing context in source order.
	pub context_after:  Vec<ContextLine>,
	/// Whole-file snapshot tag, absent for immutable or oversized sources.
	pub snapshot_tag:   Option<Str>,
}

/// Revision-pinned file bytes retained until final grep visibility is known.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchSnapshot {
	/// Stable canonical identity shared with matching rows.
	pub source_key: Str,
	/// Exact revision identity for the retained bytes.
	pub revision:   Bytes,
	/// Complete bytes used to compute the model-facing snapshot tag.
	pub bytes:      Bytes,
}

/// One staged snapshot identity carried in the durable grep payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SnapshotCandidate {
	/// Stable canonical identity shared with matching rows.
	pub source_key: Str,
	/// Exact revision identity staged by the document authority.
	pub revision:   Bytes,
}

/// One staged snapshot whose centrally receipted lines may be authorized.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SnapshotRecord {
	/// Stable canonical identity shared with matching rows.
	pub source_key: Str,
	/// Exact staged revision identity.
	pub revision:   Bytes,
	/// One-based source lines retained by final output projection.
	pub seen_lines: Vec<usize>,
}

/// Structured resource result returned to the executor.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct SearchResult {
	/// Matches in deterministic traversal order.
	pub matches:            Vec<SearchMatch>,
	/// Revision-pinned editable files awaiting final visibility accounting.
	pub snapshots:          Vec<SearchSnapshot>,
	/// Whether the resolved scope can contain multiple files.
	pub multi_scope:        bool,
	/// Whether the native global match ceiling prevented a complete scan.
	pub limit_reached:      bool,
	/// Count of unreadable large candidates whose names were unavailable.
	pub skipped_oversized:  u32,
	/// Missing targets retained in caller order.
	pub missing_paths:      Vec<Str>,
	/// Archive members that could not be searched as UTF-8 text.
	pub archive_unreadable: Vec<Str>,
	/// Explicit files searched only through the leading 4MB window.
	pub oversized_files:    Vec<Str>,
}

/// One retained match in a grouped payload.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileMatch {
	/// One-based source line number.
	pub line_number:    u32,
	/// Retained matching line text.
	pub line:           Str,
	/// Whether the matching line was column-truncated.
	pub truncated:      bool,
	/// Leading context within the requested line ranges.
	pub context_before: Vec<ContextLine>,
	/// Trailing context within the requested line ranges.
	pub context_after:  Vec<ContextLine>,
}

/// One model-facing file section.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct FileGroup {
	/// Workspace-relative display path.
	pub path:         Str,
	/// Stable canonical identity used to record final line visibility.
	pub source_key:   Str,
	/// Whole-file hashline snapshot tag when editable.
	pub snapshot_tag: Option<Str>,
	/// Retained matches in source order.
	pub matches:      Vec<FileMatch>,
}

/// Durable successful `grep@1` result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Current page of grouped file matches.
	pub files:                   Vec<FileGroup>,
	/// Revision-pinned candidates staged without authorizing source lines.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub snapshots:               Vec<SnapshotCandidate>,
	/// Number of distinct matching files observed before pagination.
	pub total_files:             u64,
	/// Whether the total is a lower bound because native grep stopped early.
	pub total_files_lower_bound: bool,
	/// Whether the resolved scope can contain multiple files.
	pub multi_scope:             bool,
	/// Effective file offset for this page.
	pub skip:                    u64,
	/// Whether more matching files remain after this page.
	pub file_limit_reached:      bool,
	/// Whether any hot file was clipped at its diversity cap.
	pub per_file_limit_reached:  bool,
}

/// Ephemeral progress from `grep@1`; grep has no durable updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Durable typed `grep@1` failure.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// The expression was empty or whitespace-only.
	#[error("Pattern must not be empty")]
	EmptyPattern,
	/// The requested file offset was negative or not finite.
	#[error("Skip must be a non-negative number")]
	InvalidSkip,
	/// A path selector was invalid for grep.
	#[error("{message}")]
	InvalidSelector {
		/// Exact model-facing diagnostic.
		message: Str,
	},
	/// A URI target uses a backend that has not landed yet.
	#[error("{message}")]
	UnsupportedTarget {
		/// Exact model-facing diagnostic.
		message: Str,
	},
	/// Neither the Rust regex engine nor PCRE2 accepted the expression.
	#[error("Invalid regex: {message}")]
	InvalidRegex {
		/// Parser detail without the `Invalid regex:` prefix.
		message: Str,
	},
	/// The fixed 30-second native deadline elapsed.
	#[error("Grep timed out after 30s; narrow paths or pattern, or scope with `glob` first")]
	TimedOut,
	/// Every submitted path was missing.
	#[error(
		"Path not found: {}; list each target in the semicolon-delimited `path`",
		join_strs(.paths)
	)]
	AllPathsMissing {
		/// Missing paths in caller order.
		paths: Vec<Str>,
	},
	/// The workspace owner rejected or failed the request.
	#[error("{message}")]
	Workspace {
		/// Stable resource-owned explanation.
		message: Str,
	},
	/// The resource itself observed cancellation without an invocation
	/// interrupt.
	#[error("workspace search was cancelled: {reason}")]
	Cancelled {
		/// Stable resource-owned cancellation reason.
		reason: Str,
	},
}

/// Zero-box workspace traversal boundary shared by `grep@1` and `glob@1`.
pub trait WorkspaceSearch: Send + Sync + 'static {
	/// Resolves the authored root list before search.
	///
	/// Environment owners use `unsplit` to preserve an existing literal path
	/// containing semicolons. The default keeps the schema-level split for
	/// host-free implementations.
	fn prepare_roots(
		&self,
		roots: Vec<SearchRoot>,
		_unsplit: Option<SearchRoot>,
	) -> impl Future<Output = Result<Vec<SearchRoot>, Fault>> + Send + '_ {
		future::ready(Ok(roots))
	}

	/// Execute a native regex search and return revision-pinned snapshot
	/// candidates without authorizing any source lines.
	fn search(
		&self,
		request: SearchRequest,
	) -> impl Future<Output = Result<SearchResult, Fault>> + Send + '_;

	/// Stages exact snapshot bytes without authorizing any source line.
	fn stage_snapshots(&self, snapshots: Vec<SearchSnapshot>) -> Result<(), Fault>;
	/// Authorizes only source lines named by the central dispatcher's final
	/// visibility receipt.
	fn record_snapshots(&self, records: Vec<SnapshotRecord>) -> Result<(), Fault>;
	/// Match paths in deterministic workspace traversal order.
	fn glob(
		&self,
		request: WalkRequest,
		cancellation: CancellationToken,
	) -> impl Future<Output = Result<WalkResult, GlobFault>> + Send + '_;
	/// Attempts a resolver-backed glob such as `ssh://`; `None` keeps ordinary
	/// workspace dispatch or reports an unsupported scheme.
	fn glob_resource(
		&self,
		_request: WalkRequest,
		_cancellation: CancellationToken,
	) -> impl Future<Output = Option<Result<WalkResult, GlobFault>>> + Send + '_ {
		future::ready(None)
	}
}

/// Generic `grep@1` executor over an environment-owned workspace resource.
pub struct Grep<W> {
	workspace:      W,
	context_before: u32,
	context_after:  u32,
	spec:           ToolSpec,
}

/// Returns the host-free `grep@1` specification.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("grep"),
		rev:             Rev { family: Str::new(""), n: 1 },
		description:     sf!(
			"Searches files/internal URLs: Rust regex, PCRE2 fallback.\n\n<instruction>\n- `path`: \
			 known files, directories, globs, internal URLs; roots `;`-separated.\n- Broad searches \
			 may time out → narrow scope or use `glob` first.\n- One-file line selector: \
			 `src/foo.ts:50-100`; never selects search root.\n- Literal `\\n` or `\\\\n` enables \
			 cross-line patterns.\n</instruction>\n\n<critical>\n- MUST use instead of shell \
			 `grep`/`rg`.\n</critical>",
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: Some(DocEffects { read: true, write_globs: Arc::default() }),
			exec:      None,
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("grep.rs"),
		)
		.into(),
	}
}

/// Construct `grep@1` over `workspace`.
pub fn tool<W: WorkspaceSearch>(workspace: W, context_before: u32, context_after: u32) -> Grep<W> {
	Grep { workspace, context_before, context_after, spec: spec() }
}

impl<W: WorkspaceSearch> Tool for Grep<W> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		let span = tracing::debug_span!(
			"grep_execution",
			pattern_len = tracing::field::Empty,
			multiline = tracing::field::Empty,
			path = tracing::field::Empty,
		);
		stream! {
			let arguments = match params.whole::<Params>().await {
				Ok(arguments) => arguments,
				Err(error) => {
					yield param_event(error);
					return;
				},
			};
			match params.interruptable().committed().await {
				Ok(_) => {},
				Err(error) => {
					yield commit_event(error);
					return;
				},
			}

			if arguments.pattern.trim().is_empty() {
				yield done(Err(Fault::EmptyPattern));
				return;
			}
			span.record("pattern_len", arguments.pattern.len());
			span.record(
				"multiline",
				arguments.pattern.contains('\n') || arguments.pattern.contains("\\n"),
			);
			span.record(
				"path",
				tracing::field::display(tracing_path_metadata(
					arguments.path.as_deref().unwrap_or("."),
				)),
			);
			let skip = match normalize_skip(arguments.skip) {
				Ok(skip) => skip,
				Err(fault) => {
					yield done(Err(fault));
					return;
				},
			};
			let (roots, unsplit) = match parse_roots(arguments.path.as_deref()) {
				Ok(roots) => roots,
				Err(fault) => {
					yield done(Err(fault));
					return;
				},
			};
			let operation = async {
				let roots = self.workspace.prepare_roots(roots, unsplit).await?;
				let request =
					build_request(arguments, &roots, self.context_before, self.context_after);
				let result = self.workspace.search(request).await?;
				prepare_payload(result, &roots, skip, &self.workspace)
			}.instrument(span.clone()).fuse();
			let interruption = params.next_interrupt().fuse();
			pin_mut!(operation, interruption);
			select_biased! {
				result = operation => {
					match result {
						Ok((payload, diags)) => {
							for diag in diags {
								yield Ev::Diag(diag);
							}
							yield done(Ok(payload));
						},
						Err(fault) => yield done(Err(fault)),
					}
				},
				interrupt = interruption => {
					yield interrupt_event(interrupt, "grep traversal owner disappeared");
				},
			}
		}
	}

	fn prompt(&self, view: Result<&Self::Payload, &Self::Fault>, caps: &PromptCaps) -> Vec<Part> {
		grep_projection(view, caps).parts
	}

	fn projection(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		caps: &PromptCaps,
	) -> PromptProjection {
		grep_projection(view, caps)
	}

	fn authorize_visibility(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		receipt: &VisibilityReceipt,
	) -> Result<(), ProjectionAuthorizationError> {
		let Ok(payload) = view else {
			return Ok(());
		};
		let mut visible = HashMap::<Str, Vec<usize>>::new();
		for line in &receipt.lines {
			visible
				.entry(line.source_key.clone())
				.or_default()
				.push(line.line);
		}
		let records = payload
			.snapshots
			.iter()
			.filter_map(|snapshot| {
				let mut seen_lines = visible.remove(&snapshot.source_key)?;
				seen_lines.sort_unstable();
				seen_lines.dedup();
				Some(SnapshotRecord {
					source_key: snapshot.source_key.clone(),
					revision: snapshot.revision.clone(),
					seen_lines,
				})
			})
			.collect();
		self
			.workspace
			.record_snapshots(records)
			.map_err(ProjectionAuthorizationError::new)
	}
}

fn grep_projection(view: Result<&Payload, &Fault>, caps: &PromptCaps) -> PromptProjection {
	let Some(mut projection) = TextProjection::new(*caps) else {
		return PromptProjection::default();
	};
	let mut visibility = Vec::new();
	match view {
		Ok(payload) => {
			let (text, source_rows) = render_payload(payload);
			for fragment in text.split_inclusive('\n') {
				projection.push(fragment);
			}
			visibility.extend(source_rows.into_iter().map(|row| ProjectionSpan {
				part:       0,
				start_byte: row.start_byte,
				end_byte:   row.end_byte,
				source_key: row.source_key,
				line:       row.line_number,
			}));
		},
		Err(fault) => {
			projection.push(&fault.to_string());
		},
	}
	PromptProjection { parts: projection.finish(), visibility }
}
fn build_request(
	arguments: Params,
	roots: &[SearchRoot],
	context_before: u32,
	context_after: u32,
) -> SearchRequest {
	let (single_file_max_count, multi_file_max_count, max_count) = fetch_budgets(roots);
	SearchRequest {
		multiline: arguments.pattern.contains('\n') || arguments.pattern.contains("\\n"),
		pattern: arguments.pattern,
		roots: roots.to_vec(),
		ignore_case: !arguments.case.unwrap_or(true),
		gitignore: arguments.gitignore.unwrap_or(true),
		hidden: true,
		max_count,
		single_file_max_count,
		multi_file_max_count,
		context_before,
		context_after,
		max_columns: DEFAULT_MAX_COLUMN,
		timeout_ms: SEARCH_GREP_TIMEOUT_MS,
	}
}

fn normalize_skip(skip: Option<f64>) -> Result<u64, Fault> {
	let skip = skip.unwrap_or(0.0);
	if !skip.is_finite() || skip < 0.0 {
		return Err(Fault::InvalidSkip);
	}
	Ok(skip.floor() as u64)
}

fn parse_roots(path: Option<&str>) -> Result<(Vec<SearchRoot>, Option<SearchRoot>), Fault> {
	let entries = path.map(split_semicolon_targets).unwrap_or_default();
	let entries = if entries.is_empty() {
		vec![sf!(".")]
	} else {
		entries
	};
	let roots = entries
		.into_iter()
		.map(parse_root)
		.collect::<Result<Vec<_>, _>>()?;
	let unsplit = path
		.filter(|path| path.contains(';'))
		.and_then(|path| parse_root(Str::new(path.trim_end())).ok());
	Ok((roots, unsplit))
}

fn parse_root(original: Str) -> Result<SearchRoot, Fault> {
	let split = split_path_and_selector(&original);
	let mut ranges = Box::<[LineRange]>::default();
	if let Some(selector) = split.selector {
		let parsed = parse_selector(Some(selector)).map_err(|error| Fault::InvalidSelector {
			message: sf!(
				"path entry \"{original}\" has an invalid selector \":{selector}\" — {error}"
			),
		})?;
		match parsed {
			ParsedSelector::Lines { ranges: selected, .. } => ranges = selected,
			ParsedSelector::Raw | ParsedSelector::Conflicts | ParsedSelector::None => {},
			ParsedSelector::Image => {
				return Err(Fault::InvalidSelector {
					message: sf!(
						"path entry \"{original}\" — the display-only \":img\" selector is not valid \
						 for search"
					),
				});
			},
		}
	}
	let clean = split.path;
	if !ranges.is_empty() && has_glob_chars(clean) {
		return Err(Fault::InvalidSelector {
			message: sf!("Line-range selector requires a single file, not a glob: {original}"),
		});
	}
	let kind = match parse_uri(clean).map_err(|error| Fault::InvalidSelector {
		message: sf!("path entry \"{original}\" has an invalid URL — {error}"),
	})? {
		Some(uri) if uri.scheme == Scheme::Http => SearchRootKind::Url,
		Some(uri) if uri.scheme == Scheme::File => SearchRootKind::Filesystem,
		Some(_) => SearchRootKind::Internal,
		None if looks_like_archive_member(clean) => SearchRootKind::Archive,
		None => SearchRootKind::Filesystem,
	};
	Ok(SearchRoot { original: Str::new(original.as_str()), path: Str::new(clean), kind, ranges })
}

fn has_glob_chars(path: &str) -> bool {
	path
		.bytes()
		.any(|byte| matches!(byte, b'*' | b'?' | b'[' | b']' | b'{' | b'}'))
}

fn looks_like_archive_member(path: &str) -> bool {
	crate::read::archive::parse_archive_path_candidates(path)
		.into_iter()
		.any(|candidate| !candidate.sub_path.is_empty())
}

fn fetch_budgets(roots: &[SearchRoot]) -> (u32, u32, u32) {
	let single_baseline = u32::try_from(SINGLE_FILE_MATCHES + 1).unwrap_or(u32::MAX);
	let multi_baseline = u32::try_from(MULTI_FILE_PER_FILE_MATCHES + 1).unwrap_or(u32::MAX);
	let has_ranges = roots.iter().any(|root| !root.ranges.is_empty());
	let range_cap = |per_file_keep: u32| {
		let cap = roots
			.iter()
			.flat_map(|root| root.ranges.iter())
			.map(|range| {
				range.end_line.unwrap_or_else(|| {
					range
						.start_line
						.saturating_sub(1)
						.saturating_add(u64::from(per_file_keep))
				})
			})
			.max()
			.unwrap_or(0)
			.min(u64::from(NATIVE_GREP_MAX_FILE_BYTES));
		u32::try_from(cap).unwrap_or(NATIVE_GREP_MAX_FILE_BYTES)
	};
	let single = single_baseline.max(range_cap(single_baseline));
	let multi = multi_baseline.max(range_cap(multi_baseline));
	let max_count = if has_ranges {
		INTERNAL_TOTAL_CAP
			.div_ceil(multi_baseline)
			.saturating_mul(multi)
	} else {
		INTERNAL_TOTAL_CAP
	};
	(single, multi, max_count)
}

fn make_payload(
	result: SearchResult,
	roots: &[SearchRoot],
	requested_skip: u64,
) -> (Payload, SmallVec<Diag, 6>) {
	let per_file_cap = if result.multi_scope {
		MULTI_FILE_PER_FILE_MATCHES
	} else {
		SINGLE_FILE_MATCHES
	};
	let mut groups = Vec::<FileGroup>::new();
	let mut group_by_path = HashMap::<Str, usize>::new();
	let mut seen = HashSet::<(Str, u32)>::new();
	let mut per_file_limit_reached = false;

	for matched in result.matches {
		let ranges = usize::try_from(matched.root_index)
			.ok()
			.and_then(|index| roots.get(index))
			.map(|root| root.ranges.as_ref())
			.unwrap_or_default();
		if !ranges.is_empty() && !line_is_in_ranges(u64::from(matched.line_number), ranges) {
			continue;
		}
		if !seen.insert((matched.source_key.clone(), matched.line_number)) {
			continue;
		}
		let group_index = if let Some(index) = group_by_path.get(&matched.path).copied() {
			index
		} else {
			let index = groups.len();
			group_by_path.insert(matched.path.clone(), index);
			groups.push(FileGroup {
				path:         matched.path.clone(),
				source_key:   matched.source_key.clone(),
				snapshot_tag: matched.snapshot_tag.clone(),
				matches:      Vec::new(),
			});
			index
		};
		let group = &mut groups[group_index];
		if group.matches.len() >= per_file_cap {
			per_file_limit_reached = true;
			continue;
		}
		let filter_context = |context: Vec<ContextLine>| {
			if ranges.is_empty() {
				context
			} else {
				context
					.into_iter()
					.filter(|line| line_is_in_ranges(u64::from(line.line_number), ranges))
					.collect()
			}
		};
		group.matches.push(FileMatch {
			line_number:    matched.line_number,
			line:           matched.line,
			truncated:      matched.truncated,
			context_before: filter_context(matched.context_before),
			context_after:  filter_context(matched.context_after),
		});
	}

	let total_files = u64::try_from(groups.len()).unwrap_or(u64::MAX);
	let skip = if result.multi_scope {
		requested_skip
	} else {
		0
	};
	let start = usize::try_from(skip.min(total_files))
		.unwrap_or(usize::MAX)
		.min(groups.len());
	let end = start.saturating_add(DEFAULT_FILE_LIMIT).min(groups.len());
	let file_limit_reached = result.multi_scope && end < groups.len();
	let files = groups.drain(start..end).collect();
	let mut diags = SmallVec::new();
	if !result.missing_paths.is_empty() {
		diags.push(Diag::warn(DiagKind::MissingPaths, Str::new(join_strs(&result.missing_paths))));
	}
	if !result.archive_unreadable.is_empty() {
		diags.push(Diag::warn(
			DiagKind::Skipped,
			sf!("Archive entries not searched: {}", join_strs(&result.archive_unreadable)),
		));
	}
	if !result.oversized_files.is_empty() {
		diags.push(Diag::warn(
			DiagKind::PartialScan,
			sf!("Only the first 4 MB was searched: {}", join_strs(&result.oversized_files)),
		));
	} else if result.skipped_oversized > 0 {
		diags.push(Diag::warn(
			DiagKind::Skipped,
			sf!("{} unreadable large files were not searched", result.skipped_oversized),
		));
	}
	(
		Payload {
			files,
			snapshots: Vec::new(),
			total_files,
			total_files_lower_bound: result.limit_reached,
			multi_scope: result.multi_scope,
			skip,
			file_limit_reached,
			per_file_limit_reached,
		},
		diags,
	)
}

fn prepare_payload<W: WorkspaceSearch>(
	mut result: SearchResult,
	roots: &[SearchRoot],
	requested_skip: u64,
	workspace: &W,
) -> Result<(Payload, SmallVec<Diag, 6>), Fault> {
	let snapshots = std::mem::take(&mut result.snapshots);
	let (mut payload, mut diags) = make_payload(result, roots, requested_skip);
	let visible_sources = payload
		.files
		.iter()
		.map(|file| file.source_key.clone())
		.collect::<HashSet<_>>();
	let snapshots = snapshots
		.into_iter()
		.filter(|snapshot| visible_sources.contains(&snapshot.source_key))
		.collect::<Vec<_>>();
	payload.snapshots = snapshots
		.iter()
		.map(|snapshot| SnapshotCandidate {
			source_key: snapshot.source_key.clone(),
			revision:   snapshot.revision.clone(),
		})
		.collect();
	workspace.stage_snapshots(snapshots)?;
	if payload.files.is_empty()
		&& payload.multi_scope
		&& payload.skip > 0
		&& payload.total_files > 0
		&& payload.skip >= payload.total_files
	{
		let suffix = if payload.total_files_lower_bound {
			"+"
		} else {
			""
		};
		diags.push(Diag::warn(
			DiagKind::RangeOutOfBounds,
			sf!("skip={} is past the end of {}{} files", payload.skip, payload.total_files, suffix),
		));
	} else if payload.file_limit_reached {
		let next_skip = payload
			.skip
			.saturating_add(u64::try_from(payload.files.len()).unwrap_or(u64::MAX));
		diags.push(
			Diag::info(
				DiagKind::Pagination,
				sf!(
					"files {}-{} of {}",
					payload.skip.saturating_add(1),
					next_skip,
					payload.total_files
				),
			)
			.continuation(sf!("skip={next_skip}"))
			.omitted(payload.total_files.saturating_sub(next_skip), Unit::Files),
		);
	}
	Ok((payload, diags))
}

#[derive(Debug)]
struct RenderedSourceLine {
	source_key:  Str,
	line_number: usize,
	start_byte:  usize,
	end_byte:    usize,
}

fn render_payload(payload: &Payload) -> (String, Vec<RenderedSourceLine>) {
	let mut output = String::new();
	let mut source_rows = Vec::new();
	if payload.files.is_empty() {
		if payload.total_files == 0 {
			output.push_str("No matches found");
		}
		return (output, source_rows);
	}

	if payload.multi_scope {
		render_grouped_files(&mut output, &mut source_rows, &payload.files);
	} else {
		for (index, file) in payload.files.iter().enumerate() {
			if index > 0 {
				output.push_str("\n\n");
			}
			if let Some(tag) = &file.snapshot_tag {
				let _ = writeln!(output, "{}", format_hashline_header(&file.path, tag));
			}
			render_file_matches(&mut output, &mut source_rows, file);
		}
	}
	(output, source_rows)
}

fn render_grouped_files(
	output: &mut String,
	source_rows: &mut Vec<RenderedSourceLine>,
	files: &[FileGroup],
) {
	let tree = build_path_tree(
		files
			.iter()
			.map(|file| PathTreeInput::with_key(&file.path, false, &file.path)),
	);
	let by_path: HashMap<&str, &FileGroup> = files
		.iter()
		.map(|file| (file.path.as_ref(), file))
		.collect();
	let mut emitted = false;
	for event in walk_path_tree(&tree) {
		if emitted {
			if event.starts_group() {
				output.push_str("\n\n");
			} else {
				output.push('\n');
			}
		}
		emitted = true;
		for _ in 0..event.heading_level() {
			output.push('#');
		}
		output.push(' ');
		output.push_str(event.name);
		match event.kind {
			GroupedTreeEventKind::Directory => output.push('/'),
			GroupedTreeEventKind::File => {
				let file = by_path[event.key];
				if let Some(tag) = &file.snapshot_tag {
					output.push('#');
					output.push_str(tag);
				}
				output.push('\n');
				render_file_matches(output, source_rows, file);
			},
		}
	}
}

fn render_file_matches(
	output: &mut String,
	source_rows: &mut Vec<RenderedSourceLine>,
	file: &FileGroup,
) {
	let mut last_emitted = None;
	for matched in &file.matches {
		for context in &matched.context_before {
			push_match_line(
				output,
				source_rows,
				&file.source_key,
				&mut last_emitted,
				context.line_number,
				&context.line,
				false,
			);
		}
		push_match_line(
			output,
			source_rows,
			&file.source_key,
			&mut last_emitted,
			matched.line_number,
			&matched.line,
			true,
		);
		for context in &matched.context_after {
			push_match_line(
				output,
				source_rows,
				&file.source_key,
				&mut last_emitted,
				context.line_number,
				&context.line,
				false,
			);
		}
	}
	if output.ends_with('\n') {
		output.pop();
	}
}

fn push_match_line(
	output: &mut String,
	source_rows: &mut Vec<RenderedSourceLine>,
	source_key: &Str,
	last: &mut Option<u32>,
	number: u32,
	line: &str,
	matched: bool,
) {
	if last.is_some_and(|previous| number > previous.saturating_add(1)) {
		output.push_str("...\n");
	}
	let marker = if matched { '*' } else { ' ' };
	let start_byte = output.len();
	let _ = writeln!(output, "{marker}{number}:{line}");
	if let Ok(line_number) = usize::try_from(number) {
		source_rows.push(RenderedSourceLine {
			source_key: source_key.clone(),
			line_number,
			start_byte,
			end_byte: output.len().saturating_sub(1),
		});
	}
	*last = Some(number);
}

fn join_strs(values: &[Str]) -> String {
	values
		.iter()
		.map(Str::as_str)
		.collect::<Vec<_>>()
		.join(", ")
}

fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	let useless = result
		.as_ref()
		.is_ok_and(|payload| payload.files.is_empty() && payload.total_files == 0);
	Ev::Done(ToolTerminal::Done { result, useless })
}

fn param_event(error: ParamError) -> Ev<Update, Payload, Fault> {
	match error {
		ParamError::Args(issue) if issue.kind == ArgIssueKind::Aborted => {
			Ev::Aborted(Abort::InputDropped)
		},
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn interrupt_event(
	interrupt: Result<omp_tool::Interrupt, InterruptWaitError>,
	closed_reason: &'static str,
) -> Ev<Update, Payload, Fault> {
	match interrupt {
		Ok(interrupt) => Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
		Err(InterruptWaitError::Closed) => {
			Ev::Aborted(Abort::Interrupted { reason: Str::new(closed_reason) })
		},
		Err(InterruptWaitError::Protocol(message)) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"pattern":"TODO","path":"src"}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn search_match(path: impl Into<Str>, root_index: u64) -> SearchMatch {
		let path = path.into();
		SearchMatch {
			source_key: path.clone(),
			path,
			root_index,
			line_number: 1,
			line: sf!("needle"),
			truncated: false,
			context_before: Vec::new(),
			context_after: Vec::new(),
			snapshot_tag: None,
		}
	}

	#[test]
	fn semicolon_roots_preserve_order_and_parse_per_file_ranges() {
		let (roots, unsplit) = parse_roots(Some(" src ; tests/grep.rs:5-8,12-13 ")).unwrap();
		assert_eq!(roots.len(), 2);
		assert_eq!(roots[0].path, "src");
		assert!(roots[0].ranges.is_empty());
		assert_eq!(roots[1].path, "tests/grep.rs");
		assert_eq!(roots[1].ranges.as_ref(), [
			LineRange { start_line: 5, end_line: Some(8) },
			LineRange { start_line: 12, end_line: Some(13) },
		]);
		let unsplit = unsplit.expect("literal-preserving candidate");
		assert_eq!(unsplit.original, " src ; tests/grep.rs:5-8,12-13");
		assert_eq!(unsplit.path, " src ; tests/grep.rs");
		assert_eq!(unsplit.ranges.as_ref(), [
			LineRange { start_line: 5, end_line: Some(8) },
			LineRange { start_line: 12, end_line: Some(13) },
		]);
	}

	#[test]
	fn internal_roots_keep_ranges_and_ignore_display_only_modes() {
		let (roots, _) = parse_roots(Some(
			"artifact://7:raw:2-4; skill://prompt:conflicts; bundle.7z:docs/readme.txt",
		))
		.unwrap();
		assert_eq!(roots[0].kind, SearchRootKind::Internal);
		assert_eq!(roots[0].path, "artifact://7");
		assert_eq!(roots[0].ranges.as_ref(), [LineRange { start_line: 2, end_line: Some(4) }]);
		assert_eq!(roots[1].kind, SearchRootKind::Internal);
		assert_eq!(roots[1].path, "skill://prompt");
		assert!(roots[1].ranges.is_empty());
		assert_eq!(roots[2].kind, SearchRootKind::Archive);
	}

	#[test]
	fn selector_shaped_literal_spelling_is_retained_for_workspace_precedence() {
		let root = parse_root(sf!("test:1-2")).unwrap();
		assert_eq!(root.original, "test:1-2");
		assert_eq!(root.path, "test");
		assert_eq!(root.ranges.as_ref(), [LineRange { start_line: 1, end_line: Some(2) }]);
	}

	#[test]
	fn request_applies_case_gitignore_and_cross_line_rules() {
		let (roots, _) = parse_roots(Some("src; tests")).unwrap();
		let request = build_request(
			Params {
				pattern:   sf!(r"alpha\nbeta"),
				path:      None,
				case:      Some(false),
				gitignore: Some(false),
				skip:      None,
			},
			&roots,
			1,
			3,
		);
		assert!(request.ignore_case);
		assert!(request.multiline);
		assert!(!request.gitignore);
		assert_eq!(request.roots, roots);
		assert_eq!(request.context_before, 1);
		assert_eq!(request.context_after, 3);

		let default_case = build_request(
			Params {
				pattern:   sf!("alpha"),
				path:      None,
				case:      None,
				gitignore: None,
				skip:      None,
			},
			&parse_roots(None).unwrap().0,
			0,
			0,
		);
		assert!(!default_case.ignore_case);
		assert!(default_case.gitignore);
		assert!(!default_case.multiline);
	}

	#[test]
	fn skip_paginates_matching_files_not_match_rows() {
		let (roots, _) = parse_roots(Some(".")).unwrap();
		let matches: Vec<_> = (0..22)
			.map(|index| search_match(format!("src/file-{index:02}.rs"), 0))
			.collect();
		let (first, _) = make_payload(
			SearchResult { matches: matches.clone(), multi_scope: true, ..SearchResult::default() },
			&roots,
			0,
		);
		assert_eq!(first.files.len(), DEFAULT_FILE_LIMIT);
		assert_eq!(first.files[0].path, "src/file-00.rs");
		assert!(first.file_limit_reached);

		let (second, _) = make_payload(
			SearchResult { matches, multi_scope: true, ..SearchResult::default() },
			&roots,
			20,
		);
		assert_eq!(second.total_files, 22);
		assert_eq!(second.skip, 20);
		assert_eq!(
			second
				.files
				.iter()
				.map(|file| file.path.as_str())
				.collect::<Vec<_>>(),
			["src/file-20.rs", "src/file-21.rs"]
		);
		assert!(!second.file_limit_reached);
	}
}
