//! Session-scoped lowering of opaque text-edit intents into canonical byte
//! edits.

use std::{collections::HashMap, path::Path, str, sync::Arc};

use bytes::Bytes;
use omp_core::{IntoStr, Str, sf};
use omp_edit::{
	EditError, EditStore,
	fuzzy::{DEFAULT_FUZZY_THRESHOLD, replace_text},
	modes::hashline::{
		apply::{ApplyOptions, EmptyPaste, apply_edits, is_head_tail_only},
		input::{Patch, SplitOptions},
		patcher::no_change_loop_diagnostic,
		recovery::{RecoveryChain, recover_text},
	},
	span_edits,
	store::payload_hash,
	text::{detect_line_ending, normalize_to_lf, restore_line_endings, strip_bom},
};
use parking_lot::RwLock;
use serde::Deserialize;
use smallvec::SmallVec;

use crate::docserver::{
	ByteEdit, ByteRange, DocumentSnapshot, Error, ReadSelection, Result, validate_edits,
};

/// Built-in hashline edit-intent format name.
pub const HASHLINE_EDIT_FORMAT: &str = "omp.hashline";
/// Built-in exact/fuzzy replacement edit-intent format name.
pub const REPLACE_EDIT_FORMAT: &str = "omp.replace";

/// A disk-free lowering strategy for one opaque edit format.
///
/// Implementations receive the exact immutable transaction base. They must not
/// consult ambient filesystem state, and their edits must use coordinates from
/// that base. The registry validates this contract before returning an output.
pub trait TextEditAdapter: Send + Sync {
	/// Records which part of an exact snapshot was returned to this session.
	///
	/// Stateful adapters may retain the shared snapshot and derive authorization
	/// provenance from `selection`. Stateless adapters need not override this.
	fn record_snapshot(
		&self,
		_path: &Path,
		_snapshot: Arc<DocumentSnapshot>,
		_selection: &ReadSelection,
	) -> Result<()> {
		Ok(())
	}

	/// Lowers an opaque payload into sorted base-coordinate byte edits.
	fn lower(
		&self,
		path: &Path,
		base_snapshot: Arc<DocumentSnapshot>,
		payload: Bytes,
		options_json: Bytes,
	) -> Result<Vec<ByteEdit>>;
}

#[derive(Clone)]
enum Adapter {
	Hashline(Arc<HashlineAdapter>),
	Replace(Arc<ReplaceAdapter>),
	Boxed(Arc<dyn TextEditAdapter>),
}

impl Adapter {
	fn record_snapshot(
		&self,
		path: &Path,
		snapshot: Arc<DocumentSnapshot>,
		selection: &ReadSelection,
	) -> Result<()> {
		match self {
			Self::Hashline(adapter) => adapter.record_snapshot(path, snapshot, selection),
			Self::Replace(adapter) => adapter.record_snapshot(path, snapshot, selection),
			Self::Boxed(adapter) => adapter.record_snapshot(path, snapshot, selection),
		}
	}

	fn lower(
		&self,
		path: &Path,
		base_snapshot: Arc<DocumentSnapshot>,
		payload: Bytes,
		options_json: Bytes,
	) -> Result<Vec<ByteEdit>> {
		match self {
			Self::Hashline(adapter) => adapter.lower(path, base_snapshot, payload, options_json),
			Self::Replace(adapter) => adapter.lower(path, base_snapshot, payload, options_json),
			Self::Boxed(adapter) => adapter.lower(path, base_snapshot, payload, options_json),
		}
	}
}

/// A connection-local registry of opaque text-edit adapters.
///
/// Construct one registry per connection or session. In particular, sharing a
/// registry would also share hashline read provenance, retained snapshots,
/// clipboard registers, and no-op counters.
pub struct EditAdapterRegistry {
	adapters: RwLock<HashMap<Str, Adapter>>,
}

impl Default for EditAdapterRegistry {
	fn default() -> Self {
		Self::new()
	}
}
impl EditAdapterRegistry {
	/// Creates an empty session-scoped registry.
	pub fn new() -> Self {
		Self { adapters: RwLock::new(HashMap::new()) }
	}

