//! Workspace path matching with mtime-ranked grouped output.

use std::{collections::HashSet, sync::Arc};

use async_stream::stream;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CommitError, Constraint, Diag, DiagKind, DocEffects, Effects, Ev,
	IncomingParams, InterruptWaitError, ParamError, Part, PromptCaps, Rev, Tool, ToolSpec,
	ToolTerminal, Unit,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::{
	grep::WorkspaceSearch,
	path::tracing_path_metadata,
	render::{TextProjection, paths::format_grouped_paths},
};

/// Default number of paths returned by `glob@1`.
pub const DEFAULT_LIMIT: u64 = 200;
/// Maximum number of paths returned by `glob@1`.
pub const MAX_LIMIT: u64 = 200;
/// Maximum time allotted to the workspace traversal.
pub const DEFAULT_TIMEOUT_MS: u64 = 5_000;

const fn default_true() -> bool {
	true
}

#[expect(
	clippy::trivially_copy_pass_by_ref,
	reason = "schemars skip_serializing_if predicates receive field references"
)]
const fn is_true(value: &bool) -> bool {
	*value
}

/// Model arguments for `glob@1`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[schemars(description = "")]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// glob, file, or directory to search — a single path or a
	/// semicolon-delimited list ("src/**/*.ts; test/**/*.ts"). Omitted ->
	/// searches the workspace root (".")
	#[schemars(description = "glob, file, or directory to search — a single path or a \
	                          semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted \
	                          -> searches the workspace root (\".\")")]
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "String")]
	pub path:      Option<Str>,
	/// include hidden files
	#[serde(default = "default_true")]
	#[schemars(skip_serializing_if = "is_true")]
	pub hidden:    bool,
	/// respect gitignore
	#[serde(default = "default_true")]
	#[schemars(skip_serializing_if = "is_true")]
	pub gitignore: bool,
	/// max results
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "serde_json::Number")]
	pub limit:     Option<f64>,
}

/// Fully specified request passed to the workspace resource after commitment.
///
/// `path` stays unsplit so the resource can stat the literal spelling before
/// interpreting semicolons. This preserves real filenames containing `;`.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WalkRequest {
	/// Raw model path, defaulted to `.`.
	pub path:       Str,
	/// Whether dot-prefixed paths are traversed.
	pub hidden:     bool,
	/// Whether ignore files are honored.
	pub gitignore:  bool,
	/// Effective per-call result cap.
	pub limit:      u64,
	/// Traversal deadline in milliseconds.
	pub timeout_ms: u64,
}

/// One workspace-relative path discovered by the resource.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WalkMatch {
	/// Workspace-relative model-facing path using `/` separators.
	pub path:        Str,
	/// Modification time in milliseconds, used for newest-first ranking.
	pub modified_ms: u64,
	/// Whether this path names a directory.
	pub is_dir:      bool,
}

/// Structured resource result, including partial traversal truth.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct WalkResult {
	/// Matches gathered before completion or timeout.
	pub matches:       Vec<WalkMatch>,
	/// Missing targets skipped while at least one target survived. The resource
	/// returns [`Fault::PathNotFound`] instead when the sole or every target is
	/// missing.
	pub missing_paths: Vec<Str>,
	/// Whether the traversal deadline ended the scan.
	pub timed_out:     bool,
	/// Whether the resource omitted matches for a non-timeout limit.
	pub truncated:     bool,
}

/// Durable successful `glob@1` result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Payload {
	/// Newest-first, deduplicated, display-ready paths retained by the hard cap.
	pub matches:              Vec<WalkMatch>,
	/// User targets skipped because their base paths were missing.
	pub missing_paths:        Vec<Str>,
	/// Whether the traversal deadline ended the scan.
	pub timed_out:            bool,
	/// Whether timeout, the resource, or the hard result cap omitted matches.
	pub truncated:            bool,
	/// Effective result limit when it omitted otherwise available matches.
	pub result_limit_reached: Option<u64>,
	/// Number of distinct partial matches gathered before applying the limit.
	pub partial_match_count:  u64,
	/// Deadline used by this invocation, retained for exact timeout rendering.
	pub timeout_ms:           u64,
}

/// Ephemeral progress from `glob@1`; traversal has no durable updates.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Update {}

