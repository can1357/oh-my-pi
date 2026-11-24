//! Activity scans over session transcripts (JSONL), exported via N-API.
//!
//! Tool calls with their results and the reasoning before them, regex matches
//! over message text, thinking, call arguments, and results, call counts, and
//! one transcript's records back `archive.calls`, `grep`, `stats`, and
//! `messages`. The caller picks the transcripts (project, time window,
//! subagents); this module reads them in parallel.
//!
//! A line is classified from its head before any parse: entries other than
//! `session` and `message`, and message roles a scan does not need, are never
//! decoded. Each file is one blocking job on Tokio's pool; the export settles
//! a Promise and never holds the JS thread. Capped scans read files newest
//! first in batches and stop once the next batch is older than every hit they
//! keep.

use std::{
	borrow::Cow, collections::HashMap, fmt, fs, marker::PhantomData, num::NonZero, sync::Arc,
};

use grep_matcher::{Match, Matcher};
use jiff::{Timestamp, tz::TimeZone};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use omp_xfs::grep::Engine;
use serde::{
	Deserialize, Deserializer,
	de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Value, value::RawValue};

use crate::{task, utils::clamp_u32};

/// Characters a long tool result keeps from each end in returned records.
const RESULT_EDGE: usize = 500;
/// Characters a long string argument keeps from each end in returned records.
const ARGUMENT_EDGE: usize = 2000;
/// Characters of reasoning a call keeps, from its end: the part nearest the
/// call.
const REASONING_CHARS: usize = 4000;
/// Characters a match snippet keeps on each side of the match.
const SNIPPET_CHARS: usize = 100;
/// Stands in for the cut middle of a long text.
const CUT_MARK: &str = "\n…\n";
/// Leading bytes of a message line searched for its role before a full parse.
const ROLE_PROBE_BYTES: usize = 1024;

// ─────────────────────────────────────────────────────────────────────────────
// N-API surface
// ─────────────────────────────────────────────────────────────────────────────

/// A transcript to scan.
#[napi(object)]
pub struct TranscriptFile {
	/// JSONL file.
	pub path:   String,
	/// Unix milliseconds of its newest activity (its mtime): capped scans read
	/// files newest first and skip those older than every hit they keep.
	pub newest: f64,
}

/// Session header of a scanned transcript.
#[napi(object)]
pub struct TranscriptHeader {
	/// Index of the transcript in `files`.
	pub file: u32,
	pub id:   String,
	pub cwd:  String,
}

/// Which tool calls count; omitted fields match every call.
#[napi(object, object_to_js = false)]
pub struct TranscriptCallFilter {
	/// Tool names.
	pub tools:  Option<Vec<String>>,
	/// Regex matching some string inside the arguments.
	pub args:   Option<String>,
	/// Regex matching the whole result text.
	pub result: Option<String>,
	/// `true` keeps failed calls, `false` succeeded ones; a call without a
	/// result matches neither.
	pub error:  Option<bool>,
}

/// Regex dialect of a scan: the grep tool's (Rust `regex`, PCRE2 for
/// look-around and back-references).
#[napi(object, object_to_js = false)]
pub struct TranscriptRegexFlags {
	/// Case-insensitive matching.
	pub ignore_case: Option<bool>,
	/// `.` matches newlines and matches may span lines.
	pub dot_all:     Option<bool>,
}

/// Options for [`transcript_calls`].
#[napi(object, object_to_js = false)]
pub struct TranscriptCallsOptions<'env> {
	pub files:  Vec<TranscriptFile>,
	/// Unix milliseconds; calls made earlier are skipped.
	pub since:  Option<f64>,
	/// Unix milliseconds; calls made at or after it are skipped.
	pub until:  Option<f64>,
	pub filter: TranscriptCallFilter,
	pub flags:  Option<TranscriptRegexFlags>,
	/// Newest calls returned at most.
	pub limit:  u32,
	pub signal: Option<Unknown<'env>>,
}

/// A tool call with its result and the reasoning before it.
#[napi(object)]
pub struct TranscriptCall {
	/// Index of the transcript in `files`.
	pub file:         u32,
	/// Session entry id of the assistant message holding the call.
	pub entry:        Option<String>,
	/// Unix milliseconds; 0 when the line carries no time.
	pub at:           f64,
	pub call_id:      String,
	pub tool:         String,
	/// Arguments as a JSON object; strings longer than 4,003 characters keep
	/// their first and last 2,000.
	pub args:         String,
	/// Result text; longer than 1,003 characters keeps its first and last 500.
	pub result:       Option<String>,
	/// UTF-16 length of the whole result text.
	pub result_chars: Option<u32>,
	pub is_error:     Option<bool>,
	/// The last 4,000 characters of the thinking and reply before the call.
	pub reasoning:    Option<String>,
	pub model:        Option<String>,
	/// omp version that recorded the call.
	pub version:      Option<String>,
}

/// What [`transcript_calls`] found.
#[napi(object)]
pub struct TranscriptCallsResult {
	/// Newest first.
	pub calls:   Vec<TranscriptCall>,
	/// Headers of the transcripts read.
	pub headers: Vec<TranscriptHeader>,
}

/// Text a grep searches.
#[napi(string_enum)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TranscriptSource {
	#[napi(value = "user")]
	User,
	#[napi(value = "assistant")]
	Assistant,
	#[napi(value = "thinking")]
	Thinking,
	#[napi(value = "args")]
	Args,
	#[napi(value = "result")]
	Result,
}

