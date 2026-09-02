//! Golden-fixture test: Glm5 vs reference HF tokenizers
//! (`add_special_tokens=False`).
//!
//! GLM-4.x note: GLM-5 is an ID-preserving superset of GLM-4.x (~3.5k extra
//! merges), so GLM-4.x counts are near-exact under this table — no separate
//! 4.x fixtures needed.
//!
//! The fixture includes directed `ignore_merges` probes: vocab tokens (e.g.
//! ' 参考' = 99855) that HF's greedy merge order never produces bottom-up —
//! plain BPE emits multiple ids (' 参考' → [26767, 224, 98580]) while
//! `ignore_merges` emits the single whole-piece id. Verified against the
//! Python reference with the flag toggled (tools/gen-glm-fixtures.py).

use crate::utok::Encoding;

#[test]
fn glm5_matches_reference() {
	let raw = include_str!("../../../fixtures/glm5.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	let cases = fixture["cases"].as_array().expect("cases array");
	assert!(!cases.is_empty());
	for case in cases {
		let text = case["text"].as_str().expect("text");
		let want: Vec<u32> = case["ids"]
			.as_array()
			.expect("ids")
			.iter()
			.map(|v| v.as_u64().expect("id") as u32)
			.collect();
		let count = case["count"].as_u64().expect("count") as u32;
		assert_eq!(count as usize, want.len(), "fixture self-consistency: {text:?}");

		let got = Encoding::Glm5.encode(text).expect("glm is a BPE family");
		assert_eq!(got, want, "encode mismatch on {text:?}");
		assert_eq!(Encoding::Glm5.count(text), count, "count mismatch on {text:?}");
	}
}

/// Directed `ignore_merges` semantics: ' 参考' exists in vocab (99855) but
/// HF's greedy merge order never forms it from bytes; normal merge-loop BPE
/// yields [26767, 224, 98580] (verified with the Python reference with
/// `ignore_merges=false`). The whole-piece short-circuit must win.
#[test]
fn glm5_ignore_merges_whole_piece_wins() {
	assert_eq!(Encoding::Glm5.encode(" 参考").unwrap(), vec![99855]);
	assert_eq!(Encoding::Glm5.count(" 参考"), 1);
	assert_eq!(Encoding::Glm5.encode(" 参考资料").unwrap(), vec![99924]);
	// Same token mid-text: pretokenizer isolates ' 参考' as its own piece.
	assert_eq!(Encoding::Glm5.encode("龘 参考").unwrap(), vec![82225, 246, 99855]);
	// Extended so the piece is NOT a whole-vocab hit: the merge loop runs
	// and must match the reference (rank-order merging, ' 参考龘' is OOV).
	assert_eq!(
		Encoding::Glm5.count(" 参考龘"),
		Encoding::Glm5.encode(" 参考龘").unwrap().len() as u32
	);
}

/// UTF-16 / UTF-32 parity: every fixture case must produce identical ids
/// and counts when tokenized natively in u16/u32 code units (no transcode).
/// The corpus includes emoji (surrogate pairs in UTF-16) — asserted
/// explicitly below so the coverage is self-documenting.
#[test]
fn glm5_utf16_utf32_parity() {
	let raw = include_str!("../../../fixtures/glm5.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	let cases = fixture["cases"].as_array().expect("cases array");
	let mut saw_surrogate_pair = false;
	for case in cases {
		let text = case["text"].as_str().expect("text");
		let want: Vec<u32> = case["ids"]
			.as_array()
			.expect("ids")
			.iter()
			.map(|v| v.as_u64().expect("id") as u32)
			.collect();
		let count = want.len() as u32;

		let utf16: Vec<u16> = text.encode_utf16().collect();
		let utf32: Vec<u32> = text.chars().map(|c| c as u32).collect();
		saw_surrogate_pair |= utf16.len() > utf32.len();

		assert_eq!(Encoding::Glm5.encode(&utf16).unwrap(), want, "utf16 encode mismatch on {text:?}");
		assert_eq!(Encoding::Glm5.count(&utf16), count, "utf16 count mismatch on {text:?}");
		assert_eq!(Encoding::Glm5.encode(&utf32).unwrap(), want, "utf32 encode mismatch on {text:?}");
		assert_eq!(Encoding::Glm5.count(&utf32), count, "utf32 count mismatch on {text:?}");
	}
	assert!(saw_surrogate_pair, "corpus must exercise a UTF-16 surrogate pair");
}
