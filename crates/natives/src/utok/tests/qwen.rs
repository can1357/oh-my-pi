//! Golden-fixture test: Qwen3 vs reference HF tokenizers encode
//! (`add_special_tokens=false`), including NFC normalization and the
//! dead-rank (merge-unreachable vocab entry) regressions.

use crate::utok::Encoding;

#[test]
fn qwen3_matches_reference() {
	let raw = include_str!("../../../fixtures/qwen3.json");
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

		let got = Encoding::Qwen3.encode(text).expect("qwen is a BPE family");
		assert_eq!(got, want, "encode mismatch on {text:?}");
		assert_eq!(Encoding::Qwen3.count(text), count, "count mismatch on {text:?}");
	}
}

/// Every fixture case must produce identical ids/counts when the input is
/// re-encoded as UTF-16 or UTF-32 units (flavor invariance for valid text).
/// Qwen additionally normalizes NFC, so non-u8 flavors exercise the
/// codepoint-level normalization path (NFD extras below).
#[test]
fn qwen3_utf16_utf32_parity() {
	let raw = include_str!("../../../fixtures/qwen3.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	let cases = fixture["cases"].as_array().expect("cases array");
	// NFD text (normalization must fire in every flavor), astral CJK,
	// ZWJ emoji, and single-digit runs.
	let extra = "cafe\u{301} A\u{30a}ngstro\u{308}m \u{1112}\u{1161}\u{11ab} 𝕏𠀀中文👨‍👩‍👧‍👦 12345";
	let texts = cases
		.iter()
		.map(|c| c["text"].as_str().expect("text"))
		.chain(std::iter::once(extra));
	for text in texts {
		let want = Encoding::Qwen3.encode(text).expect("qwen is a BPE family");
		let u16s: Vec<u16> = text.encode_utf16().collect();
		let u32s: Vec<u32> = text.chars().map(|c| c as u32).collect();
		assert_eq!(
			Encoding::Qwen3.encode(u16s.as_slice()),
			Some(want.clone()),
			"utf16 encode mismatch on {text:?}"
		);
		assert_eq!(
			Encoding::Qwen3.encode(u32s.as_slice()),
			Some(want.clone()),
			"utf32 encode mismatch on {text:?}"
		);
		let n = want.len() as u32;
		assert_eq!(Encoding::Qwen3.count(u16s.as_slice()), n, "utf16 count mismatch on {text:?}");
		assert_eq!(Encoding::Qwen3.count(u32s.as_slice()), n, "utf32 count mismatch on {text:?}");
	}
}

/// Merge-unreachable vocab entries (dead ranks) must never be emitted:
/// the pack blanks them, so whole-piece short-circuits cannot resolve to
/// them. Guarded by fixtures too; this pins the ids explicitly.
#[test]
fn qwen3_dead_ranks_not_emitted() {
	// "毛泽东" is vocab id 105115 but unreachable via merges; HF emits
	// [97008, 98340, 96265].
	let got = Encoding::Qwen3
		.encode("毛泽东")
		.expect("qwen is a BPE family");
	assert_eq!(got, vec![97008, 98340, 96265]);
	assert!(!got.contains(&105115));
}