/// Options for [`transcript_grep`].
#[napi(object, object_to_js = false)]
pub struct TranscriptGrepOptions<'env> {
	pub files:   Vec<TranscriptFile>,
	pub since:   Option<f64>,
	pub until:   Option<f64>,
	pub pattern: String,
	pub flags:   Option<TranscriptRegexFlags>,
	pub sources: Vec<TranscriptSource>,
	/// Tools whose arguments and results are searched; all when omitted.
	pub tools:   Option<Vec<String>>,
	pub limit:   u32,
	pub signal:  Option<Unknown<'env>>,
}

/// One place a grep pattern matched.
#[napi(object)]
pub struct TranscriptGrepHit {
	pub file:    u32,
	pub entry:   Option<String>,
	pub at:      f64,
	pub source:  TranscriptSource,
	/// Tool whose arguments or result matched.
	pub tool:    Option<String>,
	pub call_id: Option<String>,
	/// Snippet around the match, whitespace collapsed.
	pub text:    String,
	/// The matched text.
	pub matched: String,
}

/// What [`transcript_grep`] found.
#[napi(object)]
pub struct TranscriptGrepResult {
	/// Newest first.
	pub hits:    Vec<TranscriptGrepHit>,
	pub headers: Vec<TranscriptHeader>,
}

/// Call fact [`transcript_stats`] counts by within each transcript.
#[napi(string_enum)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TranscriptStatsKey {
	#[napi(value = "tool")]
	Tool,
	#[napi(value = "model")]
	Model,
	#[napi(value = "version")]
	Version,
	/// Local calendar day, `YYYY-MM-DD`.
	#[napi(value = "day")]
	Day,
	/// One count per transcript.
	#[napi(value = "none")]
	PerTranscript,
}

/// Options for [`transcript_stats`].
#[napi(object, object_to_js = false)]
pub struct TranscriptStatsOptions<'env> {
	pub files:  Vec<TranscriptFile>,
	pub since:  Option<f64>,
	pub until:  Option<f64>,
	pub filter: TranscriptCallFilter,
	pub flags:  Option<TranscriptRegexFlags>,
	pub by:     TranscriptStatsKey,
	pub signal: Option<Unknown<'env>>,
}

/// Calls of one transcript counted under one key.
#[napi(object)]
pub struct TranscriptStat {
	pub file:   u32,
	/// `null` when the fact is unknown, and for `by: "none"`.
	pub key:    Option<String>,
	pub calls:  u32,
	pub errors: u32,
}

/// What [`transcript_stats`] counted.
#[napi(object)]
pub struct TranscriptStatsResult {
	pub stats:   Vec<TranscriptStat>,
	pub headers: Vec<TranscriptHeader>,
}

/// Kind of a transcript record.
#[napi(string_enum)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum TranscriptRecordKind {
	#[napi(value = "user")]
	User,
	#[napi(value = "assistant")]
	Assistant,
	#[napi(value = "thinking")]
	Thinking,
	#[napi(value = "call")]
	Call,
	#[napi(value = "result")]
	Result,
}

/// Options for [`transcript_messages`].
#[napi(object, object_to_js = false)]
pub struct TranscriptMessagesOptions<'env> {
	pub path:   String,
	/// Kinds kept; all when omitted.
	pub kinds:  Option<Vec<TranscriptRecordKind>>,
	pub since:  Option<f64>,
	pub until:  Option<f64>,
	/// Newest records returned at most.
	pub limit:  u32,
	pub signal: Option<Unknown<'env>>,
}

/// One transcript record, whole.
#[napi(object)]
pub struct TranscriptRecord {
	pub entry:    Option<String>,
	pub at:       f64,
	pub kind:     TranscriptRecordKind,
	/// Message or result text; `null` for calls.
	pub text:     Option<String>,
	pub tool:     Option<String>,
	pub call_id:  Option<String>,
	/// Arguments of a call as a JSON object.
	pub args:     Option<String>,
	pub is_error: Option<bool>,
}

/// The newest `limit` tool calls of `files` matching the filter, with their
/// results and reasoning.
///
/// # Errors
/// Rejects when cancelled; a regex that compiles in neither engine falls back
/// to literal text, as in the grep tool.
#[napi]
pub fn transcript_calls<'env>(
	env: &'env Env,
	options: TranscriptCallsOptions<'env>,
) -> Result<PromiseRaw<'env, TranscriptCallsResult>> {
	let TranscriptCallsOptions { files, since, until, filter, flags, limit, signal } = options;
	let matcher = CallMatcher::new(filter, flags, Window::new(since, until))?;
	let ct = task::CancelToken::new(None, signal);
	task::future(env, "transcript_calls", async move {
		let (calls, headers) = scan(
			files,
			Some(limit as usize),
			Roles::ALL,
			ct,
			move |file, records| {
				let paired = pair_calls(records);
				let mut hits = Vec::new();
				for row in paired.calls.iter().rev() {
					if hits.len() >= limit as usize {
						break;
					}
					if matcher.matches(row) {
						hits.push(call_output(file, row, &paired.texts));
					}
				}
				hits
			},
			|call| call.at,
		)
		.await?;
		Ok(TranscriptCallsResult { calls, headers })
	})
}

