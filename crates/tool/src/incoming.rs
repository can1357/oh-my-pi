//! Linear invocation framing layered over `omp-slopjson`.

use std::{
	any,
	collections::VecDeque,
	future::Future,
	marker::PhantomData,
	ops::Range,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use flume::{Receiver, Sender};
use futures::{FutureExt, pin_mut, select_biased};
use omp_core::{
	SparseMap, Str, sf,
	slopjson::{
		IncomingCursor as SlopCursor, IncomingDoc, IncomingError, IncomingFeed, PullIssue,
		PullIssueKind, PullMode, PullPathSegment, Pulled, PulledKind, Value,
	},
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use smallvec::SmallVec;
use thiserror::Error;

use crate::{
	ArgIssue, ArgIssueKind, ArgPath, ArgSpec, ArgSpecRegistry, Coerce, Repair, RepairKind, Rev,
};

/// One event in the client-to-executor invocation stream.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InvocationEvent {
	/// Exact provider-emitted argument text fragment.
	ArgText {
		/// Raw text chunk emitted by the provider.
		fragment: Str,
	},
	/// Authoritative complete-argument boundary supplied by the invocation host.
	ArgsCommitted {
		/// Final complete argument payload string.
		raw: Str,
	},
	/// Steering observed by an interruptible pull or commitment wait.
	Interrupt(Interrupt),
}

/// Structured invocation interrupt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Interrupt {
	/// Stable interrupt class supplied by the loop.
	pub class:  Str,
	/// Human-readable reason or steering item.
	pub reason: Str,
}

impl Interrupt {
	/// Invocation deadline expiry.
	pub const DEADLINE: &'static str = "deadline";
	/// Explicit user cancellation.
	pub const ESCAPE: &'static str = "escape";
	/// Session termination.
	pub const SHUTDOWN: &'static str = "shutdown";
	/// User steering supplied while a turn is in progress.
	pub const STEERING: &'static str = "steering";
}
/// Sending failed because the invocation consumer is gone.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
#[error("invocation event stream is closed")]
pub struct InvocationSendError;
/// Whether a committed canonical payload is the deterministic settlement of
/// the provider's streamed fragments.
///
/// Provider codecs normalize JSON spelling, while recovery may apply bounded
/// syntax repair, schema-directed scalar coercion, and charitable removal of
/// closed-schema extras before the call becomes executable and durable. Those
/// changes must not make live execution diverge from the canonical call
/// replayed from the journal. Structurally incomplete streams and materially
/// different retained values remain protocol violations. A
/// freeform grammar call is the one shape-changing exception: recovery wraps
/// its exact streamed text in the canonical `input` object.
fn commit_supersedes_stream(streamed: &str, committed: &str) -> bool {
	let Ok(committed_doc) = serde_json::from_str::<Value>(committed) else {
		return false;
	};
	if committed_doc.get("input").and_then(Value::as_str) == Some(streamed) {
		return true;
	}
	match (omp_core::slopjson::parse(streamed), omp_core::slopjson::parse(committed)) {
		(Ok(streamed), Ok(committed)) => repaired_value_eq(&streamed, &committed),
		_ => false,
	}
}

fn repaired_value_eq(streamed: &Value, committed: &Value) -> bool {
	if streamed == committed {
		return true;
	}
	match (streamed, committed) {
		(Value::Object(streamed), Value::Object(committed)) => {
			committed.len() <= streamed.len()
				&& committed.iter().all(|(key, settled)| {
					streamed
						.get(key)
						.is_some_and(|value| repaired_value_eq(value, settled))
				})
		},
		(Value::Array(streamed), Value::Array(committed)) => {
			streamed.len() == committed.len()
				&& streamed
					.iter()
					.zip(committed)
					.all(|(value, settled)| repaired_value_eq(value, settled))
		},
		(Value::String(streamed), Value::Object(_) | Value::Array(_)) => {
			let trimmed = streamed.trim();
			serde_json::from_str::<Value>(&trimmed)
				.is_ok_and(|parsed| repaired_value_eq(&parsed, committed))
		},
		(Value::String(streamed), Value::Bool(committed)) => match streamed.trim().as_str() {
			"true" | "yes" | "1" => *committed,
			"false" | "no" | "0" => !*committed,
			_ => false,
		},
		(Value::String(streamed), Value::Number(committed)) => {
			let trimmed = streamed.trim();
			trimmed
				.parse::<i64>()
				.is_ok_and(|parsed| committed.as_i64() == Some(parsed))
				|| trimmed
					.parse::<f64>()
					.is_ok_and(|parsed| committed.as_f64() == parsed)
		},
		(value, Value::String(committed)) if !matches!(value, Value::String(_)) => {
			value.to_string() == committed.as_str()
		},
		(value, Value::Array(committed)) if !matches!(value, Value::Array(_)) => {
			committed.len() == 1 && repaired_value_eq(value, &committed[0])
		},
		_ => false,
	}
}

struct DirectFeed {
	state:     Mutex<DirectFeedState>,
	finalized: Mutex<Option<FinalizedArgs>>,
	producers: AtomicUsize,
}

struct DirectFeedState {
	parser:    Option<IncomingFeed>,
	fragments: SmallVec<Str, 4>,
	byte_len:  usize,
	committed: bool,
	protocol:  Option<Str>,
}

impl Drop for DirectFeed {
	fn drop(&mut self) {
		if let Some(feed) = self.state.get_mut().parser.take() {
			feed.abort();
		}
	}
}

/// Producer side of one linear invocation event stream.
///
/// Dropping the last producer before `args_committed` abandons the parser feed;
/// [`IncomingParams`] then reports an abort rather than inventing finalization.
pub struct InvocationFeed {
	tx:     Sender<InvocationEvent>,
	direct: Arc<DirectFeed>,
}

impl Clone for InvocationFeed {
	fn clone(&self) -> Self {
		self.direct.producers.fetch_add(1, Ordering::Relaxed);
		Self { tx: self.tx.clone(), direct: Arc::clone(&self.direct) }
	}
}

impl Drop for InvocationFeed {
	fn drop(&mut self) {
		if self.direct.producers.fetch_sub(1, Ordering::AcqRel) == 1 {
			let mut direct = self.direct.state.lock();
			if !direct.committed
				&& let Some(feed) = direct.parser.take()
			{
				feed.abort();
			}
		}
	}
}

impl InvocationFeed {
	/// Takes the canonical finalization receipt produced by the tool-side
	/// argument decoder.
	///
	/// The invocation owner uses this single-consumer observation seam to
	/// journal repair metadata without changing the authoritative
	/// [`InvocationEvent::ArgsCommitted`] payload.
	pub fn take_finalized_args(&self) -> Option<FinalizedArgs> {
		self.direct.finalized.lock().take()
	}

