use std::{hint::black_box, time::Instant};

use omp_core::Hash32;
fn main() {
	let buffer = vec![0x5au8; 16 * 1024 * 1024];
	let started = Instant::now();
	let mut hasher = Hash32::hasher();
	let chunked = std::env::args().any(|arg| arg == "--chunked");
	for _ in 0..4 {
		if chunked {
			for chunk in buffer.chunks(64 * 1024) {
				hasher.update(black_box(chunk));
			}
		} else {
			hasher.update(black_box(&buffer));
		}
	}
	let digest = hasher.finalize();
	println!(
		"bytes=67108864 chunked={chunked} elapsed_seconds={:.9} digest={:?}",
		started.elapsed().as_secs_f64(),
		black_box(digest)
	);
}
