//! Byte-level BPE over a Hugging Face `tokenizer.json` (the GPT-2 family
//! scheme `SmolLM2` uses), without the `tokenizers` crate and its C regex
//! dependency.
//!
//! Supported pipeline, which is exactly `SmolLM2`'s: no normalizer, a
//! `Sequence[Digits(individual_digits), ByteLevel(use_regex)]` pre-tokenizer,
//! a `BPE` model without dropout or subword prefixes, and a `ByteLevel`
//! decoder. Anything else is rejected at load so a changed tokenizer cannot
//! silently mis-tokenize. Added (special) tokens are never matched inside
//! user text: prompts are data, not control sequences. Bytes without a vocab
//! symbol (a few control and unused UTF-8 lead bytes) are dropped, as the
//! reference BPE does without an unknown token.

use std::{collections::HashMap, path::Path, sync::Arc};

use anyhow::{Context, bail, ensure};
use serde::Deserialize;
use xutf::{GeneralCategoryGroup, Ucd};

/// How a char takes part in pre-tokenization.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Class {
	/// Punctuation and symbols: neither whitespace, letter nor number.
	Other,
	Letter,
	/// Always a pre-token of its own.
	Number,
	/// U+0020, which joins the word or symbol run after it.
	Blank,
	Space,
}

/// [`Class`] of every ASCII byte; `None` for the bytes of a multi-byte char,
/// which is classified from its scalar.
static CLASSES: [Option<Class>; 256] = {
	let mut table = [None; 256];
	let mut byte = 0;
	while byte < 0x80 {
		table[byte] = Some(match byte as u8 {
			b' ' => Class::Blank,
			b'\t'..=b'\r' => Class::Space,
			b'0'..=b'9' => Class::Number,
			b'A'..=b'Z' | b'a'..=b'z' => Class::Letter,
			_ => Class::Other,
		});
		byte += 1;
	}
	table
};

/// Suffixes split off the word before them.
const CONTRACTIONS: [&[u8]; 7] = [b"'s", b"'t", b"'re", b"'ve", b"'m", b"'ll", b"'d"];

#[cold]
fn classify_wide(text: &str, at: usize) -> (Class, usize) {
	let c = text[at..].chars().next().expect("cursor inside the text");
	let class = if c.is_numeric() {
		Class::Number
	} else if c.is_whitespace() {
		Class::Space
	} else if c.general_category_group() == GeneralCategoryGroup::Letter {
		Class::Letter
	} else {
		Class::Other
	};
	(class, c.len_utf8())
}

/// Class and byte length of the char at `at`; `None` at the end.
#[inline]
fn classify(text: &str, at: usize) -> Option<(Class, usize)> {
	Some(match CLASSES[usize::from(*text.as_bytes().get(at)?)] {
		Some(class) => (class, 1),
		None => classify_wide(text, at),
	})
}

/// End of the run of `class` chars starting at `at`.
#[inline]
fn run_end(text: &str, mut at: usize, class: Class) -> usize {
	while let Some((found, len)) = classify(text, at)
		&& found == class
	{
		at += len;
	}
	at
}

/// Byte ranges of the pre-tokens, as `Digits(individual_digits)` followed by
/// `ByteLevel` produce them: every numeric char alone; contractions (`'s`,
/// `'ll`, …); words and symbol runs, each with the blank before it;
/// whitespace runs, which leave their last char to the word that follows
/// (`"a  b"` → `"a"`, `" "`, `" b"`).
fn pre_tokenize(text: &str) -> Vec<(usize, usize)> {
	let mut spans = Vec::new();
	let mut at = 0;
	while let Some((class, len)) = classify(text, at) {
		let start = at;
		at += len;
		match class {
			Class::Number => {},
			Class::Letter => at = run_end(text, at, Class::Letter),
			Class::Other => {
				let rest = &text.as_bytes()[start..];
				at = match CONTRACTIONS.iter().find(|suffix| rest.starts_with(suffix)) {
					Some(suffix) => start + suffix.len(),
					None => run_end(text, at, Class::Other),
				};
			},
			Class::Blank | Class::Space => {
				let next = classify(text, at).map(|(next, _)| next);
				if class == Class::Blank
					&& let Some(word @ (Class::Letter | Class::Other)) = next
				{
					at = run_end(text, at, word);
				} else {
					let mut last = start;
					while let Some((Class::Blank | Class::Space, len)) = classify(text, at) {
						last = at;
						at += len;
					}
					let word_follows =
						matches!(classify(text, at), Some((Class::Letter | Class::Other, _)));
					if word_follows && last > start {
						at = last;
					}
				}
			},
		}
		spans.push((start, at));
	}
	spans
}