	/// Relays one raw argument text fragment verbatim.
	pub fn arg_text(&self, fragment: Str) -> Result<(), InvocationSendError> {
		if self.tx.is_disconnected() {
			return Err(InvocationSendError);
		}
		let mut direct = self.direct.state.lock();
		if direct.committed {
			direct
				.protocol
				.get_or_insert_with(|| sf!("argument text arrived after commitment"));
			if let Some(feed) = direct.parser.take() {
				feed.abort();
			}
			return Ok(());
		}
		if direct
			.parser
			.as_mut()
			.is_some_and(|feed| feed.push(&fragment).is_err())
		{
			direct
				.protocol
				.get_or_insert_with(|| sf!("JSON feed closed before commitment"));
		}
		direct.byte_len = direct.byte_len.saturating_add(fragment.len());
		direct.fragments.push(fragment);
		Ok(())
	}

	/// Closes argument streaming with the authoritative canonical settlement.
	pub fn args_committed(&self, raw: Str) -> Result<(), InvocationSendError> {
		if self.tx.is_disconnected() {
			return Err(InvocationSendError);
		}
		{
			let mut direct = self.direct.state.lock();
			if direct.committed {
				direct
					.protocol
					.get_or_insert_with(|| sf!("duplicate argument commitment"));
			} else if direct.byte_len == 0 && !raw.is_empty() {
				direct.byte_len = raw.len();
				direct.fragments.push(raw.clone());
				if direct
					.parser
					.as_mut()
					.is_some_and(|feed| feed.push(&raw).is_err())
				{
					direct
						.protocol
						.get_or_insert_with(|| sf!("JSON feed closed before commitment"));
				}
			} else if direct.byte_len != raw.len()
				|| !direct
					.fragments
					.iter()
					.flat_map(|fragment| fragment.bytes())
					.eq(raw.bytes())
			{
				let mut streamed = String::with_capacity(direct.byte_len);
				for fragment in &direct.fragments {
					streamed.push_str(fragment);
				}
				if !commit_supersedes_stream(&streamed, &raw) {
					direct
						.protocol
						.get_or_insert_with(|| sf!("committed arguments differ from streamed fragments"));
				}
			}
			direct.committed = true;
			if let Some(feed) = direct.parser.take() {
				if direct.protocol.is_some() {
					feed.abort();
				} else {
					feed.finish();
				}
			}
		}
		self.send(InvocationEvent::ArgsCommitted { raw })
	}

	/// Relays one steering interrupt.
	pub fn interrupt(&self, interrupt: Interrupt) -> Result<(), InvocationSendError> {
		self.send(InvocationEvent::Interrupt(interrupt))
	}

	fn send(&self, event: InvocationEvent) -> Result<(), InvocationSendError> {
		self.tx.send(event).map_err(|_| InvocationSendError)
	}
}

/// Failure while pulling a requested argument value.
#[derive(Debug, Error)]
pub enum ParamError {
	/// A pulled value was absent, malformed, mistyped, or abandoned.
	#[error("argument pull failed")]
	Args(Box<ArgIssue>),
	/// An interrupt was observed through [`IncomingParams::interruptable`].
	#[error("argument pull interrupted")]
	Interrupted(Interrupt),
	/// Framing violated the one-stream commitment protocol.
	#[error("invalid invocation framing: {0}")]
	Protocol(Str),
}

/// Failure while waiting for the explicit effect gate.
#[derive(Debug, Error)]
pub enum CommitError {
	/// Feed disappeared before commitment.
	#[error("invocation feed dropped before argument commitment")]
	Aborted,
	/// An interrupt was observed by an interruptible wait.
	#[error("argument commitment interrupted")]
	Interrupted(Interrupt),
	/// Framing violated the one-stream commitment protocol.
	#[error("invalid invocation framing: {0}")]
	Protocol(Str),
}
/// Failure while waiting for the next invocation interrupt.
#[derive(Debug, Error)]
pub enum InterruptWaitError {
	/// The invocation owner disappeared before sending another interrupt.
	#[error("invocation event stream closed")]
	Closed,
	/// Framing violated the one-stream invocation protocol.
	#[error("invalid invocation framing: {0}")]
	Protocol(Str),
}
/// Immutable result of strict whole-structure argument finalization.
#[derive(Clone, Debug, PartialEq)]
pub struct FinalizedArgs {
	raw:            Str,
	effective:      Value,
	effective_json: Str,
	repairs:        SmallVec<Repair, 4>,
}

impl FinalizedArgs {
	/// Authoritative canonical commitment supplied by the invocation host.
	pub const fn raw(&self) -> &Str {
		&self.raw
	}

	/// One canonical effective argument value shared by every downstream
	/// consumer.
	pub const fn effective(&self) -> &Value {
		&self.effective
	}

	/// Cached compact JSON representation of [`effective`](Self::effective).
	pub const fn effective_json(&self) -> &Str {
		&self.effective_json
	}

	/// Immutable parser, alias, coercion, and elision trail.
	pub fn repairs(&self) -> &[Repair] {
		&self.repairs
	}
}

struct CursorState {
	active: AtomicBool,
	chunks: Mutex<Option<SparseMap<u32, usize>>>,
}

/// Re-entrant host cursor over one incoming argument document.
///
/// Pull requests may be created from separate host callbacks, but only one may
/// remain outstanding. A concurrent request is refused rather than queued.
#[derive(Clone)]
pub struct IncomingCursor<'c> {
	inner: SlopCursor,
	rev:   Option<&'c Rev>,

	arg_specs: Option<&'c ArgSpecRegistry>,
	state:     Arc<CursorState>,
}
struct PullSlot<'a>(&'a AtomicBool);

impl Drop for PullSlot<'_> {
	fn drop(&mut self) {
		self.0.store(false, Ordering::Release);
	}
}

impl IncomingCursor<'_> {
	/// Pulls one declared path while enforcing the invocation's single
	/// outstanding host slot.
	pub async fn pull_at<'a>(
		&'a self,
		path: &'a [ArgPath],
		mode: PullMode,
		expected: &'static str,
	) -> Result<Pulled, ParamError> {
		if self
			.state
			.active
			.compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
			.is_err()
		{
			return Err(ParamError::Protocol(sf!("concurrent pull")));
		}
		let _slot = PullSlot(&self.state.active);
		let declaration = self
			.rev
			.zip(self.arg_specs)
			.and_then(|(rev, specs)| specs.get_with_id(rev, path));
		let slop_path = declared_pull_path(path, self.rev.zip(self.arg_specs));
		let mode = match mode {
			PullMode::Chunk(_) | PullMode::Line(_) => {
				let (path_id, _) = declaration
					.ok_or_else(|| ParamError::Protocol(sf!("chunk pull requires a declared path")))?;
				let emitted = self
					.state
					.chunks
					.lock()
					.as_ref()
					.and_then(|chunks| chunks.get(path_id))
					.copied()
					.unwrap_or(0);
				if matches!(mode, PullMode::Line(_)) {
					PullMode::Line(emitted)
				} else {
					PullMode::Chunk(emitted)
				}
			},
			other => other,
		};
		let mut pulled = self
			.inner
			.pull_at(&slop_path, mode, expected)
			.await
			.map_err(|error| param_error(error, self.rev.zip(self.arg_specs)))?;
		if let PulledKind::Complete(value) = &mut pulled.kind
			&& let Some((_, spec)) = declaration
		{
			let _ = apply_coercions(value, spec);
		}
		if let PulledKind::Chunk { value, .. } = &pulled.kind {
			let (path_id, _) = declaration.expect("chunk mode requires a declaration");
			let mut chunks = self.state.chunks.lock();
			let offsets = chunks.get_or_insert_with(SparseMap::new);
			let emitted = offsets.get(path_id).copied().unwrap_or(0);
			offsets.insert(path_id, emitted.saturating_add(value.len()));
		}
		Ok(pulled)
	}

	/// Copies one exact raw source span returned by [`pull_at`](Self::pull_at).
	pub fn raw(&self, span: Range<usize>) -> Option<Str> {
		self.inner.raw(span)
	}
}