/// The newest `limit` matches of `pattern` in `sources` of `files`.
///
/// # Errors
/// Rejects when cancelled.
#[napi]
pub fn transcript_grep<'env>(
	env: &'env Env,
	options: TranscriptGrepOptions<'env>,
) -> Result<PromiseRaw<'env, TranscriptGrepResult>> {
	let TranscriptGrepOptions { files, since, until, pattern, flags, sources, tools, limit, signal } =
		options;
	let engine = compile(&pattern, flags.as_ref())?;
	let window = Window::new(since, until);
	let wants = |source| sources.contains(&source);
	let roles = Roles {
		user:      wants(TranscriptSource::User),
		assistant: wants(TranscriptSource::Assistant)
			|| wants(TranscriptSource::Thinking)
			|| wants(TranscriptSource::Args),
		results:   wants(TranscriptSource::Result),
	};
	let ct = task::CancelToken::new(None, signal);
	task::future(env, "transcript_grep", async move {
		let (hits, headers) = scan(
			files,
			Some(limit as usize),
			roles,
			ct,
			move |file, records| {
				let tool_ok = |tool: &str| {
					tools
						.as_ref()
						.is_none_or(|tools| tools.iter().any(|t| t == tool))
				};
				let mut hits = Vec::new();
				for record in records.iter().rev() {
					if hits.len() >= limit as usize {
						break;
					}
					let hit = match record {
						Record::Text(text) => {
							let source = match text.role {
								TextRole::User => TranscriptSource::User,
								TextRole::Assistant => TranscriptSource::Assistant,
								TextRole::Thinking => TranscriptSource::Thinking,
							};
							if !sources.contains(&source) || !window.contains(text.at) {
								continue;
							}
							find(&engine, &text.text).map(|found| {
								grep_hit(
									file,
									text.entry.as_deref(),
									text.at,
									source,
									None,
									None,
									&text.text,
									found,
								)
							})
						},
						Record::Call(call) => {
							if !sources.contains(&TranscriptSource::Args)
								|| !window.contains(call.at)
								|| !tool_ok(&call.tool)
							{
								continue;
							}
							let Some(args) = call
								.args
								.and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
							else {
								continue;
							};
							find_in_value(&args, &engine).map(|(text, found)| {
								grep_hit(
									file,
									call.entry.as_deref(),
									call.at,
									TranscriptSource::Args,
									Some(&call.tool),
									Some(&call.call_id),
									text,
									found,
								)
							})
						},
						Record::Outcome(outcome) => {
							if !sources.contains(&TranscriptSource::Result)
								|| !window.contains(outcome.at)
								|| (tools.is_some() && !outcome.tool.as_deref().is_some_and(tool_ok))
							{
								continue;
							}
							find(&engine, &outcome.text).map(|found| {
								grep_hit(
									file,
									None,
									outcome.at,
									TranscriptSource::Result,
									outcome.tool.as_deref(),
									Some(&outcome.call_id),
									&outcome.text,
									found,
								)
							})
						},
					};
					hits.extend(hit);
				}
				hits
			},
			|hit| hit.at,
		)
		.await?;
		Ok(TranscriptGrepResult { hits, headers })
	})
}

/// Calls of `files` matching the filter, counted per transcript by `by`.
///
/// # Errors
/// Rejects when cancelled.
#[napi]
pub fn transcript_stats<'env>(
	env: &'env Env,
	options: TranscriptStatsOptions<'env>,
) -> Result<PromiseRaw<'env, TranscriptStatsResult>> {
	let TranscriptStatsOptions { files, since, until, filter, flags, by, signal } = options;
	let matcher = CallMatcher::new(filter, flags, Window::new(since, until))?;
	let ct = task::CancelToken::new(None, signal);
	let zone = TimeZone::system();
	task::future(env, "transcript_stats", async move {
		let roles = Roles { user: false, assistant: true, results: true };
		let (stats, headers) = scan(
			files,
			None,
			roles,
			ct,
			move |file, records| {
				let paired = pair_calls(records);
				let mut buckets: HashMap<Option<String>, (u32, u32)> = HashMap::new();
				for row in paired.calls.iter().filter(|row| matcher.matches(row)) {
					let key = match by {
						TranscriptStatsKey::Tool => Some(row.call.tool.to_string()),
						TranscriptStatsKey::Model => row.call.model.as_deref().map(str::to_owned),
						TranscriptStatsKey::Version => row.call.version.as_deref().map(str::to_owned),
						TranscriptStatsKey::Day => Timestamp::from_millisecond(row.call.at)
							.ok()
							.filter(|_| row.call.at > 0)
							.map(|at| at.to_zoned(zone.clone()).date().to_string()),
						TranscriptStatsKey::PerTranscript => None,
					};
					let bucket = buckets.entry(key).or_default();
					bucket.0 += 1;
					if row.outcome.as_ref().is_some_and(|outcome| outcome.is_error) {
						bucket.1 += 1;
					}
				}
				buckets
					.into_iter()
					.map(|(key, (calls, errors))| TranscriptStat { file, key, calls, errors })
					.collect()
			},
			|_| 0.0,
		)
		.await?;
		Ok(TranscriptStatsResult { stats, headers })
	})
}