	/// Creates a session-scoped registry containing `omp.hashline` and
	/// `omp.replace`.
	///
	/// `omp.hashline` accepts the raw UTF-8 hashline patch as its payload and
	/// either empty options or `{}`. `omp.replace` accepts payload JSON
	/// `{ \"old_text\": string, \"new_text\": string }`; its optional JSON
	/// options are `replace_all: bool`, `allow_fuzzy: bool`, and
	/// `threshold: number`. Omitted fields replace one occurrence, permit fuzzy
	/// matching, and use [`DEFAULT_FUZZY_THRESHOLD`].
	pub fn with_built_ins() -> Self {
		let mut adapters = HashMap::new();
		adapters.insert(
			sf!(HASHLINE_EDIT_FORMAT),
			Adapter::Hashline(Arc::new(HashlineAdapter::default())),
		);
		adapters.insert(sf!(REPLACE_EDIT_FORMAT), Adapter::Replace(Arc::new(ReplaceAdapter)));
		Self { adapters: RwLock::new(adapters) }
	}

	/// Registers one format for this session, rejecting empty or duplicate
	/// names.
	pub fn register(&self, format: impl IntoStr, adapter: Arc<dyn TextEditAdapter>) -> Result<()> {
		let format = format.into_str();
		if format.is_empty() {
			return Err(Error::InvalidTarget {
				target: format,
				reason: sf!("edit format must not be empty"),
			});
		}
		let mut adapters = self.adapters.write();
		if adapters.contains_key(&format) {
			return Err(Error::InvalidTarget {
				target: format,
				reason: sf!("edit format is already registered in this session"),
			});
		}
		adapters.insert(format, Adapter::Boxed(adapter));
		Ok(())
	}

	/// Records an exact read and its selection with every adapter currently
	/// registered in this session.
	pub fn record_snapshot(
		&self,
		path: &Path,
		snapshot: Arc<DocumentSnapshot>,
		selection: &ReadSelection,
	) -> Result<()> {
		let adapters = self
			.adapters
			.read()
			.values()
			.cloned()
			.collect::<SmallVec<Adapter, 4>>();
		for adapter in adapters {
			adapter.record_snapshot(path, snapshot.clone(), selection)?;
		}
		Ok(())
	}

	/// Lowers one opaque intent and validates its sorted base-coordinate edits.
	pub fn lower(
		&self,
		format: &str,
		path: &Path,
		base_snapshot: Arc<DocumentSnapshot>,
		payload: Bytes,
		options_json: Bytes,
	) -> Result<Vec<ByteEdit>> {
		let adapter =
			self
				.adapters
				.read()
				.get(format)
				.cloned()
				.ok_or_else(|| Error::InvalidTarget {
					target: Str::new(format),
					reason: sf!("unknown edit format"),
				})?;
		let base_len = u64::try_from(base_snapshot.content().len()).map_err(|_| {
			Error::InvalidContent { reason: sf!("base snapshot is too large for byte coordinates") }
		})?;
		let edits = adapter.lower(path, base_snapshot, payload, options_json)?;
		validate_edits(base_len, &edits)?;
		Ok(edits)
	}
}

#[derive(Default)]
struct HashlineAdapter {
	store: EditStore,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HashlineOptions {}

impl TextEditAdapter for HashlineAdapter {
	fn record_snapshot(
		&self,
		path: &Path,
		snapshot: Arc<DocumentSnapshot>,
		selection: &ReadSelection,
	) -> Result<()> {
		let path = path_key(path)?;
		// Binary documents are never hashline-editable, so invalid UTF-8 reads
		// are deliberately not retained.
		let Ok(exact) = str::from_utf8(snapshot.content()) else {
			return Ok(());
		};
		let (_, without_bom) = strip_bom(exact);
		let normalized = normalize_to_lf(without_bom);
		let seen_lines = selected_lines(&normalized, selection)?;
		self
			.store
			.record(Path::new(path.as_str()), &normalized, Some(&seen_lines));
		Ok(())
	}

