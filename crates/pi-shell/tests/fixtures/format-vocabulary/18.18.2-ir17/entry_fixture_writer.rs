use std::{borrow::Cow, path::{Path, PathBuf}};

use pi_shell::bash::{
	Engine, MemStore, RunId, StateStore, Vpid,
	store::{BlobSlot, Change, KeyBuf, Record, Table},
};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
struct Header {
	magic: [u8; 4],
	ir: u32,
	frames: u32,
	build: [u8; 32],
	runs: Vec<RunId>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Entry {
	id: u32,
	revision: u32,
	required: bool,
	vpid: Option<Vpid>,
	payload: Vec<u8>,
}

#[derive(Serialize)]
struct Envelope<'a> {
	core: &'a [u8],
	entries: Cow<'a, [Entry]>,
}

fn wrap(core_store: &[u8], old_image: &[u8], id: u32, required: bool) -> (Vec<u8>, Vec<Entry>) {
	let mut store = MemStore::from_bytes(core_store).unwrap();
	let bytes = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let (mut header, core) = postcard::take_from_bytes::<Header>(&bytes).unwrap();
	assert_eq!(header.magic, *b"OBF1");
	assert_eq!((header.ir, header.frames), (17, 30));
	assert_eq!(header.build, Engine::build_id());
	let mut old = MemStore::from_bytes(old_image).unwrap();
	let old_bytes = old.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let (old_header, old_body) = postcard::take_from_bytes::<Header>(&old_bytes).unwrap();
	assert_eq!(old_header.magic, *b"OBF2");
	assert_eq!((old_header.ir, old_header.frames), (15, 29));
	let (_, entry_wire) = postcard::take_from_bytes::<Vec<u8>>(old_body).unwrap();
	let entries: Vec<Entry> = postcard::from_bytes(entry_wire).unwrap();
	assert_eq!(entries.len(), 1);
	assert_eq!((entries[0].id, entries[0].revision, entries[0].required), (id, 7, required));
	assert_eq!(entries[0].vpid, Some(Vpid(1)));
	assert_eq!(postcard::to_stdvec(&entries).unwrap().as_slice(), entry_wire);
	header.magic = *b"OBF2";
	let mut encoded = postcard::to_stdvec(&header).unwrap();
	encoded.extend_from_slice(&postcard::to_stdvec(&Envelope { core, entries: Cow::Borrowed(&entries) }).unwrap());
	store.put_blob(BlobSlot::Frames, &encoded).unwrap();
	(store.to_bytes(), entries)
}

fn with_unknown_record(core_store: &[u8], record_path: &Path) -> Vec<u8> {
	let record_bytes = std::fs::read(record_path).unwrap();
	let (key, record): (KeyBuf, Record) = postcard::from_bytes(&record_bytes).unwrap();
	assert!(matches!(key, KeyBuf::UnknownMisc(74)));
	let mut store = MemStore::from_bytes(core_store).unwrap();
	store.apply(Change::Put(key.as_key(), record)).unwrap();
	let mut actual = Vec::new();
	store.scan(Table::Misc, &mut |key, record| {
		if matches!(key, pi_shell::bash::store::Key::UnknownMisc(_)) {
			actual.push(postcard::to_stdvec(&(key.to_buf(), record)).unwrap());
		}
	}).unwrap();
	assert_eq!(actual, [record_bytes]);
	store.to_bytes()
}

#[test]
fn write_current_vocabulary_fixtures() {
	let core = PathBuf::from(std::env::var_os("FIXTURE_CORE").expect("FIXTURE_CORE"));
	let old = PathBuf::from(std::env::var_os("FIXTURE_OLD").expect("FIXTURE_OLD"));
	let output = PathBuf::from(std::env::var_os("FIXTURE_OUTPUT").expect("FIXTURE_OUTPUT"));
	std::fs::create_dir_all(&output).unwrap();
	let parent = std::fs::read(core.join("parent-wait.image")).unwrap();
	std::fs::write(output.join("base-parent-wait.image"), &parent).unwrap();
	for (name, original, id, required) in [
		("owned-optional.image", "owned-optional-vocabulary.image", 65_537, false),
		("owned-required.image", "owned-required-vocabulary.image", 65_537, true),
		("reserved-required.image", "owned-reserved-required.image", 1, false),
	] {
		let old_image = std::fs::read(old.join(original)).unwrap();
		let (image, entries) = wrap(&parent, &old_image, id, required);
		std::fs::write(output.join(name), image).unwrap();
		std::fs::write(output.join(format!("{name}.entries.json")), serde_json::to_vec_pretty(&entries).unwrap()).unwrap();
	}
	for kind in ["root", "subshell"] {
		let source = std::fs::read(core.join(format!("{kind}-kept.image"))).unwrap();
		let record_path = old.join(format!("unknown-{kind}-kept.record"));
		let bytes = with_unknown_record(&source, &record_path);
		std::fs::write(output.join(format!("unknown-{kind}-kept.image")), bytes).unwrap();
		std::fs::copy(&record_path, output.join(format!("unknown-{kind}-kept.record"))).unwrap();
	}
}