/// The newest `limit` records of `kinds` in one transcript, whole, oldest
/// first.
///
/// # Errors
/// Rejects when the file cannot be read or the scan is cancelled.
#[napi]
pub fn transcript_messages(
	options: TranscriptMessagesOptions<'_>,
) -> Result<task::Promise<Vec<TranscriptRecord>>> {
	let TranscriptMessagesOptions { path, kinds, since, until, limit, signal } = options;
	let window = Window::new(since, until);
	let ct = task::CancelToken::new(None, signal);
	Ok(task::blocking("transcript_messages", ct, move |ct| {
		let wants = |kind| kinds.as_ref().is_none_or(|kinds| kinds.contains(&kind));
		let roles = Roles {
			user:      wants(TranscriptRecordKind::User),
			assistant: wants(TranscriptRecordKind::Assistant)
				|| wants(TranscriptRecordKind::Thinking)
				|| wants(TranscriptRecordKind::Call),
			results:   wants(TranscriptRecordKind::Result),
		};
		let buf = fs::read(&path).map_err(|err| Error::from_reason(format!("{path}: {err}")))?;
		ct.heartbeat()?;
		let transcript = read_transcript(&buf, roles);
		let mut kept: Vec<TranscriptRecord> = transcript
			.records
			.iter()
			.map(record_output)
			.filter(|record| wants(record.kind) && window.contains(record.at as i64))
			.collect();
		let excess = kept.len().saturating_sub(limit as usize);
		kept.drain(..excess);
		Ok(kept)
	}))
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanning
// ─────────────────────────────────────────────────────────────────────────────

/// A half-open `[since, until)` span of Unix milliseconds.
#[derive(Clone, Copy)]
struct Window {
	since: Option<i64>,
	until: Option<i64>,
}

impl Window {
	fn new(since: Option<f64>, until: Option<f64>) -> Self {
		Self { since: since.map(|at| at as i64), until: until.map(|at| at as i64) }
	}

	fn contains(self, at: i64) -> bool {
		self.since.is_none_or(|since| at >= since) && self.until.is_none_or(|until| at < until)
	}
}

/// Message roles a scan parses.
#[derive(Clone, Copy)]
struct Roles {
	user:      bool,
	assistant: bool,
	results:   bool,
}

impl Roles {
	const ALL: Self = Self { user: true, assistant: true, results: true };

	fn wants(self, role: &str) -> bool {
		match role {
			"user" => self.user,
			"assistant" => self.assistant,
			"toolResult" => self.results,
			_ => false,
		}
	}
}

/// Runs `per_file` over every readable transcript of `files`, one blocking
/// job per file on Tokio's pool, and merges the hits newest first. With a
/// `limit`, files are read newest first in batches, and reading stops once the
/// next batch is older than the `limit`-th hit kept.
async fn scan<H, F, A>(
	files: Vec<TranscriptFile>,
	limit: Option<usize>,
	roles: Roles,
	ct: task::CancelToken,
	per_file: F,
	at: A,
) -> Result<(Vec<H>, Vec<TranscriptHeader>)>
where
	H: Send + 'static,
	F: for<'a> Fn(u32, Vec<Record<'a>>) -> Vec<H> + Send + Sync + 'static,
	A: Fn(&H) -> f64 + Send,
{
	let mut order: Vec<usize> = (0..files.len()).collect();
	order.sort_by(|&a, &b| files[b].newest.total_cmp(&files[a].newest));
	let files: Arc<[TranscriptFile]> = files.into();
	let per_file = Arc::new(per_file);
	let batch = std::thread::available_parallelism().map_or(1, NonZero::get) * 2;
	let mut hits: Vec<H> = Vec::new();
	let mut headers = Vec::new();
	for indices in order.chunks(batch) {
		ct.heartbeat()?;
		if let Some(limit) = limit
			&& hits.len() >= limit
			&& files[indices[0]].newest < at(&hits[limit - 1])
		{
			break;
		}
		let reads: Vec<_> = indices
			.iter()
			.map(|&index| {
				let files = Arc::clone(&files);
				let per_file = Arc::clone(&per_file);
				task::spawn_blocking("transcript_scan", move || {
					read_file(&files[index].path, index, roles, &*per_file)
				})
			})
			.collect();
		for read in reads {
			let (header, found) = read.await?;
			headers.extend(header);
			hits.extend(found);
		}
		if let Some(limit) = limit {
			hits.sort_by(|a, b| at(b).total_cmp(&at(a)));
			hits.truncate(limit);
		}
	}
	Ok((hits, headers))
}

/// The header and `per_file`'s hits of transcript `index`; an unreadable file
/// has neither.
fn read_file<H>(
	path: &str,
	index: usize,
	roles: Roles,
	per_file: &impl for<'a> Fn(u32, Vec<Record<'a>>) -> Vec<H>,
) -> (Option<TranscriptHeader>, Vec<H>) {
	let Ok(buf) = fs::read(path) else {
		return (None, Vec::new());
	};
	let transcript = read_transcript(&buf, roles);
	let file = clamp_u32(index as u64);
	let header = transcript.header.map(|(id, cwd)| TranscriptHeader {
		file,
		id: id.into_owned(),
		cwd: cwd.into_owned(),
	});
	(header, per_file(file, transcript.records))
}

/// Calls matching a [`TranscriptCallFilter`] within a window.
struct CallMatcher {
	tools:  Option<Vec<String>>,
	args:   Option<Engine>,
	result: Option<Engine>,
	error:  Option<bool>,
	window: Window,
}

impl CallMatcher {
	fn new(
		filter: TranscriptCallFilter,
		flags: Option<TranscriptRegexFlags>,
		window: Window,
	) -> Result<Self> {
		let compiled =
			|pattern: Option<String>| pattern.map(|p| compile(&p, flags.as_ref())).transpose();
		Ok(Self {
			tools: filter.tools,
			args: compiled(filter.args)?,
			result: compiled(filter.result)?,
			error: filter.error,
			window,
		})
	}

	fn matches(&self, row: &CallRow<'_>) -> bool {
		if !self.window.contains(row.call.at)
			|| self
				.tools
				.as_ref()
				.is_some_and(|tools| !tools.iter().any(|t| *t == row.call.tool))
		{
			return false;
		}
		if let Some(want) = self.error
			&& row
				.outcome
				.as_ref()
				.is_none_or(|outcome| outcome.is_error != want)
		{
			return false;
		}
		if let Some(engine) = &self.result
			&& row
				.outcome
				.as_ref()
				.is_none_or(|outcome| find(engine, &outcome.text).is_none())
		{
			return false;
		}
		if let Some(engine) = &self.args {
			let Some(args) = row
				.call
				.args
				.and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
			else {
				return false;
			};
			return find_in_value(&args, engine).is_some();
		}
		true
	}
}

