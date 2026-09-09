//! Multi-file structural rewrites with dry-run validation and recovery
//! snapshots.
use std::{
	fs,
	io::{self, Read as _, Write as _},
	path::{Path, PathBuf},
	str,
	sync::Arc,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use async_stream::stream;
use bytes::Bytes;
use futures::{FutureExt as _, Stream};
use omp_core::{FastHashMap, FastHashSet, Hash32, Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, CallOutcome, CommitError, Constraint, Diag, DiagKind, DocEffects,
	Effects, Ev, IncomingParams, InterruptWaitError, LiftedCall, ParamError, Part, PromptCaps,
	RecordedCall, Rev, Tool, ToolSpec, ToolTerminal, Unit,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::staging::{
	ProposalActionError, ProposalDecision, ProposalError, ProposalRejection, StagedProposalAction,
	StagedProposalRegistry, proposal_pending_notice,
};

const MAX_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIAGNOSTICS: usize = 20;
const REWRITE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
/// One ordered ast-grep pattern and replacement-template pair.
pub struct RewriteOp {
	/// Structural AST pattern. `$NAME` captures one node and `$$$NAME`
	/// captures zero or more nodes; a repeated name must match identical
	/// structure and may be reused by the replacement.
	pub pat: Str,
	/// Replacement template substituted for every match of `pat`.
	pub out: Str,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize)]
#[serde(deny_unknown_fields)]
/// Agent-supplied structural rewrite proposal.
pub struct Params {
	/// Required non-empty operations evaluated together against every
	/// compatible target's original AST. Reusing a metavariable in one pattern
	/// requires the captures to be structurally identical; replacement
	/// templates substitute captures
	/// from that pattern.
	pub ops:   Vec<RewriteOp>,
	/// Required workspace-relative files, directories, or globs selecting at
	/// most 200 mixed-language files. Each file's language is inferred
	/// independently.
	pub paths: Vec<Str>,
}

/// `ast_edit@1` arguments retained only to lift historical calls.
#[derive(Deserialize)]
struct ParamsV1 {
	ops:     Vec<RewriteOp>,
	paths:   Vec<Str>,
	#[serde(default)]
	i:       Option<Str>,
	#[serde(default)]
	notrunc: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Per-file change summary for a staged proposal or finalized application.
pub struct ChangedFile {
	/// Workspace-relative path that the proposal would change or has changed.
	pub path:         Str,
	/// Number of structural matches replaced in this file.
	pub replacements: u32,
	/// Twelve-hex-character prefix of the original content's SHA-256 digest.
	pub before_hash:  Str,
	/// Twelve-hex-character prefix of the proposed content's SHA-256 digest.
	pub after_hash:   Str,
	/// Stable numbered source diff for this file.
	pub diff:         Str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Non-fatal reason a targeted file was omitted from the proposal.
pub struct Advisory {
	/// Workspace-relative path of the skipped target.
	pub path:    Str,
	/// Language-resolution, rule-compilation, or encoding explanation.
	pub message: Str,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Structural-rewrite result before or after proposal resolution.
pub struct Payload {
	/// Proposed files while staged, or files written after `resolve` applies the
	/// proposal.
	pub files:              Vec<ChangedFile>,
	/// Capped per-file skips encountered while constructing the proposal.
	pub advisories:         Vec<Advisory>,
	/// Advisory count before capping.
	pub advisories_total:   usize,
	/// Capped syntax-tree and language-specific pattern parse diagnostics.
	pub parse_errors:       Vec<Str>,
	/// Parse diagnostic count before capping.
	pub parse_errors_total: usize,
	/// Files selected before language, encoding, and parser filtering.
	pub files_searched:     usize,
	/// Number of files with at least one exact structural replacement.
	pub files_touched:      usize,
	/// Number of exact structural replacements across all changed files.
	pub total_replacements: u32,
	/// Recovery-snapshot directory created on apply; `None` while the proposal
	/// is staged.
	pub recovery_root:      Option<Str>,
	/// Exact uncommitted proposal identity required by `dyn resolve` or
	/// `dyn reject`.
	pub pending_proposal:   Option<Str>,
}

/// `ast_edit@1` result retained only to lift historical verdicts.
#[derive(Deserialize)]
struct PayloadV1 {
	files:            Vec<ChangedFile>,
	advisories:       Vec<Advisory>,
	recovery_root:    Option<Str>,
	pending_proposal: Option<Str>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
/// Empty update type because structural rewrites emit only a terminal result.
pub enum Update {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
/// Terminal validation, target-discovery, staging, or rewrite failure.
pub struct Fault {
	message: Str,
}

/// Workspace-scoped structural-rewrite tool exposed as `ast_edit`.
pub struct AstEdit {
	root:      PathBuf,
	spec:      ToolSpec,
	proposals: StagedProposalRegistry,
}

/// Returns the host-free `ast_edit@2` specification.
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("ast_edit"),
		rev:             Rev { family: Default::default(), n: 2 },
		description:     sf!(
			"Stages structural ast-grep rewrites across mixed-language targets. Patterns are AST \
			 nodes: `$NAME` captures one node and `$$$NAME` captures zero or more; repeated \
			 metavariables require identical structure. Every rewrite is dry-run first; duplicate \
			 patterns, files above 8 MiB, and more than 200 selected files are bounded. Parse \
			 diagnostics are separate from exact replacement results. Resolution requires the \
			 proposal's exact id, rechecks every source revision, and applies the immutable preview."
		),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects {
			documents: Some(DocEffects {
				read:        true,
				write_globs: [sf!("**")].into_iter().collect::<Arc<_>>(),
			}),
			exec:      None,
			inference: None,
			desktop:   None,
			subagents: 0,
		},
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("ast_edit.rs"),
		)
		.into(),
	}
}

/// Builds an `ast_edit` tool that stages proposals in `proposals` for later
/// resolve or reject.
pub fn tool(root: PathBuf, proposals: StagedProposalRegistry) -> AstEdit {
	AstEdit { root, proposals, spec: spec() }
}

struct Prepared {
	absolute:     PathBuf,
	relative:     Str,
	original:     Vec<u8>,
	updated:      String,
	replacements: u32,
	before:       [u8; 32],
	after:        [u8; 32],
}

impl Tool for AstEdit {
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
			if params.ops.is_empty() || params.paths.is_empty() {
				yield done(Err(fault("ops and paths must not be empty")));
				return;
			}
			let mut unique = FastHashSet::default();
			if params
				.ops
				.iter()
				.any(|op| op.pat.trim().is_empty() || !unique.insert(op.pat.clone()))
			{
				yield done(Err(fault("rewrite patterns must be non-empty and unique")));
				return;
			}
			if let Err(error) = incoming.interruptable().committed().await {
				yield commit_event(error);
				return;
			}

			let started = Instant::now();
			let target_patterns = params.paths.iter().map(ToString::to_string).collect::<Vec<_>>();
			let files = match omp_ast::ops::collect_matched_files_filtered_bounded(
				&self.root,
				&target_patterns,
				None,
				MAX_FILES,
			) {
				Ok(files) => files,
				Err(error) => {
					yield done(Err(Fault { message: Str::new(error.to_string()) }));
					return;
				},
			};
			if files.len() > MAX_FILES {
				yield done(Err(fault("ast_edit target exceeds the 200-file hard cap")));
				return;
			}
			if started.elapsed() >= REWRITE_TIMEOUT {
				yield done(Err(fault("ast_edit target discovery timed out after 30s; narrow `paths`")));
				return;
			}
			if let Some(interrupt) = incoming.next_interrupt().now_or_never() {
				yield interrupt_event(interrupt);
				return;
			}

			let files_searched = files.len();
			let root = match self.root.canonicalize() {
				Ok(root) => root,
				Err(error) => {
					yield done(Err(Fault { message: Str::new(error.to_string()) }));
					return;
				},
			};
			let rules_input = params
				.ops
				.iter()
				.map(|op| (op.pat.to_string(), op.out.to_string()))
				.collect::<Vec<_>>();
			let mut compiled = FastHashMap::default();
			let mut prepared = Vec::new();
			let mut advisories = Vec::new();
			let mut advisories_total = 0;
			let mut parse_errors = Vec::new();
			let mut parse_errors_total = 0;
			let mut seen_parse_errors = FastHashSet::default();
			let mut total_source_bytes = 0_u64;

			for file in files {
				if started.elapsed() >= REWRITE_TIMEOUT {
					yield done(Err(fault("ast_edit timed out after 30s; narrow `paths`")));
					return;
				}
				if let Some(interrupt) = incoming.next_interrupt().now_or_never() {
					yield interrupt_event(interrupt);
					return;
				}
				let absolute = match file.absolute_path.canonicalize() {
					Ok(path) if path.starts_with(&root) => path,
					Ok(_) => {
						yield done(Err(fault("ast_edit target escapes the workspace root")));
						return;
					},
					Err(error) => {
						push_advisory(
							&mut advisories,
							&mut advisories_total,
							file.relative_path,
							Str::new(error.to_string()),
						);
						continue;
					},
				};
				let language = match omp_ast::ops::resolve_language(None, &absolute) {
					Ok(language) => language,
					Err(error) => {
						push_advisory(
							&mut advisories,
							&mut advisories_total,
							file.relative_path,
							Str::new(error.to_string()),
						);
						continue;
					},
				};
				let rules = compiled.entry(language).or_insert_with(|| {
					omp_ast::ops::compile_rewrite_rules(&rules_input, language)
						.map_err(|(index, error)| (index, Str::new(error.to_string())))
				});
				let rules = match rules {
					Ok(rules) => rules,
					Err((index, error)) => {
						push_parse_error(
							&mut parse_errors,
							&mut parse_errors_total,
							&mut seen_parse_errors,
							sf!(
								"{}: operation {} pattern does not parse for this language: {}",
								file.relative_path,
								*index + 1,
								error.as_str()
							),
						);
						continue;
					},
				};
				let byte_len = match fs::metadata(&absolute) {
					Ok(metadata) => metadata.len(),
					Err(error) => {
						push_advisory(
							&mut advisories,
							&mut advisories_total,
							file.relative_path,
							Str::new(error.to_string()),
						);
						continue;
					},
				};
				if byte_len > MAX_FILE_BYTES {
					push_advisory(
						&mut advisories,
						&mut advisories_total,
						file.relative_path,
						sf!("file exceeds the {} MiB AST parsing bound", MAX_FILE_BYTES / 1024 / 1024),
					);
					continue;
				}
				total_source_bytes = total_source_bytes.saturating_add(byte_len);
				if total_source_bytes > MAX_TOTAL_SOURCE_BYTES {
					yield done(Err(fault(
						"ast_edit sources exceed the 64 MiB transaction bound; narrow `paths`",
					)));
					return;
				}
				let mut original = Vec::with_capacity(byte_len as usize);
				let read_result = fs::File::open(&absolute).and_then(|file| {
					file
						.take(MAX_FILE_BYTES + 1)
						.read_to_end(&mut original)
						.map(|_| ())
				});
				if let Err(error) = read_result {
					push_advisory(
						&mut advisories,
						&mut advisories_total,
						file.relative_path,
						Str::new(error.to_string()),
					);
					continue;
				}
				if original.len() as u64 > MAX_FILE_BYTES {
					push_advisory(
						&mut advisories,
						&mut advisories_total,
						file.relative_path,
						sf!("file grew beyond the {} MiB AST parsing bound", MAX_FILE_BYTES / 1024 / 1024),
					);
					continue;
				}
				total_source_bytes = total_source_bytes
					.saturating_add((original.len() as u64).saturating_sub(byte_len));
				if total_source_bytes > MAX_TOTAL_SOURCE_BYTES {
					yield done(Err(fault(
						"ast_edit sources exceed the 64 MiB transaction bound; narrow `paths`",
					)));
					return;
				}
				let source = if let Ok(source) = str::from_utf8(&original) { source } else {
					push_advisory(
						&mut advisories,
						&mut advisories_total,
						file.relative_path,
						sf!("non-UTF-8 file skipped"),
					);
					continue;
				};
				let (updated, replacements, has_parse_errors) =
					match omp_ast::ops::rewrite_source_with_parse_status(source, language, rules) {
						Ok(result) => result,
						Err(error) => {
							yield done(Err(Fault { message: Str::new(error.to_string()) }));
							return;
						},
					};
				if has_parse_errors {
					push_parse_error(
						&mut parse_errors,
						&mut parse_errors_total,
						&mut seen_parse_errors,
						sf!("{}: parse error (syntax tree contains error nodes)", file.relative_path),
					);
				}
				if replacements != 0 {
					prepared.push(Prepared {
						absolute,
						relative: file.relative_path,
						before: *Hash32::sum(&original).as_bytes(),
						after: *Hash32::sum(updated.as_bytes()).as_bytes(),
						original,
						updated,
						replacements,
					});
				}
			}
			drop(compiled);
			drop(rules_input);

			let files = prepared
				.iter()
				.map(|prepared| ChangedFile {
					path: prepared.relative.clone(),
					replacements: prepared.replacements,
					before_hash: short_hash(&prepared.before),
					after_hash: short_hash(&prepared.after),
					diff: prepared_diff(prepared),
				})
				.collect::<Vec<_>>();
			let files_touched = files.len();
			let total_replacements = files
				.iter()
				.fold(0_u32, |total, file| total.saturating_add(file.replacements));
			if started.elapsed() >= REWRITE_TIMEOUT {
				yield done(Err(fault("ast_edit timed out after 30s; narrow `paths`")));
				return;
			}
			if let Some(interrupt) = incoming.next_interrupt().now_or_never() {
				yield interrupt_event(interrupt);
				return;
			}
			if prepared.is_empty() {
				let payload = Payload {
					files,
					advisories,
					advisories_total,
					parse_errors,
					parse_errors_total,
					files_searched,
					files_touched,
					total_replacements,
					recovery_root: None,
					pending_proposal: None,
				};
				for diag in diags(&payload) {
					yield Ev::Diag(diag);
				}
				yield done(Ok(payload));
				return;
			}

			let summary = sf!(
				"Pending proposal: ast_edit would apply {total_replacements} replacement(s) to \
				 {files_touched} file(s)."
			);
			let pending = match self.proposals.stage(
				sf!("ast_edit"),
				summary,
				AstEditAction {
					root,
					prepared,
					files: files.clone(),
					advisories: advisories.clone(),
					advisories_total,
					parse_errors: parse_errors.clone(),
					parse_errors_total,
					files_searched,
				},
			).await {
				Ok(pending) => pending,
				Err(error) => {
					yield done(Err(Fault { message: Str::new(error.to_string()) }));
					return;
				},
			};
			let payload = Payload {
				files,
				advisories,
				advisories_total,
				parse_errors,
				parse_errors_total,
				files_searched,
				files_touched,
				total_replacements,
				recovery_root: None,
				pending_proposal: Some(pending.id),
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
		vec![Part::Text {
			text: match view {
				Err(error) => Str::new(error.to_string()),
				Ok(payload) => Str::new(render_payload(payload)),
			},
		}]
	}
}

fn snapshot_all(root: &Path, prepared: &[Prepared]) -> io::Result<()> {
	for item in prepared {
		let target = root.join(item.relative.as_str());
		if let Some(parent) = target.parent() {
			fs::create_dir_all(parent)?;
		}
		fs::write(target, &item.original)?;
	}
	Ok(())
}
struct AstEditAction {
	root:               PathBuf,
	prepared:           Vec<Prepared>,
	files:              Vec<ChangedFile>,
	advisories:         Vec<Advisory>,
	advisories_total:   usize,
	parse_errors:       Vec<Str>,
	parse_errors_total: usize,
	files_searched:     usize,
}

impl StagedProposalAction for AstEditAction {
	fn finalize(&mut self, decision: &ProposalDecision) -> Result<serde_json::Value, ProposalError> {
		if matches!(
			decision,
			ProposalDecision::Reject(
				ProposalRejection::Requested { .. } | ProposalRejection::RegimeLimitReached
			)
		) {
			return Ok(serde_json::json!({ "rejected": true }));
		}
		self.apply().map_err(ProposalError::from)
	}
}

impl AstEditAction {
	fn apply(&self) -> Result<serde_json::Value, ProposalActionError> {
		validate_revisions(&self.prepared)?;
		let generation = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |duration| duration.as_nanos());
		let recovery = self
			.root
			.join(".omp/recovery/ast-edit")
			.join(generation.to_string());
		snapshot_all(&recovery, &self.prepared)
			.map_err(|source| ProposalActionError::Io { path: recovery.clone(), source })?;
		let mut staged = Vec::with_capacity(self.prepared.len());
		for (index, item) in self.prepared.iter().enumerate() {
			let mut temporary = item.absolute.as_os_str().to_os_string();
			temporary.push(format!(".omp-ast-edit-{generation}-{index}"));
			let temporary = PathBuf::from(temporary);
			let result = fs::OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(&temporary)
				.and_then(|mut file| file.write_all(item.updated.as_bytes()))
				.and_then(|()| {
					let permissions = fs::metadata(&item.absolute)?.permissions();
					fs::set_permissions(&temporary, permissions)
				});
			if let Err(source) = result {
				let _ = fs::remove_file(&temporary);
				for staged in &staged {
					let _ = fs::remove_file(staged);
				}
				return Err(ProposalActionError::Io { path: temporary, source });
			}
			staged.push(temporary);
		}
		if let Err(error) = validate_revisions(&self.prepared) {
			for staged in &staged {
				let _ = fs::remove_file(staged);
			}
			return Err(error);
		}
		let mut committed = 0;
		for (item, temporary) in self.prepared.iter().zip(&staged) {
			if let Err(error) = validate_revisions(std::slice::from_ref(item)) {
				for restore in self.prepared[..committed].iter().rev() {
					let _ = fs::write(&restore.absolute, &restore.original);
				}
				for staged in &staged[committed..] {
					let _ = fs::remove_file(staged);
				}
				return Err(error);
			}
			if let Err(source) = fs::rename(temporary, &item.absolute) {
				for restore in self.prepared[..committed].iter().rev() {
					let _ = fs::write(&restore.absolute, &restore.original);
				}
				for staged in &staged[committed..] {
					let _ = fs::remove_file(staged);
				}
				return Err(ProposalActionError::Io { path: item.absolute.clone(), source });
			}
			committed += 1;
		}
		let files = self.files.clone();
		let files_touched = files.len();
		let total_replacements = files
			.iter()
			.fold(0_u32, |total, file| total.saturating_add(file.replacements));
		Ok(serde_json::to_value(Payload {
			files,
			advisories: self.advisories.clone(),
			advisories_total: self.advisories_total,
			parse_errors: self.parse_errors.clone(),
			parse_errors_total: self.parse_errors_total,
			files_searched: self.files_searched,
			files_touched,
			total_replacements,
			recovery_root: Some(Str::from(recovery.to_string_lossy().into_owned())),
			pending_proposal: None,
		})?)
	}
}

fn validate_revisions(prepared: &[Prepared]) -> Result<(), ProposalActionError> {
	for item in prepared {
		let byte_len = fs::metadata(&item.absolute)
			.map_err(|source| ProposalActionError::Io { path: item.absolute.clone(), source })?
			.len();
		if byte_len > MAX_FILE_BYTES {
			return Err(ProposalActionError::RevisionChanged { path: item.absolute.clone() });
		}
		let mut current = Vec::with_capacity(byte_len as usize);
		fs::File::open(&item.absolute)
			.and_then(|file| {
				file
					.take(MAX_FILE_BYTES + 1)
					.read_to_end(&mut current)
					.map(|_| ())
			})
			.map_err(|source| ProposalActionError::Io { path: item.absolute.clone(), source })?;
		if current.len() as u64 > MAX_FILE_BYTES || Hash32::sum(&current).as_bytes() != &item.before {
			return Err(ProposalActionError::RevisionChanged { path: item.absolute.clone() });
		}
	}
	Ok(())
}

fn push_advisory(advisories: &mut Vec<Advisory>, total: &mut usize, path: Str, message: Str) {
	*total = total.saturating_add(1);
	if advisories.len() < MAX_DIAGNOSTICS {
		advisories.push(Advisory { path, message });
	}
}

fn push_parse_error(
	errors: &mut Vec<Str>,
	total: &mut usize,
	seen: &mut FastHashSet<Str>,
	error: Str,
) {
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
	if payload.files.is_empty() {
		output.push_str("No replacements made\n");
	}
	for file in &payload.files {
		use std::fmt::Write as _;
		let _ = writeln!(
			output,
			"{}: {} replacement{} ({} -> {})",
			file.path,
			file.replacements,
			if file.replacements == 1 { "" } else { "s" },
			file.before_hash,
			file.after_hash
		);
		output.push_str(file.diff.as_str());
		if !file.diff.is_empty() && !file.diff.ends_with('\n') {
			output.push('\n');
		}
	}
	{
		use std::fmt::Write as _;
		let _ = writeln!(
			output,
			"[{} replacements in {} files; searched {} files]",
			payload.total_replacements, payload.files_touched, payload.files_searched
		);
		if let Some(id) = &payload.pending_proposal {
			let _ = writeln!(output, "{}", proposal_pending_notice(id));
		}
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
	if payload.files.is_empty() && !payload.parse_errors.is_empty() {
		diags.push(Diag::warn(
			DiagKind::Advisory,
			"Parse issues mean the rewrite may be mis-scoped; narrow `paths` before concluding \
			 absence.",
		));
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
	if let Some(recovery) = &payload.recovery_root {
		let diag = Diag::info(DiagKind::Snapshot, "Recovery snapshot recorded");
		diags.push(if recovery.starts_with("artifact://") {
			diag.artifact(recovery.clone())
		} else {
			Diag::info(DiagKind::Snapshot, sf!("Recovery snapshot recorded at {recovery}"))
		});
	}
	diags
}

fn lift_legacy_call(from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
	if !from.family.is_empty() || from.n != 1 {
		return None;
	}
	let old = serde_json::from_slice::<ParamsV1>(call.raw_args).ok()?;
	let mut raw_args = serde_json::to_value(Params { ops: old.ops, paths: old.paths }).ok()?;
	if let Some(object) = raw_args.as_object_mut() {
		if let Some(intent) = old.i {
			object.insert("i".to_owned(), serde_json::Value::String(intent.to_string()));
		}
		if let Some(notrunc) = old.notrunc {
			object.insert("notrunc".to_owned(), serde_json::Value::Bool(notrunc));
		}
	}
	let verdict = match serde_json::from_slice::<CallOutcome<PayloadV1, Fault>>(call.verdict).ok()? {
		CallOutcome::Ok(payload) => {
			let files_touched = payload.files.len();
			let total_replacements = payload
				.files
				.iter()
				.fold(0_u32, |total, file| total.saturating_add(file.replacements));
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Ok(Payload {
				advisories_total: payload.advisories.len(),
				parse_errors: Vec::new(),
				parse_errors_total: 0,
				files_searched: 0,
				files_touched,
				total_replacements,
				files: payload.files,
				advisories: payload.advisories,
				recovery_root: payload.recovery_root,
				pending_proposal: payload.pending_proposal,
			}))
			.ok()?
		},
		CallOutcome::Faulted(fault) => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Faulted(fault)).ok()?
		},
		CallOutcome::ArgsRejected(issue) => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::ArgsRejected(issue)).ok()?
		},
		CallOutcome::Aborted { abort, kind, policy } => {
			serde_json::to_vec(&CallOutcome::<Payload, Fault>::Aborted { abort, kind, policy }).ok()?
		},
	};
	Some(LiftedCall {
		raw_args: Bytes::from(serde_json::to_vec(&raw_args).ok()?),
		verdict:  Bytes::from(verdict),
	})
}