	fn lower(
		&self,
		path: &Path,
		base_snapshot: Arc<DocumentSnapshot>,
		payload: Bytes,
		options_json: Bytes,
	) -> Result<Vec<ByteEdit>> {
		parse_hashline_options(&options_json)?;
		let path_text = path_key(path)?;
		let payload_text =
			str::from_utf8(&payload).map_err(|source| Error::HashlinePayloadUtf8 { source })?;
		let base_exact =
			str::from_utf8(base_snapshot.content()).map_err(|_| Error::InvalidContent {
				reason: sf!("base snapshot is not valid UTF-8 and cannot be edited as text"),
			})?;
		let (bom, without_bom) = strip_bom(base_exact);
		let ending = detect_line_ending(without_bom);
		let base_lf = normalize_to_lf(without_bom);

		let patch = Patch::parse(payload_text, &SplitOptions::default())
			.map_err(|source| Error::HashlineParse { source })?;
		if patch.sections.len() != 1 {
			return Err(Error::InvalidContent {
				reason: sf!("omp.hashline payload must contain exactly one file section"),
			});
		}
		let section = &patch.sections[0];
		if section.path != path_text {
			return Err(Error::InvalidTarget {
				target: Str::new(&section.path),
				reason: sf!("hashline section path does not match transaction path {path_text}"),
			});
		}
		let tag = section
			.file_hash
			.as_deref()
			.ok_or_else(|| Error::InvalidContent {
				reason: sf!("omp.hashline section must include an exact snapshot tag"),
			})?;
		let parsed = section
			.parse()
			.map_err(|source| Error::HashlineParse { source })?;
		if parsed.file_op.is_some() {
			return Err(Error::InvalidContent {
				reason: sf!("omp.hashline text intents cannot contain filesystem operations",),
			});
		}
		let anchor_lines = section
			.collect_anchor_lines()
			.map_err(|source| Error::HashlineParse { source })?;
		let retained = self
			.store
			.by_hash(path, tag)
			.ok_or_else(|| Error::HashlineLookup { path: path_text.clone(), tag: Str::new(tag) })?;
		if let Some(unseen) = anchor_lines.iter().find(|line| {
			!retained
				.seen_lines
				.as_ref()
				.is_some_and(|seen| seen.contains(line))
		}) {
			return Err(Error::InvalidTarget {
				target: path_text.clone(),
				reason: sf!(
					"hashline line {unseen} was not present in this session's read of {path_text}#{tag}"
				),
			});
		}

		let retained_is_live = retained.text.as_ref() == base_lf.as_ref();
		let head_tail_live = !retained_is_live && is_head_tail_only(&parsed.edits);
		let mut clipboard = self.store.start_clipboard_batch();
		let output_lf = if retained_is_live || head_tail_live {
			apply_edits(&base_lf, &parsed.edits, ApplyOptions {
				clipboard:      Some(&mut clipboard),
				path:           Some(&path_text),
				on_empty_paste: EmptyPaste::Throw,
			})
			.map_err(|source| Error::HashlineApply { source })?
			.text
		} else {
			recover_text(
				&retained.text,
				&base_lf,
				&parsed.edits,
				Some(&mut clipboard),
				Some(&path_text),
				RecoveryChain::Session,
			)
			.map_err(|source| Error::HashlineRecovery { source })?
			.ok_or_else(|| Error::HashlineRecovery {
				source: EditError::apply(
					"the retained hashline edit could not be safely recovered onto the current document",
				),
			})?
			.text
		};
		self.store.commit_clipboard(&clipboard);

		let restored_body = restore_line_endings(&output_lf, ending);
		let mut restored = String::with_capacity(bom.len() + restored_body.len());
		restored.push_str(bom);
		restored.push_str(&restored_body);
		let edits = span_edits(base_exact, &restored)
			.into_iter()
			.map(|edit| {
				Ok(ByteEdit::new(
					ByteRange::new(edit.start as u64, edit.end as u64)?,
					Bytes::copy_from_slice(edit.replacement.as_bytes()),
				))
			})
			.collect::<Result<Vec<_>>>()?;

		if edits.is_empty() {
			let (count, escalate) = self.store.record_noop(path, payload_hash(payload_text));
			if escalate {
				return Err(Error::InvalidContent {
					reason: Str::new(no_change_loop_diagnostic(&path_text, count)),
				});
			}
		} else {
			self.store.reset_noop(path);
		}
		Ok(edits)
	}
}

struct ReplaceAdapter;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplacePayload {
	old_text: String,
	new_text: String,
}

#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ReplaceAdapterOptions {
	replace_all: bool,
	allow_fuzzy: bool,
	threshold:   f64,
}