/// Durable typed `glob@1` failure.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Fault {
	/// The caller supplied a non-positive or non-finite limit.
	#[error("Limit must be a positive number")]
	InvalidLimit,
	/// The input contained no usable path target.
	#[error("`path` must contain non-empty globs or paths")]
	EmptyPath,
	/// A traversal attempted to start at filesystem root.
	#[error("Searching from root directory '/' is not allowed")]
	RootSearch,
	/// Every requested target, or the sole requested target, was missing.
	#[error("Path not found: {}", join_strs(.paths))]
	PathNotFound {
		/// Missing target spellings in model input order.
		paths: Vec<Str>,
	},
	/// A direct non-directory target could not be treated as a file.
	#[error("Path is not a directory: {path}")]
	PathNotDirectory {
		/// Rejected target path.
		path: Str,
	},
	/// A URI scheme has no local path-backed glob implementation yet.
	#[error("{scheme}:// targets are not supported yet")]
	UnsupportedScheme {
		/// Lowercase URI scheme without punctuation.
		scheme: Str,
	},
	/// A glob pattern could not be compiled by the workspace walker.
	#[error("invalid glob pattern {pattern}: {message}")]
	InvalidPattern {
		/// Exact rejected pattern.
		pattern: Str,
		/// Resource-owned parser explanation.
		message: Str,
	},
	/// The workspace owner rejected or failed the request.
	#[error("{message}")]
	Workspace {
		/// Stable resource-owned explanation.
		message: Str,
	},
	/// The resource observed cancellation without an invocation interrupt.
	#[error("{reason}")]
	Cancelled {
		/// Stable resource-owned cancellation reason.
		reason: Str,
	},
}

fn join_strs(values: &[Str]) -> String {
	values
		.iter()
		.map(Str::as_str)
		.collect::<Vec<_>>()
		.join(", ")
}
/// Generic `glob@1` executor over an environment-owned workspace resource.
pub struct Glob<W> {
	workspace: W,
	spec:      ToolSpec,
}

/// Returns the host-free `glob@1` specification.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("glob"),
		rev:             Rev { family: Str::new(""), n: 1 },
		description:     sf!(
			"Globs files and directories with fast pattern matching.\n\n<instruction>\n- `path`: \
			 glob, file, or directory; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).\n- \
			 `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or \
			 build output.\n- `hidden` defaults `true`; pair it with `gitignore: false` for ignored \
			 dotfiles.\n</instruction>\n\n<output>\nMatches are newest-first and grouped by \
			 directory; directories end in `/`.\n</output>",
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
			include_bytes!("glob.rs"),
		)
		.into(),
	}
}

/// Constructs `glob@1` over `workspace`.
pub fn tool<W: WorkspaceSearch>(workspace: W) -> Glob<W> {
	Glob { workspace, spec: spec() }
}

impl<W: WorkspaceSearch> Tool for Glob<W> {
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
		let span = tracing::debug_span!("glob_execution", pattern = tracing::field::Empty);
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

			let limit = match effective_limit(arguments.limit) {
				Ok(limit) => limit,
				Err(fault) => {
					yield done(Err(fault));
					return;
				},
			};
			let path = arguments.path.unwrap_or_else(|| sf!("."));
			span.record("pattern", tracing::field::display(tracing_path_metadata(&path)));
			if path.trim().is_empty() {
				yield done(Err(Fault::EmptyPath));
				return;
			}
			if contains_root_target(&path) {
				yield done(Err(Fault::RootSearch));
				return;
			}
			let resource_scheme = unsupported_scheme(&path);
			let request = walk_request(path, arguments.hidden, arguments.gitignore, limit);
			let cancellation = CancellationToken::new();
			let operation = async {
				let result = if let Some(scheme) = resource_scheme {
					match self.workspace.glob_resource(request, cancellation.clone()).await {
						Some(result) => result,
						None => Err(Fault::UnsupportedScheme { scheme }),
					}
				} else {
					self.workspace.glob(request, cancellation.clone()).await
				}?;
				Ok(payload(result, limit, DEFAULT_TIMEOUT_MS))
			}
			.instrument(span.clone());
			tokio::pin!(operation);
			tokio::select! {
				biased;
				interrupt = params.next_interrupt() => {
					cancellation.cancel();
					let _ = operation.await;
					yield interrupt_event(interrupt, "glob traversal owner disappeared");
				},
				result = &mut operation => {
					match result {
						Ok(payload) => {
							for diag in payload_diags(&payload) {
								yield Ev::Diag(diag);
							}
							yield done(Ok(payload));
						},
						Err(fault) => yield done(Err(fault)),
					}
				},
			}
		}
	}

	fn prompt(&self, view: Result<&Self::Payload, &Self::Fault>, caps: &PromptCaps) -> Vec<Part> {
		let Some(mut projection) = TextProjection::new(*caps) else {
			return Vec::new();
		};
		match view {
			Ok(payload) => {
				let text = render_payload(payload);
				for fragment in text.split_inclusive('\n') {
					if !projection.push(fragment) {
						break;
					}
				}
			},
			Err(fault) => {
				projection.push(&fault.to_string());
			},
		}
		projection.finish()
	}
}