fn prepared_diff(prepared: &Prepared) -> Str {
	let original = str::from_utf8(&prepared.original).unwrap_or_default();
	let original = omp_edit::text::normalize_to_lf(omp_edit::text::strip_bom(original).1);
	let updated = omp_edit::text::normalize_to_lf(omp_edit::text::strip_bom(&prepared.updated).1);
	omp_edit::diff_string::generate_diff_string(
		&original,
		&updated,
		None,
		&omp_edit::diff_string::BlockContextSource {
			path: Some(prepared.relative.as_str()),
			lang: None,
		},
	)
	.diff
	.into()
}

fn short_hash(hash: &[u8; 32]) -> Str {
	use omp_core::encoding::hex;
	let mut out = [0_u8; 16];
	let count = hex::encode_mut(hash, &mut out);
	Str::new(str::from_utf8(&out[..count.min(12)]).expect("hex is UTF-8"))
}
const fn fault(message: &'static str) -> Fault {
	Fault { message: Str::new_static(message) }
}
fn done(result: Result<Payload, Fault>) -> Ev<Update, Payload, Fault> {
	Ev::Done(ToolTerminal::Done {
		useless: result.as_ref().is_ok_and(|p| p.files.is_empty()),
		result,
	})
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
		ParamError::Protocol(message) => Ev::Args(issue(message)),
	}
}
fn commit_event(error: CommitError) -> Ev<Update, Payload, Fault> {
	match error {
		CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		CommitError::Interrupted(v) => Ev::Aborted(Abort::Interrupted { reason: v.reason }),
		CommitError::Protocol(v) => Ev::Args(issue(v)),
	}
}
fn interrupt_event(
	interrupt: Result<omp_tool::Interrupt, InterruptWaitError>,
) -> Ev<Update, Payload, Fault> {
	match interrupt {
		Ok(interrupt) => Ev::Aborted(Abort::Interrupted { reason: interrupt.reason }),
		Err(InterruptWaitError::Closed) => {
			Ev::Aborted(Abort::Interrupted { reason: sf!("AST edit invocation owner disappeared") })
		},
		Err(InterruptWaitError::Protocol(message)) => Ev::Args(issue(message)),
	}
}

