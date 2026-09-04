//! Bounded multi-target structural search with stable pagination and
//! diagnostics.

use std::{
	collections::{HashMap, HashSet},
	fs,
	future::Future,
	path::PathBuf,
	sync::Arc,
	time::{Duration, Instant},
};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt as _, Stream, pin_mut, select_biased};
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Diag, DiagKind, DocEffects,
	Effects, Ev, IncomingParams, InterruptWaitError, LiftedCall, ParamError, Part, PromptCaps,
	RecordedCall, Rev, Tool, ToolSpec, ToolTerminal, Unit,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const DEFAULT_PAGE_LIMIT: usize = 50;
const MAX_PAGE_LIMIT: usize = 200;
const MAX_SKIP: usize = 100_000;
const MAX_FILES: usize = 20_000;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 20;
const SEARCH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(rename_all = "lowercase")]
/// Ast-grep syntax matching strictness.
pub enum SearchMode {
	/// Match concrete syntax, including unnamed tokens.
	Cst,
	/// Balanced ast-grep matching; the default.
	Smart,
	/// Match named AST nodes.
	Ast,
	/// Ignore more syntactic trivia than AST mode.
	Relaxed,
	/// Match structural signatures.
	Signature,
	/// Match template syntax.
	Template,
}

impl From<SearchMode> for omp_ast::ops::AstMatchStrictness {
	fn from(value: SearchMode) -> Self {
		match value {
			SearchMode::Cst => Self::Cst,
			SearchMode::Smart => Self::Smart,
			SearchMode::Ast => Self::Ast,
			SearchMode::Relaxed => Self::Relaxed,
			SearchMode::Signature => Self::Signature,
			SearchMode::Template => Self::Template,
		}
	}
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
/// Agent-supplied structural search arguments.
pub struct Params {
	/// Ast-grep structural pattern, including any metavariables to bind.
	pub pat:        Str,
	#[serde(default)]
	/// Optional language alias. Omit to infer a language independently per file.
	pub lang:       Option<Str>,
	#[serde(default)]
	/// Semicolon-separated workspace-relative files, directories, or globs;
	/// defaults to `.`.
	pub path:       Option<Str>,
	#[serde(default)]
	/// Optional walk-relative glob intersected with every path target.
	pub glob:       Option<Str>,
	#[serde(default)]
	/// Optional grammar-node selector for a contextual ast-grep pattern.
	pub selector:   Option<Str>,
	#[serde(default)]
	/// Pattern matching strictness; defaults to `smart`.
	pub strictness: Option<SearchMode>,
	#[serde(default)]
	#[schemars(with = "Option<serde_json::Number>")]
	/// Matches to skip in globally sorted order; defaults to zero.
	pub skip:       Option<f64>,
	#[serde(default)]
	#[schemars(with = "Option<serde_json::Number>")]
	/// Page size from 1 through 200; defaults to 50.
	pub limit:      Option<f64>,
}

/// `ast_grep@1` argument shape, retained only to lift historical calls.
#[derive(Deserialize)]
struct ParamsV1 {
	pat:     Str,
	#[serde(default)]
	path:    Option<Str>,
	#[serde(default)]
	cursor:  usize,
	#[serde(default)]
	limit:   Option<usize>,
	#[serde(default)]
	i:       Option<Str>,
	#[serde(default)]
	notrunc: Option<bool>,
}

/// `ast_grep@2` argument shape, retained only to lift historical calls.
#[derive(Deserialize)]
struct ParamsV2 {
	pat:     Str,
	#[serde(default)]
	path:    Option<Str>,
	#[serde(default)]
	skip:    usize,
	#[serde(default)]
	i:       Option<Str>,
	#[serde(default)]
	notrunc: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// One structural source match returned to the agent.
pub struct Match {
	/// Workspace-relative path of the matched source file.
	pub path:       Str,
	/// One-based source line at which the matched node starts.
	pub line:       usize,
	/// One-based source column at which the matched node starts.
	pub column:     usize,
	/// One-based source line at which the matched node ends.
	pub end_line:   usize,
	/// One-based source column at which the matched node ends.
	pub end_column: usize,
	/// Exact source text covered by the matched AST node.
	pub text:       Str,
	/// Stable, display-ready metavariable bindings (`$A=value, $B=value`).
	pub bindings:   Str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Non-fatal reason a targeted file could not be searched.
pub struct Advisory {
	/// Workspace-relative path of the skipped target.
	pub path:    Str,
	/// Language-resolution, file-size, or file-read explanation.
	pub message: Str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Paginated structural-search result returned to the agent.
pub struct Payload {
	/// Current page of matches in stable path and source order.
	pub matches:            Vec<Match>,
	/// Capped per-file failures that did not prevent other files from searching.
	pub advisories:         Vec<Advisory>,
	/// Advisory count before capping.
	pub advisories_total:   usize,
	/// Capped syntax-tree and pattern-compilation diagnostics.
	pub parse_errors:       Vec<Str>,
	/// Parse-error count before capping.
	pub parse_errors_total: usize,
	/// Number of matches across all targets before pagination.
	pub total:              usize,
	/// Number of distinct files with at least one match before pagination.
	pub files_with_matches: usize,
	/// Files selected for the search, including files reported by an advisory.
	pub files_searched:     usize,
	/// Effective globally sorted match offset.
	pub skip:               usize,
	/// Effective page size.
	pub limit:              usize,
	/// Whether matches remain after this page.
	pub limit_reached:      bool,
	/// `skip` value that resumes at the next page, or `None` on the final page.
	pub next_skip:          Option<usize>,
}

/// `ast_grep@1` payload shape, retained only to lift historical verdicts.
#[derive(Deserialize)]
struct PayloadV1 {
	matches:     Vec<Match>,
	advisories:  Vec<Advisory>,
	total:       usize,
	next_cursor: Option<usize>,
}

/// `ast_grep@2` payload shape, retained only to lift historical verdicts.
#[derive(Deserialize)]
struct PayloadV2 {
	matches:        Vec<Match>,
	advisories:     Vec<Advisory>,
	total:          usize,
	next_skip:      Option<usize>,
	#[serde(default)]
	files_searched: usize,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Empty update type because structural search emits only a terminal result.
pub enum Update {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
/// Terminal argument, target-discovery, or search failure.
pub struct Fault {
	message: Str,
}

/// Inputs resolved by the environment authority after argument commitment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolveRequest {
	/// Caller-authored local paths, globs, or internal/read URLs.
	pub roots:              Vec<Str>,
	/// Optional walk-relative filter intersected with each root.
	pub glob:               Option<Str>,
	/// Maximum distinct files the authority may return, plus one sentinel.
	pub maximum_files:      usize,
	/// Maximum bytes the authority may materialize for one remote resource.
	pub maximum_file_bytes: u64,
	/// End-to-end resolution and materialization deadline.
	pub timeout:            Duration,
}

/// One canonical local file returned by the environment authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedFile {
	/// Canonical locally readable path.
	pub absolute_path: PathBuf,
	/// Stable workspace/scope-relative display path.
	pub display_path:  Str,
}

/// Typed authority failures that happen before AST parsing begins.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolveFault {
	/// A local target is invalid or escapes its workspace authority.
	#[error("invalid AST search target: {target}")]
	InvalidTarget {
		/// Caller-authored target.
		target: Str,
	},
	/// The independent glob filter is invalid.
	#[error("invalid AST search glob: {glob}")]
	InvalidGlob {
		/// Caller-authored glob.
		glob: Str,
	},
	/// The target scheme cannot expose bounded searchable bytes.
	#[error("unsupported AST search target: {target}")]
	UnsupportedTarget {
		/// Caller-authored URL.
		target: Str,
	},
	/// None of the caller's roots survived resolution.
	#[error("no AST search target exists")]
	AllTargetsMissing {
		/// Caller roots in authored order.
		targets: Vec<Str>,
	},
	/// A resolver-backed resource exceeded its materialization ceiling.
	#[error("AST search target exceeds the {maximum_bytes}-byte materialization bound: {target}")]
	MaterializationTooLarge {
		/// Caller-authored URL.
		target:        Str,
		/// Fixed host-side ceiling.
		maximum_bytes: u64,
	},
	/// Resolution exceeded its host-owned deadline.
	#[error("AST search target resolution timed out")]
	TimedOut,
	/// The environment authority was unavailable.
	#[error("AST search authority is unavailable")]
	AuthorityUnavailable,
}

/// Environment-owned path and resource resolution boundary.
///
/// Dropping the returned future MUST cancel in-flight URL materialization.
pub trait AstSearchResolver: Send + Sync + 'static {
	/// Resolves local paths and internal/read URLs into canonical bounded files.
	fn resolve(
		&self,
		request: ResolveRequest,
	) -> impl Future<Output = Result<Vec<ResolvedFile>, ResolveFault>> + Send + '_;
}

impl AstSearchResolver for PathBuf {
	fn resolve(
		&self,
		request: ResolveRequest,
	) -> impl Future<Output = Result<Vec<ResolvedFile>, ResolveFault>> + Send + '_ {
		let root = self.clone();
		async move {
			let targets = request
				.roots
				.iter()
				.map(ToString::to_string)
				.collect::<Vec<_>>();
			let files = omp_ast::ops::collect_matched_files_filtered_bounded(
				&root,
				&targets,
				request.glob.as_deref(),
				request.maximum_files,
			)
			.map_err(|error| match error.kind() {
				std::io::ErrorKind::NotFound => {
					ResolveFault::AllTargetsMissing { targets: request.roots.clone() }
				},
				std::io::ErrorKind::InvalidInput => {
					ResolveFault::InvalidGlob { glob: request.glob.clone().unwrap_or_default() }
				},
				std::io::ErrorKind::PermissionDenied => ResolveFault::InvalidTarget {
					target: request.roots.first().cloned().unwrap_or_default(),
				},
				_ => ResolveFault::AuthorityUnavailable,
			})?;
			Ok(files
				.into_iter()
				.map(|file| ResolvedFile {
					absolute_path: file.absolute_path,
					display_path:  file.relative_path,
				})
				.collect())
		}
	}
}

/// Workspace-scoped structural-search tool exposed as `ast_grep`.
pub struct AstGrep<R> {
	resolver: R,
	spec:     ToolSpec,
}

/// Returns the host-free `ast_grep@3` specification used by both the native
/// registry and the generated `dyn ast_grep --help` surface.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("ast_grep"),
		rev:             Rev { family: Default::default(), n: 3 },
		description:     sf!(
			"Searches files structurally with ast-grep. `path` accepts files, directories, and globs \
			 separated by semicolons; `glob` further filters each target. Language is inferred per \
			 file unless `lang` is set. Results are globally ordered; use `skip` and `limit` to \
			 page. Parse issues are non-fatal and reported separately from result data."
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
			include_bytes!("ast_grep.rs"),
		)
		.into(),
	}
}