fn declared_pull_path(
	path: &[ArgPath],
	arg_specs: Option<(&Rev, &ArgSpecRegistry)>,
) -> SmallVec<PullPathSegment, 4> {
	let mut prefix = SmallVec::<ArgPath, 4>::new();
	path
		.iter()
		.map(|part| {
			prefix.push(part.clone());
			match part {
				ArgPath::Key(key) => {
					if let Some(spec) = arg_specs.and_then(|(rev, specs)| specs.get(rev, &prefix)) {
						let mut keys = SmallVec::with_capacity(1 + spec.aliases.len());
						let canonical = match spec.path.last() {
							Some(ArgPath::Key(canonical)) => canonical.clone(),
							_ => key.clone(),
						};
						keys.push(canonical);
						keys.extend(spec.aliases.iter().cloned());
						PullPathSegment::Keys(keys)
					} else {
						PullPathSegment::Key(key.clone())
					}
				},
				ArgPath::Index(index) => {
					PullPathSegment::Index(usize::try_from(*index).unwrap_or(usize::MAX))
				},
			}
		})
		.collect()
}

enum CoercionResult {
	Value(Value),
	Elided,
}

struct AppliedCoercions {
	steps:  SmallVec<(Coerce, Str, Str), 2>,
	elided: bool,
}

fn apply_coercions(value: &mut Value, spec: &ArgSpec) -> AppliedCoercions {
	let mut applied = AppliedCoercions { steps: SmallVec::new(), elided: false };
	for coercion in &spec.coerce {
		let before = Str::new(value.to_string());
		let Some(result) = coerce_once(*coercion, value, !spec.from_union_branch) else {
			continue;
		};
		match result {
			CoercionResult::Value(next) => {
				let after = Str::new(next.to_string());
				*value = next;
				applied.steps.push((*coercion, before, after));
			},
			CoercionResult::Elided => {
				applied.elided = true;
				applied.steps.push((*coercion, before, sf!("<absent>")));
				break;
			},
		}
	}
	applied
}

fn coerce_once(coercion: Coerce, value: &Value, allow_lossy: bool) -> Option<CoercionResult> {
	use crate::Coerce;
	match coercion {
		Coerce::LooseBool => match value {
			Value::String(value) => match value.as_str() {
				"true" | "yes" | "1" => Some(CoercionResult::Value(Value::Bool(true))),
				"false" | "no" | "0" => Some(CoercionResult::Value(Value::Bool(false))),
				_ => None,
			},
			Value::Number(number) if number.as_i64() == Some(1) => {
				Some(CoercionResult::Value(Value::Bool(true)))
			},
			Value::Number(number) if number.as_i64() == Some(0) => {
				Some(CoercionResult::Value(Value::Bool(false)))
			},
			_ => None,
		},
		Coerce::Integer => match value {
			Value::String(value) => value
				.parse::<i64>()
				.map(Value::from)
				.or_else(|_| value.parse::<u64>().map(Value::from))
				.ok()
				.map(CoercionResult::Value),
			Value::Number(number) if number.is_f64() => {
				let number = number.as_f64();
				(number.fract() == 0.0 && number >= i64::MIN as f64 && number < -(i64::MIN as f64))
					.then(|| CoercionResult::Value(Value::from(number as i64)))
			},
			_ => None,
		},
		Coerce::Number => match value {
			Value::String(value) => value
				.parse::<f64>()
				.ok()
				.and_then(omp_core::slopjson::Number::from_f64)
				.map(Value::from)
				.map(CoercionResult::Value),
			_ => None,
		},
		Coerce::String => match value {
			Value::Array(_) | Value::Object(_) if !allow_lossy => None,
			Value::String(_) => None,
			_ => Some(CoercionResult::Value(Value::String(Str::new(value.to_string())))),
		},
		Coerce::Singleton if !allow_lossy || matches!(value, Value::Array(_)) => None,
		Coerce::Singleton => Some(CoercionResult::Value(Value::Array(vec![value.clone()]))),
		Coerce::JsonString => match value {
			Value::String(value) => omp_core::slopjson::parse(value)
				.ok()
				.map(CoercionResult::Value),
			_ => None,
		},
		Coerce::Strip => match value {
			Value::String(value) => {
				let trimmed = value.trim();
				(trimmed.len() != value.len()).then(|| CoercionResult::Value(Value::String(trimmed)))
			},
			_ => None,
		},
		Coerce::Csv => match value {
			Value::String(value) if value.contains(',') => Some(CoercionResult::Value(Value::Array(
				value
					.split(",")
					.map(|item| Value::String(item.trim()))
					.collect(),
			))),
			_ => None,
		},
		Coerce::NullElision => match value {
			Value::Null => Some(CoercionResult::Elided),
			Value::String(value) if value.is_empty() || value == "null" => {
				Some(CoercionResult::Elided)
			},
			_ => None,
		},
	}
}

struct StructureNode<'a> {
	value:     &'a Value,
	source:    SmallVec<PullPathSegment, 4>,
	canonical: SmallVec<ArgPath, 4>,
}

