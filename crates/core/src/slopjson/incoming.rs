//! Typed cursors over a JSON document while its text is still arriving.
//!
//! [`IncomingDoc::channel`] returns a push-side [`IncomingFeed`] and a
//! read-side root cursor. The producer appends UTF-8 fragments, then explicitly
//! calls [`IncomingFeed::finish`] or [`IncomingFeed::abort`]. Dropping the feed
//! aborts it. There is one shared append-only buffer and one exclusive linear
//! cursor: child cursors retain a mutable borrow of their parent, and pulls are
//! ordinary futures whose cancellation releases that borrow. There are no
//! snapshots, per-field events, or broadcast/fan-out channels.
//! [`IncomingCursor`] is the host-facing exception: it is cloneable so a
//! transport can retain it, but the transport must serialize outstanding pulls.
//!
//! A scalar completes at its closing quote/delimiter, and a container completes
//! only when its closing delimiter arrives. Finished-but-truncated input yields
//! [`PullIssueKind::Incomplete`]; abandoned input yields
//! [`PullIssueKind::Aborted`]. String chunks contain only decoded bytes whose
//! meaning is stable, so an escape or Unicode escape may span any number of
//! fragments.
//!
//! Pulling an [`IncomingObject::key`] makes that key required: a missing or
//! mistyped value is a structured [`PullIssue`]. Object members never pulled
//! are skipped without validation. [`IncomingDoc::whole`] is the explicit
//! whole-document pull and runs only after successful input completion.
//!
//! Object cursors bind the first occurrence of a duplicate key. In contrast,
//! [`IncomingJson::value`] and whole-container collection use the module's
//! final [`crate::slopjson::parse`] path, whose [`crate::slopjson::Object`] has
//! normal last-write-wins behavior. Consumers for which duplicates are
//! significant must detect that divergence themselves.
//!
//! Mid-stream cursors tolerate incomplete tokens but read double-quoted
//! strings with the final parser's strict closing rule ([`Mode::Incoming`]):
//! an unescaped inner `"` can never swallow a sibling key or value. A pulled
//! scalar completes only once a value terminator follows it, like numbers,
//! so structural garbage after a value surfaces as
//! [`PullIssueKind::Incomplete`] rather than a silently misparsed pull.
//! Single-quote recovery (`'it's'`) is shared with the final parser and
//! passes both.

use std::{
	any, error,
	fmt::{self, Display},
	future::poll_fn,
	marker::PhantomData,
	mem,
	ops::{Deref, Range},
	slice,
	sync::Arc,
	task::{Poll, Waker},
};

use parking_lot::{Mutex, MutexGuard};
use serde::de::DeserializeOwned;
use smallvec::SmallVec;
use thiserror::Error;

use crate::{
	IntoStr, Str,
	slopjson::{
		Deserializer, Number, Object, ParseError, Value, from_str, parse,
		parser::{Atom, MAX_DEPTH, Mode, Parser, RepairLog, RepairPathSegment},
	},
};

/// Failure while awaiting an incoming JSON value.
#[derive(Debug, Error)]
pub enum IncomingError {
	/// A pulled JSON value was missing, mistyped, malformed, incomplete, or
	/// aborted.
	#[error(transparent)]
	Pull(#[from] PullIssue),
	/// The producer abandoned the input before marking it complete.
	#[error("incoming JSON input was aborted")]
	Aborted,
	/// An explicitly requested whole-document decode failed.
	#[error(transparent)]
	Parse(#[from] ParseError),
}

/// Structured reason a pulled JSON value could not be supplied.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullIssue {
	/// Full key/index path pulled by the consumer.
	pub path:     Vec<PullPathSegment>,
	/// Shape requested by the typed cursor.
	pub expected: &'static str,
	/// Why the pull could not produce that shape.
	pub kind:     PullIssueKind,
}

impl Display for PullIssue {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "invalid JSON pull {:?}: expected {} ({})", self.path, self.expected, self.kind)
	}
}

impl error::Error for PullIssue {}

/// Location component in a pulled JSON path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PullPathSegment {
	/// One exact object member name.
	Key(Str),
	/// Canonical object member name followed by its accepted aliases.
	///
	/// Selection is atomic and resolves the first matching occurrence in
	/// source order. An empty set can never match.
	Keys(SmallVec<Str, 4>),
	/// Array element index.
	Index(usize),
}

impl PullPathSegment {
	fn key_names(&self) -> Option<&[Str]> {
		match self {
			Self::Key(key) => Some(slice::from_ref(key)),
			Self::Keys(keys) => Some(keys),
			Self::Index(_) => None,
		}
	}
}

/// Kind of pull failure represented by [`PullIssue`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullIssueKind {
	/// The requested member was absent when its container completed.
	Missing,
	/// The producer finished before the pulled value's closing token.
	Incomplete,
	/// The producer abandoned the input before the pull completed.
	Aborted,
	/// A complete pulled value could not be parsed.
	Malformed,
	/// A value was present with a different JSON shape.
	TypeMismatch {
		/// Shape observed in the input.
		found: &'static str,
	},
}

impl Display for PullIssueKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Missing => f.write_str("missing"),
			Self::Incomplete => f.write_str("incomplete"),
			Self::Aborted => f.write_str("aborted"),
			Self::Malformed => f.write_str("malformed"),
			Self::TypeMismatch { found } => write!(f, "found {found}"),
		}
	}
}

/// Error returned when text is pushed after the feed has closed.
#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
#[error("incoming JSON feed is already closed")]
pub struct FeedClosed;

type WakerSet = SmallVec<Waker, 4>;

#[derive(Default)]
struct InputState {
	text:        String,
	end:         End,
	wakers:      WakerSet,
	repairs:     RepairLog,
	checkpoints: SmallVec<LocateCheckpoint, 4>,
}