/// Builds an `ast_grep` tool over the supplied environment search authority.
pub fn tool<R: AstSearchResolver>(resolver: R) -> AstGrep<R> {
	AstGrep { resolver, spec: spec() }
}

impl<R: AstSearchResolver> Tool for AstGrep<R> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Payload;
	type Update = Update;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut incoming: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Update, Payload, Fault>> + Send + 'c {
		stream! {
			let params = match incoming.whole::<Params>().await {
				Ok(value) => value,
				Err(error) => {
					yield param_event(error);
					return;
				},
			};
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let pattern = params.pat.trim();
			if pattern.is_empty() {
				yield done(Err(fault("`pat` must be a non-empty pattern")));
				return;
			}
			let skip = match normalize_integer(params.skip, 0, MAX_SKIP, "skip") {
				Ok(value) => value,
				Err(error) => {
					yield done(Err(error));
					return;
				},
			};
			let limit = match normalize_integer(params.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, "limit") {
				Ok(0) => {
					yield done(Err(fault("limit must be at least 1")));
					return;
				},
				Ok(value) => value,
				Err(error) => {
					yield done(Err(error));
					return;
				},
			};
			let targets = match parse_targets(params.path.as_deref()) {
				Ok(targets) => targets,
				Err(error) => {
					yield done(Err(error));
					return;
				},
			};
			let explicit_lang = params.lang.as_deref().map(str::trim).filter(|value| !value.is_empty());
			if let Some(lang) = explicit_lang
				&& omp_ast::ops::resolve_supported_lang(lang).is_err()
			{
				yield done(Err(Fault { message: sf!(
					"unsupported language `{lang}`; supported aliases: {}",
					omp_ast::ops::supported_lang_list()
				) }));
				return;
			}
			let files = {
				let resolution = self
					.resolver
					.resolve(ResolveRequest {
						roots: targets,
						glob: params.glob.clone(),
						maximum_files: MAX_FILES,
						maximum_file_bytes: MAX_FILE_BYTES,
						timeout: SEARCH_TIMEOUT,
					})
					.fuse();
				let interruption = incoming.next_interrupt().fuse();
				pin_mut!(resolution, interruption);
				select_biased! {
					interrupt = interruption => {
						yield interrupt_event(interrupt);
						return;
					},
					result = resolution => match result {
						Ok(files) => files,
						Err(error) => {
							yield done(Err(Fault { message: Str::new(error.to_string()) }));
							return;
						},
					},
				}
			};
			if files.len() > MAX_FILES {
				yield done(Err(Fault { message: sf!(
					"AST search selected {} files; narrow `path` or `glob` below the {MAX_FILES}-file safety bound",
					files.len()
				) }));
				return;
			}
			if let Some(interrupt) = incoming.next_interrupt().now_or_never() {
				yield interrupt_event(interrupt);
				return;
			}

			let started = Instant::now();
			let files_searched = files.len();
			let strictness = omp_ast::ops::resolve_strictness(params.strictness.map(Into::into));
			let mut compiled = HashMap::new();
			let mut matches = Vec::with_capacity(limit);
			let mut total = 0usize;
			let mut files_with_matches = 0usize;
			let mut advisories = Vec::new();
			let mut advisories_total = 0usize;
			let mut parse_errors = Vec::new();
			let mut parse_errors_total = 0usize;
			let mut seen_parse_errors = HashSet::new();

			for file in files {
				if started.elapsed() >= SEARCH_TIMEOUT {
					yield done(Err(fault("AST search timed out after 30s; narrow `path` or `glob`")));
					return;
				}
				if let Some(interrupt) = incoming.next_interrupt().now_or_never() {
					yield interrupt_event(interrupt);
					return;
				}
				let language = match omp_ast::ops::resolve_language(explicit_lang, &file.absolute_path) {
					Ok(language) => language,
					Err(error) => {
						push_advisory(
							&mut advisories,
							&mut advisories_total,
							file.display_path,
							Str::new(error.to_string()),
						);
						continue;
					},
				};
				let compiled_pattern = compiled.entry(language).or_insert_with(|| {
					omp_ast::ops::compile_pattern(
						pattern.as_str(),
						params.selector.as_deref(),
						&strictness,
						language,
					)
					.map_err(|error| Str::new(error.to_string()))
				});
				let compiled_pattern = match compiled_pattern {
					Ok(compiled_pattern) => compiled_pattern,
					Err(error) => {
						push_parse_error(
							&mut parse_errors,
							&mut parse_errors_total,
							&mut seen_parse_errors,
							sf!("{}: {pattern}: {error}", file.display_path),
						);
						continue;
					},
				};
				let byte_len = match fs::metadata(&file.absolute_path) {
					Ok(metadata) => metadata.len(),
					Err(error) => {
						push_advisory(
							&mut advisories,
							&mut advisories_total,
							file.display_path,
							Str::new(error.to_string()),
						);
						continue;
					},
				};
				if byte_len > MAX_FILE_BYTES {
					push_advisory(
						&mut advisories,
						&mut advisories_total,
						file.display_path,
						sf!("file exceeds the {} MiB AST parsing bound", MAX_FILE_BYTES / 1024 / 1024),
					);
					continue;
				}
				let source = match fs::read_to_string(&file.absolute_path) {
					Ok(source) => source,
					Err(error) => {
						push_advisory(
							&mut advisories,
							&mut advisories_total,
							file.display_path,
							Str::new(error.to_string()),
						);
						continue;
					},
				};
				let (found, has_parse_errors) = omp_ast::ops::collect_matches_with_parse_status(
					&source,
					language,
					std::slice::from_ref(compiled_pattern),
				);
				if has_parse_errors {
					push_parse_error(
						&mut parse_errors,
						&mut parse_errors_total,
						&mut seen_parse_errors,
						sf!("{}: parse error (syntax tree contains error nodes)", file.display_path),
					);
				}
				if !found.is_empty() {
					files_with_matches = files_with_matches.saturating_add(1);
				}
				for found in found {
					let index = total;
					total = total.saturating_add(1);
					if index < skip || matches.len() >= limit {
						continue;
					}
					matches.push(Match {
						path: file.display_path.clone(),
						line: found.line,
						column: found.column,
						end_line: found.end_line,
						end_column: found.end_column,
						text: found.text,
						bindings: render_bindings(&found.bindings),
					});
				}
			}

			let page_end = skip.saturating_add(matches.len());
			let limit_reached = page_end < total;
			let payload = Payload {
				matches,
				advisories,
				advisories_total,
				parse_errors,
				parse_errors_total,
				total,
				files_with_matches,
				files_searched,
				skip,
				limit,
				limit_reached,
				next_skip: limit_reached.then_some(page_end),
			};
			for diag in diags(&payload) {
				yield Ev::Diag(diag);
			}
			yield done(Ok(payload));
		}
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		lift_legacy_call(from, call)
	}

	fn prompt(&self, view: Result<&Payload, &Fault>, _: &PromptCaps) -> Vec<Part> {
		let text = match view {
			Err(error) => Str::new(error.to_string()),
			Ok(payload) => Str::new(render_payload(payload)),
		};
		vec![Part::Text { text }]
	}
}