fn issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed JSON argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(
			r#"{{"ops":[{{"pat":"oldApi($$$ARGS)","out":"newApi($$$ARGS)"}}],"paths":["src/**/*.ts"]}}"#
		)),
		found:    Some(message),
	}
}
#[cfg(test)]
mod tests {
	use futures::{StreamExt as _, executor::block_on};
	use omp_tool::{Interrupt, Severity};

	use super::*;

	fn invoke_events(
		root: PathBuf,
		proposals: StagedProposalRegistry,
		raw: &str,
	) -> Vec<Ev<Update, Payload, Fault>> {
		let tool = tool(root, proposals);
		let (feed, incoming) = IncomingParams::channel();
		feed
			.args_committed(Str::new(raw))
			.expect("invocation consumer remains live");
		block_on(tool.call(incoming).collect())
	}

	fn result(events: &[Ev<Update, Payload, Fault>]) -> Result<Payload, Fault> {
		events
			.iter()
			.find_map(|event| match event {
				Ev::Done(ToolTerminal::Done { result, .. }) => Some(result.clone()),
				_ => None,
			})
			.unwrap_or_else(|| panic!("expected terminal ast_edit outcome: {events:?}"))
	}

	fn invoke(
		root: PathBuf,
		proposals: StagedProposalRegistry,
		raw: &str,
	) -> Result<Payload, Fault> {
		result(&invoke_events(root, proposals, raw))
	}