#[derive(Clone)]
struct LocateCheckpoint {
	path:       SmallVec<PullPathSegment, 4>,
	offset:     usize,
	next_index: usize,
	kind:       CheckpointKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CheckpointKind {
	Object,
	Array,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum End {
	#[default]
	Open,
	Finished,
	Aborted,
}

#[derive(Default)]
struct Shared {
	state: Mutex<InputState>,
}

/// Push side of an [`IncomingDoc`] channel.
///
/// Dropping this handle abandons the input, like [`abort`](Self::abort).
/// Call [`finish`](Self::finish) explicitly to mark the document complete.
pub struct IncomingFeed {
	shared: Arc<Shared>,
	closed: bool,
}

impl IncomingFeed {
	/// Append one UTF-8 fragment and wake every pending cursor.
	pub fn push(&mut self, fragment: &str) -> Result<(), FeedClosed> {
		let mut state = self.shared.state.lock();
		if state.end != End::Open {
			return Err(FeedClosed);
		}
		state.text.push_str(fragment);
		let wakers = mem::take(&mut state.wakers);
		drop(state);
		wake_all(wakers);
		Ok(())
	}

	/// Mark the input complete and wake the pending cursor.
	pub fn finish(mut self) {
		self.close(End::Finished);
	}

	/// Abandon the input and wake the pending cursor.
	pub fn abort(mut self) {
		self.close(End::Aborted);
	}

	fn close(&mut self, end: End) {
		if self.closed {
			return;
		}
		self.closed = true;
		let mut state = self.shared.state.lock();
		state.end = end;
		let wakers = mem::take(&mut state.wakers);
		drop(state);
		wake_all(wakers);
	}
}

impl Drop for IncomingFeed {
	fn drop(&mut self) {
		self.close(End::Aborted);
	}
}

/// Root cursor over one growing JSON document.
pub struct IncomingDoc {
	shared: Arc<Shared>,
}

impl IncomingDoc {
	/// Create a push feed and its read-side document cursor.
	pub fn channel() -> (IncomingFeed, Self) {
		let shared = Arc::new(Shared::default());
		(IncomingFeed { shared: Arc::clone(&shared), closed: false }, Self { shared })
	}

	/// Await explicit input completion.
	///
	/// Returns [`IncomingError::Aborted`] if the feed is aborted or dropped
	/// without an explicit [`IncomingFeed::finish`].
	pub async fn finished(&self) -> Result<(), IncomingError> {
		poll_fn(|cx| {
			let mut state = self.shared.state.lock();
			match state.end {
				End::Finished => Poll::Ready(Ok(())),
				End::Aborted => Poll::Ready(Err(IncomingError::Aborted)),
				End::Open => {
					register_waker(&mut state.wakers, cx.waker());
					Poll::Pending
				},
			}
		})
		.await
	}

	/// Deserialize the entire finished document into `T`.
	///
	/// This is an explicit whole-document pull and waits for
	/// [`IncomingFeed::finish`]. The mutable borrow makes it one ordinary,
	/// cancellation-composable pull: dropping the future releases the cursor
	/// rather than leaving a subscription behind. Aborted input is not decoded.
	pub async fn whole<T: DeserializeOwned>(&mut self) -> Result<T, IncomingError> {
		self.finished().await?;
		let mut state = self.shared.state.lock();
		let mut deserializer = Deserializer::new(&state.text);
		let value = serde::Deserialize::deserialize(&mut deserializer)?;
		deserializer.end()?;
		let repairs = deserializer.into_repairs();
		state.repairs.append_unique(repairs, &[]);
		Ok(value)
	}

	/// Create a cloneable path-addressed cursor for host-driven pulls.
	pub fn cursor(&self) -> IncomingCursor {
		IncomingCursor { shared: Arc::clone(&self.shared) }
	}

	/// Borrow the parser repairs observed by cursor scans so far.
	///
	/// The returned guard prevents the append-only record from changing while
	/// it is borrowed.
	pub fn repairs(&self) -> RepairGuard<'_> {
		RepairGuard(self.shared.state.lock())
	}

	/// Borrow the single linear cursor for the root JSON value.
	///
	/// A cursor and every child derived from it retain this mutable borrow.
	/// Consequently a document cannot be snapshotted or fanned out into
	/// concurrent pulls; cancelling or completing the pull releases it.
	pub fn json(&mut self) -> IncomingJson<'_> {
		IncomingJson { shared: Arc::clone(&self.shared), path: Vec::new(), _linear: PhantomData }
	}
}

/// Borrowed view of the append-only repair record.
pub struct RepairGuard<'a>(MutexGuard<'a, InputState>);

impl Deref for RepairGuard<'_> {
	type Target = RepairLog;

	fn deref(&self) -> &Self::Target {
		&self.0.repairs
	}
}

/// Cloneable path-addressed cursor over one growing document.
#[derive(Clone)]
pub struct IncomingCursor {
	shared: Arc<Shared>,
}

/// Readiness requested from [`IncomingCursor::pull_at`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullMode {
	/// Resolve when the selected value's first token arrives.
	Started,
	/// Resolve when the selected value is structurally complete.
	Complete,
	/// Resolve with stable decoded string bytes after the supplied decoded
	/// offset.
	Chunk(usize),
	/// Resolve with complete decoded lines after the supplied decoded offset.
	///
	/// While the string remains open, the frontier is rounded down to the last
	/// newline. The final unterminated line is emitted when the string closes.
	Line(usize),
}

/// JSON shape observed by a started pull.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PulledValueKind {
	/// JSON null.
	Null,
	/// Boolean.
	Boolean,
	/// Number.
	Number,
	/// String.
	String,
	/// Array.
	Array,
	/// Object.
	Object,
}

/// Payload resolved by a path-addressed pull.
#[derive(Clone, Debug, PartialEq)]
pub enum PulledKind {
	/// A value has started but may not yet be complete.
	Started(PulledValueKind),
	/// A complete parsed value.
	Complete(Value),
	/// Stable decoded string output.
	Chunk {
		/// Non-overlapping decoded bytes beginning at the requested offset.
		value:    Str,
		/// Whether the string's closing quote has arrived.
		complete: bool,
	},
}

