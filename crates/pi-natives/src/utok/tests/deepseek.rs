//! Golden-fixture test: `DeepSeekV3` vs reference HF tokenizers encode
//! (`add_special_tokens=False`) over cache/deepseek-v4.tokenizer.json.
//! Base BPE is identical V3..V4 (verified upstream: same vocab + merges
//! hash), so one encoding covers the whole family.

use crate::utok::Encoding;

#[test]
fn deepseek_matches_reference() {
	let raw = include_str!("../../../fixtures/deepseek3.json");
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

		let got = Encoding::DeepSeekV3
			.encode(text)
			.expect("deepseek is a BPE family");
		assert_eq!(got, want, "encode mismatch on {text:?}");
		// Merge-unreachable sentinels (ids 0..2) are blanked in the packed
		// table; encode_ordinary must never emit them — including for the
		// fixture cases spelling them out verbatim.
		assert!(got.iter().all(|&id| id > 2), "sentinel id emitted on {text:?}");
		assert_eq!(Encoding::DeepSeekV3.count(text), count, "count mismatch on {text:?}");
	}
}

/// V3 parity spot check: ids generated with deepseek-ai/DeepSeek-V3's
/// tokenizer for one mixed CJK/digit/latin sample (see fixture
/// `v3_parity`); must equal our V4-table output byte for byte.
#[test]
fn deepseek_v3_parity_sample() {
	let raw = include_str!("../../../fixtures/deepseek3.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	let parity = &fixture["v3_parity"];
	let text = parity["text"].as_str().expect("v3_parity.text");
	let want: Vec<u32> = parity["ids"]
		.as_array()
		.expect("v3_parity.ids")
		.iter()
		.map(|v| v.as_u64().expect("id") as u32)
		.collect();
	assert_eq!(Encoding::DeepSeekV3.encode(text).unwrap(), want);
	assert_eq!(Encoding::DeepSeekV3.count(text) as usize, want.len());
}

/// Flavor invariance: UTF-16 and UTF-32 inputs must yield the same ids
/// and counts as `&str` for every fixture case (all valid text).
#[test]
fn deepseek_utf16_utf32_parity() {
	let raw = include_str!("../../../fixtures/deepseek3.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	for case in fixture["cases"].as_array().expect("cases array") {
		let text = case["text"].as_str().expect("text");
		let want = Encoding::DeepSeekV3.encode(text).unwrap();
		let count = Encoding::DeepSeekV3.count(text);

		let u16s: Vec<u16> = text.encode_utf16().collect();
		assert_eq!(Encoding::DeepSeekV3.encode(&u16s).unwrap(), want, "utf16 ids on {text:?}");
		assert_eq!(Encoding::DeepSeekV3.count(&u16s), count, "utf16 count on {text:?}");

		let u32s: Vec<u32> = text.chars().map(|c| c as u32).collect();
		assert_eq!(Encoding::DeepSeekV3.encode(&u32s).unwrap(), want, "utf32 ids on {text:?}");
		assert_eq!(Encoding::DeepSeekV3.count(&u32s), count, "utf32 count on {text:?}");
	}
}
