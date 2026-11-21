use crate::utok::bpe::{PieceMemo, RankTable};

#[test]
fn parses_empty_slots_duplicate_entries_and_short_long_boundaries() {
	let mut tokens: Vec<Vec<u8>> = (0..=255).map(|byte| vec![byte]).collect();
	tokens.extend((0..=255).map(|byte| vec![b'a', byte]));
	tokens.extend((0..=255).map(|byte| vec![byte; 16]));
	tokens.push(vec![b'z'; 15]);
	tokens.push(vec![b'z'; 128]);
	tokens.resize(tokens.len() + 4096, Vec::new());
	tokens.push(b"abc".to_vec());
	tokens.push(b"abc".to_vec());

	let compressed = encode_tokens(&tokens);
	let table = RankTable::parse(&compressed);

	for (rank, token) in tokens.iter().enumerate().take(tokens.len() - 1) {
		if !token.is_empty() && token != b"abc" {
			assert_eq!(table.rank(token), Some(u32::try_from(rank).unwrap()));
		}
	}
	let abc_rank = u32::try_from(tokens.len() - 1).unwrap();
	assert_eq!(table.rank(b"abc"), Some(abc_rank));
	assert_eq!(table.rank(b""), None);
	assert_eq!(table.rank(b"acb"), None);
	assert_eq!(table.max_token_len, 128);
	let mut encoded = Vec::new();
	table.encode_piece(b"abca", &mut encoded);
	assert_eq!(encoded, [abc_rank, u32::from(b'a')]);
	assert_eq!(PieceMemo::with(|memo| table.count_piece(b"abca", memo)), 2);
}

/// The per-thread piece memo is shared by every table a thread counts with
/// (o200k and Jev's base table merge the same pieces): one table's count
/// must never answer for another's.
#[test]
fn piece_memo_keeps_tables_apart() {
	let bytes: Vec<Vec<u8>> = (0..=255).map(|byte| vec![byte]).collect();
	let mut with_ab = bytes.clone();
	with_ab.push(b"ab".to_vec());
	let merges = RankTable::parse(&encode_tokens(&with_ab));
	let bytes_only = RankTable::parse(&encode_tokens(&bytes));

	PieceMemo::with(|memo| {
		for _ in 0..2 {
			assert_eq!(merges.count_piece(b"abab", memo), 2);
			assert_eq!(bytes_only.count_piece(b"abab", memo), 4);
			assert_eq!(merges.count_merged(b"ab", memo), 1);
			assert_eq!(bytes_only.count_merged(b"ab", memo), 2);
		}
	});
}

fn encode_tokens(tokens: &[Vec<u8>]) -> Vec<u8> {
	let mut raw = b"UTOK1\n".to_vec();
	raw.extend(u32::try_from(tokens.len()).unwrap().to_le_bytes());
	for token in tokens {
		let mut len = token.len();
		while len >= 0x80 {
			raw.push((len as u8 & 0x7f) | 0x80);
			len >>= 7;
		}
		raw.push(len as u8);
		raw.extend(token);
	}
	zstd::encode_all(raw.as_slice(), 0).unwrap()
}