	fn accepting_registry() -> StagedProposalRegistry {
		let proposals = StagedProposalRegistry::new();
		proposals.install_activation_observer(Arc::new(|_| Box::pin(async { Ok(()) })));
		proposals
	}

	fn action(root: &Path, path: &Path, original: &[u8], updated: &str) -> AstEditAction {
		AstEditAction {
			root:               root.to_path_buf(),
			prepared:           vec![Prepared {
				absolute:     path.to_path_buf(),
				relative:     Str::new("sample.rs"),
				original:     original.to_vec(),
				updated:      updated.to_owned(),
				replacements: 1,
				before:       *Hash32::sum(original).as_bytes(),
				after:        *Hash32::sum(updated.as_bytes()).as_bytes(),
			}],
			files:              vec![ChangedFile {
				path:         Str::new("sample.rs"),
				replacements: 1,
				before_hash:  short_hash(Hash32::sum(original).as_bytes()),
				after_hash:   short_hash(Hash32::sum(updated.as_bytes()).as_bytes()),
				diff:         sf!(""),
			}],
			advisories:         Vec::new(),
			advisories_total:   0,
			parse_errors:       Vec::new(),
			parse_errors_total: 0,
			files_searched:     1,
		}
	}

	#[test]
	fn revision_two_schema_is_the_generated_dyn_contract() {
		let spec = spec();
		assert_eq!(spec.rev, Rev { family: Str::default(), n: 2 });
		let schema: serde_json::Value = serde_json::from_slice(&spec.schema).expect("JSON schema");
		for field in ["ops", "paths", "i", "notrunc"] {
			assert!(schema["properties"].get(field).is_some(), "missing generated dyn field {field}");
		}
		assert!(schema.to_string().contains("$$$NAME"));
	}

