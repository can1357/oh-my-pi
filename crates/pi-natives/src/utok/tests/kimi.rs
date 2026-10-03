//! Golden-fixture test: `KimiK2` vs reference tiktoken `encode_ordinary`.

use crate::utok::Encoding;

#[test]
fn kimi_k2_matches_reference() {
	let raw = include_str!("../../../fixtures/kimi_k2.json");
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

		let got = Encoding::KimiK2.encode(text).expect("kimi is a BPE family");
		assert_eq!(got, want, "encode mismatch on {text:?}");
		assert_eq!(Encoding::KimiK2.count(text), count, "count mismatch on {text:?}");
	}
}

/// Every fixture case must produce identical ids/counts when the input is
/// re-encoded as UTF-16 or UTF-32 units (flavor invariance for valid text).
#[test]
fn kimi_k2_utf16_utf32_parity() {
	let raw = include_str!("../../../fixtures/kimi_k2.json");
	let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");
	let cases = fixture["cases"].as_array().expect("cases array");
	// Surrogate-pair-heavy extra: Kimi's Han classes meet 2-unit UTF-16
	// codepoints (emoji, 𝕏 U+1D54D, and astral Han U+20000 𠀀).
	let extra = "👨‍👩‍👧‍👦𝕏≈中文𠀀𠀁English🇹🇵123'll  \n";
	let texts = cases
		.iter()
		.map(|c| c["text"].as_str().expect("text"))
		.chain(std::iter::once(extra));
	for text in texts {
		let want = Encoding::KimiK2.encode(text).expect("kimi is a BPE family");
		let u16s: Vec<u16> = text.encode_utf16().collect();
		let u32s: Vec<u32> = text.chars().map(|c| c as u32).collect();
		assert_eq!(
			Encoding::KimiK2.encode(u16s.as_slice()),
			Some(want.clone()),
			"utf16 encode mismatch on {text:?}"
		);
		assert_eq!(
			Encoding::KimiK2.encode(u32s.as_slice()),
			Some(want.clone()),
			"utf32 encode mismatch on {text:?}"
		);
		let n = want.len() as u32;
		assert_eq!(Encoding::KimiK2.count(u16s.as_slice()), n, "utf16 count mismatch on {text:?}");
		assert_eq!(Encoding::KimiK2.count(u32s.as_slice()), n, "utf32 count mismatch on {text:?}");
	}
}
