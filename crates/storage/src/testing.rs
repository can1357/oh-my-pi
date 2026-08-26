//! Shared conformance assertions for storage adapters.

use std::fmt::Display;

use crate::backend::ByteJournalStore;

const FIRST: &[u8] = b"v4\n";
const SECOND: &[u8] = b"ok\n";

/// Asserts one byte-journal store satisfies the append-only contract.
///
/// Covers append ordering with resulting byte lengths, exact byte round-trip,
/// and rollback via [`ByteJournalStore::truncate`] to an earlier length
/// snapshot.
pub fn assert_byte_journal_contract<S: ByteJournalStore>(mut store: S) {
	let watermark = expect(store.append(FIRST), "append first byte group");
	assert_eq!(watermark, FIRST.len() as u64, "append returns resulting byte length");

	let after = expect(store.append(SECOND), "append second byte group");
	assert_eq!(
		after,
		(FIRST.len() + SECOND.len()) as u64,
		"append ordering advances the resulting length"
	);
	assert_eq!(
		expect(store.read(0, after as usize), "read ordered bytes"),
		[FIRST, SECOND].concat(),
		"exact byte round-trip"
	);

	expect(store.truncate(watermark), "rollback to earlier length snapshot");
	assert_eq!(
		expect(store.len(), "length after rollback"),
		watermark,
		"rollback restores the earlier length"
	);
	assert_eq!(
		expect(store.read(0, after as usize), "read after rollback"),
		FIRST,
		"rollback drops bytes after the snapshot"
	);
}

fn expect<T, E: Display>(result: Result<T, E>, operation: &str) -> T {
	result.unwrap_or_else(|error| panic!("{operation} failed: {error}"))
}