	#[test]
	fn mixed_language_metavariable_rewrite_is_staged_then_applied_by_exact_id() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		let typescript = temp.path().join("sample.ts");
		let python = temp.path().join("sample.py");
		fs::write(&typescript, "const value = old(1);\n").expect("seed TypeScript");
		fs::write(&python, "value = old(2)\n").expect("seed Python");
		let proposals = accepting_registry();
		let payload = invoke(
			temp.path().to_path_buf(),
			proposals.clone(),
			r#"{"ops":[{"pat":"old($$$ARGS)","out":"new($$$ARGS)"}],"paths":["*.ts","*.py"]}"#,
		)
		.expect("mixed-language preview");
		assert_eq!(payload.files_searched, 2);
		assert_eq!(payload.files_touched, 2);
		assert_eq!(payload.total_replacements, 2);
		assert_eq!(
			fs::read_to_string(&typescript).expect("preview source"),
			"const value = old(1);\n"
		);
		assert_eq!(fs::read_to_string(&python).expect("preview source"), "value = old(2)\n");
		let id = payload.pending_proposal.expect("proposal id");
		assert!(proposals.is_pending(id.as_str()));
		assert!(matches!(
			proposals
				.finalize("pending-action:ast_edit:not-this-proposal", ProposalDecision::Resolve {
					reason: sf!("Wrong proposal."),
				},),
			Err(ProposalError::Unknown)
		));
		assert!(proposals.is_pending(id.as_str()));
		let outcome = proposals
			.finalize(id.as_str(), ProposalDecision::Resolve {
				reason: sf!("Apply the reviewed mixed-language edit."),
			})
			.expect("exact proposal resolves");
		let applied: Payload = serde_json::from_value(outcome.payload).expect("typed apply payload");
		assert_eq!(applied.total_replacements, 2);
		assert!(applied.recovery_root.is_some());
		let applied_diags = diags(&applied);
		assert!(applied_diags.iter().any(|diag| {
			diag.native_kind() == Some(DiagKind::Snapshot)
				&& diag.severity == Severity::Info
				&& diag.artifact.is_none()
				&& diag
					.text
					.contains(applied.recovery_root.as_deref().expect("recovery root"))
		}));
		assert!(!render_payload(&applied).contains("recovery snapshot"));
		assert_eq!(
			fs::read_to_string(&typescript).expect("applied TypeScript"),
			"const value = new(1);\n"
		);
		assert_eq!(fs::read_to_string(&python).expect("applied Python"), "value = new(2)\n");
	}

	#[test]
	fn pattern_parse_diagnostics_are_non_fatal_and_separate_from_results() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		fs::write(temp.path().join("source.ts"), "old(1);\n").expect("seed source");
		let payload = invoke(
			temp.path().to_path_buf(),
			accepting_registry(),
			r#"{"ops":[{"pat":"old(","out":"new($A)"}],"paths":["source.ts"]}"#,
		)
		.expect("pattern parse issue remains non-terminal");
		assert_eq!(payload.total_replacements, 0);
		assert_eq!(payload.parse_errors_total, 1);
		assert!(payload.parse_errors[0].contains("operation 1 pattern does not parse"));
	}

	#[test]
	fn source_parse_diagnostics_are_non_fatal_and_separate_from_results() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		fs::write(temp.path().join("broken.ts"), "export function broken( { return 1; }")
			.expect("seed broken source");
		let events = invoke_events(
			temp.path().to_path_buf(),
			accepting_registry(),
			r#"{"ops":[{"pat":"unlikely($A)","out":"likely($A)"}],"paths":["broken.ts"]}"#,
		);
		let payload = result(&events).expect("parse issue remains non-terminal");
		assert_eq!(payload.total_replacements, 0);
		assert_eq!(payload.parse_errors_total, 1);
		assert!(payload.parse_errors[0].contains("broken.ts: parse error"));
		assert_eq!(
			render_payload(&payload),
			"No replacements made\n[0 replacements in 0 files; searched 1 files]"
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
					&& diag.text.contains("rewrite may be mis-scoped")
		)));
	}

	#[test]
	fn oversized_files_are_skipped_before_materialization() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		let path = temp.path().join("large.ts");
		let file = fs::File::create(&path).expect("create large source");
		file
			.set_len(MAX_FILE_BYTES + 1)
			.expect("make sparse large source");
		let events = invoke_events(
			temp.path().to_path_buf(),
			accepting_registry(),
			r#"{"ops":[{"pat":"old($A)","out":"new($A)"}],"paths":["large.ts"]}"#,
		);
		let payload = result(&events).expect("large file produces advisory");
		assert_eq!(payload.advisories_total, 1);
		assert!(payload.advisories[0].message.contains("8 MiB"));
		assert!(events.iter().any(|event| matches!(
			event,
			Ev::Diag(diag)
				if diag.native_kind() == Some(DiagKind::Advisory)
					&& diag.severity == Severity::Warn
					&& diag.text.contains("large.ts")
					&& diag.text.contains("8 MiB")
		)));
	}

	#[test]
	fn diagnostic_caps_and_artifact_snapshot_keep_typed_fields() {
		let payload = Payload {
			files:              Vec::new(),
			advisories:         vec![Advisory {
				path:    sf!("unknown.ext"),
				message: sf!("unsupported language"),
			}],
			advisories_total:   3,
			parse_errors:       vec![sf!("broken.ts: parse error")],
			parse_errors_total: 4,
			files_searched:     7,
			files_touched:      0,
			total_replacements: 0,
			recovery_root:      Some(sf!(
				"artifact://sha256/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
			)),
			pending_proposal:   None,
		};
		let diagnostics = diags(&payload);
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
		assert!(diagnostics.iter().any(|diag| {
			diag.native_kind() == Some(DiagKind::Snapshot)
				&& diag.severity == Severity::Info
				&& diag.artifact.as_deref() == payload.recovery_root.as_deref()
				&& !diag.text.contains("artifact://")
		}));
		assert_eq!(
			render_payload(&payload),
			"No replacements made\n[0 replacements in 0 files; searched 7 files]"
		);
	}

	#[test]
	fn committed_edit_observes_runtime_interrupts() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		fs::write(temp.path().join("source.ts"), "old(1);\n").expect("seed source");
		let tool = tool(temp.path().to_path_buf(), accepting_registry());
		let (feed, incoming) = IncomingParams::channel();
		feed
			.args_committed(Str::new_static(
				r#"{"ops":[{"pat":"old($A)","out":"new($A)"}],"paths":["source.ts"]}"#,
			))
			.expect("commit args");
		feed
			.interrupt(Interrupt { class: sf!("user"), reason: sf!("stop edit") })
			.expect("send interrupt");
		let events = block_on(tool.call(incoming).collect::<Vec<_>>());
		assert!(matches!(
			events.as_slice(),
			[Ev::Aborted(Abort::Interrupted { reason })] if reason == "stop edit"
		));
		assert_eq!(
			fs::read_to_string(temp.path().join("source.ts")).expect("source remains"),
			"old(1);\n"
		);
	}

	#[test]
	fn lifts_revision_one_payload_and_protocol_fields() {
		let tool = tool(PathBuf::from("."), StagedProposalRegistry::new());
		let raw_args = br#"{"i":"Modernizing calls","notrunc":true,"ops":[{"pat":"old($A)","out":"new($A)"}],"paths":["src/**/*.ts"]}"#;
		let verdict = br#"{"kind":"ok","value":{"files":[],"advisories":[],"recovery_root":null,"pending_proposal":null}}"#;
		let lifted = tool
			.lift(&Rev { family: Str::default(), n: 1 }, RecordedCall { raw_args, verdict })
			.expect("revision one lifts");
		let args: serde_json::Value = serde_json::from_slice(&lifted.raw_args).expect("lifted args");
		assert_eq!(args["i"], "Modernizing calls");
		assert_eq!(args["notrunc"], true);
		let outcome: CallOutcome<Payload, Fault> =
			serde_json::from_slice(&lifted.verdict).expect("lifted verdict");
		let CallOutcome::Ok(payload) = outcome else {
			panic!("expected lifted success")
		};
		assert_eq!(payload.total_replacements, 0);
		assert_eq!(payload.files_searched, 0);
	}

	#[test]
	fn staged_action_mutates_only_after_resolve_and_regime_limit_is_effect_free() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		let path = temp.path().join("sample.rs");
		let original = b"fn old() {}\n";
		fs::write(&path, original).expect("seed source");

		let mut rejected = action(temp.path(), &path, original, "fn new() {}\n");
		rejected
			.finalize(&ProposalDecision::Reject(ProposalRejection::RegimeLimitReached))
			.expect("proposal rejected");
		assert_eq!(fs::read(&path).expect("source readable"), original);

		let mut resolved = action(temp.path(), &path, original, "fn new() {}\n");
		let payload = resolved
			.finalize(&ProposalDecision::Resolve {
				reason: Str::new_static("Apply the reviewed rewrite."),
			})
			.expect("proposal resolved");
		assert_eq!(fs::read_to_string(&path).expect("source readable"), "fn new() {}\n");
		assert_eq!(payload["files"][0]["path"], "sample.rs");
		assert!(payload["recovery_root"].as_str().is_some());
	}

	#[test]
	fn resolve_rechecks_every_staged_source_revision() {
		let temp = tempfile::tempdir().expect("temporary workspace");
		let path = temp.path().join("sample.rs");
		let original = b"fn old() {}\n";
		fs::write(&path, original).expect("seed source");
		let mut staged = action(temp.path(), &path, original, "fn new() {}\n");
		fs::write(&path, "fn concurrent() {}\n").expect("concurrent edit");
		assert!(matches!(
			staged.finalize(&ProposalDecision::Resolve {
				reason: sf!("Apply only if the preview is current."),
			}),
			Err(ProposalError::Action(ProposalActionError::RevisionChanged { .. }))
		));
		assert_eq!(
			fs::read_to_string(&path).expect("concurrent source remains"),
			"fn concurrent() {}\n"
		);
	}
}