fn normalize_integer(
	value: Option<f64>,
	default: usize,
	maximum: usize,
	name: &'static str,
) -> Result<usize, Fault> {
	let Some(value) = value else {
		return Ok(default);
	};
	if !value.is_finite() || value < 0.0 {
		return Err(Fault { message: sf!("{name} must be a non-negative finite number") });
	}
	let value = value.floor();
	if value > maximum as f64 {
		return Err(Fault { message: sf!("{name} exceeds the safety bound of {maximum}") });
	}
	Ok(value as usize)
}

fn parse_targets(path: Option<&str>) -> Result<Vec<Str>, Fault> {
	let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else {
		return Ok(vec![sf!(".")]);
	};
	let targets = path.split(';').map(str::trim).collect::<Vec<_>>();
	if targets.iter().any(|target| target.is_empty()) {
		return Err(fault("`path` contains an empty semicolon-delimited target"));
	}
	Ok(targets.into_iter().map(Str::new).collect())
}

fn push_advisory(advisories: &mut Vec<Advisory>, total: &mut usize, path: Str, message: Str) {
	*total = total.saturating_add(1);
	if advisories.len() < MAX_DIAGNOSTICS {
		advisories.push(Advisory { path, message });
	}
}

fn push_parse_error(errors: &mut Vec<Str>, total: &mut usize, seen: &mut HashSet<Str>, error: Str) {
	if !seen.insert(error.clone()) {
		return;
	}
	*total = total.saturating_add(1);
	if errors.len() < MAX_DIAGNOSTICS {
		errors.push(error);
	}
}