async fn validate_structure(
	cursor: &SlopCursor,
	root: &Value,
	arg_specs: Option<(&Rev, &ArgSpecRegistry)>,
) -> Result<(), ParamError> {
	let mut pending = vec![StructureNode {
		value:     root,
		source:    SmallVec::new(),
		canonical: SmallVec::new(),
	}];
	while let Some(node) = pending.pop() {
		match node.value {
			Value::Object(object) => {
				let keys = cursor
					.object_keys(&node.source)
					.await
					.map_err(|error| param_error(error, arg_specs))?;
				let mut seen = SmallVec::<SmallVec<ArgPath, 4>, 8>::new();
				for key in &keys {
					let candidate = child_path(&node.canonical, ArgPath::Key(key.clone()));
					let spec = arg_specs.and_then(|(rev, specs)| specs.get(rev, &candidate));
					let identity = spec.map_or_else(|| candidate.clone(), |spec| spec.path.clone());
					if seen.contains(&identity) {
						let expected = spec
							.map_or_else(|| sf!("one unambiguous value"), |spec| spec.expected.clone());
						return Err(ParamError::Args(Box::new(ArgIssue {
							path: identity.into_iter().collect(),
							expected,
							kind: ArgIssueKind::Ambiguous,
							example: spec.and_then(|spec| spec.example.clone()),
							found: Some(sf!("multiple values")),
						})));
					}
					seen.push(identity);
				}
				for (key, value) in object {
					let candidate = child_path(&node.canonical, ArgPath::Key(key.clone()));
					let canonical = arg_specs
						.and_then(|(rev, specs)| specs.get(rev, &candidate))
						.map_or(candidate, |spec| spec.path.clone());
					let mut source = node.source.clone();
					source.push(PullPathSegment::Key(key.clone()));
					pending.push(StructureNode { value, source, canonical });
				}
			},
			Value::Array(values) => {
				for (index, value) in values.iter().enumerate() {
					let index_u64 = u64::try_from(index).unwrap_or(u64::MAX);
					let candidate = child_path(&node.canonical, ArgPath::Index(index_u64));
					let canonical = arg_specs
						.and_then(|(rev, specs)| specs.get(rev, &candidate))
						.map_or(candidate, |spec| spec.path.clone());
					let mut source = node.source.clone();
					source.push(PullPathSegment::Index(index));
					pending.push(StructureNode { value, source, canonical });
				}
			},
			_ => {},
		}
	}
	Ok(())
}

fn child_path(path: &[ArgPath], child: ArgPath) -> SmallVec<ArgPath, 4> {
	let mut result = SmallVec::with_capacity(path.len() + 1);
	result.extend(path.iter().cloned());
	result.push(child);
	result
}

fn canonicalize(
	mut value: Value,
	path: &SmallVec<ArgPath, 4>,
	arg_specs: Option<(&Rev, &ArgSpecRegistry)>,
	repairs: &mut SmallVec<Repair, 4>,
) -> Option<Value> {
	if let Some(spec) = arg_specs.and_then(|(rev, specs)| specs.get(rev, path)) {
		let applied = apply_coercions(&mut value, spec);
		for (coercion, before, after) in applied.steps {
			repairs.push(Repair {
				path:   spec.path.clone(),
				kind:   if coercion == Coerce::NullElision {
					RepairKind::Elision
				} else {
					RepairKind::Coercion
				},
				detail: sf!("{coercion}: {before} -> {after}"),
			});
		}
		if applied.elided {
			return None;
		}
	}
	match value {
		Value::Object(object) => {
			let mut canonical = omp_core::slopjson::Object::with_capacity(object.len());
			let parent = arg_specs.and_then(|(rev, specs)| specs.get(rev, path));
			for (key, value) in object {
				let candidate = child_path(path, ArgPath::Key(key.clone()));
				let spec = arg_specs.and_then(|(rev, specs)| specs.get(rev, &candidate));
				if spec.is_none()
					&& parent
						.is_some_and(|parent| !parent.additional_properties && !parent.from_union_branch)
				{
					repairs.push(Repair {
						path:   candidate,
						kind:   RepairKind::Elision,
						detail: sf!("undeclared property elided"),
					});
					continue;
				}
				let (canonical_path, canonical_key) = if let Some(spec) = spec {
					let canonical_key = match spec.path.last() {
						Some(ArgPath::Key(key)) => key.clone(),
						_ => key.clone(),
					};
					if canonical_key != key {
						repairs.push(Repair {
							path:   spec.path.clone(),
							kind:   RepairKind::Alias,
							detail: sf!("{key} -> {canonical_key}"),
						});
					}
					(spec.path.clone(), canonical_key)
				} else {
					(candidate, key)
				};
				if let Some(value) = canonicalize(value, &canonical_path, arg_specs, repairs) {
					let previous = canonical.insert(canonical_key, value);
					debug_assert!(previous.is_none(), "ambiguity was rejected before canonicalization");
				}
			}
			Some(Value::Object(canonical))
		},
		Value::Array(values) => Some(Value::Array(
			values
				.into_iter()
				.enumerate()
				.filter_map(|(index, value)| {
					let path = child_path(path, ArgPath::Index(index as u64));
					canonicalize(value, &path, arg_specs, repairs)
				})
				.collect(),
		)),
		value => Some(value),
	}
}

/// Tool-facing cursor over one invocation's single inbound event stream.
///
/// Raw fragments are fed to one `omp-slopjson` document. [`pull`](Self::pull)
/// transfers that document into exactly one linear cursor session; callers can
/// pull selected keys inside the session without touching unknown siblings.
/// Effects must await [`committed`](Self::committed), which succeeds only after
/// an explicit [`InvocationEvent::ArgsCommitted`].
pub struct IncomingParams<'c> {
	events:        Receiver<InvocationEvent>,
	owner:         Option<Str>,
	invocation:    Option<Str>,
	direct:        Option<Arc<DirectFeed>>,
	feed:          Option<IncomingFeed>,
	doc:           Option<IncomingDoc>,
	finalizer:     Option<SlopCursor>,
	finalized:     Option<FinalizedArgs>,
	cursor_issued: bool,
	arg_specs:     Option<(&'c Rev, &'c ArgSpecRegistry)>,
	assembled:     String,
	committed:     Option<Str>,
	interrupts:    VecDeque<Interrupt>,
	protocol:      Option<Str>,
	_scope:        PhantomData<&'c ()>,
}

impl IncomingParams<'static> {
	/// Creates the producer and consumer sides of one invocation.
	pub fn channel() -> (InvocationFeed, Self) {
		Self::channel_for(None, None)
	}

	/// Creates an invocation scoped to one authenticated kernel owner.
	pub fn owned_channel(owner: Str) -> (InvocationFeed, Self) {
		Self::channel_for(Some(owner), None)
	}

	/// Creates an invocation carrying the kernel's stable call identity, so a
	/// tool that hands work to a host surface (an `ask` dialog) can be
	/// answered by that identity.
	pub fn channel_for(owner: Option<Str>, invocation: Option<Str>) -> (InvocationFeed, Self) {
		let (tx, events) = flume::unbounded();
		let (parser, doc) = IncomingDoc::channel();
		let direct = Arc::new(DirectFeed {
			state:     Mutex::new(DirectFeedState {
				parser:    Some(parser),
				fragments: SmallVec::new(),
				byte_len:  0,
				committed: false,
				protocol:  None,
			}),
			finalized: Mutex::new(None),
			producers: AtomicUsize::new(1),
		});
		(InvocationFeed { tx, direct: Arc::clone(&direct) }, Self {
			events,
			owner,
			invocation,
			direct: Some(direct),
			feed: None,
			arg_specs: None,
			finalizer: Some(doc.cursor()),
			doc: Some(doc),
			finalized: None,
			cursor_issued: false,
			assembled: String::new(),
			committed: None,
			interrupts: VecDeque::new(),
			protocol: None,
			_scope: PhantomData,
		})
	}
}