impl Default for ReplaceAdapterOptions {
	fn default() -> Self {
		Self { replace_all: false, allow_fuzzy: true, threshold: DEFAULT_FUZZY_THRESHOLD }
	}
}

impl TextEditAdapter for ReplaceAdapter {
	/// `payload` is JSON `{ "old_text": string, "new_text": string }`.
	/// `options_json` is an optional JSON object with `replace_all`,
	/// `allow_fuzzy`, and `threshold`. Omitted fields replace one occurrence,
	/// permit fuzzy matching, and use [`DEFAULT_FUZZY_THRESHOLD`].
	fn lower(
		&self,
		_path: &Path,
		base_snapshot: Arc<DocumentSnapshot>,
		payload: Bytes,
		options_json: Bytes,
	) -> Result<Vec<ByteEdit>> {
		let payload: ReplacePayload =
			serde_json::from_slice(&payload).map_err(|source| Error::ReplacePayloadJson { source })?;
		let options = if options_json.is_empty() {
			ReplaceAdapterOptions::default()
		} else {
			serde_json::from_slice(&options_json)
				.map_err(|source| Error::ReplaceOptionsJson { source })?
		};
		let base_exact =
			str::from_utf8(base_snapshot.content()).map_err(|_| Error::InvalidContent {
				reason: sf!("base snapshot is not valid UTF-8 and cannot be edited as text"),
			})?;
		let (bom, without_bom) = strip_bom(base_exact);
		let ending = detect_line_ending(without_bom);
		let base_lf = normalize_to_lf(without_bom);
		let result = replace_text(
			&base_lf,
			&payload.old_text,
			&payload.new_text,
			options.allow_fuzzy,
			options.replace_all,
			Some(options.threshold),
		)
		.map_err(|source| Error::Replace { source })?;

		let restored_body = restore_line_endings(&result.content, ending);
		let mut restored = String::with_capacity(bom.len() + restored_body.len());
		restored.push_str(bom);
		restored.push_str(&restored_body);
		span_edits(base_exact, &restored)
			.into_iter()
			.map(|edit| {
				Ok(ByteEdit::new(
					ByteRange::new(edit.start as u64, edit.end as u64)?,
					Bytes::copy_from_slice(edit.replacement.as_bytes()),
				))
			})
			.collect()
	}
}

fn parse_hashline_options(options: &[u8]) -> Result<()> {
	if options.is_empty() {
		return Ok(());
	}
	serde_json::from_slice::<HashlineOptions>(options)
		.map(|_| ())
		.map_err(|source| Error::HashlineOptionsJson { source })
}

fn path_key(path: &Path) -> Result<Str> {
	path
		.to_str()
		.map(Str::new)
		.ok_or_else(|| Error::InvalidTarget {
			target: Str::new(path.to_string_lossy()),
			reason: sf!("edit paths must be valid UTF-8"),
		})
}