fn render_payload(payload: &Payload) -> String {
	let mut output = String::new();
	let mut previous_path: Option<&Str> = None;
	for found in &payload.matches {
		use std::fmt::Write as _;
		if previous_path != Some(&found.path) {
			if previous_path.is_some() {
				output.push('\n');
			}
			let _ = writeln!(output, "# {}", found.path);
			previous_path = Some(&found.path);
		}
		for (index, line) in found.text.lines().enumerate() {
			let marker = if index == 0 { '*' } else { ' ' };
			let _ = writeln!(output, "{marker}{}:{line}", found.line + index);
		}
		if !found.bindings.is_empty() {
			let _ = writeln!(output, "  meta: {}", found.bindings);
		}
	}
	if payload.matches.is_empty() {
		output.push_str("No matches found\n");
	}
	{
		use std::fmt::Write as _;
		let _ = writeln!(
			output,
			"[{} matches in {} files; searched {} files]",
			payload.total, payload.files_with_matches, payload.files_searched
		);
	}
	output.pop();
	output
}

fn diags(payload: &Payload) -> Vec<Diag> {
	let mut diags = Vec::with_capacity(
		payload
			.advisories
			.len()
			.saturating_add(payload.parse_errors.len())
			.saturating_add(4),
	);
	if payload.matches.is_empty() && !payload.parse_errors.is_empty() {
		diags.push(Diag::warn(
			DiagKind::Advisory,
			"Parse issues mean the query may be mis-scoped; narrow `path` before concluding absence.",
		));
	}
	if let Some(skip) = payload.next_skip {
		diags.push(
			Diag::info(DiagKind::Pagination, "AST matches continue beyond this page")
				.continuation(sf!("skip={skip}")),
		);
	}
	diags.extend(payload.advisories.iter().map(|advisory| {
		Diag::warn(DiagKind::Advisory, sf!("{}: {}", advisory.path, advisory.message))
	}));
	if payload.advisories_total > payload.advisories.len() {
		diags.push(Diag::info(DiagKind::LimitReached, "advisories").omitted(
			u64::try_from(payload.advisories_total - payload.advisories.len()).unwrap_or(u64::MAX),
			Unit::Items,
		));
	}
	diags.extend(
		payload
			.parse_errors
			.iter()
			.cloned()
			.map(|error| Diag::warn(DiagKind::ParseIssue, error)),
	);
	if payload.parse_errors_total > payload.parse_errors.len() {
		diags.push(Diag::info(DiagKind::LimitReached, "parse issues").omitted(
			u64::try_from(payload.parse_errors_total - payload.parse_errors.len()).unwrap_or(u64::MAX),
			Unit::Files,
		));
	}
	diags
}