impl<'c> IncomingParams<'c> {
	/// Constructs a cursor from an existing linear event receiver.
	pub fn from_receiver(events: Receiver<InvocationEvent>) -> Self {
		let (feed, doc) = IncomingDoc::channel();
		Self {
			events,
			owner: None,
			invocation: None,
			direct: None,
			feed: Some(feed),
			arg_specs: None,
			finalizer: Some(doc.cursor()),
			doc: Some(doc),
			finalized: None,
			cursor_issued: false,
			assembled: String::new(),
			committed: None,
			interrupts: VecDeque::new(),
			protocol: None,
			_scope: PhantomData,
		}
	}

	/// Authenticated owner of the persistent resources used by this invocation.
	pub const fn owner(&self) -> Option<&Str> {
		self.owner.as_ref()
	}

	/// Kernel call identity of this invocation (the `<tool id>` in the
	/// session tree), when the dispatcher supplied one.
	pub const fn invocation_id(&self) -> Option<&Str> {
		self.invocation.as_ref()
	}

	/// Binds argument pulls to the immutable declarations for the invoked
	/// revision.
	pub const fn bind_arg_specs(&mut self, rev: &'c Rev, specs: &'c ArgSpecRegistry) {
		self.arg_specs = Some((rev, specs));
	}

	/// Takes the document's path-addressed host cursor.
	///
	/// The closure API and cursor API are mutually exclusive views of the same
	/// document. A second take is a protocol error.
	pub fn cursor(&mut self) -> Result<IncomingCursor<'c>, ParamError> {
		if self.direct.is_none() {
			return Err(ParamError::Protocol(sf!("path cursor requires an InvocationFeed channel",)));
		}
		self.sync_direct_problem().map_err(ParamError::Protocol)?;
		if self.cursor_issued {
			return Err(ParamError::Protocol(sf!("JSON cursor session was already consumed",)));
		}
		let doc = self
			.doc
			.take()
			.ok_or_else(|| ParamError::Protocol(sf!("JSON cursor session was already consumed")))?;
		self.cursor_issued = true;
		let (rev, arg_specs) = self
			.arg_specs
			.map_or((None, None), |(rev, specs)| (Some(rev), Some(specs)));
		Ok(IncomingCursor {
			inner: doc.cursor(),
			rev,
			arg_specs,
			state: Arc::new(CursorState { active: AtomicBool::new(false), chunks: Mutex::new(None) }),
		})
	}

	/// Runs the invocation's sole JSON cursor session while continuing to feed
	/// it.
	///
	/// The closure owns the document, making fan-out impossible. It may pull
	/// only selected object keys; malformed or unknown siblings are never
	/// parsed merely because they exist.
	pub async fn pull<R, F, Fut>(&mut self, operation: F) -> Result<R, ParamError>
	where
		F: FnOnce(IncomingDoc) -> Fut,
		Fut: Future<Output = Result<R, IncomingError>>,
	{
		self.drive_pull(operation, false).await
	}

	/// Strictly finalizes the complete argument document exactly once.
	pub async fn finalize(&mut self) -> Result<&FinalizedArgs, ParamError> {
		self.finalize_with_interrupts(false).await
	}

	/// Returns the authoritative canonical argument commitment.
	pub async fn raw(&mut self) -> Result<Str, ParamError> {
		self
			.drive_commit_raw(false)
			.await
			.map_err(commit_param_error)
	}

	/// Explicitly opts into decoding and validating the one canonical complete
	/// argument shape.
	pub async fn whole<T: DeserializeOwned>(&mut self) -> Result<T, ParamError> {
		let finalized = self.finalize().await?;
		crate::decode_params(finalized.effective_json())
			.map_err(|_| malformed_issue(any::type_name::<T>(), None))
	}

	/// Waits for the explicit effect-authorization frame and returns the
	/// canonical effective argument JSON.
	///
	/// Disconnect/drop before that frame is [`CommitError::Aborted`].
	pub async fn committed(&mut self) -> Result<Str, CommitError> {
		self
			.finalize_with_interrupts(false)
			.await
			.map(|finalized| finalized.effective_json().clone())
			.map_err(param_commit_error)
	}

	/// Returns a view whose pulls and commitment wait observe interrupts.
	pub const fn interruptable(&mut self) -> InterruptibleParams<'_, 'c> {
		InterruptibleParams { inner: self }
	}

	/// Removes the oldest interrupt observed by a non-interruptible operation.
	pub fn take_interrupt(&mut self) -> Option<Interrupt> {
		self.interrupts.pop_front()
	}

	/// Waits for and consumes the next structured interrupt.
	///
	/// This is the cooperative-cancellation arm for resource operations that
	/// begin after argument commitment. A closed feed is reported separately
	/// because the resource owner must then establish terminal effect truth.
	pub async fn next_interrupt(&mut self) -> Result<Interrupt, InterruptWaitError> {
		if let Some(interrupt) = self.interrupts.pop_front() {
			return Ok(interrupt);
		}
		loop {
			if let Ok(event) = self.events.recv_async().await {
				if let Some(interrupt) = self.apply(event).map_err(InterruptWaitError::Protocol)? {
					self.interrupts.pop_back();
					return Ok(interrupt);
				}
			} else {
				self.disconnect();
				return Err(InterruptWaitError::Closed);
			}
		}
	}

	async fn finalize_with_interrupts(
		&mut self,
		observe: bool,
	) -> Result<&FinalizedArgs, ParamError> {
		self.sync_direct_problem().map_err(ParamError::Protocol)?;
		if self.finalized.is_none() {
			let raw = self
				.drive_commit_raw(observe)
				.await
				.map_err(commit_param_error)?;
			let cursor = self
				.finalizer
				.clone()
				.ok_or_else(|| ParamError::Protocol(sf!("argument finalizer cursor is unavailable")))?;
			let observed_raw = cursor
				.raw_document()
				.await
				.map_err(|error| param_error(error, self.arg_specs))?;
			// A canonicalized or repaired commitment supersedes the streamed
			// text; finalize from the committed document instead of the feed.
			let cursor = if observed_raw == raw {
				cursor
			} else if commit_supersedes_stream(&observed_raw, &raw) {
				let (mut feed, doc) = IncomingDoc::channel();
				let _ = feed.push(&raw);
				feed.finish();
				doc.cursor()
			} else {
				return Err(ParamError::Protocol(sf!(
					"finalized arguments differ from streamed fragments",
				)));
			};
			let pulled = cursor
				.pull_at(&[], PullMode::Complete, "an argument object")
				.await
				.map_err(|error| param_error(error, self.arg_specs))?;
			let PulledKind::Complete(root) = pulled.kind else {
				unreachable!("complete pull always returns a complete value")
			};
			if !matches!(&root, Value::Object(_)) {
				return Err(malformed_issue("an argument object", Some(value_kind(&root))));
			}
			validate_structure(&cursor, &root, self.arg_specs).await?;
			let mut repairs = SmallVec::new();
			{
				let parser_repairs = cursor.repairs();
				for repair in parser_repairs.as_slice() {
					let path = repair
						.path
						.iter()
						.map(|part| match part {
							omp_core::slopjson::RepairPathSegment::Key(key) => ArgPath::Key(key.clone()),
							omp_core::slopjson::RepairPathSegment::Index(index) => {
								ArgPath::Index(*index as u64)
							},
						})
						.collect();
					repairs.push(Repair {
						path,
						kind: RepairKind::Tolerance,
						detail: sf!("{:?}: {} -> {}", repair.kind, repair.before, repair.after),
					});
				}
			}
			let effective = canonicalize(root, &SmallVec::new(), self.arg_specs, &mut repairs)
				.expect("the root argument object cannot be elided");
			let effective_json = Str::new(effective.to_string());
			self.finalized = Some(FinalizedArgs { raw, effective, effective_json, repairs });
			if let (Some(direct), Some(finalized)) = (&self.direct, &self.finalized) {
				*direct.finalized.lock() = Some(finalized.clone());
			}
		}
		Ok(self
			.finalized
			.as_ref()
			.expect("set above or already finalized"))
	}

	async fn drive_pull<R, F, Fut>(&mut self, operation: F, observe: bool) -> Result<R, ParamError>
	where
		F: FnOnce(IncomingDoc) -> Fut,
		Fut: Future<Output = Result<R, IncomingError>>,
	{
		self.sync_direct_problem().map_err(ParamError::Protocol)?;
		if let Some(problem) = self.protocol.clone() {
			return Err(ParamError::Protocol(problem));
		}
		if observe && let Some(interrupt) = self.interrupts.pop_front() {
			return Err(ParamError::Interrupted(interrupt));
		}
		let doc = self
			.doc
			.take()
			.ok_or_else(|| ParamError::Protocol(sf!("JSON cursor session was already consumed")))?;
		let arg_specs = self.arg_specs;
		let events = self.events.clone();
		let pull = operation(doc).fuse();
		pin_mut!(pull);
		loop {
			let receive = events.recv_async().fuse();
			pin_mut!(receive);
			select_biased! {
				result = pull => return result.map_err(|error| param_error(error, arg_specs)),
				event = receive => match event {
					Ok(event) => {
						if let Some(interrupt) = self.apply(event).map_err(ParamError::Protocol)?
							&& observe
						{
							self.interrupts.pop_back();
							return Err(ParamError::Interrupted(interrupt));
						}
					},
					Err(_) => self.disconnect(),
				},
			}
		}
	}

	async fn drive_commit_raw(&mut self, observe: bool) -> Result<Str, CommitError> {
		self.sync_direct_problem().map_err(CommitError::Protocol)?;
		if let Some(problem) = self.protocol.clone() {
			return Err(CommitError::Protocol(problem));
		}
		if let Some(raw) = self.committed.clone() {
			return Ok(raw);
		}
		if observe && let Some(interrupt) = self.interrupts.pop_front() {
			return Err(CommitError::Interrupted(interrupt));
		}
		loop {
			if let Ok(event) = self.events.recv_async().await {
				if let Some(interrupt) = self.apply(event).map_err(CommitError::Protocol)?
					&& observe
				{
					self.interrupts.pop_back();
					return Err(CommitError::Interrupted(interrupt));
				}
				self.sync_direct_problem().map_err(CommitError::Protocol)?;
				if let Some(raw) = self.committed.clone() {
					return Ok(raw);
				}
			} else {
				self.disconnect();
				return Err(CommitError::Aborted);
			}
		}
	}

	fn apply(&mut self, event: InvocationEvent) -> Result<Option<Interrupt>, Str> {
		match event {
			InvocationEvent::ArgText { fragment } => {
				if self.committed.is_some() {
					return self.protocol("argument text arrived after commitment");
				}
				self.assembled.push_str(&fragment);
				if let Some(feed) = &mut self.feed {
					feed
						.push(&fragment)
						.map_err(|_| sf!("JSON feed closed before commitment"))?;
				}
				Ok(None)
			},
			InvocationEvent::ArgsCommitted { raw } => {
				if self.committed.is_some() {
					return self.protocol("duplicate argument commitment");
				}
				if self.assembled.is_empty() && !raw.is_empty() {
					if let Some(feed) = &mut self.feed {
						feed
							.push(&raw)
							.map_err(|_| sf!("JSON feed closed before commitment"))?;
					}
					self.assembled.push_str(&raw);
				}
				if self.assembled != raw.as_str() && !commit_supersedes_stream(&self.assembled, &raw) {
					return self.protocol("committed arguments differ from streamed fragments");
				}
				self.committed = Some(raw);
				if let Some(feed) = self.feed.take() {
					feed.finish();
				}
				Ok(None)
			},
			InvocationEvent::Interrupt(interrupt) => {
				self.interrupts.push_back(interrupt.clone());
				Ok(Some(interrupt))
			},
		}
	}

	fn protocol<T>(&mut self, message: &'static str) -> Result<T, Str> {
		let problem = Str::new(message);
		self.protocol = Some(problem.clone());
		if let Some(feed) = self.feed.take() {
			feed.abort();
		}
		Err(problem)
	}

	fn sync_direct_problem(&mut self) -> Result<(), Str> {
		let Some(direct) = self.direct.as_ref() else {
			return Ok(());
		};
		let problem = { direct.state.lock().protocol.clone() };
		if let Some(problem) = problem {
			self.protocol = Some(problem.clone());
			return Err(problem);
		}
		Ok(())
	}

	fn disconnect(&mut self) {
		if self.committed.is_none()
			&& let Some(feed) = self.feed.take()
		{
			feed.abort();
		}
	}
}