/// The grep tool's dialect: `dot_all` lets `.` and matches cross newlines.
fn compile(pattern: &str, flags: Option<&TranscriptRegexFlags>) -> Result<Engine> {
	let ignore_case = flags.and_then(|flags| flags.ignore_case).unwrap_or(false);
	let dot_all = flags.and_then(|flags| flags.dot_all).unwrap_or(false);
	let pattern = if dot_all {
		Cow::Owned(format!("(?s){pattern}"))
	} else {
		Cow::Borrowed(pattern)
	};
	Engine::compile(&pattern, ignore_case, dot_all).map_err(Error::from_reason)
}

/// The first match of `engine` in `text`; an engine error (a PCRE2 match
/// limit) reads as no match.
fn find(engine: &Engine, text: &str) -> Option<Match> {
	engine.find(text.as_bytes()).ok().flatten()
}

/// The first string inside `value`, depth first, that `engine` matches.
fn find_in_value<'v>(value: &'v Value, engine: &Engine) -> Option<(&'v str, Match)> {
	match value {
		Value::String(text) => find(engine, text).map(|found| (text.as_str(), found)),
		Value::Array(items) => items.iter().find_map(|item| find_in_value(item, engine)),
		Value::Object(fields) => fields.values().find_map(|item| find_in_value(item, engine)),
		_ => None,
	}
}

#[expect(clippy::too_many_arguments, reason = "one hit's fields")]
fn grep_hit(
	file: u32,
	entry: Option<&str>,
	at: i64,
	source: TranscriptSource,
	tool: Option<&str>,
	call_id: Option<&str>,
	text: &str,
	found: Match,
) -> TranscriptGrepHit {
	TranscriptGrepHit {
		file,
		entry: entry.map(str::to_owned),
		at: at as f64,
		source,
		tool: tool.map(str::to_owned),
		call_id: call_id.map(str::to_owned),
		text: snippet(text, found.start(), found.end()),
		matched: text[found.start()..found.end()].to_owned(),
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Records
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq)]
enum TextRole {
	User,
	Assistant,
	Thinking,
}

/// A user prompt, an assistant reply, or the assistant's thinking before it.
struct Utterance<'a> {
	role:  TextRole,
	at:    i64,
	entry: Option<Cow<'a, str>>,
	text:  Cow<'a, str>,
}

/// A tool call the assistant made.
struct ToolCall<'a> {
	call_id: Cow<'a, str>,
	entry:   Option<Cow<'a, str>>,
	at:      i64,
	tool:    Cow<'a, str>,
	args:    Option<&'a RawValue>,
	model:   Option<Cow<'a, str>>,
	version: Option<Cow<'a, str>>,
}

/// The result of a tool call.
struct Outcome<'a> {
	call_id:  Cow<'a, str>,
	tool:     Option<Cow<'a, str>>,
	at:       i64,
	text:     Cow<'a, str>,
	is_error: bool,
}

/// One record in transcript order; a message's thinking precedes its reply,
/// which precedes its calls.
enum Record<'a> {
	Text(Utterance<'a>),
	Call(ToolCall<'a>),
	Outcome(Outcome<'a>),
}

/// The header and records of one transcript, borrowing its bytes.
#[derive(Default)]
struct Transcript<'a> {
	/// Session id and working directory.
	header:  Option<(Cow<'a, str>, Cow<'a, str>)>,
	records: Vec<Record<'a>>,
}

/// A call with its result and the index of the newest thinking or reply text
/// before it.
struct CallRow<'a> {
	call:      ToolCall<'a>,
	reasoning: Option<usize>,
	outcome:   Option<Outcome<'a>>,
}

/// A transcript's calls, paired with results, and its texts.
struct PairedCalls<'a> {
	texts: Vec<Utterance<'a>>,
	calls: Vec<CallRow<'a>>,
}

#[derive(Clone, Copy)]
enum LineKind {
	Session,
	Message,
}

/// Entry type at the head of a line, spaced JSON (`{"type": "message"`)
/// included.
fn line_kind(line: &[u8]) -> Option<LineKind> {
	let rest = line.strip_prefix(b"{")?.trim_ascii_start();
	let rest = rest.strip_prefix(b"\"type\"")?.trim_ascii_start();
	let rest = rest.strip_prefix(b":")?.trim_ascii_start();
	if rest.starts_with(b"\"message\"") {
		Some(LineKind::Message)
	} else if rest.starts_with(b"\"session\"") {
		Some(LineKind::Session)
	} else {
		None
	}
}

/// Role of a compact message line, read from its head; `None` sends the line
/// to a full parse.
fn probe_role(line: &[u8]) -> Option<&str> {
	const KEY: &[u8] = b"\"message\":{\"role\":\"";
	let head = &line[..line.len().min(ROLE_PROBE_BYTES)];
	let start = memchr::memmem::find(head, KEY)? + KEY.len();
	let rest = &head[start..];
	let end = memchr::memchr(b'"', rest)?;
	std::str::from_utf8(&rest[..end]).ok()
}

