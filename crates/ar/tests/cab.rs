//! Microsoft Cabinet indexing, compression, checksum, and rejection contracts.

mod support;

use omp_ar::{Archive, Error, Format, Limits};
use omp_core::encoding::hex;
use sha2::{Digest, Sha256};
use support::fixtures::fixture_bytes;

const MSZIP_HASH: &str = "6a2d9536b995c42a9b9daa2c2eaabf9a1e13e594669a420f8d3e66150af33cff";
const LZX_HASH: &str = "e978598104671296857e0543f4280f4d4e0506dd3cad5162e9f2a4f604fafc78";
const E8_HASH: &str = "ea4ff46bad2ca4bea457b9a5cabbbc353f9446b7b40f83f15fd6fab262192d52";
const RESERVED_HASH: &str = "356fccab233a844365ec431e6208ca69cf7a57884f32a5f5f831124102f4fb84";

#[test]
fn indexes_and_extracts_uncompressed_and_mszip_folders() {
	for fixture in ["cab-none.cab", "cab-mszip.cab"] {
		let bytes = fixture_bytes(fixture);
		assert_eq!(Format::sniff(&bytes), Some(Format::Cab));
		let mut archive = Archive::from_bytes_with_format(&bytes, Format::Cab).unwrap();
		let files: Vec<_> = archive
			.entries()
			.filter(|entry| !entry.is_directory())
			.map(|entry| (entry.path().to_owned(), entry.size()))
			.collect();
		if fixture == "cab-none.cab" {
			assert_eq!(files, [
				("aa/evil.txt".to_owned(), 23),
				("nested/hello.txt".to_owned(), 60_023),
				("root.txt".to_owned(), 17),
			]);
		} else {
			assert_eq!(files, [("nested/hello.txt".to_owned(), 60_023), ("root.txt".to_owned(), 17),]);
		}
		let root = archive
			.entries()
			.find(|entry| entry.path() == "root.txt")
			.unwrap();
		assert_eq!(root.mode(), Some(0o100_644));
		assert!(root.modified_unix_seconds().is_some());
		assert_eq!(archive.read("root.txt").unwrap(), b"CAB root payload\n");
		let expected = format!("nested cabinet payload\n{}", "history-window-line\n".repeat(3000));
		assert_eq!(archive.read("nested/hello.txt").unwrap(), expected.as_bytes());
	}
}

#[test]
fn extracts_reference_mszip_and_lzx_and_defers_quantum_error() {
	let bytes = fixture_bytes("cab-mixed-reference.cab");
	let mut archive = Archive::from_bytes_with_format(&bytes, Format::Cab).unwrap();
	let files: Vec<_> = archive
		.entries()
		.filter(|entry| !entry.is_directory())
		.map(|entry| (entry.path(), entry.size()))
		.collect();
	assert_eq!(files, [("lzx.txt", 187), ("mszip.txt", 57), ("qtm.txt", 59)]);
	assert_eq!(sha256(&archive.read("mszip.txt").unwrap()), MSZIP_HASH);
	assert_eq!(sha256(&archive.read("lzx.txt").unwrap()), LZX_HASH);
	assert!(matches!(archive.read("qtm.txt"), Err(Error::UnsupportedCabQuantum { level: 18 })));
}

#[test]
fn decodes_lzx_uncompressed_blocks_and_e8_translation() {
	let bytes = fixture_bytes("cab-lzx-e8.cab");
	let mut archive = Archive::from_bytes_with_format(&bytes, Format::Cab).unwrap();
	let extracted = archive.read("e8.bin").unwrap();
	assert_eq!(sha256(&extracted), E8_HASH);
	assert_eq!(&extracted[5..10], &[0xe8, 15, 0, 0, 0]);
}

#[test]
fn skips_reserve_areas_and_verifies_reserved_block_checksum() {
	let bytes = fixture_bytes("cab-reserved.cab");
	let mut archive = Archive::from_bytes_with_format(&bytes, Format::Cab).unwrap();
	let files: Vec<_> = archive
		.entries()
		.filter(|entry| !entry.is_directory())
		.map(|entry| entry.path())
		.collect();
	assert_eq!(files, ["reserved.txt"]);
	assert_eq!(sha256(&archive.read("reserved.txt").unwrap()), RESERVED_HASH);
}