/// Interrupt-observing view over an [`IncomingParams`] cursor.
pub struct InterruptibleParams<'p, 'c> {
	inner: &'p mut IncomingParams<'c>,
}

impl InterruptibleParams<'_, '_> {
	/// Runs the sole JSON cursor and returns immediately on observed interrupt.
	pub async fn pull<R, F, Fut>(&mut self, operation: F) -> Result<R, ParamError>
	where
		F: FnOnce(IncomingDoc) -> Fut,
		Fut: Future<Output = Result<R, IncomingError>>,
	{
		self.inner.drive_pull(operation, true).await
	}

	/// Whole-document decode with interrupt observation.
	pub async fn whole<T: DeserializeOwned>(&mut self) -> Result<T, ParamError> {
		let finalized = self.inner.finalize_with_interrupts(true).await?;
		crate::decode_params(finalized.effective_json())
			.map_err(|_| malformed_issue(any::type_name::<T>(), None))
	}

	/// Explicit commitment wait with interrupt observation.
	pub async fn committed(&mut self) -> Result<Str, CommitError> {
		self
			.inner
			.finalize_with_interrupts(true)
			.await
			.map(|finalized| finalized.effective_json().clone())
			.map_err(param_commit_error)
	}
}

fn commit_param_error(error: CommitError) -> ParamError {
	match error {
		CommitError::Aborted => {
			malformed_issue_with_kind("complete JSON arguments", ArgIssueKind::Aborted, None)
		},
		CommitError::Interrupted(interrupt) => ParamError::Interrupted(interrupt),
		CommitError::Protocol(problem) => ParamError::Protocol(problem),
	}
}

