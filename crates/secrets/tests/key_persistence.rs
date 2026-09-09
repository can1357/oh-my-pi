//! Verifies concurrent key creation converges on one persisted owner-only
//! secret.

use std::{
	sync::{Arc, Barrier},
	thread,
};

#[test]
fn exclusive_key_creators_converge_on_one_owner_only_file() {
	let scratch = tempfile::tempdir().expect("scratch");
	let path = Arc::new(
		scratch
			.path()
			.join(omp_cache::secret_key::PLACEHOLDER_KEY_FILE),
	);
	let barrier = Arc::new(Barrier::new(8));
	let threads: Vec<_> = (0..8)
		.map(|_| {
			let path = Arc::clone(&path);
			let barrier = Arc::clone(&barrier);
			thread::spawn(move || {
				barrier.wait();
				omp_cache::secret_key::load_or_create_at(&path).expect("creator")
			})
		})
		.collect();
	let keys: Vec<_> = threads
		.into_iter()
		.map(|thread| thread.join().expect("creator thread"))
		.collect();
	assert!(keys.iter().all(|key| key == &keys[0]));
	assert_eq!(
		omp_cache::secret_key::read_at(&path)
			.expect("read winner")
			.as_deref(),
		Some(keys[0].as_str())
	);
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		assert_eq!(
			std::fs::metadata(&*path)
				.expect("metadata")
				.permissions()
				.mode() & 0o777,
			0o600
		);
	}
}
