use pi_shell::bash::{Engine, MemStore, StateStore, store::BlobSlot};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Identity {
	Same,
	Different,
}

// The 18.16.0 pair was written by unmodified upstream main
// b0b02d1120976535f466b282739c25775f991830; the 18.17.0 pair by unmodified
// upstream main 251a2fab8e77618892665e883f8cc8455303bee0. Both use frames v29.
// Engine::build_id hashes the crate version: each release bump needs a new
// upstream-written pair. Keep existing bytes unchanged for their red controls.
// Select only by the identity actually stored in an image; never rewrite it.
pub fn store(parent_wait: bool, identity: Identity) -> MemStore {
	let images: [&[u8]; 2] = if parent_wait {
		[
			include_bytes!("../fixtures/frames/upstream-v29-18.17-parent-wait.image"),
			include_bytes!("../fixtures/frames/upstream-v29-parent-wait.image"),
		]
	} else {
		[
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