fn param_commit_error(error: ParamError) -> CommitError {
	match error {
		ParamError::Args(issue) if issue.kind == ArgIssueKind::Aborted => CommitError::Aborted,
		ParamError::Args(_) => {
			CommitError::Protocol(sf!("argument finalization failed before authorization"))
		},
		ParamError::Interrupted(interrupt) => CommitError::Interrupted(interrupt),
		ParamError::Protocol(problem) => CommitError::Protocol(problem),
	}
}

fn malformed_issue(expected: &'static str, found: Option<&'static str>) -> ParamError {
	malformed_issue_with_kind(expected, ArgIssueKind::Malformed, found)
}

fn malformed_issue_with_kind(
	expected: &'static str,
	kind: ArgIssueKind,
	found: Option<&'static str>,
) -> ParamError {
	ParamError::Args(Box::new(ArgIssue {
		path: Vec::new(),
		expected: Str::new(expected),
		kind,
		example: None,
		found: found.map(Str::new),
	}))
}

const fn value_kind(value: &Value) -> &'static str {
	match value {
		Value::Null => "null",
		Value::Bool(_) => "boolean",
		Value::Number(_) => "number",
		Value::String(_) => "string",
		Value::Array(_) => "array",
		Value::Object(_) => "object",
	}
}

fn param_error(error: IncomingError, arg_specs: Option<(&Rev, &ArgSpecRegistry)>) -> ParamError {
	match error {
		IncomingError::Pull(issue) => ParamError::Args(Box::new(arg_issue(issue, arg_specs))),
		IncomingError::Aborted => ParamError::Args(Box::new(ArgIssue {
			path:     Vec::new(),
			expected: sf!("complete JSON arguments"),
			kind:     ArgIssueKind::Aborted,
			example:  None,
			found:    None,
		})),
		IncomingError::Parse(_) => ParamError::Args(Box::new(ArgIssue {
			path:     Vec::new(),
			expected: sf!("valid JSON arguments"),
			kind:     ArgIssueKind::Malformed,
			example:  None,
			found:    None,
		})),
	}
}

fn arg_issue(issue: PullIssue, arg_specs: Option<(&Rev, &ArgSpecRegistry)>) -> ArgIssue {
	let (kind, found) = match issue.kind {
		PullIssueKind::Missing => (ArgIssueKind::Missing, None),
		PullIssueKind::Incomplete => (ArgIssueKind::Incomplete, None),
		PullIssueKind::Aborted => (ArgIssueKind::Aborted, None),
		PullIssueKind::Malformed => (ArgIssueKind::Malformed, None),
		PullIssueKind::TypeMismatch { found } => (ArgIssueKind::TypeMismatch, Some(Str::new(found))),
	};
	let path = issue
		.path
		.into_iter()
		.map(|part| match part {
			PullPathSegment::Key(key) => ArgPath::Key(key),
			PullPathSegment::Keys(keys) => ArgPath::Key(keys.into_iter().next().unwrap_or_default()),
			PullPathSegment::Index(index) => ArgPath::Index(index as u64),
		})
		.collect::<Vec<_>>();
	let spec = arg_specs.and_then(|(rev, specs)| specs.get(rev, &path));
	let expected =
		spec.map_or_else(|| Str::new(issue.expected), |declared| declared.expected.clone());
	let example = spec.and_then(|declared| declared.example.clone());
	ArgIssue { path, expected, kind, example, found }
}

#[cfg(test)]
mod tests {
	use futures::executor::block_on;
	use smallvec::smallvec;

	use super::*;

	const EXAMPLE: &str = r#"{"path":"résumé/💾"}"#;

	#[derive(Debug, Deserialize, Eq, PartialEq)]
	#[serde(deny_unknown_fields)]
	struct ExampleParams {
		path: Str,
	}