/// The header and the records of `roles` among `buf`'s complete lines; an
/// unparseable line, such as a half-written last one, is skipped.
fn read_transcript(buf: &[u8], roles: Roles) -> Transcript<'_> {
	let mut transcript = Transcript::default();
	for line in buf.split(|&byte| byte == b'\n') {
		match line_kind(line) {
			Some(LineKind::Message) => {
				if probe_role(line).is_some_and(|role| !roles.wants(role)) {
					continue;
				}
				let Ok(text) = std::str::from_utf8(line) else {
					continue;
				};
				let Ok(entry) = serde_json::from_str::<Line<'_>>(text) else {
					continue;
				};
				push_message(entry, roles, &mut transcript.records);
			},
			Some(LineKind::Session) if transcript.header.is_none() => {
				let Ok(text) = std::str::from_utf8(line) else {
					continue;
				};
				if let Ok(Line { id: Str(Some(id)), cwd: Str(Some(cwd)), .. }) =
					serde_json::from_str(text)
				{
					transcript.header = Some((id, cwd));
				}
			},
			_ => {},
		}
	}
	transcript
}

fn push_message<'a>(line: Line<'a>, roles: Roles, out: &mut Vec<Record<'a>>) {
	let Some(message) = line.message else { return };
	let Some(role) = message.role.0.as_deref() else {
		return;
	};
	if !roles.wants(role) {
		return;
	}
	let at = line.timestamp.0.as_deref().map_or(0, parse_time);
	let entry = line.id.0;
	match role {
		"user" => {
			let text = trimmed(join_text(message.content));
			if !text.is_empty() {
				out.push(Record::Text(Utterance { role: TextRole::User, at, entry, text }));
			}
		},
		"assistant" => {
			let Content::Blocks(blocks) = message.content else {
				if let Content::Text(text) = message.content {
					let text = trimmed(text);
					if !text.is_empty() {
						out.push(Record::Text(Utterance { role: TextRole::Assistant, at, entry, text }));
					}
				}
				return;
			};
			let version = line.runtime.and_then(|runtime| runtime.version.0);
			let mut thinking = Vec::new();
			let mut replies = Vec::new();
			let mut calls = Vec::new();
			for block in blocks {
				match block.kind.0.as_deref() {
					Some("text") => replies.extend(block.text.0),
					Some("thinking") => thinking.extend(block.thinking.0),
					Some("toolCall") => {
						if let (Some(call_id), Some(tool)) = (block.id.0, block.name.0) {
							calls.push(ToolCall {
								call_id,
								entry: entry.clone(),
								at,
								tool,
								args: block.arguments,
								model: message.model.0.clone(),
								version: version.clone(),
							});
						}
					},
					_ => {},
				}
			}
			let thinking = trimmed(join(thinking, "\n\n"));
			if !thinking.is_empty() {
				out.push(Record::Text(Utterance {
					role: TextRole::Thinking,
					at,
					entry: entry.clone(),
					text: thinking,
				}));
			}
			let reply = trimmed(join(replies, "\n"));
			if !reply.is_empty() {
				out.push(Record::Text(Utterance { role: TextRole::Assistant, at, entry, text: reply }));
			}
			out.extend(calls.into_iter().map(Record::Call));
		},
		"toolResult" => {
			let Some(call_id) = message.tool_call_id.0 else {
				return;
			};
			out.push(Record::Outcome(Outcome {
				call_id,
				tool: message.tool_name.0,
				at,
				text: join_text(message.content),
				is_error: message.is_error == Some(true),
			}));
		},
		_ => {},
	}
}