#[test]
fn decodes_utf8_names_maps_directory_modes_and_drops_escaping_paths() {
	let mut utf8 = fixture_bytes("cab-reserved.cab");
	let file_offset = le_u32(&utf8, 16) as usize;
	let encoded = "résumé.txt".as_bytes();
	assert_eq!(encoded.len(), "reserved.txt".len());
	utf8[file_offset + 16..file_offset + 16 + encoded.len()].copy_from_slice(encoded);
	utf8[file_offset + 14] |= 0x80;
	let archive = Archive::from_bytes_with_format(&utf8, Format::Cab).unwrap();
	assert!(archive.entries().any(|entry| entry.path() == "résumé.txt"));

	let mut directory = fixture_bytes("cab-reserved.cab");
	let file_offset = le_u32(&directory, 16) as usize;
	directory[file_offset..file_offset + 4].fill(0);
	directory[file_offset + 14] |= 0x10;
	let archive = Archive::from_bytes_with_format(&directory, Format::Cab).unwrap();
	let entry = archive
		.entries()
		.find(|entry| entry.path() == "reserved.txt")
		.unwrap();
	assert!(entry.is_directory());
	assert_eq!(entry.size(), 0);
	assert_eq!(entry.mode(), Some(0o040_755));

	let mut escaping = fixture_bytes("cab-none.cab");
	let offset = find_ascii(&escaping, b"aa\\evil.txt").unwrap();
	escaping[offset..offset + 11].copy_from_slice(b"..\\evil.txt");
	let archive = Archive::from_bytes_with_format(&escaping, Format::Cab).unwrap();
	assert!(
		!archive
			.entries()
			.any(|entry| matches!(entry.path(), "aa/evil.txt" | "evil.txt"))
	);
}

#[test]
fn rejects_truncation_multicab_checksum_damage_and_bad_mszip_framing() {
	let mut truncated = fixture_bytes("cab-none.cab");
	truncated.pop();
	assert!(matches!(
		Archive::from_bytes_with_format(&truncated, Format::Cab),
		Err(Error::InvalidArchive(_) | Error::Io(_))
	));

	let mut multi = fixture_bytes("cab-none.cab");
	multi[30] |= 1;
	assert!(matches!(
		Archive::from_bytes_with_format(&multi, Format::Cab),
		Err(Error::UnsupportedFeature("multi-volume CAB archive"))
	));

	let mut corrupt = fixture_bytes("cab-none.cab");
	*corrupt.last_mut().unwrap() ^= 0xff;
	assert!(matches!(
		Archive::from_bytes_with_format(&corrupt, Format::Cab),
		Err(Error::InvalidArchive("CAB CFDATA block checksum mismatch"))
	));

	let mut mszip = fixture_bytes("cab-mszip.cab");
	let data_start = le_u32(&mszip, 36) as usize;
	mszip[data_start..data_start + 4].fill(0);
	mszip[data_start + 8] = 0;
	assert!(matches!(
		Archive::from_bytes_with_format(&mszip, Format::Cab),
		Err(Error::InvalidArchive("CAB MSZIP block is missing its CK signature"))
	));
}

#[test]
fn rejects_unsupported_parameters_and_resource_limit_overruns() {
	let mut quantum = fixture_bytes("cab-none.cab");
	quantum[42] = 2;
	quantum[43] = 18;
	let mut archive = Archive::from_bytes_with_format(&quantum, Format::Cab).unwrap();
	assert!(matches!(archive.read("root.txt"), Err(Error::UnsupportedCabQuantum { level: 18 })));

	let fixture = fixture_bytes("cab-none.cab");
	for (limits, expected) in [
		(Limits::DEFAULT.with_max_index_size(64), "index"),
		(Limits::DEFAULT.with_max_entries(2), "entries"),
		(Limits::DEFAULT.with_max_member_size(16), "member"),
		(Limits::DEFAULT.with_max_path_size(7), "path"),
		(Limits::DEFAULT.with_max_in_memory_size(32 * 1024), "memory"),
	] {
		let result = Archive::from_bytes_with_format_and_limits(&fixture, Format::Cab, limits);
		let matches = match (expected, result) {
			("index", Err(Error::IndexTooLarge { .. }))
			| ("entries", Err(Error::TooManyEntries { .. }))
			| ("member", Err(Error::MemberTooLarge { .. }))
			| ("path", Err(Error::PathTooLong { .. }))
			| ("memory", Err(Error::ArchiveTooLargeInMemory { .. })) => true,
			_ => false,
		};
		assert!(matches, "CAB did not enforce {expected} limit");
	}
}

fn sha256(bytes: &[u8]) -> String {
	hex::encode(Sha256::digest(bytes).as_slice()).into_string()
}

fn le_u32(bytes: &[u8], offset: usize) -> u32 {
	u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

fn find_ascii(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack
		.windows(needle.len())
		.position(|candidate| candidate == needle)
}