	#[test]
	fn whole_decodes_tool_params_without_protocol_intent() {
		let (feed, mut params) = IncomingParams::channel();
		feed
			.args_committed(sf!(r#"{{"i":"Reading fixture","path":"fixture.txt"}}"#))
			.expect("arguments remain connected");
		assert_eq!(
			block_on(params.whole::<ExampleParams>()).expect("intent is protocol metadata"),
			ExampleParams { path: sf!("fixture.txt") },
		);
	}

	fn declarations() -> (Rev, ArgSpecRegistry) {
		let rev = Rev { family: sf!("native"), n: 7 };
		let mut specs = ArgSpecRegistry::new();
		specs
			.register(rev.clone(), ArgSpec {
				path:                  smallvec![ArgPath::Key(sf!("path"))],
				aliases:               smallvec![sf!("file_path")],
				coerce:                smallvec![],
				from_union_branch:     false,
				expected:              sf!("declared numeric path"),
				example:               Some(Str::new(EXAMPLE)),
				additional_properties: false,
			})
			.expect("argument declaration registers");
		specs.seal();
		(rev, specs)
	}

	fn bound_params<'a>(
		rev: &'a Rev,
		specs: &'a ArgSpecRegistry,
	) -> (InvocationFeed, IncomingParams<'a>) {
		let (feed, mut params): (_, IncomingParams<'a>) = IncomingParams::channel();
		params.bind_arg_specs(rev, specs);
		(feed, params)
	}

	fn number_issue(params: &mut IncomingParams<'_>, key: &'static str) -> ArgIssue {
		let error = block_on(params.pull(|mut doc| async move {
			let root = doc.json();
			let mut object = root.object();
			let mut value = object.key(key);
			value.number().await
		}))
		.expect_err("declared number pull must reject a string");
		let ParamError::Args(issue) = error else {
			panic!("pull failure must remain a structured argument issue");
		};
		*issue
	}

	#[test]
	fn canonicalized_commitment_supersedes_whitespaced_stream() {
		let (feed, mut params) = IncomingParams::channel();
		feed
			.arg_text(sf!(r#"{{"pattern": "TODO", "#))
			.expect("fragment remains connected");
		feed
			.arg_text(sf!(r#""path": "src"}}"#))
			.expect("fragment remains connected");
		feed
			.args_committed(sf!(r#"{{"pattern":"TODO","path":"src"}}"#))
			.expect("commit remains connected");
		let raw = block_on(params.committed()).expect("cosmetic normalization is accepted");
		assert_eq!(raw.as_str(), r#"{"pattern":"TODO","path":"src"}"#);
	}

	#[test]
	fn repaired_commitment_supersedes_a_sloppy_stream() {
		let (feed, mut params) = IncomingParams::channel();
		feed
			.arg_text(sf!("{{path:'crates',}}"))
			.expect("fragment remains connected");
		feed
			.args_committed(sf!(r#"{{"path":"crates"}}"#))
			.expect("commit remains connected");
		let raw = block_on(params.committed()).expect("repaired commitment is authoritative");
		assert_eq!(raw.as_str(), r#"{"path":"crates"}"#);
	}
	#[test]
	fn schema_coerced_commitment_is_the_executed_document() {
		let (feed, mut params) = IncomingParams::channel();
		feed
			.arg_text(sf!(
				r#"{{"args":{{"flag":"yes","count":"42","ratio":"3.5","label":99}},"extra":1}}"#,
			))
			.expect("fragment remains connected");
		feed
			.args_committed(sf!(r#"{{"args":{{"flag":true,"count":42,"ratio":3.5,"label":"99"}}}}"#,))
			.expect("commit remains connected");
		let effective =
			block_on(params.committed()).expect("schema-directed scalar repair is authoritative");
		assert_eq!(
			effective.as_str(),
			r#"{"args":{"flag":true,"count":42,"ratio":3.5,"label":"99"}}"#,
		);
	}
	#[test]
	fn closed_object_elides_unknown_members_with_a_repair() {
		let rev = Rev { family: sf!("python"), n: 1 };
		let mut specs = ArgSpecRegistry::new();
		for path in [smallvec![ArgPath::Key(sf!("args"))], smallvec![
			ArgPath::Key(sf!("args")),
			ArgPath::Key(sf!("label"))
		]] {
			specs
				.register(rev.clone(), ArgSpec {
					path,
					aliases: SmallVec::new(),
					coerce: SmallVec::new(),
					from_union_branch: false,
					expected: sf!("a declared argument"),
					example: None,
					additional_properties: false,
				})
				.expect("argument declaration registers");
		}
		specs.seal();
		let (feed, mut params) = bound_params(&rev, &specs);
		feed
			.args_committed(sf!(r#"{{"args":{{"label":"ok","extra":1}}}}"#))
			.expect("arguments remain connected");
		let finalized = block_on(params.finalize()).expect("closed object repairs extra member");
		assert_eq!(finalized.effective_json(), r#"{"args":{"label":"ok"}}"#);
		assert_eq!(finalized.repairs().len(), 1);
		assert_eq!(finalized.repairs()[0].path, [
			ArgPath::Key(sf!("args")),
			ArgPath::Key(sf!("extra"))
		],);
		assert_eq!(finalized.repairs()[0].kind, RepairKind::Elision);
		let receipt = feed
			.take_finalized_args()
			.expect("the invocation owner observes tool-side finalization");
		assert_eq!(receipt.effective_json(), r#"{"args":{"label":"ok"}}"#);
		assert_eq!(receipt.repairs(), finalized.repairs());
		assert!(
			feed.take_finalized_args().is_none(),
			"the finalization receipt is consumed exactly once",
		);
	}

	#[test]
	fn truncated_stream_cannot_be_superseded_by_repaired_commitment() {
		let (feed, mut params) = IncomingParams::channel();
		feed
			.arg_text(sf!(r#"{{"command":"echo never","i":"Truncated"#))
			.expect("fragment remains connected");
		feed
			.args_committed(sf!(r#"{{"command":"echo never"}}"#))
			.expect("commit remains connected");
		assert!(matches!(block_on(params.committed()), Err(CommitError::Protocol(_)),));
	}

	#[test]
	fn canonicalized_freeform_commitment_supersedes_json_shaped_text() {
		// A grammar-constrained tool streams raw text; recovery commits the
		// canonical `{"input": <text>}` object. Even text that parses as JSON
		// must not be mistaken for a divergent document.
		let (feed, mut params) = IncomingParams::channel();
		feed
			.arg_text(sf!("[1,2,3]"))
			.expect("fragment remains connected");
		feed
			.args_committed(sf!(r#"{{"input":"[1,2,3]"}}"#))
			.expect("commit remains connected");
		let raw = block_on(params.committed()).expect("canonicalized freeform commit is accepted");
		assert_eq!(raw.as_str(), r#"{"input":"[1,2,3]"}"#);
	}

	#[test]
	fn materially_different_commitment_stays_a_protocol_error() {
		let (feed, mut params) = IncomingParams::channel();
		feed
			.arg_text(sf!(r#"{{"path":"src"}}"#))
			.expect("fragment remains connected");
		feed
			.args_committed(sf!(r#"{{"path":"elsewhere"}}"#))
			.expect("commit remains connected");
		let error = block_on(params.committed()).expect_err("divergent values are rejected");
		assert!(matches!(error, CommitError::Protocol(message)
			if message.contains("committed arguments differ")));
	}

	#[test]
	fn canonical_and_alias_failures_share_the_declared_example() {
		let (rev, specs) = declarations();
		for key in ["path", "file_path"] {
			let (feed, mut params) = bound_params(&rev, &specs);
			feed
				.args_committed(sf!(r#"{{"{key}":"wrong"}}"#))
				.expect("arguments remain connected");

			let issue = number_issue(&mut params, key);
			assert_eq!(issue.path, vec![ArgPath::Key(Str::new(key))]);
			assert_eq!(issue.expected, "declared numeric path");
			assert_eq!(issue.example.as_deref(), Some(EXAMPLE));
		}
	}

	#[test]
	fn undeclared_failure_does_not_invent_an_example() {
		let (rev, specs) = declarations();
		let (feed, mut params) = bound_params(&rev, &specs);
		feed
			.args_committed(sf!(r#"{{"other":"wrong"}}"#))
			.expect("arguments remain connected");
		let issue = number_issue(&mut params, "other");
		assert_eq!(issue.path, vec![ArgPath::Key(sf!("other"))]);
		assert_eq!(issue.example, None);
	}

	#[test]
	fn declared_example_survives_interrupt_then_pull_reentry() {
		let (rev, specs) = declarations();
		let (feed, mut params) = bound_params(&rev, &specs);
		let interrupt = Interrupt { class: sf!("steering"), reason: sf!("change direction") };
		feed
			.interrupt(interrupt.clone())
			.expect("interrupt remains connected");
		feed
			.args_committed(sf!(r#"{{"file_path":"wrong"}}"#))
			.expect("arguments remain connected");
		block_on(params.committed()).expect("commit buffers the earlier interrupt");

		let interrupted = block_on(
			params
				.interruptable()
				.pull(|_| async { Ok::<(), IncomingError>(()) }),
		);
		assert!(matches!(
			interrupted,
			Err(ParamError::Interrupted(observed)) if observed == interrupt
		));

		let issue = number_issue(&mut params, "file_path");
		assert_eq!(issue.path, vec![ArgPath::Key(sf!("file_path"))]);
		assert_eq!(issue.example.as_deref().map(str::as_bytes), Some(EXAMPLE.as_bytes()));
	}
}