fn render_bindings(bindings: &[omp_ast::ops::AstBinding]) -> Str {
	let mut output = String::new();
	for (index, binding) in bindings.iter().enumerate() {
		use std::fmt::Write as _;
		if index > 0 {
			output.push_str(", ");
		}
		let _ = write!(output, "{}={}", binding.name, binding.value);
	}
	Str::new(output)
}

fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done {
		useless: result.as_ref().is_ok_and(|payload| payload.total == 0),
		result,
	})
}

fn lift_legacy_call(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() {
		return None;
	}
	let (params, intent, notrunc, legacy_skip, legacy_limit) = match from.n {
		1 => {
			let old = serde_json::from_slice::<ParamsV1>(call.raw_args).ok()?;
			(
				Params {
					pat:        old.pat,
					lang:       None,
					path:       old.path,
					glob:       None,
					selector:   None,
					strictness: None,
					skip:       Some(old.cursor as f64),
					limit:      old.limit.map(|limit| limit as f64),
				},
				old.i,
				old.notrunc,
				old.cursor,
				old.limit.unwrap_or(DEFAULT_PAGE_LIMIT),
			)
		},
		2 => {
			let old = serde_json::from_slice::<ParamsV2>(call.raw_args).ok()?;
			(
				Params {
					pat:        old.pat,
					lang:       None,
					path:       old.path,
					glob:       None,
					selector:   None,
					strictness: None,
					skip:       Some(old.skip as f64),
					limit:      None,
				},
				old.i,
				old.notrunc,
				old.skip,
				DEFAULT_PAGE_LIMIT,
			)
		},
		_ => return None,
	};
	let mut raw_args = serde_json::to_value(params).ok()?;
	if let Some(object) = raw_args.as_object_mut() {
		if let Some(intent) = intent {
			object.insert("i".to_owned(), serde_json::Value::String(intent.to_string()));
		}
		if let Some(notrunc) = notrunc {
			object.insert("notrunc".to_owned(), serde_json::Value::Bool(notrunc));
		}
	}
	let raw_args = serde_json::to_vec(&raw_args).ok()?;
	let verdict = match from.n {
		1 => lift_v1_verdict(call.verdict, legacy_skip, legacy_limit)?,
		2 => lift_v2_verdict(call.verdict, legacy_skip, legacy_limit)?,
		_ => return None,
	};
	Some(LiftedCall { raw_args: Bytes::from(raw_args), verdict: Bytes::from(verdict) })
}