fn selected_lines(content: &str, selection: &ReadSelection) -> Result<Vec<u32>> {
	let line_count = if content.is_empty() {
		0
	} else {
		u32::try_from(content.lines().count())
			.map_err(|_| Error::InvalidContent { reason: sf!("snapshot has too many lines") })?
	};
	match selection {
		ReadSelection::Whole => Ok((1..=line_count).collect()),
		ReadSelection::Bytes(_) => Ok(Vec::new()),
		ReadSelection::Lines(ranges) => {
			let mut lines = Vec::new();
			for range in ranges {
				let range = range.validate(u64::from(line_count))?;
				for line in range.start() + 1..=range.end() {
					lines.push(u32::try_from(line).map_err(|_| Error::InvalidContent {
						reason: sf!("snapshot has too many lines"),
					})?);
				}
			}
			lines.sort_unstable();
			lines.dedup();
			Ok(lines)
		},
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::docserver::{
		DocumentHead, DocumentId, DocumentKind, DocumentPresence, LineRange, Revision,
	};

	fn snapshot(sequence: u64, content: &'static [u8]) -> Arc<DocumentSnapshot> {
		let content = Bytes::from_static(content);
		let head = DocumentHead::new(
			DocumentId::from_bytes([7; 16]),
			Revision::for_content(sequence, &content),
			DocumentPresence::Present,
			DocumentKind::Text(None),
			content.len() as u64,
		)
		.expect("head");
		Arc::new(DocumentSnapshot::new(head, content).expect("snapshot"))
	}

	#[test]
	fn unknown_format_is_rejected() {
		let registry = EditAdapterRegistry::with_built_ins();
		let error = registry
			.lower(
				"example.unknown",
				Path::new("file.txt"),
				snapshot(1, b"text\n"),
				Bytes::new(),
				Bytes::new(),
			)
			.expect_err("unknown format");
		assert!(matches!(error, Error::InvalidTarget { .. }));
	}

	#[test]
	fn replace_returns_exact_base_coordinate_edit() {
		let registry = EditAdapterRegistry::with_built_ins();
		let edits = registry
			.lower(
				REPLACE_EDIT_FORMAT,
				Path::new("file.txt"),
				snapshot(1, b"before needle after\n"),
				Bytes::from_static(br#"{"old_text":"needle","new_text":"thread"}"#),
				Bytes::from_static(br#"{"allow_fuzzy":false}"#),
			)
			.expect("replace");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].range(), ByteRange::new(0, 20).expect("range"));
		assert_eq!(edits[0].replacement().as_ref(), b"before thread after\n");
	}

	#[test]
	fn replace_preserves_bom_and_crlf_in_exact_coordinates() {
		let registry = EditAdapterRegistry::with_built_ins();
		let edits = registry
			.lower(
				REPLACE_EDIT_FORMAT,
				Path::new("file.txt"),
				snapshot(1, b"\xEF\xBB\xBFleft\r\nneedle\r\nright\r\n"),
				Bytes::from_static(br#"{"old_text":"needle","new_text":"thread"}"#),
				Bytes::from_static(br#"{"allow_fuzzy":false}"#),
			)
			.expect("replace");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].range(), ByteRange::new(9, 17).expect("range"));
		assert_eq!(edits[0].replacement().as_ref(), b"thread\r\n");
	}

	#[test]
	fn hashline_recovers_stale_edit_onto_current_snapshot() {
		let registry = EditAdapterRegistry::with_built_ins();
		let old = snapshot(1, b"alpha\nbeta\ngamma\n");
		registry
			.record_snapshot(
				Path::new("file.txt"),
				old.clone(),
				&ReadSelection::Lines(vec![LineRange::new(1, 2).expect("lines")]),
			)
			.expect("record");
		let tag = omp_edit::store::file_hash(str::from_utf8(old.content()).expect("UTF-8 fixture"));
		let patch = Bytes::from(format!("[file.txt#{tag}]\nPUT 2.=2:\n+BETA\n"));
		let edits = registry
			.lower(
				HASHLINE_EDIT_FORMAT,
				Path::new("file.txt"),
				snapshot(2, b"alpha\nbeta\ngamma\nsuffix\n"),
				patch,
				Bytes::new(),
			)
			.expect("recover");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].range(), ByteRange::new(6, 11).expect("range"));
		assert_eq!(edits[0].replacement().as_ref(), b"BETA\n");
	}

	#[test]
	fn hashline_recovers_through_a_second_recorded_snapshot() {
		let registry = EditAdapterRegistry::with_built_ins();
		let old = snapshot(1, b"alpha\nbeta\ngamma\n");
		registry
			.record_snapshot(Path::new("file.txt"), old.clone(), &ReadSelection::Whole)
			.expect("record old");
		let tag = omp_edit::store::file_hash(str::from_utf8(old.content()).expect("UTF-8 fixture"));
		let current = snapshot(2, b"prefix\nalpha\nbeta\ngamma\n");
		registry
			.record_snapshot(Path::new("file.txt"), current.clone(), &ReadSelection::Whole)
			.expect("record current");
		let patch = Bytes::from(format!("[file.txt#{tag}]\nPUT 2.=2:\n+BETA\n"));
		let edits = registry
			.lower(HASHLINE_EDIT_FORMAT, Path::new("file.txt"), current, patch, Bytes::new())
			.expect("recover through retained chain");
		assert_eq!(edits.len(), 1);
		assert_eq!(edits[0].range(), ByteRange::new(13, 18).expect("range"));
		assert_eq!(edits[0].replacement().as_ref(), b"BETA\n");
	}

	#[test]
	fn hashline_rejects_stale_duplicate_when_authored_line_changed() {
		let registry = EditAdapterRegistry::with_built_ins();
		let old = snapshot(1, b"top\nduplicate\nmiddle\nduplicate\nbottom\n");
		registry
			.record_snapshot(Path::new("file.txt"), old.clone(), &ReadSelection::Whole)
			.expect("record");
		let tag = omp_edit::store::file_hash(str::from_utf8(old.content()).expect("UTF-8 fixture"));
		let patch = Bytes::from(format!("[file.txt#{tag}]\nCUT 4\n"));
		let error = registry
			.lower(
				HASHLINE_EDIT_FORMAT,
				Path::new("file.txt"),
				snapshot(2, b"top\nduplicate\nmiddle\nchanged\nbottom\n"),
				patch,
				Bytes::new(),
			)
			.expect_err("changed authored duplicate must fail closed");
		assert!(matches!(error, Error::HashlineRecovery { source: EditError::Apply(_) }));
	}

	#[test]
	fn stale_head_tail_only_patch_applies_to_live_boundaries() {
		let registry = EditAdapterRegistry::with_built_ins();
		let old = snapshot(1, b"old first\nold last\n");
		registry
			.record_snapshot(Path::new("file.txt"), old.clone(), &ReadSelection::Whole)
			.expect("record");
		let tag = omp_edit::store::file_hash(str::from_utf8(old.content()).expect("UTF-8 fixture"));
		let patch = Bytes::from(format!("[file.txt#{tag}]\nPUT <1:\n+HEAD\nPUT >$:\n+TAIL\n"));
		let current = b"changed first\nchanged last\n";
		let edits = registry
			.lower(
				HASHLINE_EDIT_FORMAT,
				Path::new("file.txt"),
				snapshot(2, current),
				patch,
				Bytes::new(),
			)
			.expect("content-independent boundaries apply to live bytes");
		assert_eq!(edits.len(), 2);
		assert_eq!(edits[0].range(), ByteRange::new(0, 0).expect("head range"));
		assert_eq!(edits[0].replacement().as_ref(), b"HEAD\n");
		let end = u64::try_from(current.len()).expect("fixture length");
		assert_eq!(edits[1].range(), ByteRange::new(end, end).expect("tail range"));
		assert_eq!(edits[1].replacement().as_ref(), b"TAIL\n");
	}

	#[test]
	fn hashline_seen_lines_do_not_cross_sessions() {
		let first = EditAdapterRegistry::with_built_ins();
		let second = EditAdapterRegistry::with_built_ins();
		let read = snapshot(1, b"alpha\nbeta\ngamma\n");
		first
			.record_snapshot(
				Path::new("file.txt"),
				read.clone(),
				&ReadSelection::Lines(vec![LineRange::new(1, 2).expect("lines")]),
			)
			.expect("first record");
		second
			.record_snapshot(
				Path::new("file.txt"),
				read.clone(),
				&ReadSelection::Lines(vec![LineRange::new(0, 1).expect("lines")]),
			)
			.expect("second record");
		let tag = omp_edit::store::file_hash(str::from_utf8(read.content()).expect("UTF-8 fixture"));
		let patch = Bytes::from(format!("[file.txt#{tag}]\nPUT 2.=2:\n+BETA\n"));
		first
			.lower(
				HASHLINE_EDIT_FORMAT,
				Path::new("file.txt"),
				read.clone(),
				patch.clone(),
				Bytes::new(),
			)
			.expect("authorized session");
		let error = second
			.lower(HASHLINE_EDIT_FORMAT, Path::new("file.txt"), read, patch, Bytes::new())
			.expect_err("isolated provenance");
		assert!(matches!(error, Error::InvalidTarget { .. }));
	}
}