/// Pairs calls with their results and links each to the newest thinking or
/// reply before it; a user message clears that link.
fn pair_calls(records: Vec<Record<'_>>) -> PairedCalls<'_> {
	let mut paired = PairedCalls { texts: Vec::new(), calls: Vec::new() };
	let mut by_id: HashMap<Cow<'_, str>, usize> = HashMap::new();
	let mut reasoning = None;
	for record in records {
		match record {
			Record::Text(text) => {
				reasoning = (text.role != TextRole::User).then_some(paired.texts.len());
				paired.texts.push(text);
			},
			Record::Call(call) => {
				by_id.insert(call.call_id.clone(), paired.calls.len());
				paired
					.calls
					.push(CallRow { call, reasoning, outcome: None });
			},
			Record::Outcome(outcome) => {
				if let Some(&index) = by_id.get(&outcome.call_id) {
					paired.calls[index].outcome = Some(outcome);
				}
			},
		}
	}
	paired
}

/// The thinking and reply of the message holding text `anchor`, in order.
fn reasoning_text(texts: &[Utterance<'_>], anchor: usize) -> String {
	let entry = texts[anchor].entry.as_deref();
	let mut start = anchor;
	while start > 0 {
		let prior = &texts[start - 1];
		if prior.role == TextRole::User || entry.is_none() || prior.entry.as_deref() != entry {
			break;
		}
		start -= 1;
	}
	texts[start..=anchor]
		.iter()
		.map(|text| text.text.as_ref())
		.collect::<Vec<_>>()
		.join("\n\n")
}

fn call_output(file: u32, row: &CallRow<'_>, texts: &[Utterance<'_>]) -> TranscriptCall {
	let mut args = row
		.call
		.args
		.and_then(|raw| serde_json::from_str::<Value>(raw.get()).ok())
		.unwrap_or_else(|| Value::Object(serde_json::Map::new()));
	cut_strings(&mut args);
	let outcome = row.outcome.as_ref();
	TranscriptCall {
		file,
		entry: row.call.entry.as_deref().map(str::to_owned),
		at: row.call.at as f64,
		call_id: row.call.call_id.to_string(),
		tool: row.call.tool.to_string(),
		args: args.to_string(),
		result: outcome.map(|outcome| excerpt(&outcome.text, RESULT_EDGE).into_owned()),
		result_chars: outcome.map(|outcome| clamp_u32(outcome.text.encode_utf16().count() as u64)),
		is_error: outcome.map(|outcome| outcome.is_error),
		reasoning: row
			.reasoning
			.map(|anchor| tail(&reasoning_text(texts, anchor), REASONING_CHARS).into_owned()),
		model: row.call.model.as_deref().map(str::to_owned),
		version: row.call.version.as_deref().map(str::to_owned),
	}
}

fn record_output(record: &Record<'_>) -> TranscriptRecord {
	match record {
		Record::Text(text) => TranscriptRecord {
			entry:    text.entry.as_deref().map(str::to_owned),
			at:       text.at as f64,
			kind:     match text.role {
				TextRole::User => TranscriptRecordKind::User,
				TextRole::Assistant => TranscriptRecordKind::Assistant,
				TextRole::Thinking => TranscriptRecordKind::Thinking,
			},
			text:     Some(text.text.to_string()),
			tool:     None,
			call_id:  None,
			args:     None,
			is_error: None,
		},
		Record::Call(call) => TranscriptRecord {
			entry:    call.entry.as_deref().map(str::to_owned),
			at:       call.at as f64,
			kind:     TranscriptRecordKind::Call,
			text:     None,
			tool:     Some(call.tool.to_string()),
			call_id:  Some(call.call_id.to_string()),
			args:     Some(
				call
					.args
					.map_or_else(|| "{}".to_owned(), |raw| raw.get().to_owned()),
			),
			is_error: None,
		},
		Record::Outcome(outcome) => TranscriptRecord {
			entry:    None,
			at:       outcome.at as f64,
			kind:     TranscriptRecordKind::Result,
			text:     Some(outcome.text.to_string()),
			tool:     outcome.tool.as_deref().map(str::to_owned),
			call_id:  Some(outcome.call_id.to_string()),
			args:     None,
			is_error: Some(outcome.is_error),
		},
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Text helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Unix milliseconds of an RFC 3339 timestamp; 0 when unparseable.
fn parse_time(text: &str) -> i64 {
	text
		.parse::<Timestamp>()
		.map_or(0, |at| at.as_millisecond())
}

/// `parts` joined by `separator`, borrowing a lone part.
fn join<'a>(mut parts: Vec<Cow<'a, str>>, separator: &str) -> Cow<'a, str> {
	match parts.len() {
		0 => Cow::Borrowed(""),
		1 => parts.pop().unwrap_or_default(),
		_ => Cow::Owned(parts.join(separator)),
	}
}

/// The text blocks of a message's content, joined by newlines; string content
/// is one block.
fn join_text(content: Content<'_>) -> Cow<'_, str> {
	match content {
		Content::Absent => Cow::Borrowed(""),
		Content::Text(text) => text,
		Content::Blocks(blocks) => join(
			blocks
				.into_iter()
				.filter(|block| block.kind.0.as_deref() == Some("text"))
				.filter_map(|block| block.text.0)
				.collect(),
			"\n",
		),
	}
}

fn trimmed(text: Cow<'_, str>) -> Cow<'_, str> {
	match text {
		Cow::Borrowed(text) => Cow::Borrowed(text.trim()),
		Cow::Owned(text) if text.trim().len() == text.len() => Cow::Owned(text),
		Cow::Owned(text) => Cow::Owned(text.trim().to_owned()),
	}
}

/// `text` with its middle cut when it holds more than `edge` characters at
/// each end plus the cut mark.
fn excerpt(text: &str, edge: usize) -> Cow<'_, str> {
	let cut_chars = CUT_MARK.chars().count();
	if text.len() <= edge * 2 + cut_chars {
		return Cow::Borrowed(text);
	}
	let (Some((head, _)), Some((tail, _))) =
		(text.char_indices().nth(edge), text.char_indices().nth_back(edge - 1))
	else {
		return Cow::Borrowed(text);
	};
	if tail <= head || text[head..tail].chars().nth(cut_chars).is_none() {
		return Cow::Borrowed(text);
	}
	Cow::Owned(format!("{}{CUT_MARK}{}", &text[..head], &text[tail..]))
}

/// The last `chars` characters of `text`, `…` marking a cut.
fn tail(text: &str, chars: usize) -> Cow<'_, str> {
	match text.char_indices().nth_back(chars - 1) {
		Some((start, _)) if start > 0 => Cow::Owned(format!("…{}", &text[start..])),
		_ => Cow::Borrowed(text),
	}
}

/// `value` with every string inside cut by [`excerpt`] at [`ARGUMENT_EDGE`].
fn cut_strings(value: &mut Value) {
	match value {
		Value::String(text) => {
			if let Cow::Owned(cut) = excerpt(text, ARGUMENT_EDGE) {
				*text = cut;
			}
		},
		Value::Array(items) => items.iter_mut().for_each(cut_strings),
		Value::Object(fields) => fields.values_mut().for_each(cut_strings),
		_ => {},
	}
}

/// `text` cut to [`SNIPPET_CHARS`] characters around `[start, end)`,
/// whitespace collapsed, `…` marking each cut.
fn snippet(text: &str, start: usize, end: usize) -> String {
	let from = text[..start]
		.char_indices()
		.nth_back(SNIPPET_CHARS - 1)
		.map_or(0, |(at, _)| at);
	let to = text[end..]
		.char_indices()
		.nth(SNIPPET_CHARS)
		.map_or(text.len(), |(at, _)| end + at);
	let body = text[from..to]
		.split_whitespace()
		.collect::<Vec<_>>()
		.join(" ");
	let lead = if from > 0 { "…" } else { "" };
	let trail = if to < text.len() { "…" } else { "" };
	format!("{lead}{body}{trail}")
}

// ─────────────────────────────────────────────────────────────────────────────
// Line shapes
// ─────────────────────────────────────────────────────────────────────────────

/// The fields of a `session` or `message` line scans read.
#[derive(Deserialize)]
struct Line<'a> {
	#[serde(default, borrow)]
	id:        Str<'a>,
	#[serde(default, borrow)]
	timestamp: Str<'a>,
	#[serde(default, borrow)]
	cwd:       Str<'a>,
	#[serde(default, borrow)]
	runtime:   Option<Runtime<'a>>,
	#[serde(default, borrow)]
	message:   Option<Message<'a>>,
}