fn effective_limit(limit: Option<f64>) -> Result<u64, Fault> {
	let requested = limit.unwrap_or(DEFAULT_LIMIT as f64);
	if !requested.is_finite() || requested <= 0.0 {
		return Err(Fault::InvalidLimit);
	}
	Ok((requested.floor() as u64).clamp(1, MAX_LIMIT))
}

const fn walk_request(path: Str, hidden: bool, gitignore: bool, limit: u64) -> WalkRequest {
	WalkRequest { path, hidden, gitignore, limit, timeout_ms: DEFAULT_TIMEOUT_MS }
}

pub(crate) fn display_scope(path: &str) -> Str {
	if path.contains(';') {
		return sf!(".");
	}
	let Some(wildcard) = path
		.char_indices()
		.find_map(|(index, character)| matches!(character, '*' | '?' | '[').then_some(index))
	else {
		return Str::new(path);
	};
	let prefix = &path[..wildcard];
	if prefix.ends_with('/') {
		let directory = prefix.trim_end_matches('/');
		return if directory.is_empty() {
			sf!(".")
		} else {
			Str::new(directory)
		};
	}
	prefix
		.rsplit_once('/')
		.map_or_else(|| sf!("."), |(directory, _)| Str::new(directory))
}

fn contains_root_target(path: &str) -> bool {
	path.split(';').any(|target| {
		let target = target.trim();
		!target.is_empty() && target.bytes().all(|byte| byte == b'/')
	})
}

fn unsupported_scheme(path: &str) -> Option<Str> {
	path.split(';').find_map(|target| {
		let target = target.trim();
		let (scheme, _) = target.split_once("://")?;
		let mut chars = scheme.bytes();
		let valid = matches!(chars.next(), Some(first) if first.is_ascii_alphabetic())
			&& chars.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'.' | b'-'));
		valid.then(|| Str::new(scheme.to_ascii_lowercase()))
	})
}

fn payload(mut result: WalkResult, limit: u64, timeout_ms: u64) -> Payload {
	for entry in &mut result.matches {
		let mut normalized = entry.path.replace('\\', "/");
		normalized.truncate(normalized.trim_end_matches('/').len());
		if entry.is_dir {
			normalized.push('/');
		}
		entry.path = normalized.into();
	}
	result.matches.sort_by(|left, right| {
		right
			.modified_ms
			.cmp(&left.modified_ms)
			.then_with(|| left.path.cmp(&right.path))
	});
	let mut seen = HashSet::with_capacity(result.matches.len());
	result
		.matches
		.retain(|entry| seen.insert(entry.path.clone()));
	let partial_match_count = u64::try_from(result.matches.len()).unwrap_or(u64::MAX);
	let over_limit = partial_match_count > limit;
	let retain = usize::try_from(limit)
		.unwrap_or(usize::MAX)
		.min(result.matches.len());
	result.matches.truncate(retain);
	Payload {
		matches: result.matches,
		missing_paths: result.missing_paths,
		timed_out: result.timed_out,
		truncated: result.timed_out || result.truncated || over_limit,
		result_limit_reached: (result.truncated || over_limit).then_some(limit),
		partial_match_count,
		timeout_ms,
	}
}

fn render_payload(payload: &Payload) -> String {
	let paths: Vec<&str> = payload
		.matches
		.iter()
		.map(|entry| entry.path.as_ref())
		.collect();
	if paths.is_empty() {
		return if payload.timed_out {
			String::new()
		} else {
			String::from("No files found matching pattern")
		};
	}
	format_grouped_paths(&paths)
}

fn payload_diags(payload: &Payload) -> impl Iterator<Item = Diag> {
	let timeout = payload.timed_out.then(|| {
		let elapsed = if payload.timeout_ms.is_multiple_of(1_000) {
			sf!("{}s", payload.timeout_ms / 1_000)
		} else {
			sf!("{:.1}s", payload.timeout_ms as f64 / 1_000.0)
		};
		Diag::warn(
			DiagKind::Timeout,
			sf!(
				"Glob reached its {elapsed} timeout after finding {} partial matches",
				payload.partial_match_count
			),
		)
	});
	let limit = payload.result_limit_reached.map(|limit| {
		let diag = Diag::info(DiagKind::LimitReached, sf!("{limit} result limit reached"))
			.continuation(sf!("limit={}", limit.saturating_mul(2)));
		let omitted = payload
			.partial_match_count
			.saturating_sub(u64::try_from(payload.matches.len()).unwrap_or(u64::MAX));
		if omitted == 0 {
			diag
		} else {
			diag.omitted(omitted, Unit::Files)
		}
	});
	let missing = (!payload.missing_paths.is_empty())
		.then(|| Diag::warn(DiagKind::MissingPaths, Str::new(join_strs(&payload.missing_paths))));
	[timeout, limit, missing].into_iter().flatten()
}

const fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	let useless = matches!(&result, Ok(payload) if payload.matches.is_empty() && !payload.timed_out);
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
		example:  Some(sf!(r#"{{"path":"crates/**/*.rs"}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn walk_match(path: &str, modified_ms: u64, is_dir: bool) -> WalkMatch {
		WalkMatch { path: Str::new(path), modified_ms, is_dir }
	}

	#[test]
	fn fault_messages_remain_stable_under_thiserror() {
		assert_eq!(
			Fault::PathNotFound { paths: vec![Str::new_static("a"), Str::new_static("b")] }
				.to_string(),
			"Path not found: a, b"
		);
		assert_eq!(
			Fault::InvalidPattern {
				pattern: Str::new_static("["),
				message: Str::new_static("unclosed class"),
			}
			.to_string(),
			"invalid glob pattern [: unclosed class"
		);
	}

	#[test]
	fn renderer_scope_is_the_literal_directory_prefix() {
		assert_eq!(display_scope("packages/**/*.{test,spec}.ts"), "packages");
		assert_eq!(display_scope("src/foo*.rs"), "src");
		assert_eq!(display_scope("*.rs"), ".");
		assert_eq!(display_scope("src"), "src");
		assert_eq!(display_scope("src; tests"), ".");
	}

	#[test]
	fn params_default_to_visible_gitignored_walk_and_accept_toggles() {
		let defaults: Params = serde_json::from_str("{}").unwrap();
		assert_eq!(defaults.path, None);
		assert!(defaults.hidden);
		assert!(defaults.gitignore);
		assert_eq!(defaults.limit, None);

		let toggled: Params =
			serde_json::from_str(r#"{"path":"src; tests","hidden":false,"gitignore":false}"#).unwrap();
		assert_eq!(toggled.path.as_deref(), Some("src; tests"));
		assert!(!toggled.hidden);
		assert!(!toggled.gitignore);
	}

	#[test]
	fn walk_request_preserves_multi_root_path_and_toggles() {
		let request = walk_request(sf!("src; tests"), false, false, 17);
		assert_eq!(request.path, "src; tests");
		assert!(!request.hidden);
		assert!(!request.gitignore);
		assert_eq!(request.limit, 17);
		assert_eq!(request.timeout_ms, DEFAULT_TIMEOUT_MS);
	}

	#[test]
	fn payload_is_newest_first_deduplicated_and_hard_limited() {
		let ranked = payload(
			WalkResult {
				matches:       vec![
					walk_match("src/old.rs", 10, false),
					walk_match("src/new.rs", 30, false),
					walk_match("docs/generated", 40, true),
					walk_match("src/mid.rs", 20, false),
					walk_match("src/new.rs", 1, false),
				],
				missing_paths: Vec::new(),
				timed_out:     false,
				truncated:     false,
			},
			3,
			DEFAULT_TIMEOUT_MS,
		);
		assert_eq!(
			ranked
				.matches
				.iter()
				.map(|entry| entry.path.as_str())
				.collect::<Vec<_>>(),
			["docs/generated/", "src/new.rs", "src/mid.rs"]
		);
		assert_eq!(ranked.partial_match_count, 4);
		assert_eq!(ranked.result_limit_reached, Some(3));
		assert!(ranked.truncated);
		assert_eq!(
			render_payload(&ranked),
			["# docs/generated/", "# src/", "new.rs", "mid.rs"].join("\n")
		);
		let diags = payload_diags(&ranked).collect::<Vec<_>>();
		assert_eq!(diags.len(), 1);
		assert_eq!(diags[0].native_kind(), Some(DiagKind::LimitReached));
		assert_eq!(diags[0].continuation.as_deref(), Some("limit=6"));
		assert_eq!(diags[0].omitted, Some(omp_tool::Omitted { count: 1, unit: Unit::Files }));
	}

	#[test]
	fn limit_is_positive_floored_and_capped() {
		assert_eq!(effective_limit(None), Ok(DEFAULT_LIMIT));
		assert_eq!(effective_limit(Some(3.9)), Ok(3));
		assert_eq!(effective_limit(Some(10_000.0)), Ok(MAX_LIMIT));
		assert_eq!(effective_limit(Some(0.0)), Err(Fault::InvalidLimit));
		assert_eq!(effective_limit(Some(f64::NAN)), Err(Fault::InvalidLimit));
	}
}