/// One path-addressed pull result.
#[derive(Clone, Debug, PartialEq)]
pub struct Pulled {
	/// Resolved payload.
	pub kind:        PulledKind,
	/// Raw half-open source span of the selected value as observed.
	pub span:        Range<usize>,
	/// Actual object key spelling selected by a terminal key segment.
	pub matched_key: Option<Str>,
}
impl IncomingCursor {
	/// Pull an arbitrary path without allocating or boxing the returned future.
	pub async fn pull_at<'a>(
		&'a self,
		path: &'a [PullPathSegment],
		mode: PullMode,
		expected: &'static str,
	) -> Result<Pulled, IncomingError> {
		let located = wait_for(&self.shared, path, mode, expected).await?;
		let state = self.shared.state.lock();
		let Located { start, end, kind, matched_key } = located;
		let observed_end = end.unwrap_or(state.text.len());
		let span = start..observed_end;
		let kind = match mode {
			PullMode::Started => PulledKind::Started(kind.value_kind()),
			PullMode::Complete => {
				let value = match kind {
					Kind::Null => Value::Null,
					Kind::Bool(value) => Value::Bool(value),
					Kind::Number(value) => Value::Number(value),
					Kind::String { value, .. } => Value::String(value),
					Kind::Array | Kind::Object => parse(&state.text[span.clone()])
						.map_err(|_| pull_issue(path, expected, PullIssueKind::Malformed))?,
				};
				PulledKind::Complete(value)
			},
			PullMode::Chunk(emitted) | PullMode::Line(emitted) => match kind {
				Kind::String { value, stable_len } => {
					let Some(remaining) = value.get(emitted..stable_len) else {
						return Err(pull_issue(path, "valid string offset", PullIssueKind::Malformed));
					};
					let upper = match mode {
						PullMode::Line(_) if end.is_none() => remaining
							.rfind('\n')
							.map_or(emitted, |offset| emitted + offset + 1),
						_ => stable_len,
					};
					PulledKind::Chunk {
						value:    Str::new(
							value
								.get(emitted..upper)
								.expect("validated decoded string boundaries"),
						),
						complete: end.is_some(),
					}
				},
				other => return Err(type_mismatch(path, "string", other.name())),
			},
		};
		Ok(Pulled { kind, span, matched_key })
	}

	/// Copy one valid UTF-8 source span from the append-only buffer.
	pub fn raw(&self, span: Range<usize>) -> Option<Str> {
		let state = self.shared.state.lock();
		state.text.get(span).map(Str::new)
	}

	/// Borrow parser repairs observed by any cursor scan so far.
	pub fn repairs(&self) -> RepairGuard<'_> {
		RepairGuard(self.shared.state.lock())
	}

	/// Await successful completion and copy the exact original document.
	pub async fn raw_document(&self) -> Result<Str, IncomingError> {
		wait_until_finished(&self.shared).await?;
		Ok(Str::new(self.shared.state.lock().text.as_str()))
	}

	/// Return every object key occurrence in source order, preserving
	/// duplicates.
	pub async fn object_keys<'a>(
		&'a self,
		path: &'a [PullPathSegment],
	) -> Result<SmallVec<Str, 8>, IncomingError> {
		wait_until_finished(&self.shared).await?;
		let located = wait_for(&self.shared, path, PullMode::Complete, "object").await?;
		if !matches!(&located.kind, Kind::Object) {
			return Err(type_mismatch(path, "object", located.kind.name()));
		}
		let state = self.shared.state.lock();
		let mut parser = Parser::resume(&state.text, Mode::Incoming, located.start);
		parser.set_repair_path(path);
		parser.ws();
		parser.bump();
		let mut keys = SmallVec::new();
		loop {
			parser.ws();
			match parser.peek() {
				Some(b'}') => {
					parser.bump();
					break;
				},
				Some(b',') => {
					let comma = parser.pos();
					parser.bump();
					parser.ws();
					parser.record_comma(comma, parser.peek() == Some(b'}'));
					continue;
				},
				None => {
					return Err(pull_issue(path, "object", PullIssueKind::Incomplete));
				},
				_ => {},
			}
			let key = match parser.peek() {
				Some(quote @ (b'"' | b'\'')) => {
					let progress = parser.string_progress(quote).map_err(IncomingError::from)?;
					if !progress.complete {
						return Err(pull_issue(path, "object", PullIssueKind::Incomplete));
					}
					Str::from(progress.value)
				},
				Some(_) => Str::new(parser.unquoted_key()),
				None => {
					return Err(pull_issue(path, "object", PullIssueKind::Incomplete));
				},
			};
			keys.push(key);
			parser.ws();
			if parser.peek() != Some(b':') {
				return Err(pull_issue(path, "object", PullIssueKind::Malformed));
			}
			parser.bump();
			parser.ws();
			if !matches!(
				scan_value(&mut parser, true, 1),
				Probe::Located(Located { end: Some(_), .. })
			) {
				return Err(pull_issue(path, "object", PullIssueKind::Malformed));
			}
			parser.ws();
			match parser.peek() {
				Some(b',') => {
					let comma = parser.pos();
					parser.bump();
					parser.ws();
					if parser.peek() == Some(b'}') {
						parser.record_comma(comma, true);
					}
				},
				Some(b'}') => {},
				_ => return Err(pull_issue(path, "object", PullIssueKind::Malformed)),
			}
		}
		drop(parser);
		Ok(keys)
	}
}

/// Cursor for one JSON value in the incoming document.
pub struct IncomingJson<'doc> {
	shared:  Arc<Shared>,
	path:    Vec<PullPathSegment>,
	_linear: PhantomData<&'doc mut IncomingDoc>,
}

impl<'doc> IncomingJson<'doc> {
	/// Await and parse the complete value.
	pub async fn value(&mut self) -> Result<Value, IncomingError> {
		self.value_with("value").await
	}