#[derive(Deserialize)]
struct Runtime<'a> {
	#[serde(default, borrow)]
	version: Str<'a>,
}

#[derive(Deserialize)]
struct Message<'a> {
	#[serde(default, borrow)]
	role:         Str<'a>,
	#[serde(default, borrow)]
	content:      Content<'a>,
	#[serde(default, borrow)]
	model:        Str<'a>,
	#[serde(default, borrow, rename = "toolCallId")]
	tool_call_id: Str<'a>,
	#[serde(default, borrow, rename = "toolName")]
	tool_name:    Str<'a>,
	#[serde(default, rename = "isError")]
	is_error:     Option<bool>,
}

#[derive(Deserialize)]
struct Block<'a> {
	#[serde(default, borrow, rename = "type")]
	kind:      Str<'a>,
	#[serde(default, borrow)]
	text:      Str<'a>,
	#[serde(default, borrow)]
	thinking:  Str<'a>,
	#[serde(default, borrow)]
	id:        Str<'a>,
	#[serde(default, borrow)]
	name:      Str<'a>,
	#[serde(default, borrow)]
	arguments: Option<&'a RawValue>,
}

/// Message content: a string, or blocks.
#[derive(Default)]
enum Content<'a> {
	#[default]
	Absent,
	Text(Cow<'a, str>),
	Blocks(Vec<Block<'a>>),
}

impl<'de: 'a, 'a> Deserialize<'de> for Content<'a> {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
		struct ContentVisitor<'a>(PhantomData<&'a ()>);

		impl<'de: 'a, 'a> Visitor<'de> for ContentVisitor<'a> {
			type Value = Content<'a>;

			fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				f.write_str("message content")
			}

			fn visit_borrowed_str<E>(self, text: &'de str) -> std::result::Result<Self::Value, E> {
				Ok(Content::Text(Cow::Borrowed(text)))
			}

			fn visit_str<E>(self, text: &str) -> std::result::Result<Self::Value, E> {
				Ok(Content::Text(Cow::Owned(text.to_owned())))
			}

			fn visit_string<E>(self, text: String) -> std::result::Result<Self::Value, E> {
				Ok(Content::Text(Cow::Owned(text)))
			}

			fn visit_seq<S: SeqAccess<'de>>(
				self,
				mut seq: S,
			) -> std::result::Result<Self::Value, S::Error> {
				let mut blocks = Vec::new();
				while let Some(block) = seq.next_element()? {
					blocks.push(block);
				}
				Ok(Content::Blocks(blocks))
			}

			fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
				Ok(Content::Absent)
			}

			fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
				Ok(Content::Absent)
			}
		}

		deserializer.deserialize_any(ContentVisitor(PhantomData))
	}
}

/// A string field read leniently: any other JSON value reads as absent, so one
/// odd field never drops its line.
#[derive(Default)]
struct Str<'a>(Option<Cow<'a, str>>);

impl<'de: 'a, 'a> Deserialize<'de> for Str<'a> {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
		struct StrVisitor<'a>(PhantomData<&'a ()>);

		impl<'de: 'a, 'a> Visitor<'de> for StrVisitor<'a> {
			type Value = Str<'a>;

			fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				f.write_str("any JSON value")
			}

			fn visit_borrowed_str<E>(self, text: &'de str) -> std::result::Result<Self::Value, E> {
				Ok(Str(Some(Cow::Borrowed(text))))
			}

			fn visit_str<E>(self, text: &str) -> std::result::Result<Self::Value, E> {
				Ok(Str(Some(Cow::Owned(text.to_owned()))))
			}

			fn visit_string<E>(self, text: String) -> std::result::Result<Self::Value, E> {
				Ok(Str(Some(Cow::Owned(text))))
			}

			fn visit_bool<E>(self, _: bool) -> std::result::Result<Self::Value, E> {
				Ok(Str(None))
			}

			fn visit_i64<E>(self, _: i64) -> std::result::Result<Self::Value, E> {
				Ok(Str(None))
			}

			fn visit_u64<E>(self, _: u64) -> std::result::Result<Self::Value, E> {
				Ok(Str(None))
			}

			fn visit_f64<E>(self, _: f64) -> std::result::Result<Self::Value, E> {
				Ok(Str(None))
			}

			fn visit_unit<E>(self) -> std::result::Result<Self::Value, E> {
				Ok(Str(None))
			}

			fn visit_none<E>(self) -> std::result::Result<Self::Value, E> {
				Ok(Str(None))
			}

			fn visit_seq<S: SeqAccess<'de>>(
				self,
				mut seq: S,
			) -> std::result::Result<Self::Value, S::Error> {
				while seq.next_element::<IgnoredAny>()?.is_some() {}
				Ok(Str(None))
			}

			fn visit_map<M: MapAccess<'de>>(
				self,
				mut map: M,
			) -> std::result::Result<Self::Value, M::Error> {
				while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
				Ok(Str(None))
			}
		}

		deserializer.deserialize_any(StrVisitor(PhantomData))
	}
}