#[derive(Deserialize)]
struct TokenizerJson {
	normalizer:    Option<serde_json::Value>,
	pre_tokenizer: Option<PreTokenizerJson>,
	decoder:       Option<TypedJson>,
	model:         ModelJson,
	#[serde(default)]
	added_tokens:  Vec<AddedTokenJson>,
}

#[derive(Deserialize)]
struct TypedJson {
	#[serde(rename = "type")]
	kind: String,
}

#[derive(Deserialize)]
struct PreTokenizerJson {
	#[serde(rename = "type")]
	kind:          String,
	#[serde(default)]
	pretokenizers: Vec<PreTokenizerStepJson>,
}

#[derive(Deserialize)]
struct PreTokenizerStepJson {
	#[serde(rename = "type")]
	kind:              String,
	#[serde(default)]
	individual_digits: bool,
	#[serde(default)]
	add_prefix_space:  bool,
	#[serde(default = "default_true")]
	use_regex:         bool,
}

const fn default_true() -> bool {
	true
}

#[derive(Deserialize)]
struct ModelJson {
	#[serde(rename = "type")]
	kind: String,
	#[serde(default)]
	dropout: Option<f64>,
	#[serde(default)]
	continuing_subword_prefix: Option<String>,
	#[serde(default)]
	end_of_word_suffix: Option<String>,
	vocab: HashMap<String, u32>,
	merges: Vec<MergeJson>,
}

/// `"a b"` (older files) or `["a", "b"]` (newer files).
#[derive(Deserialize)]
#[serde(untagged)]
enum MergeJson {
	Joined(String),
	Pair([String; 2]),
}

#[derive(Deserialize)]
struct AddedTokenJson {
	id:      u32,
	content: String,
	#[serde(default)]
	special: bool,
}

/// GPT-2 `bytes_to_unicode`: every byte maps to a printable char.
fn byte_chars() -> [char; 256] {
	let mut table = ['\0'; 256];
	let mut next = 256u32;
	for byte in 0..=255u8 {
		let printable = matches!(byte, b'!'..=b'~' | 0xA1..=0xAC | 0xAE..=0xFF);
		let code = if printable {
			u32::from(byte)
		} else {
			let code = next;
			next += 1;
			code
		};
		table[usize::from(byte)] = char::from_u32(code).unwrap_or('\0');
	}
	table
}

/// Token ids plus the byte span of each token in the encoded text.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Encoding {
	/// Token ids in order.
	pub ids:     Vec<u32>,
	/// `[start, end)` byte offsets of each token.
	pub offsets: Vec<(usize, usize)>,
}

/// Every token's raw bytes in one arena (one allocation instead of one per
/// token), shared with the search index.
#[derive(Default)]
pub struct TokenBytes {
	bytes: Vec<u8>,
	/// `bytes[ends[id - 1]..ends[id]]` is token `id` (`0` before the first).
	ends:  Vec<u32>,
}

impl TokenBytes {
	/// Append the next token id's bytes.
	fn push(&mut self, token: impl IntoIterator<Item = u8>) {
		self.bytes.extend(token);
		self.ends.push(self.bytes.len() as u32);
	}

	/// Bytes of token `id`; empty for ids past the vocab.
	pub fn get(&self, id: u32) -> &[u8] {
		let id = id as usize;
		let Some(&end) = self.ends.get(id) else {
			return &[];
		};
		let start = if id == 0 { 0 } else { self.ends[id - 1] };
		&self.bytes[start as usize..end as usize]
	}
}

#[cfg(test)]
impl<T: AsRef<[u8]>> FromIterator<T> for TokenBytes {
	fn from_iter<I: IntoIterator<Item = T>>(tokens: I) -> Self {
		let mut out = Self::default();
		for token in tokens {
			out.push(token.as_ref().iter().copied());
		}
		out
	}
}

/// `SmolLM2`'s byte-level BPE tokenizer.
pub struct Tokenizer {
	/// Single-byte token id for every byte value, if the vocab has one.
	byte_ids:    [Option<u32>; 256],
	/// `(left, right)` → `(rank, merged id)`.
	merges:      HashMap<(u32, u32), (u32, u32)>,
	/// Raw bytes each token decodes to.
	token_bytes: Arc<TokenBytes>,
	/// Special added tokens (never produced by `encode`).
	special:     Vec<bool>,
}

impl Tokenizer {
	/// Load `tokenizer.json`.
	///
	/// # Errors
	/// Fails when the file is unreadable or not a byte-level BPE tokenizer
	/// with `SmolLM2`'s pipeline.
	pub fn load(path: &Path) -> anyhow::Result<Self> {
		let text = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
		let json: TokenizerJson =
			serde_json::from_slice(&text).with_context(|| format!("parse {}", path.display()))?;
		Self::from_json(json)
	}

