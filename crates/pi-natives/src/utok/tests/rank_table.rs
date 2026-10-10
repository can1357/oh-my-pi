use crate::utok::bpe::RankTable;

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
	assert_eq!(table.count_piece(b"abca"), 2);
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
