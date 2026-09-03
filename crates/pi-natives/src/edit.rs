//! N-API surface for the Rust edit engine (`pi_edit`).
//!
//! # Overview
//! One [`EditSession`] per edit tool call: the agent loop feeds raw streamed
//! argument fragments through [`EditSession::push`], a background pump
//! computes per-file diff previews off the JS thread and delivers them via
//! the `onPreview` callback, and [`EditSession::apply`] stages the finished
//! edit in memory and writes every file through the host-owned `writer`
//! callback (LSP writethrough / ACP bridge stay in TypeScript).
//!
//! [`EditStore`] holds the session-wide snapshot/clipboard/no-op state that
//! read-side tools populate. The remaining exports are pure helpers used by
//! the TypeScript tool shell (matcher projection, prompts, hashline display
//! formatting, notebook decoding).

use std::{
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use async_trait::async_trait;
use napi::{
	bindgen_prelude::{Promise, Result},
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use pi_edit::{
	EditError, EditMode, EditResult, PathPolicy, Session,
	diff_string::{BlockContextSource, generate_diff_string},
	modes::{hashline, sloppy},
	path_policy::canonical_key,
	session::{ApplyRequest, EditWriter, PreviewBatch, SessionConfig, WriteRequest, WriteResponse},
	store,
	stream_json::snapshot_from_text,
	text::normalize_to_lf,
};

fn parse_mode(mode: &str) -> Result<EditMode> {
	EditMode::parse(mode)
		.ok_or_else(|| napi::Error::from_reason(format!("Unknown edit mode: {mode}")))
}

fn reason(err: impl std::fmt::Display) -> napi::Error {
	napi::Error::from_reason(err.to_string())
}

// ═══════════════════════════════════════════════════════════════════════════
// Policy and result objects
// ═══════════════════════════════════════════════════════════════════════════

/// A cached `vault://` root.
#[napi(object)]
pub struct EditVaultRoot {
	/// Vault name; `_` is the active vault.
	pub name: String,
	pub root: String,
}

/// Session-wide policy; TypeScript builds it once per tool call.
#[napi(object)]
pub struct EditPolicy {
	pub cwd:                  String,
	/// `replace` | `patch` | `apply_patch` | `hashline` | `sloppy`.
	pub mode:                 String,
	pub allow_fuzzy:          bool,
	pub fuzzy_threshold:      f64,
	pub enforce_seen_lines:   bool,
	pub block_auto_generated: bool,
	pub plan_active:          bool,
	/// Root of the `local://` artifact sandbox; null when the session has none.
	pub local_sandbox_root:   Option<String>,
	/// Cached vault roots; null when the vault protocol is disabled.
	pub vault_roots:          Option<Vec<EditVaultRoot>>,
	pub home_dir:             String,
	/// The payload is a verbatim custom-format string, not JSON.
	pub raw_input:            bool,
}

impl EditPolicy {
	fn into_config(self) -> Result<SessionConfig> {
		Ok(SessionConfig {
			mode:               parse_mode(&self.mode)?,
			policy:             PathPolicy {
				cwd:                  PathBuf::from(self.cwd),
				home_dir:             PathBuf::from(self.home_dir),
				local_sandbox_root:   self.local_sandbox_root.map(PathBuf::from),
				vault_roots:          self.vault_roots.map(|roots| {
					roots
						.into_iter()
						.map(|r| (r.name, PathBuf::from(r.root)))
						.collect()
				}),
				plan_active:          self.plan_active,
				block_auto_generated: self.block_auto_generated,
			},
			allow_fuzzy:        self.allow_fuzzy,
			fuzzy_threshold:    self.fuzzy_threshold,
			enforce_seen_lines: self.enforce_seen_lines,
			raw_input:          self.raw_input,
		})
	}
}

/// One file's streamed diff preview.
#[napi(object)]
pub struct EditFilePreview {
	/// Display path as authored (after suffix recovery).
	pub path:               String,
	/// Numbered unified diff; mutually exclusive with `error`.
	pub diff:               Option<String>,
	pub first_changed_line: Option<u32>,
	/// Model-facing error text.
	pub error:              Option<String>,
	/// `create` | `update` | `delete`.
	pub op:                 Option<String>,
	pub rename:             Option<String>,
}

/// A batch of previews for one session generation.
#[napi(object)]
pub struct EditPreviewBatch {
	/// Monotonically increasing per session.
	pub generation: u32,
	/// False for the final untrimmed pass after `finish()`.
	pub streaming:  bool,
	pub files:      Vec<EditFilePreview>,
}

impl From<PreviewBatch> for EditPreviewBatch {
	fn from(batch: PreviewBatch) -> Self {
		Self {
			generation: batch.generation,
			streaming:  batch.streaming,
			files:      batch
				.files
				.into_iter()
				.map(|file| EditFilePreview {
					path:               file.display,
					diff:               file.diff,
					first_changed_line: file.first_changed_line,
					error:              file.error,
					op:                 file.op.map(|op| op.as_str().to_owned()),
					rename:             file.rename,
				})
				.collect(),
		}
	}
}

/// Host write request; the host owns the bytes.
#[napi(object)]
pub struct EditWriteRequest {
	/// Absolute path.
	pub path:         String,
	pub display_path: String,
	/// `create` | `update` | `delete` | `move`.
	pub op:           String,
	/// Absolute destination for `move` (write `content` there, delete `path`).
	pub move_to:      Option<String>,
	/// Final bytes as text; null for `delete`.
	pub content:      Option<String>,
	/// Last write of this call and the LSP batch requested a flush.
	pub flush_lsp:    bool,
	pub lsp_batch_id: Option<String>,
}

/// Host write response.
#[napi(object)]
pub struct EditWriteResponse {
	/// Text actually persisted (a bridge may reformat); empty for deletes.
	pub written:          String,
	/// `FileDiagnosticsResult` serialized by the host; opaque here.
	pub diagnostics_json: Option<String>,
}

/// Apply-time knobs.
#[napi(object)]
pub struct EditApplyRequest {
	pub lsp_batch_id: Option<String>,
	pub lsp_flush:    bool,
}

/// One file's apply outcome.
#[napi(object)]
pub struct EditFileOutcome {
	/// Absolute path.
	pub path:               String,
	pub display_path:       String,
	/// `create` | `update` | `delete`.
	pub op:                 String,
	pub move_to:            Option<String>,
	pub diff:               String,
	pub first_changed_line: Option<u32>,
	pub old_text:           Option<String>,
	pub new_text:           Option<String>,
	pub snapshots_pruned:   bool,
	pub diagnostics_json:   Option<String>,
	/// Engine warnings (already rendered into `text`).
	pub warnings:           Vec<String>,
	/// Model-facing text for this file.
	pub text:               String,
	/// The file parsed before the edit and no longer does.
	pub parse_regressed:    bool,
}

/// Whole-call apply outcome. `is_error` carries the model-facing failure in
/// `text` with no files.
#[napi(object)]
pub struct EditApplyOutcome {
	pub text:     String,
	pub files:    Vec<EditFileOutcome>,
	pub is_error: bool,
}

// ═══════════════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════════════

/// Session-scoped snapshots, clipboard registers, and the no-op loop guard.
#[napi]
#[derive(Default)]
pub struct EditStore {
	inner: pi_edit::EditStore,
}

#[napi]
impl EditStore {
	#[napi(constructor)]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record `text` (any line endings) as the current snapshot of
	/// `absolutePath` and return its 4-hex tag.
	#[napi]
	pub fn record_snapshot(
		&self,
		absolute_path: String,
		text: String,
		seen_lines: Option<Vec<u32>>,
	) -> String {
		let key = canonical_key(Path::new(&absolute_path));
		let (_, body) = pi_edit::text::strip_bom(&text);
		self
			.inner
			.record(&key, &normalize_to_lf(body), seen_lines.as_deref())
	}

	/// Read `absolutePath` from disk and record it; null when the file is
	/// unreadable or larger than 4 MiB.
	#[napi]
	pub fn record_snapshot_file(
		&self,
		absolute_path: String,
		seen_lines: Option<Vec<u32>>,
	) -> Option<String> {
		self
			.inner
			.record_file(Path::new(&absolute_path), seen_lines.as_deref())
	}

	/// Merge displayed lines into the snapshot tagged `tag`.
	#[napi]
	pub fn record_seen_lines(&self, absolute_path: String, tag: String, lines: Vec<u32>) {
		self
			.inner
			.record_seen_lines(&canonical_key(Path::new(&absolute_path)), &tag, &lines);
	}

	/// Merge the lines a hashline-formatted `body` displays into the
	/// snapshot tagged `tag`.
	#[napi]
	pub fn record_seen_lines_from_body(&self, absolute_path: String, tag: String, body: String) {
		let lines = store::seen_lines_from_body(&body);
		if !lines.is_empty() {
			self
				.inner
				.record_seen_lines(&canonical_key(Path::new(&absolute_path)), &tag, &lines);
		}
	}

	/// Latest recorded text for `absolutePath`.
	#[napi]
	pub fn head_text(&self, absolute_path: String) -> Option<String> {
		self
			.inner
			.head(&canonical_key(Path::new(&absolute_path)))
			.map(|s| s.text.to_string())
	}

	/// Latest recorded tag for `absolutePath`.
	#[napi]
	pub fn head_hash(&self, absolute_path: String) -> Option<String> {
		self
			.inner
			.head(&canonical_key(Path::new(&absolute_path)))
			.map(|s| s.hash)
	}

	/// Recorded text of `absolutePath` tagged `hash`.
	#[napi]
	pub fn by_hash_text(&self, absolute_path: String, hash: String) -> Option<String> {
		self
			.inner
			.by_hash(&canonical_key(Path::new(&absolute_path)), &hash)
			.map(|s| s.text.to_string())
	}

	/// Displayed lines recorded for the snapshot tagged `hash`; null when no
	/// provenance was recorded.
	#[napi]
	pub fn seen_lines(&self, absolute_path: String, hash: String) -> Option<Vec<u32>> {
		self
			.inner
			.by_hash(&canonical_key(Path::new(&absolute_path)), &hash)
			.and_then(|s| s.seen_lines.map(|set| set.into_iter().collect()))
	}

	#[napi]
	pub fn invalidate(&self, absolute_path: String) {
		self
			.inner
			.invalidate(&canonical_key(Path::new(&absolute_path)));
	}

	#[napi]
	pub fn relocate(&self, from: String, to: String) {
		self
			.inner
			.relocate(&canonical_key(Path::new(&from)), &canonical_key(Path::new(&to)));
	}

	#[napi]
	pub fn clear(&self) {
		self.inner.clear();
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Session
// ═══════════════════════════════════════════════════════════════════════════

type PreviewCallback = ThreadsafeFunction<EditPreviewBatch, UnknownReturnValue>;
type WriterCallback = ThreadsafeFunction<EditWriteRequest, Promise<EditWriteResponse>>;

/// Argument mutations queued on the JS thread and drained into the session
/// under its lock, preserving arrival order without ever blocking JS.
enum ArgOp {
	Push(String),
	SetArgs(String),
	Finish,
}

struct Shared {
	session: napi::tokio::sync::Mutex<Session>,
	queue:   parking_lot::Mutex<Vec<ArgOp>>,
	closed:  AtomicBool,
	wake:    flume::Sender<()>,
}

impl Shared {
	fn enqueue(&self, op: ArgOp) {
		self.queue.lock().push(op);
		let _ = self.wake.try_send(());
	}

	/// Apply every queued mutation to the locked session.
	fn drain_into(&self, session: &mut Session) {
		let ops = std::mem::take(&mut *self.queue.lock());
		for op in ops {
			match op {
				ArgOp::Push(delta) => session.push(&delta),
				ArgOp::SetArgs(json) => session.set_args_json(&json),
				ArgOp::Finish => session.finish(),
			}
		}
	}
}

/// Bridges the host writer callback into the engine's writer trait.
struct TsfnWriter {
	tsfn: WriterCallback,
}

#[async_trait]
impl EditWriter for TsfnWriter {
	async fn write(&self, request: WriteRequest) -> EditResult<WriteResponse> {
		let op = if request.move_to.is_some() {
			"move"
		} else {
			request.op.as_str()
		};
		let payload = EditWriteRequest {
			path:         request.absolute.to_string_lossy().into_owned(),
			display_path: request.display,
			op:           op.to_owned(),
			move_to:      request.move_to.map(|p| p.to_string_lossy().into_owned()),
			content:      request.content,
			flush_lsp:    request.flush_lsp,
			lsp_batch_id: request.lsp_batch_id,
		};
		let promise = self
			.tsfn
			.call_async(Ok(payload))
			.await
			.map_err(|err| EditError::Writer(err.reason))?;
		let response = promise.await.map_err(|err| EditError::Writer(err.reason))?;
		Ok(WriteResponse {
			written:          response.written,
			diagnostics_json: response.diagnostics_json,
		})
	}
}

/// One edit tool call's streaming session.
#[napi]
pub struct EditSession {
	shared: Arc<Shared>,
}

#[napi]
impl EditSession {
	/// Open a session. `onPreview` (optional) receives every settled preview
	/// batch; batches are delivered one at a time, in generation order.
	#[napi(constructor)]
	pub fn new(
		store: &EditStore,
		policy: EditPolicy,
		#[napi(ts_arg_type = "((error: Error | null, batch: EditPreviewBatch) => void) | \
		                      undefined | null")]
		on_preview: Option<PreviewCallback>,
	) -> Result<Self> {
		let config = policy.into_config()?;
		let (wake, rx) = flume::bounded::<()>(1);
		let shared = Arc::new(Shared {
			session: napi::tokio::sync::Mutex::new(Session::new(config, store.inner.clone())),
			queue: parking_lot::Mutex::new(Vec::new()),
			closed: AtomicBool::new(false),
			wake,
		});
		if let Some(on_preview) = on_preview {
			napi::bindgen_prelude::spawn(preview_pump(Arc::clone(&shared), rx, on_preview));
		}
		Ok(Self { shared })
	}

	/// Append a raw streamed argument fragment.
	#[napi]
	pub fn push(&self, delta: String) {
		self.shared.enqueue(ArgOp::Push(delta));
	}

	/// Replace the buffer with the complete argument JSON (no-delta path).
	#[napi]
	pub fn set_args_json(&self, args_json: String) {
		self.shared.enqueue(ArgOp::SetArgs(args_json));
	}

	/// Arguments are complete; triggers the final untrimmed preview.
	#[napi]
	pub fn finish(&self) {
		self.shared.enqueue(ArgOp::Finish);
	}

	/// Stage and apply the finished edit through `writer`. Never rejects for
	/// engine failures: those come back as `isError` outcomes carrying the
	/// model-facing message.
	#[napi]
	pub async fn apply(
		&self,
		request: EditApplyRequest,
		#[napi(ts_arg_type = "(error: Error | null, request: EditWriteRequest) => \
		                      Promise<EditWriteResponse>")]
		writer: WriterCallback,
	) -> Result<EditApplyOutcome> {
		self.shared.closed.store(true, Ordering::Release);
		let _ = self.shared.wake.try_send(());
		let shared = Arc::clone(&self.shared);
		let mut session = shared.session.lock().await;
		shared.drain_into(&mut session);
		let writer = TsfnWriter { tsfn: writer };
		let outcome = session
			.apply(
				ApplyRequest { lsp_batch_id: request.lsp_batch_id, lsp_flush: request.lsp_flush },
				&writer,
			)
			.await;
		Ok(match outcome {
			Ok(outcome) => EditApplyOutcome {
				text:     outcome.text,
				files:    outcome
					.files
					.into_iter()
					.map(|file| EditFileOutcome {
						path:               file.absolute.to_string_lossy().into_owned(),
						display_path:       file.display,
						op:                 file.op.as_str().to_owned(),
						move_to:            file.move_to.map(|p| p.to_string_lossy().into_owned()),
						diff:               file.diff,
						first_changed_line: file.first_changed_line,
						old_text:           file.old_text,
						new_text:           file.new_text,
						snapshots_pruned:   file.snapshots_pruned,
						diagnostics_json:   file.diagnostics_json,
						warnings:           file.warnings,
						text:               file.text,
						parse_regressed:    file.parse_regressed,
					})
					.collect(),
				is_error: false,
			},
			Err(err) => {
				EditApplyOutcome { text: err.to_string(), files: Vec::new(), is_error: true }
			},
		})
	}

	/// Stop the preview pump and release buffers.
	#[napi]
	pub fn close(&self) {
		self.shared.closed.store(true, Ordering::Release);
		let _ = self.shared.wake.try_send(());
	}
}

/// Preview pump: wait for a wake, compute the preview for the newest
/// buffer on the blocking pool, deliver it, and repeat until the final
/// (post-`finish`) pass ran or the session closed. One callback is in
/// flight at a time so the JS event loop's consumption rate backpressures
/// preview work.
async fn preview_pump(shared: Arc<Shared>, rx: flume::Receiver<()>, on_preview: PreviewCallback) {
	while rx.recv_async().await.is_ok() {
		while rx.try_recv().is_ok() {}
		if shared.closed.load(Ordering::Acquire) {
			return;
		}
		let compute = Arc::clone(&shared);
		let batch = napi::bindgen_prelude::spawn_blocking(move || {
			let mut session = compute.session.blocking_lock();
			compute.drain_into(&mut session);
			if !session.preview_pending() {
				return None;
			}
			Some(session.preview())
		})
		.await;
		let Ok(Some(batch)) = batch else {
			continue;
		};
		let is_final = !batch.streaming;
		if shared.closed.load(Ordering::Acquire) {
			return;
		}
		if !batch.files.is_empty() || is_final {
			let delivered = on_preview
				.call_async(Ok(EditPreviewBatch::from(batch)))
				.await;
			if delivered.is_err() {
				return;
			}
		}
		if is_final {
			return;
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers
// ═══════════════════════════════════════════════════════════════════════════

/// `(path, added-lines digest)` for stream matchers.
#[napi(object)]
pub struct EditMatcherEntry {
	pub path:   String,
	pub digest: String,
}

/// A destructive file operation a payload declares.
#[napi(object)]
pub struct EditFileOpIntent {
	/// `delete` | `move`.
	pub kind: String,
	pub path: String,
	pub to:   Option<String>,
}

/// Static projection of a payload: target paths, per-file digests, and
/// delete/move intents.
#[napi(object)]
pub struct EditInspection {
	pub paths:    Vec<String>,
	pub entries:  Vec<EditMatcherEntry>,
	pub file_ops: Vec<EditFileOpIntent>,
}

/// Inspect `argsJson` (the JSON-serialized, possibly partial tool args)
/// without touching the filesystem.
#[napi]
pub fn edit_inspect(mode: String, args_json: String) -> Result<EditInspection> {
	let mode = parse_mode(&mode)?;
	let snapshot = snapshot_from_text(&args_json, false, true);
	let engine = pi_edit::modes::engine_for(mode, true, 0.95, false);
	let inspection = engine.inspect(&snapshot);
	Ok(EditInspection {
		paths:    inspection.paths,
		entries:  inspection
			.entries
			.into_iter()
			.map(|(path, digest)| EditMatcherEntry { path, digest })
			.collect(),
		file_ops: inspection
			.file_ops
			.into_iter()
			.map(|op| match op {
				pi_edit::FileOpIntent::Delete { path } => {
					EditFileOpIntent { kind: "delete".into(), path, to: None }
				},
				pi_edit::FileOpIntent::Move { from, to } => {
					EditFileOpIntent { kind: "move".into(), path: from, to: Some(to) }
				},
			})
			.collect(),
	})
}

/// Numbered unified diff plus the first changed line.
#[napi(object)]
pub struct EditDiffResult {
	pub diff:               String,
	pub first_changed_line: Option<u32>,
}

/// Numbered unified diff between two texts (`generateDiffString`).
#[napi]
pub fn edit_diff_string(
	old_text: String,
	new_text: String,
	path: Option<String>,
) -> EditDiffResult {
	let output = generate_diff_string(&old_text, &new_text, None, &BlockContextSource {
		path: path.as_deref(),
		lang: None,
	});
	EditDiffResult { diff: output.diff, first_changed_line: output.first_changed_line }
}

/// Tool description markdown for `mode`.
#[napi]
pub fn edit_description(mode: String) -> Result<String> {
	Ok(pi_edit::description(parse_mode(&mode)?).to_owned())
}

/// Lark grammar for `mode`, when it has a custom wire format.
#[napi]
pub fn edit_grammar(mode: String) -> Result<Option<String>> {
	Ok(pi_edit::grammar(parse_mode(&mode)?).map(str::to_owned))
}

/// Auto-generated-file guard: the rejection message when `absolutePath`
/// (displayed as `displayPath`) must not be edited, else null. Missing or
/// unreadable files are editable.
#[napi]
pub fn edit_auto_generated_message(absolute_path: String, display_path: String) -> Option<String> {
	let policy = PathPolicy {
		cwd:                  PathBuf::new(),
		home_dir:             PathBuf::new(),
		local_sandbox_root:   None,
		vault_roots:          None,
		plan_active:          false,
		block_auto_generated: true,
	};
	let mut head = [0u8; 1024];
	let read = std::fs::File::open(&absolute_path)
		.and_then(|mut file| {
			use std::io::Read;
			let mut total = 0;
			loop {
				let n = file.read(&mut head[total..])?;
				if n == 0 {
					break;
				}
				total += n;
				if total == head.len() {
					break;
				}
			}
			Ok(total)
		})
		.ok()?;
	policy.auto_generated_message(&display_path, &head[..read])
}

/// One stray sloppy payload region inside prose (UTF-16 offsets).
#[napi(object)]
pub struct InlineSloppyRegion {
	pub start:   u32,
	pub end:     u32,
	pub payload: String,
}

/// Locate `<SM:EDIT path="…">` payloads the model emitted as plain text.
#[napi]
pub fn extract_inline_sloppy_regions(text: String) -> Vec<InlineSloppyRegion> {
	sloppy::parse::extract_inline_sloppy_regions(&text)
		.into_iter()
		.map(|r| InlineSloppyRegion {
			start:   r.start as u32,
			end:     r.end as u32,
			payload: r.payload,
		})
		.collect()
}

/// 4-hex hashline content tag for `text`.
#[napi]
pub fn hashline_file_hash(text: String) -> String {
	let (_, body) = pi_edit::text::strip_bom(&text);
	store::file_hash(&normalize_to_lf(body))
}

/// `[path#TAG]` section header.
#[napi]
pub fn hashline_format_header(path: String, tag: String) -> String {
	hashline::format::format_hashline_header(&path, &tag)
}

/// `N:line` numbered display rows starting at `startLine` (default 1).
#[napi]
pub fn hashline_format_numbered_lines(text: String, start_line: Option<u32>) -> String {
	hashline::format::format_numbered_lines(&text, start_line.unwrap_or(1))
}

/// Strip hashline display prefixes (`N:` / `+N:` …) from pasted rows.
#[napi]
pub fn hashline_strip_prefixes(lines: Vec<String>) -> Vec<String> {
	hashline::prefixes::strip_hashline_prefixes(&lines)
}

/// Count of one canonical hashline op header shape in a payload.
#[napi(object)]
pub struct HashlineOpCount {
	pub label: String,
	pub count: u32,
}

/// Count canonical hashline op header shapes (`PUT N.=M:`, `CUT N*`, …) in
/// a payload; empty when it carries no hashline ops.
#[napi]
pub fn hashline_count_ops(input: String) -> Vec<HashlineOpCount> {
	let mut counts: Vec<HashlineOpCount> = Vec::new();
	for label in hashline::tokenizer::op_labels(&input) {
		match counts.iter_mut().find(|entry| entry.label == label) {
			Some(entry) => entry.count += 1,
			None => counts.push(HashlineOpCount { label, count: 1 }),
		}
	}
	counts
}

/// Decode notebook JSON into the editable cell-marker text.
#[napi]
pub fn notebook_to_editable_text(json: String, display_path: String) -> Result<String> {
	pi_edit::notebook::notebook_to_editable_text(&json, &display_path).map_err(reason)
}
