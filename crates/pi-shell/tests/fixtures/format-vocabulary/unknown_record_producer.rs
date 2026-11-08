//! Run this integration-test producer against unmodified stack base f4472073a8.
//! UNKNOWN_FIXTURE_OUT selects its output directory. Original independent
//! images remain unchanged; only their now-known Misc ordinals are retargeted.

use std::{path::PathBuf, process::Command};

use pi_shell::bash::{
	Engine, MemStore, StateStore,
	store::{BlobSlot, Change, Key, Record},
};

fn retarget(source: &[u8], ids: &[(u32, u32)]) -> (MemStore, Vec<Vec<u8>>) {
	let mut store = MemStore::from_bytes(source).unwrap();
	let frames = store.get_blob(BlobSlot::Frames).unwrap();
	let mut records = Vec::new();
	for &(old, new) in ids {
		let record: Record = store
			.get(Key::UnknownMisc(old))
			.unwrap()
			.cloned()
			.expect("the independent base must still read the original key as unknown");
		assert!(store.get(Key::UnknownMisc(new)).unwrap().is_none());
		store.apply(Change::Del(Key::UnknownMisc(old))).unwrap();
		store
			.apply(Change::Put(Key::UnknownMisc(new), record.clone()))
			.unwrap();
		records.push(postcard::to_stdvec(&(Key::UnknownMisc(new).to_buf(), &record)).unwrap());
	}
	assert_eq!(store.get_blob(BlobSlot::Frames).unwrap(), frames, "never rewrite frame bytes");
	(store, records)
}

#[test]
fn produce_unknown_record_fixtures() {
	let revision = Command::new("git")
		.args(["rev-parse", "HEAD"])
		.output()
		.unwrap();
	assert!(revision.status.success());
	let revision = String::from_utf8(revision.stdout).unwrap();
	assert_eq!(revision.trim(), "f4472073a8aa8a82d5603fb4cc9605418e11edf6");
	assert_eq!(env!("CARGO_PKG_VERSION"), "18.18.0");
	println!("writer={}; build_id={:?}; remap=74:127,75:126", revision.trim(), Engine::build_id());
	let out = PathBuf::from(std::env::var_os("UNKNOWN_FIXTURE_OUT").unwrap());
	std::fs::create_dir_all(&out).unwrap();
	for (name, source) in [
		("unknown-root-kept", include_bytes!("18.18/unknown-root-kept.image").as_slice()),
		("unknown-subshell-kept", include_bytes!("18.18/unknown-subshell-kept.image").as_slice()),
	] {
		let (store, records) = retarget(source, &[(74, 127)]);
		assert_eq!(records.len(), 1);
		std::fs::write(out.join(format!("{name}.image")), store.to_bytes()).unwrap();
		std::fs::write(out.join(format!("{name}.record")), &records[0]).unwrap();
	}
	for (name, source, ids) in [
		(
			"frameless-unknown-root",
			include_bytes!("frameless-bg-pids.image").as_slice(),
			&[(74, 127)][..],
		),
		(
			"frameless-two-unknown-roots",
			include_bytes!("frameless-root-marks.image").as_slice(),
			&[(74, 127), (75, 126)][..],
		),
	] {
		let (mut store, _) = retarget(source, ids);
		assert!(store.get_blob(BlobSlot::Frames).unwrap().is_none());
		std::fs::write(out.join(format!("{name}.image")), store.to_bytes()).unwrap();
	}
}