	/// Await and deserialize this complete value into `T`.
	///
	/// Choosing this method explicitly opts the pulled subtree into complete
	/// typed validation. A malformed or mistyped subtree is reported at this
	/// cursor's structured pull path.
	pub async fn whole<T: DeserializeOwned>(&mut self) -> Result<T, IncomingError> {
		let expected = any::type_name::<T>();
		let located = wait_for(&self.shared, &self.path, PullMode::Complete, expected).await?;
		let state = self.shared.state.lock();
		from_str(&state.text[located.start..located.end.expect("complete wait has an end")])
			.map_err(|_| pull_issue(&self.path, expected, PullIssueKind::Malformed))
	}

	/// Convert this cursor into a decoded incremental string cursor.
	pub const fn string(self) -> IncomingString<'doc> {
		IncomingString { json: self, emitted: 0, done: false }
	}

	/// Convert this cursor into an array element cursor.
	pub const fn array(self) -> IncomingArray<'doc> {
		IncomingArray { json: self, next: 0 }
	}

	/// Convert this cursor into an object cursor.
	pub const fn object(self) -> IncomingObject<'doc> {
		IncomingObject { json: self }
	}

	/// Await a complete number.
	pub async fn number(&mut self) -> Result<Number, IncomingError> {
		match self.value_with("number").await? {
			Value::Number(value) => Ok(value),
			other => Err(type_mismatch(&self.path, "number", value_name(&other))),
		}
	}

	/// Await a complete boolean.
	pub async fn boolean(&mut self) -> Result<bool, IncomingError> {
		match self.value_with("boolean").await? {
			Value::Bool(value) => Ok(value),
			other => Err(type_mismatch(&self.path, "boolean", value_name(&other))),
		}
	}

	/// Await a complete null value.
	pub async fn null(&mut self) -> Result<(), IncomingError> {
		match self.value_with("null").await? {
			Value::Null => Ok(()),
			other => Err(type_mismatch(&self.path, "null", value_name(&other))),
		}
	}

	async fn value_with(&self, expected: &'static str) -> Result<Value, IncomingError> {
		let located = wait_for(&self.shared, &self.path, PullMode::Complete, expected).await?;
		match located.kind {
			Kind::Null => Ok(Value::Null),
			Kind::Bool(value) => Ok(Value::Bool(value)),
			Kind::Number(value) => Ok(Value::Number(value)),
			Kind::String { value, .. } => Ok(Value::String(value)),
			Kind::Array | Kind::Object => {
				let state = self.shared.state.lock();
				parse(&state.text[located.start..located.end.expect("complete wait has an end")])
					.map_err(|_| pull_issue(&self.path, expected, PullIssueKind::Malformed))
			},
		}
	}
}

/// Incremental decoded string consumer.
///
/// Chunks are owned [`Str`] slices because the append buffer may grow while an
/// async caller holds a chunk. They are emitted in order without overlap;
/// [`finish`](Self::finish) returns the complete decoded string independently
/// of whether chunks were consumed.
pub struct IncomingString<'doc> {
	json:    IncomingJson<'doc>,
	emitted: usize,
	done:    bool,
}

impl IncomingString<'_> {
	/// Await the next stable decoded chunk, or `None` after the closing quote.
	pub async fn next_chunk(&mut self) -> Result<Option<Str>, IncomingError> {
		if self.done {
			return Ok(None);
		}
		let located =
			wait_for(&self.json.shared, &self.json.path, PullMode::Chunk(self.emitted), "string")
				.await?;
		let Kind::String { value, stable_len } = located.kind else {
			return Err(type_mismatch(&self.json.path, "string", located.kind.name()));
		};
		if stable_len > self.emitted {
			let chunk = Str::new(&value[self.emitted..stable_len]);
			self.emitted = stable_len;
			return Ok(Some(chunk));
		}
		self.done = true;
		Ok(None)
	}

	/// Await the next complete decoded line, retaining its trailing newline.
	///
	/// A final unterminated line is returned once the closing quote arrives.
	pub async fn next_line(&mut self) -> Result<Option<Str>, IncomingError> {
		if self.done {
			return Ok(None);
		}
		let located =
			wait_for(&self.json.shared, &self.json.path, PullMode::Line(self.emitted), "string")
				.await?;
		let complete = located.end.is_some();
		let Kind::String { value, stable_len } = located.kind else {
			return Err(type_mismatch(&self.json.path, "string", located.kind.name()));
		};
		let upper = if complete {
			stable_len
		} else {
			value[self.emitted.min(stable_len)..stable_len]
				.rfind('\n')
				.map_or(self.emitted, |offset| self.emitted + offset + 1)
		};
		if upper > self.emitted {
			let line = Str::new(&value[self.emitted..upper]);
			self.emitted = upper;
			return Ok(Some(line));
		}
		self.done = true;
		Ok(None)
	}

	/// Await the closing quote and return the complete decoded string.
	pub async fn finish(self) -> Result<Str, IncomingError> {
		let located =
			wait_for(&self.json.shared, &self.json.path, PullMode::Complete, "string").await?;
		match located.kind {
			Kind::String { value, .. } => Ok(value),
			other => Err(type_mismatch(&self.json.path, "string", other.name())),
		}
	}
}

/// Linear cursor over elements of an incoming array.
pub struct IncomingArray<'doc> {
	json: IncomingJson<'doc>,
	next: usize,
}

impl IncomingArray<'_> {
	/// Await the start of the next element.
	///
	/// The returned element cursor mutably reborrows this array, so the caller
	/// must consume or cancel it before advancing again. `None` is returned
	/// only after the array's closing bracket.
	pub async fn next(&mut self) -> Result<Option<IncomingJson<'_>>, IncomingError> {
		let root = wait_for(&self.json.shared, &self.json.path, PullMode::Started, "array").await?;
		if !matches!(root.kind, Kind::Array) {
			return Err(type_mismatch(&self.json.path, "array", root.kind.name()));
		}
		let mut path = self.json.path.clone();
		path.push(PullPathSegment::Index(self.next));
		match wait_for_raw(&self.json.shared, &path, PullMode::Started, "value").await? {
			Some(_) => {
				self.next += 1;
				Ok(Some(IncomingJson {
					shared: Arc::clone(&self.json.shared),
					path,
					_linear: PhantomData,
				}))
			},
			None => Ok(None),
		}
	}

	/// Await the closing bracket and collect fully parsed elements.
	pub async fn collect(self) -> Result<Vec<Value>, IncomingError> {
		match self.json.value_with("array").await? {
			Value::Array(values) => Ok(values),
			other => Err(type_mismatch(&self.json.path, "array", value_name(&other))),
		}
	}
}

