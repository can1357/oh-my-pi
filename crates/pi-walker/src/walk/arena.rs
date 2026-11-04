//! Append-only byte arena that walk paths are carved from.
//!
//! Chunks never move or shrink once allocated, so a [`Bytes`] handle stays
//! valid for as long as the arena that produced it, even while the arena
//! keeps growing on another thread or has been moved into a
//! [`super::Collection`]. The one exception is [`Arena::release`]: the walk
//! gives back the path it carved last when it keeps nothing of it, so the
//! arena holds the paths the walk returns and those of the directories it
//! enters, not one per entry it has seen.

use std::{mem::MaybeUninit, ptr::NonNull};

/// Size of a fresh chunk; longer paths get a chunk of their own.
const CHUNK: usize = 32 << 10;

/// A byte string stored in an [`Arena`].
#[derive(Clone, Copy, Debug)]
pub(crate) struct Bytes {
	ptr: NonNull<u8>,
	len: usize,
}

// SAFETY: `Bytes` is a shared view of immutable arena bytes; the arena keeps
// them alive and never writes them again.
unsafe impl Send for Bytes {}
// SAFETY: as above, the bytes are immutable once written.
unsafe impl Sync for Bytes {}

impl Bytes {
	/// The empty string (the walk root's relative path).
	pub(crate) const EMPTY: Self = Self { ptr: NonNull::dangling(), len: 0 };

	/// The bytes. Chunks never move, so only the arena's lifetime matters.
	///
	/// # Safety
	/// The arena that produced `self` must outlive `'a`.
	pub(crate) const unsafe fn get<'a>(self) -> &'a [u8] {
		// SAFETY: the bytes were initialised by `Arena::push` and stay
		// allocated and unmodified while the arena lives (caller contract).
		unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
	}

	/// The last `n` bytes (`n <= len`).
	pub(crate) const fn tail(self, n: usize) -> Self {
		assert!(n <= self.len);
		// SAFETY: `len - n <= len`, so the pointer stays inside (or one past)
		// the stored bytes.
		Self { ptr: unsafe { self.ptr.add(self.len - n) }, len: n }
	}
}

struct Chunk {
	ptr: NonNull<MaybeUninit<u8>>,
	cap: usize,
}

// SAFETY: a chunk exclusively owns its allocation, like the `Box` it came from.
unsafe impl Send for Chunk {}
// SAFETY: `&Chunk` exposes no way to write the allocation.
unsafe impl Sync for Chunk {}

impl Chunk {
	fn new(cap: usize) -> Self {
		let boxed: Box<[MaybeUninit<u8>]> = Box::new_uninit_slice(cap);
		Self { ptr: Box::into_non_null(boxed).cast::<MaybeUninit<u8>>(), cap }
	}
}

impl Drop for Chunk {
	fn drop(&mut self) {
		let slice = NonNull::slice_from_raw_parts(self.ptr, self.cap);
		// SAFETY: `ptr`/`cap` came from `Box::into_non_null` of a slice of this
		// length in `Chunk::new`, and are released exactly once.
		drop(unsafe { Box::from_non_null(slice) });
	}
}

/// Append-only storage for path bytes; see the module docs.
#[derive(Default)]
pub(crate) struct Arena {
	chunks: Vec<Chunk>,
	/// Bytes used in the last chunk.
	used:   usize,
}

impl std::fmt::Debug for Arena {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Arena")
			.field("chunks", &self.chunks.len())
			.finish()
	}
}

impl Arena {
	/// Stores the concatenation of `parts`.
	pub(crate) fn push(&mut self, parts: &[&[u8]]) -> Bytes {
		let len: usize = parts.iter().map(|part| part.len()).sum();
		if len == 0 {
			return Bytes::EMPTY;
		}
		let chunk = match self.chunks.last() {
			Some(chunk) if chunk.cap - self.used >= len => chunk,
			_ => {
				let chunk = self.chunks.push_mut(Chunk::new(CHUNK.max(len)));
				self.used = 0;
				&*chunk
			},
		};
		// SAFETY: `used + len <= cap`, so the range lies inside the chunk.
		let start = unsafe { chunk.ptr.add(self.used) }.cast::<u8>();
		let mut at = start.as_ptr();
		for part in parts {
			// SAFETY: `at` stays within the reserved `len` bytes; the source
			// is a distinct borrowed slice, so the ranges do not overlap.
			unsafe {
				std::ptr::copy_nonoverlapping(part.as_ptr(), at, part.len());
				at = at.add(part.len());
			}
		}
		self.used += len;
		Bytes { ptr: start, len }
	}

	/// Gives back the bytes of the latest [`Self::push`] when nothing kept
	/// them; the next push reuses the space. A handle that is not the latest
	/// push is left in place. The caller must not read `bytes` afterwards.
	pub(crate) fn release(&mut self, bytes: Bytes) {
		let Some(chunk) = self.chunks.last() else {
			return;
		};
		// SAFETY: `used <= cap`, so this is inside or one past the chunk.
		let end = unsafe { chunk.ptr.add(self.used) }.cast::<u8>();
		// SAFETY: `bytes` came from a push, so its end is inside or one past
		// the chunk that holds it.
		if bytes.len > 0 && unsafe { bytes.ptr.add(bytes.len) } == end {
			self.used -= bytes.len;
		}
	}

	/// Bytes of chunks allocated, used or not.
	#[cfg(test)]
	pub(crate) fn held(&self) -> usize {
		self.chunks.iter().map(|chunk| chunk.cap).sum()
	}
}

#[cfg(test)]
mod tests {
	use super::Arena;

	/// Only the latest push is given back: releasing an older handle leaves
	/// it and every later path intact, and the next push reuses released
	/// space.
	#[test]
	fn release_rewinds_only_the_latest_push() {
		let mut arena = Arena::default();
		let first = arena.push(&[b"first"]);
		let second = arena.push(&[b"sec", b"ond"]);
		arena.release(first);
		let third = arena.push(&[b"third"]);
		// SAFETY: `arena` outlives every read below.
		unsafe {
			assert_eq!(first.get(), b"first");
			assert_eq!(second.get(), b"second");
			assert_eq!(third.get(), b"third");
		}
		arena.release(third);
		let fourth = arena.push(&[b"4th"]);
		assert_eq!(fourth.ptr, third.ptr, "the released bytes are reused");
		// SAFETY: as above.
		unsafe {
			assert_eq!(second.get(), b"second");
			assert_eq!(fourth.get(), b"4th");
		}
	}
}