	/// Parse a `tokenizer.json` document held in memory.
	///
	/// # Errors
	/// Same as [`Tokenizer::load`].
	#[cfg(test)]
	pub fn from_bytes(bytes: &[u8]) -> anyhow::Result<Self> {
		Self::from_json(serde_json::from_slice(bytes).context("parse tokenizer.json")?)
	}

	fn from_json(json: TokenizerJson) -> anyhow::Result<Self> {
		ensure!(
			json.normalizer.is_none_or(|value| value.is_null()),
			"tokenizer normalizers are unsupported"
		);
		let pre = json
			.pre_tokenizer
			.context("tokenizer has no pre_tokenizer")?;
		let supported = pre.kind == "Sequence"
			&& matches!(
				pre.pretokenizers.as_slice(),
				[digits, bytes]
					if digits.kind == "Digits" && digits.individual_digits
						&& bytes.kind == "ByteLevel" && !bytes.add_prefix_space && bytes.use_regex
			);
		ensure!(supported, "unsupported pre_tokenizer (want Digits(individual) + ByteLevel)");
		ensure!(
			json
				.decoder
				.as_ref()
				.is_some_and(|decoder| decoder.kind == "ByteLevel"),
			"unsupported decoder (want ByteLevel)"
		);
		let model = json.model;
		ensure!(model.kind == "BPE", "unsupported tokenizer model {:?}", model.kind);
		ensure!(
			model.dropout.is_none()
				&& model
					.continuing_subword_prefix
					.as_deref()
					.is_none_or(str::is_empty)
				&& model
					.end_of_word_suffix
					.as_deref()
					.is_none_or(str::is_empty),
			"unsupported BPE options (dropout / subword affixes)"
		);

		let chars = byte_chars();
		let char_to_byte: HashMap<char, u8> = chars
			.iter()
			.enumerate()
			.map(|(byte, &c)| (c, byte as u8))
			.collect();
		let size = model
			.vocab
			.values()
			.chain(json.added_tokens.iter().map(|token| &token.id))
			.max()
			.map_or(0, |&id| id as usize + 1);
		// Final source text per id: added tokens override their vocab entry and
		// are literal, vocab entries are byte-level encoded.
		let mut sources: Vec<Option<(&str, bool)>> = vec![None; size];
		for (text, &id) in &model.vocab {
			sources[id as usize] = Some((text, true));
		}
		let mut special = vec![false; size];
		for token in &json.added_tokens {
			sources[token.id as usize] = Some((&token.content, false));
			special[token.id as usize] = token.special;
		}
		let mut token_bytes = TokenBytes::default();
		token_bytes
			.bytes
			.reserve(sources.iter().flatten().map(|(text, _)| text.len()).sum());
		token_bytes.ends.reserve(size);
		for source in sources {
			match source {
				Some((text, true)) if text.chars().all(|c| char_to_byte.contains_key(&c)) => {
					token_bytes.push(text.chars().map(|c| char_to_byte[&c]));
				},
				// Added tokens also live in the vocab under their literal text.
				Some((text, _)) => token_bytes.push(text.bytes()),
				None => token_bytes.push([]),
			}
		}
		let token_bytes = Arc::new(token_bytes);

		let mut byte_ids = [None; 256];
		for (byte, c) in chars.iter().enumerate() {
			let mut buf = [0u8; char::MAX_LEN_UTF8];
			byte_ids[byte] = model.vocab.get(&*c.encode_utf8(&mut buf)).copied();
		}
		ensure!(byte_ids.iter().flatten().count() >= 128, "vocab is not byte-level");

		let mut merges = HashMap::with_capacity(model.merges.len());
		for (rank, merge) in model.merges.iter().enumerate() {
			let (left, right) = match merge {
				MergeJson::Joined(joined) => joined.split_once(' ').context("malformed merge")?,
				MergeJson::Pair([left, right]) => (left.as_str(), right.as_str()),
			};
			let id = |text: &str| model.vocab.get(text).copied();
			let (Some(l), Some(r), Some(merged)) =
				(id(left), id(right), id(&format!("{left}{right}")))
			else {
				bail!("merge {left:?} {right:?} references unknown tokens");
			};
			merges.entry((l, r)).or_insert((rank as u32, merged));
		}

		Ok(Self { byte_ids, merges, token_bytes, special })
	}

	/// Text of token `id` for prefix matching: `None` for special tokens and
	/// tokens that are not valid UTF-8 on their own (partial characters).
	pub fn token_text(&self, id: u32) -> Option<&str> {
		let index = id as usize;
		if self.special.get(index).copied().unwrap_or(true) {
			return None;
		}
		let text = std::str::from_utf8(self.token_bytes.get(id)).ok()?;
		(!text.is_empty() && !text.contains('\u{FFFD}')).then_some(text)
	}