/// Linear cursor for keyed pulls and final collection of an incoming object.
pub struct IncomingObject<'doc> {
	json: IncomingJson<'doc>,
}

impl IncomingObject<'_> {
	/// Return a cursor bound to the first occurrence of `name`.
	///
	/// The returned cursor mutably reborrows this object. Awaiting it resolves
	/// as soon as the key's value starts; consuming or cancelling it permits
	/// the next keyed pull.
	pub fn key(&mut self, name: impl IntoStr) -> IncomingJson<'_> {
		let mut path = self.json.path.clone();
		path.push(PullPathSegment::Key(name.into_str()));
		IncomingJson { shared: Arc::clone(&self.json.shared), path, _linear: PhantomData }
	}

	/// Await the closing brace and collect the object.
	///
	/// Final collection uses [`crate::slopjson::Object`]'s last-write-wins
	/// duplicate-key semantics, unlike [`key`](Self::key), which binds the
	/// first occurrence.
	pub async fn collect(self) -> Result<Object, IncomingError> {
		match self.json.value_with("object").await? {
			Value::Object(value) => Ok(value),
			other => Err(type_mismatch(&self.json.path, "object", value_name(&other))),
		}
	}
}

impl PullMode {
	fn is_ready(self, located: &Located) -> bool {
		match self {
			Self::Started => true,
			Self::Complete => located.end.is_some(),
			Self::Chunk(emitted) => match &located.kind {
				Kind::String { value, stable_len } => {
					value.get(emitted..*stable_len).is_none()
						|| *stable_len > emitted
						|| located.end.is_some()
				},
				_ => true,
			},
			Self::Line(emitted) => match &located.kind {
				Kind::String { value, stable_len } => {
					located.end.is_some()
						|| value
							.get(emitted..*stable_len)
							.is_none_or(|remaining| remaining.contains('\n'))
				},
				_ => true,
			},
		}
	}
}

async fn wait_for(
	shared: &Shared,
	path: &[PullPathSegment],
	mode: PullMode,
	expected: &'static str,
) -> Result<Located, IncomingError> {
	wait_for_raw(shared, path, mode, expected)
		.await?
		.ok_or_else(|| pull_issue(path, expected, PullIssueKind::Missing))
}

async fn wait_for_raw(
	shared: &Shared,
	path: &[PullPathSegment],
	mode: PullMode,
	expected: &'static str,
) -> Result<Option<Located>, IncomingError> {
	poll_fn(|cx| {
		let mut state = shared.state.lock();
		let end = state.end;
		let saved = state
			.checkpoints
			.iter()
			.find(|saved| saved.path.as_slice() == path)
			.cloned();
		let (probe, repairs, next) = locate(&state.text, path, end == End::Finished, saved.as_ref());
		state.repairs.append_unique(repairs, path);
		if let Some(next) = next {
			if let Some(saved) = state
				.checkpoints
				.iter_mut()
				.find(|saved| saved.path.as_slice() == path)
			{
				*saved = next;
			} else {
				state.checkpoints.push(next);
			}
		}
		match probe {
			Probe::Located(value) if mode.is_ready(&value) => Poll::Ready(Ok(Some(value))),
			Probe::Located(_) | Probe::Pending => match end {
				End::Finished => {
					Poll::Ready(Err(pull_issue(path, expected, PullIssueKind::Incomplete)))
				},
				End::Aborted => Poll::Ready(Err(pull_issue(path, expected, PullIssueKind::Aborted))),
				End::Open => {
					register_waker(&mut state.wakers, cx.waker());
					Poll::Pending
				},
			},
			Probe::Missing => Poll::Ready(Ok(None)),
			Probe::Type { expected: structural, found } => {
				let expected = if structural == "value" {
					expected
				} else {
					structural
				};
				Poll::Ready(Err(type_mismatch(path, expected, found)))
			},
		}
	})
	.await
}

async fn wait_until_finished(shared: &Shared) -> Result<(), IncomingError> {
	poll_fn(|cx| {
		let mut state = shared.state.lock();
		match state.end {
			End::Finished => Poll::Ready(Ok(())),
			End::Aborted => Poll::Ready(Err(IncomingError::Aborted)),
			End::Open => {
				register_waker(&mut state.wakers, cx.waker());
				Poll::Pending
			},
		}
	})
	.await
}

fn register_waker(wakers: &mut WakerSet, waker: &Waker) {
	if !wakers.iter().any(|registered| registered.will_wake(waker)) {
		wakers.push(waker.clone());
	}
}

fn wake_all(wakers: WakerSet) {
	for waker in wakers {
		waker.wake();
	}
}

fn type_mismatch(
	path: &[PullPathSegment],
	expected: &'static str,
	found: &'static str,
) -> IncomingError {
	pull_issue(path, expected, PullIssueKind::TypeMismatch { found })
}

fn pull_issue(
	path: &[PullPathSegment],
	expected: &'static str,
	kind: PullIssueKind,
) -> IncomingError {
	IncomingError::Pull(PullIssue {
		path: path
			.iter()
			.map(|part| match part {
				PullPathSegment::Key(key) => PullPathSegment::Key(key.clone()),
				PullPathSegment::Keys(keys) => {
					PullPathSegment::Key(keys.first().cloned().unwrap_or_default())
				},
				PullPathSegment::Index(index) => PullPathSegment::Index(*index),
			})
			.collect(),
		expected,
		kind,
	})
}

const fn value_name(value: &Value) -> &'static str {
	match value {
		Value::Null => "null",
		Value::Bool(_) => "boolean",
		Value::Number(_) => "number",
		Value::String(_) => "string",
		Value::Array(_) => "array",
		Value::Object(_) => "object",
	}
}

