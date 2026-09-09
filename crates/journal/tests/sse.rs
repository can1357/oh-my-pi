//! Property coverage for the raw-SSE codec.

use omp_core::{Str, Ulid};
use omp_journal::{Entry, EntryId, Kind, kind::PATCH, sse};
use proptest::prelude::*;

proptest! {
	#[test]
	fn sse_round_trip_preserves_entry_identity(
		seed in any::<u128>(),
		label_tail in "[a-zA-Z0-9 ._-]{0,64}",
		text in ".{0,256}",
		integer in any::<i64>(),
	) {
		let entry = Entry {
			id: EntryId::from(Ulid::from_bytes(seed.to_be_bytes())),
			kind: Kind { name: Str::new_static(PATCH), rev: 1 },
			by: Some(EntryId::from(Ulid::from_bytes(seed.wrapping_sub(1).to_be_bytes()))),
			prior: None,
			label: Some(Str::new(format!("λ-{label_tail}"))),
			data: Str::new(serde_json::json!({"integer": integer, "text": text}).to_string()),
		};
		let mut bytes = Vec::new();
		sse::encode(&entry, &mut bytes).expect("encode");
		let mut scanner = sse::Scanner::new(&bytes);
		let decoded = scanner.next().expect("frame").expect("decode");
		prop_assert_eq!(decoded.entry, entry);
		prop_assert_eq!(decoded.span, 0..bytes.len());
		prop_assert!(scanner.next().is_none());
		prop_assert!(!scanner.has_torn_tail());
	}
}

#[test]
fn writer_uses_canonical_field_order() {
	let entry = Entry {
		id:    "01ARZ3NDEKTSV4RRFFQ69G5FAV".parse().expect("id"),
		kind:  Kind { name: Str::new_static(PATCH), rev: 1 },
		by:    Some("01ARZ3NDEKTSV4RRFFQ69G5FAA".parse().expect("cause")),
		prior: Some("01ARZ3NDEKTSV4RRFFQ69G5FAB".parse().expect("prior")),
		label: Some(Str::new_static("todo.完了")),
		data:  Str::new_static(r#"{"ops":[]}"#),
	};
	let mut bytes = Vec::new();
	sse::encode(&entry, &mut bytes).expect("encode");
	assert_eq!(
		std::str::from_utf8(&bytes).expect("UTF-8"),
		concat!(
			": todo.完了\n",
			"event: patch@1\n",
			"id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\n",
			"by: 01ARZ3NDEKTSV4RRFFQ69G5FAA\n",
			"prior: 01ARZ3NDEKTSV4RRFFQ69G5FAB\n",
			"data: {\"ops\":[]}\n\n",
		)
	);
}

#[test]
fn uppercase_event_kind_is_rejected() {
	let bytes =
		b"event: PATCH@1\nid: 01ARZ3NDEKTSV4RRFFQ69G5FAV\nby: 01ARZ3NDEKTSV4RRFFQ69G5FAA\ndata: {\"ops\":[]}\n\n";
	let mut scanner = sse::Scanner::new(bytes);
	assert!(matches!(
		scanner.next().expect("complete frame"),
		Err(sse::SseError::UnknownKind { .. })
	));
}

#[test]
fn scanner_ignores_unknown_field_lines() {
	let bytes = b"id: 01ARZ3NDEKTSV4RRFFQ69G5FAV\nevent: journal@1\nextension: retained-by-newer-reader\ndata: {}\n\n";
	let mut scanner = sse::Scanner::new(bytes);
	let frame = scanner.next().expect("frame").expect("valid frame");
	assert_eq!(frame.entry.kind.name, "journal");
	assert_eq!(frame.entry.data, "{}");
}