	/// The token byte arena, for sharing with the search index.
	pub fn token_bytes(&self) -> Arc<TokenBytes> {
		Arc::clone(&self.token_bytes)
	}

	/// Tokenize `text` (no special tokens are added or matched).
	pub fn encode(&self, text: &str) -> Encoding {
		let mut out = Encoding::default();
		for (start, end) in pre_tokenize(text) {
			self.bpe(text.as_bytes(), start, end, &mut out);
		}
		out
	}

	/// Merge the bytes of one pre-token by merge rank (lowest first, leftmost
	/// on ties) and append the tokens with their byte spans.
	fn bpe(&self, bytes: &[u8], start: usize, end: usize, out: &mut Encoding) {
		// (id, start, end) per symbol.
		let mut symbols: Vec<(u32, usize, usize)> = (start..end)
			.filter_map(|at| self.byte_ids[usize::from(bytes[at])].map(|id| (id, at, at + 1)))
			.collect();
		loop {
			let best = symbols
				.array_windows()
				.enumerate()
				.filter_map(|(i, &[(left, ..), (right, ..)])| {
					self
						.merges
						.get(&(left, right))
						.map(|&(rank, id)| (rank, i, id))
				})
				.min_by_key(|&(rank, i, _)| (rank, i));
			let Some((_, i, id)) = best else { break };
			symbols[i] = (id, symbols[i].1, symbols[i + 1].2);
			symbols.remove(i + 1);
		}
		for (id, from, to) in symbols {
			out.ids.push(id);
			out.offsets.push((from, to));
		}
	}
}

#[cfg(test)]
pub(super) mod tests {
	use super::*;

	/// Byte alphabet plus a few merges: enough to exercise pre-tokenization
	/// and merge order without the real vocabulary.
	pub(in super::super) fn tiny() -> Tokenizer {
		let chars = byte_chars();
		let mut vocab: Vec<String> = vec!["<|endoftext|>".into()];
		vocab.extend(chars.iter().map(|c| c.to_string()));
		let merges = [("Ġ", "d"), ("e", "p"), ("Ġd", "ep"), ("l", "o"), ("lo", "y")];
		for (left, right) in merges {
			vocab.push(format!("{left}{right}"));
		}
		let json = serde_json::json!({
			"normalizer": null,
			"pre_tokenizer": {"type": "Sequence", "pretokenizers": [
				{"type": "Digits", "individual_digits": true},
				{"type": "ByteLevel", "add_prefix_space": false, "trim_offsets": true, "use_regex": true},
			]},
			"decoder": {"type": "ByteLevel"},
			"added_tokens": [{"id": 0, "content": "<|endoftext|>", "special": true}],
			"model": {
				"type": "BPE",
				"vocab": vocab.iter().enumerate().map(|(i, t)| (t.clone(), i)).collect::<HashMap<_, _>>(),
				"merges": merges.iter().map(|(l, r)| format!("{l} {r}")).collect::<Vec<_>>(),
			},
		});
		Tokenizer::from_bytes(json.to_string().as_bytes()).expect("tiny tokenizer")
	}

	fn pieces(tok: &Tokenizer, text: &str) -> Vec<String> {
		let enc = tok.encode(text);
		enc.offsets
			.iter()
			.map(|&(s, e)| text[s..e].to_owned())
			.collect()
	}

	#[test]
	fn merges_follow_rank_and_offsets_cover_text() {
		let tok = tiny();
		assert_eq!(pieces(&tok, "a deploy"), ["a", " dep", "loy"]);
		let enc = tok.encode("a deploy");
		assert_eq!(tok.token_text(enc.ids[1]), Some(" dep"));
	}

	#[test]
	fn whitespace_lookahead_and_digits() {
		let pre = |text: &str| -> Vec<String> {
			pre_tokenize(text)
				.into_iter()
				.map(|(s, e)| text[s..e].to_owned())
				.collect()
		};
		// The last space of a run joins the next word; trailing runs stay whole.
		assert_eq!(pre("a  b  "), ["a", " ", " b", "  "]);
		assert_eq!(pre("a\n\nb"), ["a", "\n", "\n", "b"], "a newline never prefixes a word");
		// Every digit is its own pre-token.
		assert_eq!(pre("v12 x"), ["v", "1", "2", " x"]);
		assert_eq!(pre("it's"), ["it", "'s"]);
	}

	#[test]
	fn special_tokens_are_plain_text_and_have_no_text() {
		let tok = tiny();
		assert!(!tok.encode("<|endoftext|>").ids.contains(&0));
		assert_eq!(tok.token_text(0), None);
	}
}