#[derive(Debug)]
struct Located {
	start:       usize,
	end:         Option<usize>,
	kind:        Kind,
	matched_key: Option<Str>,
}

#[derive(Debug)]
enum Kind {
	Null,
	Bool(bool),
	Number(Number),
	String { value: Str, stable_len: usize },
	Array,
	Object,
}

impl Kind {
	const fn name(&self) -> &'static str {
		match self {
			Self::Null => "null",
			Self::Bool(_) => "boolean",
			Self::Number(_) => "number",
			Self::String { .. } => "string",
			Self::Array => "array",
			Self::Object => "object",
		}
	}

	const fn value_kind(&self) -> PulledValueKind {
		match self {
			Self::Null => PulledValueKind::Null,
			Self::Bool(_) => PulledValueKind::Boolean,
			Self::Number(_) => PulledValueKind::Number,
			Self::String { .. } => PulledValueKind::String,
			Self::Array => PulledValueKind::Array,
			Self::Object => PulledValueKind::Object,
		}
	}
}

enum Probe {
	Located(Located),
	Pending,
	Missing,
	Type { expected: &'static str, found: &'static str },
}

fn locate(
	src: &str,
	path: &[PullPathSegment],
	ended: bool,
	checkpoint: Option<&LocateCheckpoint>,
) -> (Probe, RepairLog, Option<LocateCheckpoint>) {
	let reusable =
		checkpoint.filter(|saved| saved.path.as_slice() == path && saved.offset <= src.len());
	let mut parser = if let Some(saved) = reusable {
		Parser::resume(src, Mode::Incoming, saved.offset)
	} else {
		let mut parser = Parser::new(src, Mode::Incoming);
		parser.ws();
		parser
	};
	parser.set_repair_path(&[]);
	let mut next = None;
	let probe = match path.first() {
		Some(segment @ (PullPathSegment::Key(_) | PullPathSegment::Keys(_)))
			if reusable.is_some_and(|saved| saved.kind == CheckpointKind::Object) =>
		{
			let mut offset = reusable.map(|saved| saved.offset);
			let probe = select_key_from(
				&mut parser,
				segment.key_names().expect("key segment has names"),
				&path[1..],
				ended,
				0,
				&mut offset,
			);
			next = offset.map(|offset| LocateCheckpoint {
				path: path.iter().cloned().collect(),
				offset,
				next_index: 0,
				kind: CheckpointKind::Object,
			});
			probe
		},
		Some(segment @ (PullPathSegment::Key(_) | PullPathSegment::Keys(_)))
			if parser.peek() == Some(b'{') =>
		{
			parser.bump();
			let mut offset = Some(parser.pos());
			let probe = select_key_from(
				&mut parser,
				segment.key_names().expect("key segment has names"),
				&path[1..],
				ended,
				0,
				&mut offset,
			);
			next = offset.map(|offset| LocateCheckpoint {
				path: path.iter().cloned().collect(),
				offset,
				next_index: 0,
				kind: CheckpointKind::Object,
			});
			probe
		},
		Some(PullPathSegment::Index(wanted))
			if reusable.is_some_and(|saved| saved.kind == CheckpointKind::Array) =>
		{
			let saved = reusable.expect("guard established reusable checkpoint");
			let mut offset = Some(saved.offset);
			let mut next_index = saved.next_index;
			let probe = select_index_from(
				&mut parser,
				*wanted,
				&path[1..],
				ended,
				0,
				&mut next_index,
				&mut offset,
			);
			next = offset.map(|offset| LocateCheckpoint {
				path: path.iter().cloned().collect(),
				offset,
				next_index,
				kind: CheckpointKind::Array,
			});
			probe
		},
		Some(PullPathSegment::Index(wanted)) if parser.peek() == Some(b'[') => {
			parser.bump();
			let mut offset = Some(parser.pos());
			let mut next_index = 0;
			let probe = select_index_from(
				&mut parser,
				*wanted,
				&path[1..],
				ended,
				0,
				&mut next_index,
				&mut offset,
			);
			next = offset.map(|offset| LocateCheckpoint {
				path: path.iter().cloned().collect(),
				offset,
				next_index,
				kind: CheckpointKind::Array,
			});
			probe
		},
		_ => select_value(&mut parser, path, ended, 0),
	};
	(probe, parser.take_repairs(), next)
}

fn select_value(
	parser: &mut Parser<'_>,
	path: &[PullPathSegment],
	ended: bool,
	depth: u32,
) -> Probe {
	let Some(byte) = parser.peek() else {
		return Probe::Pending;
	};
	if path.is_empty() {
		return scan_value(parser, ended, depth);
	}
	match (&path[0], byte) {
		(segment @ (PullPathSegment::Key(_) | PullPathSegment::Keys(_)), b'{') => select_key(
			parser,
			segment.key_names().expect("key segment has names"),
			&path[1..],
			ended,
			depth,
		),
		(PullPathSegment::Index(index), b'[') => {
			select_index(parser, *index, &path[1..], ended, depth)
		},
		(PullPathSegment::Key(_) | PullPathSegment::Keys(_), _) => {
			Probe::Type { expected: "object", found: byte_name(byte) }
		},
		(PullPathSegment::Index(_), _) => {
			Probe::Type { expected: "array", found: byte_name(byte) }
		},
	}
}

fn select_key(
	parser: &mut Parser<'_>,
	wanted: &[Str],
	rest: &[PullPathSegment],
	ended: bool,
	depth: u32,
) -> Probe {
	if depth >= MAX_DEPTH {
		return Probe::Pending;
	}
	parser.bump();
	let mut checkpoint = None;
	select_key_from(parser, wanted, rest, ended, depth, &mut checkpoint)
}

