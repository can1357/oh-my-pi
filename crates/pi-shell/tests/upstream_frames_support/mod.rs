use pi_shell::bash::{Engine, MemStore, StateStore, store::BlobSlot};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Identity {
	Same,
	Different,
}

// Current-identity pairs come from unmodified upstream product code. Every
// release or core-version bump needs a new pair; retain original generations
// unchanged as old-IR/build refusal controls. The foreign v30 pair is produced
// from the same upstream tree with only its crate version changed, so it
// isolates build identity without also changing the IR or core version.
// Provenance and writer sources accompany the v30 generation. Never relabel
// image headers.
pub fn store(parent_wait: bool, identity: Identity) -> MemStore {
	let images: [&[u8]; 9] = if parent_wait {
		[
			include_bytes!("../fixtures/frames/upstream-v30-18.18.7-parent-wait.image"),
			include_bytes!("../fixtures/frames/foreign-v30-18.18.7-parent-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v30-18.18.2-parent-wait.image"),
			include_bytes!("../fixtures/frames/foreign-v30-18.18.2-parent-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v30-18.18.1-parent-wait.image"),
			include_bytes!("../fixtures/frames/foreign-v30-18.18.1-parent-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-18.18-parent-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-18.17-parent-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-parent-wait.image"),
		]
	} else {
		[
			include_bytes!("../fixtures/frames/upstream-v30-18.18.7-no-wait.image"),
			include_bytes!("../fixtures/frames/foreign-v30-18.18.7-no-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v30-18.18.2-no-wait.image"),
			include_bytes!("../fixtures/frames/foreign-v30-18.18.2-no-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v30-18.18.1-no-wait.image"),
			include_bytes!("../fixtures/frames/foreign-v30-18.18.1-no-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-18.18-no-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-18.17-no-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-no-wait.image"),
		]
	};
	let current = Engine::build_id();
	for image in images {
		let mut store = MemStore::from_bytes(image).expect("upstream store image");
		let blob = store
			.get_blob(BlobSlot::Frames)
			.unwrap()
			.expect("upstream frames blob");
		let ((_, _, _, stored), _) =
			postcard::take_from_bytes::<([u8; 4], u32, u32, [u8; 32])>(&blob).unwrap();
		let stored_identity = if stored == current {
			Identity::Same
		} else {
			Identity::Different
		};
		if stored_identity == identity {
			println!("upstream fixture identity: {stored:?}; current: {current:?}");
			return store;
		}
	}
	panic!("no {identity:?} upstream fixture for current engine identity {current:?}");
}