fn lift_v1_verdict(verdict: &[u8], skip: usize, limit: usize) -> Option<Vec<u8>> {
	match serde_json::from_slice::<CallOutcome<PayloadV1, Fault>>(verdict).ok()? {
		CallOutcome::Ok(payload) => {
			let files_with_matches = distinct_match_files(&payload.matches);
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(Payload {
				advisories_total: payload.advisories.len(),
				parse_errors: Vec::new(),
				parse_errors_total: 0,
				files_with_matches,
				files_searched: 0,
				limit,
				limit_reached: payload.next_cursor.is_some(),
				next_skip: payload.next_cursor,
				skip,
				matches: payload.matches,
				advisories: payload.advisories,
				total: payload.total,
			}))
			.ok()
		},
		CallOutcome::Faulted(fault) => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Faulted(fault)).ok()
		},
		CallOutcome::ArgsRejected(issue) => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::ArgsRejected(issue)).ok()
		},
		CallOutcome::Aborted { abort, kind, policy } => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Aborted { abort, kind, policy }).ok()
		},
	}
}

fn lift_v2_verdict(verdict: &[u8], skip: usize, limit: usize) -> Option<Vec<u8>> {
	match serde_json::from_slice::<CallOutcome<PayloadV2, Fault>>(verdict).ok()? {
		CallOutcome::Ok(payload) => {
			let files_with_matches = distinct_match_files(&payload.matches);
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(Payload {
				advisories_total: payload.advisories.len(),
				parse_errors: Vec::new(),
				parse_errors_total: 0,
				files_with_matches,
				files_searched: payload.files_searched,
				limit,
				limit_reached: payload.next_skip.is_some(),
				next_skip: payload.next_skip,
				skip,
				matches: payload.matches,
				advisories: payload.advisories,
				total: payload.total,
			}))
			.ok()
		},
		CallOutcome::Faulted(fault) => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Faulted(fault)).ok()
		},
		CallOutcome::ArgsRejected(issue) => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::ArgsRejected(issue)).ok()
		},
		CallOutcome::Aborted { abort, kind, policy } => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Aborted { abort, kind, policy }).ok()
		},
	}
}

fn distinct_match_files(matches: &[Match]) -> usize {
	matches
		.iter()
		.map(|matched| &matched.path)
		.collect::<HashSet<_>>()
		.len()
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
) -> Ev<Update, Payload, Fault> {
	match interrupt {
		Ok(interrupt) => Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
		Err(InterruptWaitError::Closed) => {
			Ev::Aborted(Abort::Interrupted { reason: sf!("AST search invocation owner disappeared") })
		},
		Err(InterruptWaitError::Protocol(message)) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"pat":"$F($A)","path":"src/**/*.ts"}}"#)),
		found:    Some(message),
	}
}

const fn fault(message: &'static str) -> Fault {
	Fault { message: Str::new_static(message) }
}

#[cfg(test)]
mod tests {
	use futures::{StreamExt as _, executor::block_on};
	use omp_ast::ops::AstBinding;
	use omp_tool::{Interrupt, Severity};

	use super::*;