fn select_key_from(
	parser: &mut Parser<'_>,
	wanted: &[Str],
	rest: &[PullPathSegment],
	ended: bool,
	depth: u32,
	checkpoint: &mut Option<usize>,
) -> Probe {
	if depth >= MAX_DEPTH {
		return Probe::Pending;
	}
	loop {
		parser.ws();
		*checkpoint = Some(parser.pos());
		match parser.peek() {
			None => return Probe::Pending,
			Some(b'}') => {
				parser.bump();
				return Probe::Missing;
			},
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				parser.record_comma(comma, parser.peek() == Some(b'}'));
				continue;
			},
			_ => {},
		}
		let key_start = parser.pos();
		let actual_key = match parser.peek() {
			Some(quote @ (b'"' | b'\'')) => {
				let progress = parser
					.string_progress(quote)
					.expect("lenient string never fails");
				if !progress.complete {
					return Probe::Pending;
				}
				Str::from(progress.value)
			},
			Some(_) => {
				let key = parser.unquoted_key();
				if key.is_empty() {
					return Probe::Pending;
				}
				Str::new(key)
			},
			None => return Probe::Pending,
		};
		parser.retarget_repairs_from(key_start, RepairPathSegment::Key(actual_key.clone()));
		let key_matches = wanted.iter().any(|name| name == &actual_key);
		parser.push_repair_path(RepairPathSegment::Key(actual_key.clone()));
		parser.ws();
		if parser.peek() != Some(b':') {
			parser.pop_repair_path();
			return Probe::Pending;
		}
		parser.bump();
		parser.ws();
		if parser.at_end() {
			parser.pop_repair_path();
			return Probe::Pending;
		}
		if key_matches {
			let mut probe = select_value(parser, rest, ended, depth + 1);
			parser.pop_repair_path();
			if rest.is_empty()
				&& let Probe::Located(located) = &mut probe
			{
				located.matched_key = Some(actual_key);
			}
			return probe;
		}
		let skipped = scan_value(parser, ended, depth + 1);
		parser.pop_repair_path();
		match skipped {
			Probe::Located(Located { end: Some(_), .. }) => {},
			Probe::Located(_) | Probe::Pending => return Probe::Pending,
			Probe::Missing | Probe::Type { .. } => return Probe::Pending,
		}
		parser.ws();
		match parser.peek() {
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				if parser.peek() == Some(b'}') {
					parser.record_comma(comma, true);
				}
			},
			Some(b'}') => {
				parser.bump();
				return Probe::Missing;
			},
			_ => return Probe::Pending,
		}
	}
}

fn select_index(
	parser: &mut Parser<'_>,
	wanted: usize,
	rest: &[PullPathSegment],
	ended: bool,
	depth: u32,
) -> Probe {
	if depth >= MAX_DEPTH {
		return Probe::Pending;
	}
	parser.bump();
	let mut index = 0;
	let mut checkpoint = None;
	select_index_from(parser, wanted, rest, ended, depth, &mut index, &mut checkpoint)
}

fn select_index_from(
	parser: &mut Parser<'_>,
	wanted: usize,
	rest: &[PullPathSegment],
	ended: bool,
	depth: u32,
	index: &mut usize,
	checkpoint: &mut Option<usize>,
) -> Probe {
	if depth >= MAX_DEPTH {
		return Probe::Pending;
	}
	loop {
		parser.ws();
		*checkpoint = Some(parser.pos());
		match parser.peek() {
			None => return Probe::Pending,
			Some(b']') => {
				parser.bump();
				return Probe::Missing;
			},
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				parser.record_comma(comma, parser.peek() == Some(b']'));
				continue;
			},
			_ => {},
		}
		parser.push_repair_path(RepairPathSegment::Index(*index));
		if *index == wanted {
			let probe = select_value(parser, rest, ended, depth + 1);
			parser.pop_repair_path();
			return probe;
		}
		let skipped = scan_value(parser, ended, depth + 1);
		parser.pop_repair_path();
		match skipped {
			Probe::Located(Located { end: Some(_), .. }) => {},
			Probe::Located(_) | Probe::Pending => return Probe::Pending,
			Probe::Missing | Probe::Type { .. } => return Probe::Pending,
		}
		*index += 1;
		parser.ws();
		match parser.peek() {
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				if parser.peek() == Some(b']') {
					parser.record_comma(comma, true);
				}
			},
			Some(b']') => {
				parser.bump();
				return Probe::Missing;
			},
			_ => return Probe::Pending,
		}
	}
}

fn scan_value(parser: &mut Parser<'_>, ended: bool, depth: u32) -> Probe {
	let start = parser.pos();
	let Some(byte) = parser.peek() else {
		return Probe::Pending;
	};
	match byte {
		b'{' => scan_object(parser, ended, depth, start),
		b'[' => scan_array(parser, ended, depth, start),
		quote @ (b'"' | b'\'') => {
			let progress = parser
				.string_progress(quote)
				.expect("lenient string never fails");
			let stable_len = progress.stable_len;
			let value = Str::from(progress.value);
			let end = parser.pos();
			// Like numbers and keywords, a string is complete only once a value
			// terminator follows (or the input ended): an edge close may still
			// be reopened by later fragments via single-quote recovery.
			let complete = progress.complete && scalar_complete(parser, ended);
			Probe::Located(Located {
				start,
				end: complete.then_some(end),
				kind: Kind::String { value, stable_len },
				matched_key: None,
			})
		},
		b'-' | b'+' | b'.' | b'0'..=b'9' => {
			let Ok(Some(number)) = parser.number() else {
				return Probe::Pending;
			};
			let end = parser.pos();
			let complete = scalar_complete(parser, ended);
			Probe::Located(Located {
				start,
				end: complete.then_some(end),
				kind: Kind::Number(number),
				matched_key: None,
			})
		},
		_ => {
			if let Some(atom) = parser.match_keyword() {
				let end = parser.pos();
				let complete = scalar_complete(parser, ended);
				let kind = match atom {
					Atom::Bool(value) => Kind::Bool(value),
					Atom::Null => Kind::Null,
				};
				Probe::Located(Located { start, end: complete.then_some(end), kind, matched_key: None })
			} else if let Ok(word) = parser.bareword() {
				let end = parser.pos();
				let complete = scalar_complete(parser, ended);
				Probe::Located(Located {
					start,
					end: complete.then_some(end),
					kind: Kind::String { value: Str::new(word), stable_len: word.len() },
					matched_key: None,
				})
			} else {
				Probe::Pending
			}
		},
	}
}

fn scalar_complete(parser: &mut Parser<'_>, ended: bool) -> bool {
	parser.ws();
	matches!(parser.peek(), Some(b',' | b'}' | b']')) || (ended && parser.at_end())
}

fn scan_object(parser: &mut Parser<'_>, ended: bool, depth: u32, start: usize) -> Probe {
	if depth >= MAX_DEPTH {
		return Probe::Pending;
	}
	parser.bump();
	loop {
		parser.ws();
		match parser.peek() {
			None => return incomplete_container(start, Kind::Object),
			Some(b'}') => {
				parser.bump();
				return Probe::Located(Located {
					start,
					end: Some(parser.pos()),
					kind: Kind::Object,
					matched_key: None,
				});
			},
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				parser.record_comma(comma, parser.peek() == Some(b'}'));
				continue;
			},
			_ => {},
		}
		let key_start = parser.pos();
		let key = match parser.peek() {
			Some(quote @ (b'"' | b'\'')) => {
				let progress = parser
					.string_progress(quote)
					.expect("lenient string never fails");
				if !progress.complete {
					return incomplete_container(start, Kind::Object);
				}
				Str::from(progress.value)
			},
			Some(_) => {
				let key = parser.unquoted_key();
				if key.is_empty() {
					return incomplete_container(start, Kind::Object);
				}
				Str::new(key)
			},
			None => return incomplete_container(start, Kind::Object),
		};
		let track_path = parser.tracks_structure();
		if track_path {
			parser.retarget_repairs_from(key_start, RepairPathSegment::Key(key.clone()));
		}
		if track_path {
			parser.push_repair_path(RepairPathSegment::Key(key));
		}
		parser.ws();
		if parser.peek() != Some(b':') {
			if track_path {
				parser.pop_repair_path();
			}
			return incomplete_container(start, Kind::Object);
		}
		parser.bump();
		parser.ws();
		let value = scan_value(parser, ended, depth + 1);
		if track_path {
			parser.pop_repair_path();
		}
		match value {
			Probe::Located(Located { end: Some(_), .. }) => {},
			_ => return incomplete_container(start, Kind::Object),
		}
		parser.ws();
		match parser.peek() {
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				if parser.peek() == Some(b'}') {
					parser.record_comma(comma, true);
				}
			},
			Some(b'}') => {
				parser.bump();
				return Probe::Located(Located {
					start,
					end: Some(parser.pos()),
					kind: Kind::Object,
					matched_key: None,
				});
			},
			_ => return incomplete_container(start, Kind::Object),
		}
	}
}

fn scan_array(parser: &mut Parser<'_>, ended: bool, depth: u32, start: usize) -> Probe {
	if depth >= MAX_DEPTH {
		return Probe::Pending;
	}
	parser.bump();
	let mut index = 0;
	loop {
		parser.ws();
		match parser.peek() {
			None => return incomplete_container(start, Kind::Array),
			Some(b']') => {
				parser.bump();
				return Probe::Located(Located {
					start,
					end: Some(parser.pos()),
					kind: Kind::Array,
					matched_key: None,
				});
			},
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				parser.record_comma(comma, parser.peek() == Some(b']'));
				continue;
			},
			_ => {},
		}
		let track_path = parser.tracks_structure();
		if track_path {
			parser.push_repair_path(RepairPathSegment::Index(index));
		}
		let value = scan_value(parser, ended, depth + 1);
		if track_path {
			parser.pop_repair_path();
		}
		match value {
			Probe::Located(Located { end: Some(_), .. }) => {},
			_ => return incomplete_container(start, Kind::Array),
		}
		index += 1;
		parser.ws();
		match parser.peek() {
			Some(b',') => {
				let comma = parser.pos();
				parser.bump();
				parser.ws();
				if parser.peek() == Some(b']') {
					parser.record_comma(comma, true);
				}
			},
			Some(b']') => {
				parser.bump();
				return Probe::Located(Located {
					start,
					end: Some(parser.pos()),
					kind: Kind::Array,
					matched_key: None,
				});
			},
			_ => return incomplete_container(start, Kind::Array),
		}
	}
}

const fn incomplete_container(start: usize, kind: Kind) -> Probe {
	Probe::Located(Located { start, end: None, kind, matched_key: None })
}

const fn byte_name(byte: u8) -> &'static str {
	match byte {
		b'{' => "object",
		b'[' => "array",
		b'"' | b'\'' => "string",
		b'-' | b'+' | b'.' | b'0'..=b'9' => "number",
		b't' | b'f' | b'T' | b'F' => "boolean",
		b'n' | b'N' => "null",
		_ => "value",
	}
}

impl fmt::Debug for IncomingJson<'_> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("IncomingJson")
			.field("path_len", &self.path.len())
			.finish_non_exhaustive()
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::sf;

	#[test]
	fn locate_checkpoint_resumes_at_the_append_boundary() {
		let path = [PullPathSegment::Key(sf!("target"))];
		let prefix = "{\"a\":0,\"b\":1,";
		let (probe, repairs, checkpoint) = locate(prefix, &path, false, None);
		assert!(matches!(probe, Probe::Pending));
		assert!(repairs.is_empty());
		let checkpoint = checkpoint.expect("open root object has a safe checkpoint");
		assert_eq!(checkpoint.offset, prefix.len());

		let complete = "{\"a\":0,\"b\":1,\"target\":2}";
		let (probe, repairs, next) = locate(complete, &path, true, Some(&checkpoint));
		assert!(repairs.is_empty());
		assert!(matches!(
			probe,
			Probe::Located(Located {
				kind: Kind::Number(number),
				end: Some(_),
				..
			}) if number.as_u64() == Some(2)
		));
		assert!(next.is_some_and(|saved| saved.offset >= checkpoint.offset));
	}
}