	fn search_events(root: PathBuf, raw: &str) -> Vec<Ev<Update, Payload, Fault>> {
		let tool = tool(root);
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new(raw))
			.expect("invocation consumer remains live");
		block_on(tool.call(params).collect())
	}

	fn result(events: &[Ev<Update, Payload, Fault>]) -> Result<Payload, Fault> {
		events
			.iter()
			.find_map(|event| match event {
				Ev::Done(ToolTerminal::Done { result, .. }) => Some(result.clone()),
				_ => None,
			})
			.unwrap_or_else(|| panic!("expected terminal ast_grep outcome: {events:?}"))
	}

	fn search(root: PathBuf, raw: &str) -> Result<Payload, Fault> {
		result(&search_events(root, raw))
	}

	#[test]
	fn revision_three_schema_is_the_generated_dyn_contract() {
		let spec = spec();
		assert_eq!(spec.rev, Rev { family: Str::default(), n: 3 });
		let schema: serde_json::Value = serde_json::from_slice(&spec.schema).expect("JSON schema");
		for field in
			["pat", "lang", "path", "glob", "selector", "strictness", "skip", "limit", "i", "notrunc"]
		{
			assert!(schema["properties"].get(field).is_some(), "missing generated dyn field {field}");
		}
		assert!(
			schema.to_string().contains(r#""cst""#),
			"strictness enum values must reach the generated schema"
		);
	}

	#[test]
	fn searches_default_directory_and_intersects_glob_filter() {
		let dir = tempfile::tempdir().expect("tempdir");
		fs::create_dir_all(dir.path().join("src/nested")).expect("create source tree");
		fs::write(dir.path().join("src/root.ts"), "const answer = 1;\n").expect("write ts");
		fs::write(dir.path().join("src/nested/child.ts"), "const answer = 2;\n").expect("write ts");
		fs::write(dir.path().join("src/ignored.js"), "const answer = 3;\n").expect("write js");
		let payload =
			search(dir.path().to_path_buf(), r#"{"pat":"answer","path":"src","glob":"**/*.ts"}"#)
				.expect("search succeeds");
		assert_eq!(payload.total, 2);
		assert_eq!(payload.files_with_matches, 2);
		assert!(
			payload
				.matches
				.iter()
				.all(|matched| matched.path.ends_with(".ts"))
		);
	}

	#[test]
	fn explicit_language_searches_extensionless_files() {
		let dir = tempfile::tempdir().expect("tempdir");
		fs::write(dir.path().join("module"), "const answer = 1;\n").expect("write extensionless");
		let payload = search(
			dir.path().to_path_buf(),
			r#"{"pat":"answer","path":"module","lang":"typescript"}"#,
		)
		.expect("search succeeds");
		assert_eq!(payload.total, 1);
	}

	#[test]
	fn pagination_is_global_and_reports_complete_counts() {
		let dir = tempfile::tempdir().expect("tempdir");
		fs::write(
			dir.path().join("a.ts"),
			(0..8)
				.map(|index| format!("call({index});\n"))
				.collect::<String>(),
		)
		.expect("write a");
		fs::write(
			dir.path().join("z.ts"),
			(8..16)
				.map(|index| format!("call({index});\n"))
				.collect::<String>(),
		)
		.expect("write z");
		let first_events =
			search_events(dir.path().to_path_buf(), r#"{"pat":"call($A)","path":"*.ts","limit":8}"#);
		let first = result(&first_events).expect("first page");
		assert_eq!(first.total, 16);
		assert_eq!(first.next_skip, Some(8));
		assert!(first.matches.iter().all(|matched| matched.path == "a.ts"));
		assert!(first_events.iter().any(|event| matches!(
			event,
			Ev::Diag(diag)
				if diag.native_kind() == Some(DiagKind::Pagination)
					&& diag.severity == Severity::Info
					&& diag.continuation.as_deref() == Some("skip=8")
		)));
		let second =
			search(dir.path().to_path_buf(), r#"{"pat":"call($A)","path":"*.ts","skip":8,"limit":8}"#)
				.expect("second page");
		assert_eq!(second.total, 16);
		assert_eq!(second.files_with_matches, 2);
		assert!(second.matches.iter().all(|matched| matched.path == "z.ts"));
		assert_eq!(second.next_skip, None);
	}

	#[test]
	fn parse_errors_are_non_fatal_and_capped_separately() {
		let dir = tempfile::tempdir().expect("tempdir");
		fs::write(dir.path().join("broken.ts"), "export function broken( { return 1; }")
			.expect("write broken source");
		let events =
			search_events(dir.path().to_path_buf(), r#"{"pat":"unlikely($A)","path":"broken.ts"}"#);
		let payload = result(&events).expect("parse issue is not terminal");
		assert_eq!(payload.total, 0);
		assert_eq!(payload.parse_errors_total, 1);
		assert!(payload.parse_errors[0].contains("broken.ts: parse error"));
		assert_eq!(
			render_payload(&payload),
			"No matches found\n[0 matches in 0 files; searched 1 files]"
		);
		assert!(events.iter().any(|event| matches!(
			event,
			Ev::Diag(diag)
				if diag.native_kind() == Some(DiagKind::ParseIssue)
					&& diag.severity == Severity::Warn
					&& diag.text.contains("broken.ts: parse error")
		)));
		assert!(events.iter().any(|event| matches!(
			event,
			Ev::Diag(diag)
				if diag.native_kind() == Some(DiagKind::Advisory)
					&& diag.severity == Severity::Warn
					&& diag.text.contains("query may be mis-scoped")
		)));
	}

	#[test]
	fn diagnostic_caps_report_typed_omissions() {
		let payload = Payload {
			matches:            Vec::new(),
			advisories:         vec![Advisory {
				path:    sf!("unknown.ext"),
				message: sf!("unsupported language"),
			}],
			advisories_total:   3,
			parse_errors:       vec![sf!("broken.ts: parse error")],
			parse_errors_total: 4,
			total:              0,
			files_with_matches: 0,
			files_searched:     7,
			skip:               0,
			limit:              2,
			limit_reached:      false,
			next_skip:          None,
		};
		let diagnostics = diags(&payload);
		assert!(diagnostics.iter().any(|diag| {
			diag.native_kind() == Some(DiagKind::Advisory)
				&& diag.severity == Severity::Warn
				&& diag.text == "unknown.ext: unsupported language"
		}));
		assert!(diagnostics.iter().any(|diag| {
			diag.native_kind() == Some(DiagKind::LimitReached)
				&& diag.severity == Severity::Info
				&& diag
					.omitted
					.is_some_and(|omitted| omitted.count == 2 && omitted.unit == Unit::Items)
		}));
		assert!(diagnostics.iter().any(|diag| {
			diag.native_kind() == Some(DiagKind::LimitReached)
				&& diag.severity == Severity::Info
				&& diag
					.omitted
					.is_some_and(|omitted| omitted.count == 3 && omitted.unit == Unit::Files)
		}));
	}

	#[test]
	fn committed_search_observes_runtime_interrupts() {
		let dir = tempfile::tempdir().expect("tempdir");
		fs::write(dir.path().join("source.ts"), "call(1);\n").expect("write source");
		let tool = tool(dir.path().to_path_buf());
		let (feed, params) = IncomingParams::channel();
		feed
			.args_committed(Str::new_static(r#"{"pat":"call($A)"}"#))
			.expect("commit args");
		feed
			.interrupt(Interrupt { class: sf!("user"), reason: sf!("stop search") })
			.expect("send interrupt");
		let events = block_on(tool.call(params).collect::<Vec<_>>());
		assert!(matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::Interrupted { reason })] if reason == "stop search"
		));
	}

	#[test]
	fn lifts_both_historical_pagination_wires() {
		let tool = tool(PathBuf::from("."));
		let v1_args = br#"{"i":"Finding calls","notrunc":true,"pat":"$F($A)","cursor":7,"limit":3}"#;
		let v1_verdict =
			br#"{"kind":"ok","value":{"matches":[],"advisories":[],"total":12,"next_cursor":10}}"#;
		let lifted = tool
			.lift(&Rev { family: Default::default(), n: 1 }, RecordedCall {
				raw_args: v1_args,
				verdict:  v1_verdict,
			})
			.expect("rev 1 lifts");
		let args: serde_json::Value = serde_json::from_slice(&lifted.raw_args).expect("lifted args");
		assert_eq!(args["skip"], 7.0);
		assert_eq!(args["limit"], 3.0);
		assert_eq!(args["i"], "Finding calls");

		let v2_args = br#"{"pat":"$F($A)","skip":4}"#;
		let v2_verdict = br#"{"kind":"ok","value":{"matches":[],"advisories":[],"total":9,"next_skip":8,"files_searched":2}}"#;
		let lifted = tool
			.lift(&Rev { family: Default::default(), n: 2 }, RecordedCall {
				raw_args: v2_args,
				verdict:  v2_verdict,
			})
			.expect("rev 2 lifts");
		let args: serde_json::Value = serde_json::from_slice(&lifted.raw_args).expect("lifted args");
		assert_eq!(args["skip"], 4.0);
		let outcome: CallOutcome<Payload, Fault> =
			serde_json::from_slice(&lifted.verdict).expect("lifted verdict");
		let CallOutcome::Ok(payload) = outcome else {
			panic!("expected lifted success")
		};
		assert_eq!(payload.next_skip, Some(8));
		assert_eq!(payload.files_searched, 2);
	}

	#[test]
	fn renders_metavariable_bindings_in_stable_order() {
		let bindings = [AstBinding { name: sf!("$NAME"), value: sf!("answer") }, AstBinding {
			name:  sf!("$VALUE"),
			value: sf!("42"),
		}];
		assert_eq!(render_bindings(&bindings), "$NAME=answer, $VALUE=42");
	}
}
