//! Thread-safe append-only vector with exponential bucket growth.
//!
//! `AppendVec<T>` provides lock-free concurrent appends using atomic operations
//! and a segmented bucket allocator. Supports indexed access, slicing, and
//! bidirectional iteration.

use std::{
	alloc::{self, Layout},
	hint,
	iter::{FusedIterator, Iterator},
	mem, ops,
	ops::{Index, IndexMut},
	ptr::{self, NonNull},
	slice,
	sync::atomic::{AtomicPtr, AtomicU64, AtomicUsize, Ordering},
};

use parking_lot_core::{DEFAULT_PARK_TOKEN, DEFAULT_UNPARK_TOKEN};
use smallvec::SmallVec;

/// The number of bits used for the initial bucket size.
const SHIFT: usize = 8;

/// Maximum amount of items that can be stored in the vector in log2.
const MAX_LOG2: usize = 39;

/// A specialized bucket array optimized for append-only operations.
///
/// The bucket array uses a power-of-two growth strategy where each bucket is
/// twice the size of the previous one, providing amortized O(1) append
/// performance.
#[derive(Debug)]
struct BucketArray<T> {
	/// Array of atomic pointers to allocated buckets.
	ptrs:   [AtomicPtr<T>; MAX_LOG2 - 1 - SHIFT],
	oplock: AtomicU64,
}

// SAFETY: BucketArray can be Send if T is Send. The atomic pointers ensure
// proper synchronization when transferring ownership across threads.
unsafe impl<T: Send> Send for BucketArray<T> {}

// SAFETY: BucketArray can be Sync if T is Send + Sync. All access to the
// bucket pointers is synchronized via atomics, and T needs to be Send + Sync
// for safe concurrent access.
unsafe impl<T: Send + Sync> Sync for BucketArray<T> {}

impl<T> BucketArray<T> {
	/// Creates a new bucket array with the specified number of levels.
	const fn new() -> Self {
		// SAFETY: The array is ptr and u64 are both zero-initialized.
		unsafe { mem::zeroed() }
	}

	/// Creates a new bucket array with the specified number of levels.
	///
	/// # Arguments
	///
	/// * `capacity` - The initial capacity of the bucket array.
	///
	/// # Returns
	///
	/// A new bucket array with the specified number of levels.
	fn with_capacity(capacity: usize) -> Self {
		let buckets = Self::new();
		let (_, max_level) = Self::locate(capacity.saturating_sub(1));
		for level in 0..=max_level {
			let ptr = Self::allocate_bucket(level);
			buckets.ptrs[level as usize].store(ptr, Ordering::Relaxed);
		}
		buckets
	}

	/// Returns the maximum number of elements this bucket array can hold
	/// without reallocating.
	fn total_capacity(&self) -> usize {
		let mut total = 0;
		for (level, _) in self.iter() {
			total += Self::level_size(level as u32);
		}
		total
	}

	/// Returns the maximum capacity of the bucket array.
	fn max_capacity(&self) -> usize {
		let mut total = 0;
		for i in 0..self.ptrs.len() {
			total += Self::level_size(i as u32);
		}
		total
	}

	/// Returns the size of a bucket at the specified level.
	#[inline]
	const fn level_size(level: u32) -> usize {
		(const { 1usize << SHIFT }) << level
	}

	/// Returns the layout for a bucket at the specified level.
	#[inline]
	fn level_layout(level: u32) -> Layout {
		Layout::array::<T>(Self::level_size(level)).expect("bucket size exceeds addressable memory")
	}

	/// Computes the level and offset within that level for a given index.
	#[inline]
	const fn locate(idx: usize) -> (usize, u32) {
		let i = idx + Self::level_size(0);
		let bin = (usize::BITS - 1 - i.leading_zeros()) - (SHIFT as u32);
		let offset = i - Self::level_size(bin);
		(offset, bin)
	}

	/// Notifies all waiting threads. Uses `parking_lot_core` futex wait/wake.
	#[inline]
	fn notify_all(&self, idx: u32) {
		// SAFETY: The address passed to unpark must match the address used for park.
		// We consistently use the address of the AtomicU32.
		let mask = 1 << idx;
		if self.oplock.load(Ordering::Relaxed) & mask == 0 {
			return;
		}
		let prev = self.oplock.fetch_and(!mask, Ordering::Relaxed);
		if prev & mask != 0 {
			// SAFETY: We use the pointer as a futex key for parking_lot_core. The pointer
			// is derived from a valid allocation (self.ptrs) and offset by idx
			// which is < bucket count. The key is only used as an identifier and
			// not dereferenced by parking_lot_core.
			unsafe {
				let key = self.ptrs.as_ptr().add(idx as usize) as usize;
				parking_lot_core::unpark_all(key, DEFAULT_UNPARK_TOKEN);
			}
		}
	}

	/// Waits until the state changes from the provided `state` value.
	/// Uses `parking_lot_core` futex wait/wake.
	#[inline]
	fn wait(&self, idx: u32) {
		self.oplock.fetch_or(1 << idx, Ordering::Relaxed);

		// SAFETY: See safety comment in `notify_all`.
		unsafe {
			let key = self.ptrs.as_ptr().add(idx as usize) as usize;

			// park() checks the condition closure *before* sleeping.
			// It only sleeps if the closure returns true (meaning state hasn't changed).
			let _ = parking_lot_core::park(
				key,
				|| self.ptrs[idx as usize].load(Ordering::Acquire).is_null(), /* Validate: still
				                                                               * needs waiting? */
				|| {},              /* Before sleep
				                     * callback */
				|_, _| {},          // Timed out callback (we don't use timeouts)
				DEFAULT_PARK_TOKEN, // Token passed to unpark
				None,               // No timeout
			);
		}
	}

	/// Ensures that a bucket at the specified level is allocated and returns a
	/// pointer to it.
	#[inline]
	fn ensure_bucket(&self, level: u32, wait: bool) -> *mut T {
		let ptr = self.ptrs[level as usize].load(Ordering::Acquire);
		if !ptr.is_null() {
			return ptr;
		}
		self.try_allocate_bucket(level, wait)
	}

	/// Allocates a new bucket at the specified level.
	///
	/// This is a cold path that should rarely be taken.
	#[cold]
	fn try_allocate_bucket(&self, level: u32, wait: bool) -> *mut T {
		let bucket = &self.ptrs[level as usize];
		if wait {
			for _ in 0..1000 {
				hint::spin_loop();
				let ptr = bucket.load(Ordering::Acquire);
				if !ptr.is_null() {
					return ptr;
				}
			}
			loop {
				self.wait(level);
				let ptr = bucket.load(Ordering::Acquire);
				if !ptr.is_null() {
					return ptr;
				}
			}
		}

		let ptr = Self::allocate_bucket(level);

		// Publish with Release; a failed CAS must Acquire so the loser can safely
		// write through the winner's allocation.
		let result =
			bucket.compare_exchange(ptr::null_mut(), ptr, Ordering::Release, Ordering::Acquire);
		match result {
			Ok(_) => {
				self.notify_all(level);
				ptr
			},
			Err(p) => {
				// Shouldn't really happen unless someone just forcefully allocates
				// at this level, but let's handle it anyway.
				Self::deallocate_bucket(ptr, level);
				p
			},
		}
	}

	fn allocate_bucket(level: u32) -> *mut T {
		let layout = Self::level_layout(level);
		if layout.size() == 0 {
			// ZSTs occupy no storage; a well-aligned dangling pointer is a valid
			// bucket for reads, writes, and drops of zero-sized values.
			return NonNull::dangling().as_ptr();
		}
		// SAFETY: layout is non-zero-sized (checked above) and valid, coming
		// from level_layout. The resulting pointer is checked for null before use.
		let ptr = unsafe { alloc::alloc(layout).cast::<T>() };
		if ptr.is_null() {
			alloc::handle_alloc_error(layout);
		}
		ptr
	}

	fn deallocate_bucket(ptr: *mut T, level: u32) {
		let layout = Self::level_layout(level);
		if layout.size() == 0 {
			return;
		}
		// SAFETY: ptr was allocated with the same non-zero-sized layout via
		// allocate_bucket. The caller ensures the pointer is valid and no longer
		// in use.
		unsafe { alloc::dealloc(ptr.cast::<u8>(), layout) };
	}

	/// Clears all buckets and deallocates memory.
	fn clear(&mut self, mut n_elements: usize) {
		// We need to mut self, as we cannot have any other reference to self as this
		// operation is on going in order to not cause a race. But clippy doesn't
		// know this so let's inform it.
		hint::black_box(&mut *self);

		for (level, bucket) in self.ptrs.iter().enumerate() {
			let ptr = bucket.swap(ptr::null_mut(), Ordering::Relaxed);
			if ptr.is_null() {
				continue;
			}

			let level_size = Self::level_size(level as u32);
			let drop_count = n_elements.min(level_size);
			n_elements = n_elements.saturating_sub(drop_count);

			// SAFETY: We're dropping elements that were properly initialized.
			// We have exclusive access via &mut self, ensuring no concurrent access.
			// The pointer arithmetic is within bounds as drop_count <= level_size.
			// After dropping elements, the bucket is deallocated with the same layout
			// it was allocated with.
			unsafe {
				for i in 0..drop_count {
					ptr.add(i).drop_in_place();
				}

				let layout = Layout::array::<T>(level_size).unwrap();
				if layout.size() != 0 {
					alloc::dealloc(ptr.cast::<u8>(), layout);
				}
			}

			if n_elements == 0 {
				break;
			}
		}
	}

	/// Returns a reference to the bucket at the specified level,
	/// assuming initialization.
	///
	/// # Safety
	/// Caller must ensure the bucket exists and the level is valid.
	#[inline]
	unsafe fn get_bucket_unchecked(&self, level: u32) -> &[T] {
		// SAFETY: The caller guarantees the bucket at this level is allocated
		// and the pointer is non-null. The slice length is exactly the level size,
		// which matches the allocation size.
		unsafe {
			slice::from_raw_parts(
				self.ptrs[level as usize].load(Ordering::Relaxed),
				Self::level_size(level),
			)
		}
	}

	// Returns an iterator over the buckets, ending at the first null bucket.
	const fn iter(&self) -> BucketArrayIter<'_, T> {
		BucketArrayIter { array: &self.ptrs, level: 0 }
	}
}

impl<T> Drop for BucketArray<T> {
	/// Frees any buckets still allocated. Element destructors are the owner's
	/// responsibility: [`AppendVec`] runs them via `clear` (which also nulls
	/// every bucket pointer) before this executes.
	fn drop(&mut self) {
		for (level, bucket) in self.ptrs.iter().enumerate() {
			let ptr = bucket.swap(ptr::null_mut(), Ordering::Relaxed);
			if !ptr.is_null() {
				Self::deallocate_bucket(ptr, level as u32);
			}
		}
	}
}

/// An iterator over the elements of a [`BucketArray`].
///
/// This iterator traverses each bucket in sequence, yielding the level and a
/// pointer to the elements within each bucket. The iteration ends when all
/// initialized elements have been visited.
struct BucketArrayIter<'a, T> {
	array: &'a [AtomicPtr<T>],
	level: usize,
}

impl<T> Iterator for BucketArrayIter<'_, T> {
	type Item = (usize, NonNull<T>);

	fn next(&mut self) -> Option<Self::Item> {
		let level = self.level;
		let ptr = self.array.get(level)?.load(Ordering::Relaxed);
		self.level = level + 1;
		Some((level, NonNull::new(ptr)?))
	}

	fn size_hint(&self) -> (usize, Option<usize>) {
		let n = self.len();
		(n, Some(n))
	}
}

impl<T> FusedIterator for BucketArrayIter<'_, T> {}

impl<T> ExactSizeIterator for BucketArrayIter<'_, T> {
	fn len(&self) -> usize {
		let rem = &self.array[self.level..];
		let mut n = 0;
		for ptr in rem {
			if ptr.load(Ordering::Relaxed).is_null() {
				break;
			}
			n += 1;
		}
		n
	}
}

/// A thread-safe, append-only vector implementation with amortized O(1) push
/// operations.
///
/// This data structure is optimized for concurrent append operations while
/// maintaining strong memory safety guarantees. It uses a series of dynamically
/// allocated buckets that grow exponentially in size to reduce allocation
/// frequency.
#[derive(Debug)]
pub struct AppendVec<T> {
	/// Tracks the number of elements that are safe to access.
	last_safe:  AtomicUsize,
	/// Tracks the next index for insertion.
	next_index: AtomicUsize,
	/// The array of buckets storing the actual elements.
	buckets:    BucketArray<T>,
}

// SAFETY: AppendVec can be Send if T is Send. The atomics ensure proper
// synchronization when transferring ownership across threads.
unsafe impl<T: Send> Send for AppendVec<T> {}

// SAFETY: AppendVec can be Sync if T is Send + Sync. All internal state is
// synchronized via atomics (last_safe, next_index) and the BucketArray is Sync
// when T is Send + Sync.
unsafe impl<T: Send + Sync> Sync for AppendVec<T> {}

impl<T> Default for AppendVec<T> {
	fn default() -> Self {
		Self::new()
	}
}

impl<T: Clone> Clone for AppendVec<T> {
	fn clone(&self) -> Self {
		self.iter().cloned().collect()
	}
}

impl<T> AppendVec<T> {
	/// Creates a new, empty [`AppendVec`].
	pub const fn new() -> Self {
		Self {
			last_safe:  AtomicUsize::new(0),
			next_index: AtomicUsize::new(0),
			buckets:    BucketArray::new(),
		}
	}

	/// Creates a new, empty [`AppendVec`] with a specified capacity.
	///
	/// This method pre-allocates buckets up to the specified capacity,
	/// reducing the number of reallocations as elements are added.
	///
	/// # Arguments
	///
	/// * `capacity` - The initial capacity of the vector.
	///
	/// # Returns
	///
	/// A new [`AppendVec`] with the specified capacity.
	pub fn with_capacity(capacity: usize) -> Self {
		Self {
			last_safe:  AtomicUsize::new(0),
			next_index: AtomicUsize::new(0),
			buckets:    BucketArray::with_capacity(capacity),
		}
	}

	/// Returns the total capacity of the vector before reallocation would be
	/// needed.
	pub fn capacity(&self) -> usize {
		self.buckets.total_capacity()
	}

	/// Returns the maximum capacity of the vector.
	pub fn max_capacity(&self) -> usize {
		self.buckets.max_capacity()
	}

	/// Clears the vector, dropping all elements and deallocating memory.
	pub fn clear(&mut self) {
		let len = self.last_safe.load(Ordering::Relaxed);
		self.buckets.clear(len);
		self.next_index.store(0, Ordering::Release);
		self.last_safe.store(0, Ordering::Release);
	}

	/// Updates the `last_safe` counter after a successful push operation.
	///
	/// This ensures elements are visible only after they are fully initialized.
	#[inline]
	fn bump(&self, expected: usize, desired: usize) {
		loop {
			if self.last_safe.load(Ordering::Acquire) == expected {
				self.last_safe.store(desired, Ordering::Release);
				return;
			}
			hint::spin_loop();
		}
	}

	/// Creates an iterator that yields references to individual elements.
	pub fn iter(&self) -> AppendVecIter<'_, T> {
		AppendVecIter::new(self)
	}

	/// Get a reference to the element at the specified index, if it exists.
	pub fn get(&self, index: usize) -> Option<&T> {
		let len = self.last_safe.load(Ordering::Acquire);
		if index >= len {
			return None;
		}

		// Calculate bucket and offset
		let (offset, level) = BucketArray::<T>::locate(index);

		// SAFETY: The index is valid (index < len) and the element is fully
		// initialized. The pointer is loaded with Acquire ordering to ensure we
		// see the write. Pointer arithmetic is within bounds since offset <
		// level_size.
		unsafe {
			let ptr = self.buckets.ptrs[level as usize].load(Ordering::Acquire);
			if ptr.is_null() {
				return None;
			}

			Some(&*ptr.add(offset))
		}
	}

	/// Get a mutable reference to the element at the specified index, if it
	/// exists.
	pub fn get_mut(&mut self, index: usize) -> Option<&mut T> {
		let len = self.last_safe.load(Ordering::Relaxed);
		if index >= len {
			return None;
		}

		// Calculate bucket and offset
		let (offset, level) = BucketArray::<T>::locate(index);

		let ptr = self.buckets.ptrs[level as usize].load(Ordering::Relaxed);
		if ptr.is_null() {
			return None;
		}

		// SAFETY: We have exclusive mutable access via &mut self. The index is valid
		// (index < len) and the element is initialized. Pointer arithmetic is within
		// bounds.
		Some(unsafe { &mut *ptr.add(offset) })
	}

	/// Returns the number of elements in the vector.
	pub fn len(&self) -> usize {
		self.last_safe.load(Ordering::Acquire)
	}

	/// Checks if the vector is empty.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// Pushes an item to the vector.
	pub fn push(&self, item: T) -> usize {
		// Reserve an index for this item
		let prev = self.next_index.fetch_add(1, Ordering::Relaxed);

		// Determine which bucket and position within that bucket
		let (offset, level) = BucketArray::<T>::locate(prev);

		// Ensure the bucket exists
		let ptr = self.buckets.ensure_bucket(level, offset > 0);

		// SAFETY: We have exclusive access to this memory location because we
		// atomically reserved it via fetch_add. The pointer arithmetic is valid
		// since offset < level_size. The memory is uninitialized and write() is
		// the correct method to initialize it.
		unsafe { ptr.add(offset).write(item) };

		// Make the item visible to other threads
		self.bump(prev, prev + 1);

		prev
	}

	/// Grows the vector to at least `size` elements, initializing new elements
	/// with the provided function.
	///
	/// This method ensures the vector contains at least `size` elements. If the
	/// current length is less than `size`, new elements are initialized by
	/// calling `init` with their index.
	///
	/// # Arguments
	///
	/// * `size` - The minimum size the vector should have
	/// * `init` - A function that produces initial values for new elements,
	///   called with the index of each new element
	///
	/// # Returns
	///
	/// The previous length of the vector before growth
	pub fn grow_with(&self, size: usize, mut init: impl FnMut(usize) -> T) -> usize {
		let prev = self.next_index.fetch_max(size, Ordering::Relaxed);
		if prev < size {
			for i in prev..size {
				let (offset, level) = BucketArray::<T>::locate(i);
				let ptr = self.buckets.ensure_bucket(level, offset > 0);
				// SAFETY: We have exclusive access to indices [prev..size) via fetch_max.
				// Pointer arithmetic is valid since offset < level_size. The memory is
				// uninitialized and write() properly initializes it.
				unsafe { ptr.add(offset).write(init(i)) };
			}
			self.bump(prev, size);
		}
		prev
	}

	/// Grows the vector to at least `size` elements, initializing new elements
	/// with their default value.
	///
	/// This is a convenience method that calls `grow_with` using `T::default()`
	/// for new elements.
	///
	/// # Arguments
	///
	/// * `size` - The minimum size the vector should have
	///
	/// # Returns
	///
	/// The previous length of the vector before growth
	pub fn grow_default(&self, size: usize) -> usize
	where
		T: Default,
	{
		self.grow_with(size, |_| T::default())
	}

	/// Grows the vector to at least `size` elements, initializing new elements
	/// with the provided value.
	///
	/// This is a convenience method that calls `grow_with` using `value.clone()`
	/// for new elements.
	///
	/// # Arguments
	///
	/// * `size` - The minimum size the vector should have
	/// * `value` - The value to initialize new elements with
	///
	/// # Returns
	///
	/// The previous length of the vector before growth
	pub fn grow(&self, size: usize, value: T) -> usize
	where
		T: Clone,
	{
		self.grow_with(size, |_| value.clone())
	}

	/// Pushes multiple items at once when exclusive access is guaranteed.
	///
	/// # Panics
	///
	/// Panics if the reported iterator length would overflow the vector's
	/// maximum capacity, or if the iterator yields a different number of items
	/// than reported by [`ExactSizeIterator::len`]. If it yields too few items,
	/// the reserved range is not published and the vector is left in a poisoned
	/// state, so subsequent insertions may stall. If it yields too many items,
	/// exactly the reported prefix is published before the panic and the vector
	/// remains usable.
	pub fn extend(&self, items: impl IntoIterator<Item = T, IntoIter: ExactSizeIterator>) -> usize {
		let mut iter = items.into_iter();
		let n_items = iter.len();
		if n_items == 0 {
			// Nothing to reserve. Reserving an empty range would still run
			// bump(idx, idx), which can deadlock against a concurrent push that
			// wins the same start index.
			return self.next_index.load(Ordering::Relaxed);
		}

		// Reserve [idx, end) with a checked CAS: a lying `len()` must never
		// wrap or overflow `next_index` — a wrapped counter would hand out
		// already-occupied slots to later insertions.
		let max = self.buckets.max_capacity();
		let mut idx = self.next_index.load(Ordering::Relaxed);
		let end = loop {
			let end = idx
				.checked_add(n_items)
				.filter(|&end| end <= max)
				.expect("ExactSizeIterator length overflowed the AppendVec capacity");
			match self
				.next_index
				.compare_exchange_weak(idx, end, Ordering::Relaxed, Ordering::Relaxed)
			{
				Ok(_) => break end,
				Err(current) => idx = current,
			}
		};

		for i in idx..end {
			let item = iter
				.next()
				.expect("ExactSizeIterator under-yielded relative to its reported length");
			let (offset, level) = BucketArray::<T>::locate(i);
			let ptr = self.buckets.ensure_bucket(level, offset > 0);
			// SAFETY: We reserved exactly the indices in [idx, end) via fetch_add,
			// and the loop never writes outside that range. Pointer arithmetic is
			// valid since offset < level_size. The memory is uninitialized and
			// write() properly initializes it.
			unsafe { ptr.add(offset).write(item) };
		}

		if iter.next().is_some() {
			// The entire reservation is initialized, so publish it before reporting
			// that the iterator yielded beyond the reservation.
			self.bump(idx, end);
			panic!("ExactSizeIterator over-yielded relative to its reported length");
		}

		// Update last_safe in one go.
		self.bump(idx, end);
		idx
	}

	/// Extends the vector with the given items, without any bounds checking.
	///
	/// This method is useful when you have exclusive access to the vector and
	/// want to extend it with an unknown iterator.
	///
	/// # Panics
	///
	/// Panics if a previous insertion panicked leaving the vector in a poisoned
	/// state.
	pub fn extend_unbounded(&mut self, items: impl IntoIterator<Item = T>) -> usize {
		let idx = self.next_index.load(Ordering::Relaxed);

		let mut count = 0;
		for item in items {
			let (offset, level) = BucketArray::<T>::locate(idx + count);
			let ptr = self.buckets.ensure_bucket(level, offset > 0);
			// SAFETY: We have exclusive access via &mut self. The pointer arithmetic
			// is valid since offset < level_size. The memory is uninitialized and
			// write() properly initializes it.
			unsafe { ptr.add(offset).write(item) };
			count += 1;
		}

		assert!(
			self.last_safe.load(Ordering::Relaxed) == idx,
			"must be idle with exclusive reference"
		);
		self.next_index.store(idx + count, Ordering::Release);
		self.last_safe.store(idx + count, Ordering::Release);
		idx + count
	}

	/// Returns a view over a contiguous range of elements.
	///
	/// The returned [`AppendSlice`] is a lightweight wrapper around several
	/// slice references, each coming from a different internal bucket.  It
	/// offers the standard slice-like API (`len`, indexing, iteration)
	/// without copying the underlying data.
	///
	/// The function is lock-free and **does not allocate**.
	///
	/// # Panics
	///
	/// Panics if `range.end` is greater than the current length of the vector,
	/// or if `range.start > range.end`.
	///
	/// # Examples
	///
	/// ```
	/// use omp_core::append_vec::AppendVec;
	/// let vec = AppendVec::with_capacity(10);
	/// for i in 0..10 {
	/// 	vec.push(i);
	/// }
	/// let window = vec.slice(2..5);
	/// assert_eq!(window.len(), 3);
	/// assert_eq!(window[0], 2);
	/// ```
	pub fn slice(&self, range: ops::Range<usize>) -> AppendSlice<T> {
		assert!(range.start <= range.end, "range start must not exceed range end");
		let len = self.len();
		assert!(range.end <= len, "range end is out of bounds for AppendVec of length {len}");
		if range.start == range.end {
			return AppendSlice::default();
		}

		let (loc0, lvl0) = BucketArray::<T>::locate(range.start);
		let (loc1, lvl1) = BucketArray::<T>::locate(range.end);

		// SAFETY: The asserts above establish range.start < range.end <= len, so
		// the lvl0 bucket exists and contains an initialized element at loc0.
		let bucket0 = unsafe { self.buckets.get_bucket_unchecked(lvl0) };

		// Push first level
		if lvl1 == lvl0 {
			return AppendSlice(SmallVec::from_iter([&bucket0[loc0..loc1]]));
		}
		let mut slices = SmallVec::from_iter([&bucket0[loc0..]]);

		// Push middle levels
		for lvl in lvl0 + 1..lvl1 {
			// SAFETY: The asserts above establish range.end <= len, so all buckets
			// between lvl0 and lvl1 exist and are initialized.
			slices.push(unsafe { self.buckets.get_bucket_unchecked(lvl) });
		}

		// Push last level
		if loc1 > 0 {
			// SAFETY: The asserts above establish range.end <= len, so lvl1 exists
			// and its elements before loc1 are initialized.
			slices.push(unsafe { &self.buckets.get_bucket_unchecked(lvl1)[..loc1] });
		}

		AppendSlice(slices)
	}
}

impl<T> FromIterator<T> for AppendVec<T> {
	fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
		let iter = iter.into_iter();
		let mut vec = Self::with_capacity(iter.size_hint().0);
		vec.extend_unbounded(iter);
		vec
	}
}

impl<T> Drop for AppendVec<T> {
	fn drop(&mut self) {
		self.clear();
	}
}

/// A slice-like view produced by [`AppendVec::slice`].
///
/// Internally the vector is backed by multiple exponentially growing buckets.
/// An [`AppendSlice`] therefore stores a small `SmallVec` of slice
/// references so that the common case of spanning at most four buckets is
/// allocated on the stack.
///
/// The structure is *copy-free* and merely borrows the data.  Two different
/// iterator flavours are provided:
///
/// * [`iter`](Self::iter) – borrows `&self` and yields `&T` items.
/// * [`IntoIterator`] – consumes the range and yields `&T` items with the
///   exact-size, fused iterator [`AppendSliceIntoIter`].
#[derive(Debug)]
pub struct AppendSlice<'a, T>(SmallVec<&'a [T], 4>);

impl<T> Default for AppendSlice<'_, T> {
	fn default() -> Self {
		Self(SmallVec::new())
	}
}

impl<'a, T> FromIterator<&'a [T]> for AppendSlice<'a, T> {
	fn from_iter<I: IntoIterator<Item = &'a [T]>>(iter: I) -> Self {
		Self(iter.into_iter().collect())
	}
}

impl<'a, T> AppendSlice<'a, T> {
	/// A view over `slices` presented as one contiguous sequence.
	pub fn new(slices: &'a [&'a [T]]) -> Self {
		Self(SmallVec::from_iter(slices.iter().copied()))
	}

	/// Returns a reference to the element at `index`, or `None` if the index is
	/// out of bounds for this range.
	///
	/// Equivalent to `self.into_iter().nth(index)` but constant-time.
	pub fn get(&self, mut index: usize) -> Option<&'a T> {
		for slice in &self.0 {
			if index < slice.len() {
				return Some(&slice[index]);
			}
			index -= slice.len();
		}
		None
	}

	/// Returns the total number of elements in the range.
	pub fn len(&self) -> usize {
		self.0.iter().map(|s| s.len()).sum()
	}

	/// Returns `true` if the range contains no elements.
	pub fn is_empty(&self) -> bool {
		self.len() == 0
	}

	/// Returns an iterator over the elements in the range.
	///
	/// This is the same iterator that the `&AppendSlice` implementation of
	/// [`IntoIterator`] returns.
	#[define_opaque(Iter)]
	pub fn iter(&self) -> Iter<T> {
		self.0.iter().flat_map(|s| s.iter())
	}
}

/// Iterator returned by [`AppendSlice::iter`].
pub type Iter<'s, T: 's> = impl DoubleEndedIterator<Item = &'s T> + FusedIterator + Clone + 's;

/// An exact-size, fused iterator yielding references into the original
/// vector.
///
/// It is created by calling [`IntoIterator::into_iter`] on an
/// [`AppendSlice`].  Because the range owns its internal `SmallVec`, the
/// iterator can operate by *mutating* the stored slices in place, achieving
/// zero allocations and minimal bookkeeping.
#[derive(Debug)]
pub struct AppendSliceIntoIter<'s, T> {
	range:      AppendSlice<'s, T>,
	bucket_idx: usize,
}

impl<'s, T> Iterator for AppendSliceIntoIter<'s, T> {
	type Item = &'s T;

	fn next(&mut self) -> Option<Self::Item> {
		while let Some(slice) = self.range.0.get_mut(self.bucket_idx) {
			let Some((item, rest)) = slice.split_first() else {
				self.bucket_idx += 1;
				continue;
			};

			*slice = rest;
			return Some(item);
		}
		None
	}

	fn size_hint(&self) -> (usize, Option<usize>) {
		let n = ExactSizeIterator::len(self);
		(n, Some(n))
	}
}

impl<T> ExactSizeIterator for AppendSliceIntoIter<'_, T> {
	fn len(&self) -> usize {
		self.range.0[self.bucket_idx..]
			.iter()
			.map(|s| s.len())
			.sum()
	}
}

impl<T> FusedIterator for AppendSliceIntoIter<'_, T> {}

impl<'a, T> IntoIterator for AppendSlice<'a, T> {
	type IntoIter = AppendSliceIntoIter<'a, T>;
	type Item = &'a T;

	fn into_iter(self) -> Self::IntoIter {
		AppendSliceIntoIter { range: self, bucket_idx: 0 }
	}
}

impl<'a, 'b, T> IntoIterator for &'b AppendSlice<'a, T>
where
	'b: 'a,
{
	type IntoIter = Iter<'b, T>;
	type Item = &'a T;

	fn into_iter(self) -> Self::IntoIter {
		self.iter()
	}
}

impl<T> Index<usize> for AppendSlice<'_, T> {
	type Output = T;

	fn index(&self, index: usize) -> &Self::Output {
		self.get(index).expect("index out of bounds")
	}
}

// Implementation of common traits for AppendVec

impl<T> Index<usize> for AppendVec<T> {
	type Output = T;

	fn index(&self, index: usize) -> &Self::Output {
		self.get(index).expect("index out of bounds")
	}
}

impl<T> IndexMut<usize> for AppendVec<T> {
	fn index_mut(&mut self, index: usize) -> &mut Self::Output {
		self.get_mut(index).expect("index out of bounds")
	}
}

/// Implementation of `IntoIterator` for [`AppendVec`]
impl<'a, T> IntoIterator for &'a AppendVec<T> {
	type IntoIter = AppendVecIter<'a, T>;
	type Item = &'a T;

	fn into_iter(self) -> Self::IntoIter {
		self.iter()
	}
}

/// An iterator over elements in a [`AppendVec`].
#[derive(Debug)]
pub struct AppendVecIter<'a, T> {
	n:           usize,
	vec:         &'a AppendVec<T>,
	front:       u32,
	back:        u32,
	front_slice: &'a [T],
	back_slice:  &'a [T],
}

impl<'a, T> AppendVecIter<'a, T> {
	const fn empty(vec: &'a AppendVec<T>) -> Self {
		Self { n: 0, vec, front: 0, back: 0, front_slice: &[], back_slice: &[] }
	}

	fn new(vec: &'a AppendVec<T>) -> Self {
		let len = vec.len();
		if len == 0 {
			return Self::empty(vec);
		}

		let (back_bucket_level, back_bucket_offset) = if len > 0 {
			let (offset, level) = BucketArray::<T>::locate(len - 1);
			(level, offset + 1)
		} else {
			(0, 0)
		};

		if back_bucket_level == 0 {
			// SAFETY: len > 0, so bucket 0 must exist and contain initialized elements.
			let bucket = unsafe { vec.buckets.get_bucket_unchecked(0) };
			Self {
				n: len,
				vec,
				front: 0,
				back: 0,
				front_slice: &bucket[..back_bucket_offset],
				back_slice: &[],
			}
		} else {
			// SAFETY: len > 0 implies bucket 0 exists. The back_bucket_level was computed
			// from len-1, so that bucket also exists and contains initialized elements.
			let front_bucket = unsafe { vec.buckets.get_bucket_unchecked(0) };
			// SAFETY: back_bucket_level was computed from len-1, so it's a valid bucket
			// index.
			let back_bucket = unsafe { vec.buckets.get_bucket_unchecked(back_bucket_level) };
			Self {
				vec,
				n: len,
				front: 0,
				back: back_bucket_level,
				front_slice: front_bucket,
				back_slice: &back_bucket[..back_bucket_offset],
			}
		}
	}
}

impl<'a, T> Iterator for AppendVecIter<'a, T> {
	type Item = &'a T;

	#[inline]
	fn next(&mut self) -> Option<Self::Item> {
		if self.n == 0 {
			return None;
		}
		self.n -= 1;

		if let Some(item) = self.front_slice.split_off_first() {
			return Some(item);
		}

		self.front += 1;
		if self.front == self.back {
			mem::swap(&mut self.front_slice, &mut self.back_slice);
		} else {
			// SAFETY: The front index only advances through buckets that were
			// initialized when the iterator was created (n tracks remaining elements).
			// We never go past the back bucket.
			self.front_slice = unsafe { self.vec.buckets.get_bucket_unchecked(self.front) };
		}
		self.front_slice.split_off_first()
	}

	fn size_hint(&self) -> (usize, Option<usize>) {
		(self.n, Some(self.n))
	}
}

impl<T> ExactSizeIterator for AppendVecIter<'_, T> {
	fn len(&self) -> usize {
		self.n
	}
}

impl<T> FusedIterator for AppendVecIter<'_, T> {}

impl<T> DoubleEndedIterator for AppendVecIter<'_, T> {
	#[inline]
	fn next_back(&mut self) -> Option<Self::Item> {
		if self.n == 0 {
			return None;
		}
		self.n -= 1;

		// Fast path: if we're in the same bucket
		if self.front == self.back {
			return self.front_slice.split_off_last();
		}

		// Try current back slice
		if let Some(item) = self.back_slice.split_off_last() {
			return Some(item);
		}

		// Move to previous bucket
		self.back -= 1;
		if self.back == self.front {
			self.front_slice.split_off_last()
		} else {
			// SAFETY: The back index only moves backwards through buckets that were
			// initialized when the iterator was created (n tracks remaining elements).
			// We never go before the front bucket.
			self.back_slice = unsafe { self.vec.buckets.get_bucket_unchecked(self.back) };
			self.back_slice.split_off_last()
		}
	}
}

// Extension: ToOwned/Cow support for advanced use cases
impl<T: Clone> AppendVec<T> {
	/// Creates a standard Vec from this `AppendVec`.
	pub fn to_vec(&self) -> Vec<T> {
		self.iter().cloned().collect()
	}
}

#[cfg(test)]
mod tests {
	use std::{
		cell::RefCell,
		collections::HashSet,
		panic,
		rc::Rc,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		thread, vec,
	};

	use super::*;

	struct LyingLen<T> {
		items:        vec::IntoIter<T>,
		reported_len: usize,
	}

	impl<T> LyingLen<T> {
		fn new(items: Vec<T>, reported_len: usize) -> Self {
			Self { items: items.into_iter(), reported_len }
		}
	}

	impl<T> Iterator for LyingLen<T> {
		type Item = T;

		fn next(&mut self) -> Option<Self::Item> {
			self.items.next()
		}

		fn size_hint(&self) -> (usize, Option<usize>) {
			(self.reported_len, Some(self.reported_len))
		}
	}

	impl<T> ExactSizeIterator for LyingLen<T> {
		fn len(&self) -> usize {
			self.reported_len
		}
	}

	#[test]
	fn locate() {
		type T = BucketArray<usize>;

		fn naive_locate(mut idx: usize) -> (usize, u32) {
			for level in 0..32 {
				let size = T::level_size(level);
				if idx < size {
					return (idx, level);
				}
				idx -= size;
			}
			unreachable!()
		}

		for i in 0..1000 {
			assert_eq!(T::locate(i), naive_locate(i));
		}
	}

	#[test]
	fn test_basic_operations() {
		let vec = AppendVec::<i32>::new();

		// Test push and len
		assert_eq!(vec.push(1), 0);
		assert_eq!(vec.push(2), 1);
		assert_eq!(vec.push(3), 2);
		assert_eq!(vec.len(), 3);

		// Test get_ref
		assert_eq!(*vec.get(0).unwrap(), 1);
		assert_eq!(*vec.get(1).unwrap(), 2);
		assert_eq!(*vec.get(2).unwrap(), 3);

		// Test IndexOp
		assert_eq!(vec[0], 1);
		assert_eq!(vec[1], 2);
		assert_eq!(vec[2], 3);

		// Test iterator
		let mut iter = vec.iter();
		assert_eq!(*iter.next().unwrap(), 1);
		assert_eq!(*iter.next().unwrap(), 2);
		assert_eq!(*iter.next().unwrap(), 3);
		assert!(iter.next().is_none());

		// Test into_iter
		let mut collected = vec.into_iter().copied().collect::<Vec<_>>();
		collected.sort_unstable();
		assert_eq!(collected, vec![1, 2, 3]);
	}

	#[test]
	fn test_concurrent_push() {
		const THREADS: usize = 10;
		const ITEMS_PER_THREAD: usize = 1000;

		let vec = Arc::new(AppendVec::<usize>::new());

		thread::scope(|scope| {
			for thread in 0..THREADS {
				let vec = Arc::clone(&vec);
				scope.spawn(move || {
					let start = thread * ITEMS_PER_THREAD;
					for i in start..start + ITEMS_PER_THREAD {
						vec.push(i);
					}
				});
			}
		});

		assert_eq!(vec.len(), THREADS * ITEMS_PER_THREAD);

		let values: HashSet<usize> = vec.iter().copied().collect();
		assert_eq!(values.len(), THREADS * ITEMS_PER_THREAD);

		for expected in 0..THREADS * ITEMS_PER_THREAD {
			assert!(values.contains(&expected));
		}
	}

	#[test]
	fn test_clear() {
		let mut vec = AppendVec::<i32>::new();

		// Add some elements
		for i in 0..100 {
			vec.push(i);
		}

		assert_eq!(vec.len(), 100);

		// Clear the vector
		vec.clear();

		// Verify state after clearing
		assert_eq!(vec.len(), 0);
		assert!(vec.is_empty());

		// Test that we can add elements after clearing
		vec.push(42);
		assert_eq!(vec.len(), 1);
		assert_eq!(vec[0], 42);
	}

	#[test]
	fn test_extend_from_slice() {
		let vec = AppendVec::<i32>::new();
		let items = [1, 2, 3, 4, 5];

		vec.extend(items);

		assert_eq!(vec.len(), 5);
		for (i, &val) in items.iter().enumerate() {
			assert_eq!(vec[i], val);
		}
	}

	#[test]
	fn test_get_mut() {
		let mut vec = AppendVec::<String>::new();

		vec.push("Hello".to_string());
		vec.push("World".to_string());

		// Modify element through get_mut
		if let Some(e) = vec.get_mut(1) {
			e.push('!');
		}

		assert_eq!(vec[1], "World!");

		// Test out of bounds
		assert!(vec.get_mut(100).is_none());
	}

	#[test]
	fn test_is_empty() {
		let vec = AppendVec::<u32>::new();

		assert!(vec.is_empty());

		vec.push(1);
		assert!(!vec.is_empty());

		let mut vec = AppendVec::<u32>::new();
		vec.push(1);
		vec.clear();
		assert!(vec.is_empty());
	}

	#[test]
	fn test_extend() {
		let vec = AppendVec::<char>::new();

		let items = ['a', 'b', 'c', 'd', 'e'];
		vec.extend(items);

		assert_eq!(vec.len(), 5);
		assert_eq!(vec[0], 'a');
		assert_eq!(vec[4], 'e');
	}

	#[test]
	#[should_panic(expected = "range end is out of bounds for AppendVec of length 0")]
	fn test_slice_rejects_out_of_bounds_range() {
		let _ = AppendVec::<u32>::new().slice(0..1);
	}

	#[test]
	fn test_empty_slice_of_empty_vec() {
		let vec = AppendVec::<u32>::new();
		let slice = vec.slice(0..0);

		assert_eq!(slice.len(), 0);
		assert!(slice.iter().next().is_none());
	}

	#[test]
	#[should_panic(expected = "ExactSizeIterator under-yielded relative to its reported length")]
	fn test_extend_rejects_under_yielding_exact_size_iterator() {
		let vec = AppendVec::<u32>::new();
		vec.extend(LyingLen::new(vec![1, 2], 3));
	}

	#[test]
	#[should_panic(expected = "ExactSizeIterator over-yielded relative to its reported length")]
	fn test_extend_publishes_reported_prefix_before_over_yield_panic() {
		let vec = AppendVec::<u32>::new();
		let panic = panic::catch_unwind(panic::AssertUnwindSafe(|| {
			vec.extend(LyingLen::new(vec![10, 20, 30, 40], 2));
		}))
		.expect_err("over-yielding ExactSizeIterator must panic");

		assert_eq!(vec.len(), 2);
		assert_eq!(vec.iter().copied().collect::<Vec<_>>(), vec![10, 20]);

		panic::resume_unwind(panic);
	}

	#[test]
	#[should_panic(expected = "ExactSizeIterator length overflowed the AppendVec capacity")]
	fn test_extend_lying_len_usize_max_panics_before_reserving() {
		// The overflow check runs before the reservation CAS, so the counter
		// is never touched. No in-test catch: `catch_unwind` landing pads are
		// not emitted by the cranelift dev backend, so the catch never
		// engages and the panic reaches the harness anyway.
		let vec = AppendVec::<u32>::new();
		vec.push(1);
		vec.extend(LyingLen::new(vec![2, 3], usize::MAX));
	}

	#[test]
	fn test_extend_empty_iterator_reserves_nothing() {
		let vec = AppendVec::<u32>::new();
		vec.push(7);

		assert_eq!(vec.extend(std::iter::empty()), 1);
		assert_eq!(vec.len(), 1);

		// The vector stays fully usable afterwards.
		assert_eq!(vec.push(8), 1);
		assert_eq!(vec.iter().copied().collect::<Vec<_>>(), vec![7, 8]);
	}

	#[test]
	fn test_to_vec() {
		let vec = AppendVec::<usize>::new();
		for i in 0..100 {
			vec.push(i);
		}

		let std_vec = vec.to_vec();

		assert_eq!(std_vec.len(), 100);
		for (i, &val) in std_vec.iter().enumerate() {
			assert_eq!(val, i);
		}
	}

	#[test]
	fn test_element_iter_size_hint() {
		let vec = AppendVec::<i32>::new();
		for i in 0..100 {
			vec.push(i);
		}

		let iter = vec.iter();
		assert_eq!(iter.size_hint(), (100, Some(100)));
		assert_eq!(iter.len(), 100);

		// Check size_hint during iteration
		let mut iter = vec.iter();
		iter.next();
		iter.next();
		assert_eq!(iter.size_hint(), (98, Some(98)));
	}

	#[test]
	fn test_bucket_array_num_buckets() {
		let bucket_array = BucketArray::<i32>::new();
		assert_eq!(bucket_array.iter().count(), 0);

		// Allocate a bucket via the ensure_bucket method
		bucket_array.ensure_bucket(0, false);
		assert_eq!(bucket_array.iter().count(), 1);

		bucket_array.ensure_bucket(1, false);
		bucket_array.ensure_bucket(2, false);
		assert_eq!(bucket_array.iter().count(), 3);
	}

	#[test]
	fn test_destructors() {
		// Counter to track destructor calls
		static DESTROY_COUNT: AtomicUsize = AtomicUsize::new(0);

		// Type that counts when destroyed
		struct DestructorCounter;

		impl Drop for DestructorCounter {
			fn drop(&mut self) {
				DESTROY_COUNT.fetch_add(1, Ordering::SeqCst);
			}
		}

		{
			let mut vec = AppendVec::<DestructorCounter>::new();

			// Add several counters
			for _ in 0..10 {
				vec.push(DestructorCounter);
			}

			// Verify no destructors called yet
			assert_eq!(DESTROY_COUNT.load(Ordering::SeqCst), 0);

			// Clear should call destructors
			vec.clear();
			assert_eq!(DESTROY_COUNT.load(Ordering::SeqCst), 10);

			// Add more elements
			for _ in 0..5 {
				vec.push(DestructorCounter);
			}
		} // vec goes out of scope here

		// Verify all destructors called
		assert_eq!(DESTROY_COUNT.load(Ordering::SeqCst), 15);
	}

	#[test]
	fn test_drop_elements_across_buckets() {
		// Create a shared counter across multiple objects
		let counter = Rc::new(RefCell::new(0));

		struct Tracked {
			counter: Rc<RefCell<usize>>,
		}

		impl Drop for Tracked {
			fn drop(&mut self) {
				*self.counter.borrow_mut() += 1;
			}
		}

		{
			let mut vec = AppendVec::<Tracked>::new();

			// Add enough elements to span multiple buckets
			let total = 1000;
			for _ in 0..total {
				vec.push(Tracked { counter: counter.clone() });
			}

			// Verify no elements dropped yet
			assert_eq!(*counter.borrow(), 0);

			// Validate the element count
			assert_eq!(vec.len(), total);

			// Clear half the vector
			vec.clear();
			assert_eq!(*counter.borrow(), total);
		}

		// All objects should be dropped when vec goes out of scope
		assert_eq!(*counter.borrow(), 1000);
	}

	#[test]
	fn test_range_and_iterators() {
		let vec = AppendVec::<usize>::new();

		// Fill vector with enough elements to span multiple buckets.
		for i in 0..600 {
			vec.push(i);
		}

		// ----- Single-bucket range -----
		let range_single = vec.slice(10..20);
		assert_eq!(range_single.len(), 10);
		assert!(!range_single.is_empty());
		assert_eq!(range_single[0], 10);
		assert_eq!(range_single[9], 19);

		// Iterate using AppendSliceIter
		let collected_iter: Vec<_> = range_single.iter().copied().collect();
		assert_eq!(collected_iter, (10usize..20).collect::<Vec<_>>());

		// Iterate using AppendSliceIntoIter (consumes the range)
		let collected_into: Vec<_> = range_single.into_iter().copied().collect();
		assert_eq!(collected_into, (10usize..20).collect::<Vec<_>>());

		// ----- Multi-bucket range -----
		let range_multi = vec.slice(200..400); // crosses bucket boundary (256-element level)
		assert_eq!(range_multi.len(), 200);
		assert_eq!(range_multi[0], 200);
		assert_eq!(range_multi[199], 399);

		let collected_multi: Vec<_> = range_multi.into_iter().copied().collect();
		assert_eq!(collected_multi, (200usize..400).collect::<Vec<_>>());
	}

	#[test]
	fn test_iter_double_ended() {
		let vec = AppendVec::<i32>::new();

		// Test empty iterator
		let mut empty_iter = vec.iter();
		assert!(empty_iter.next().is_none());
		assert!(empty_iter.next_back().is_none());

		// Add some elements
		for i in 0..10 {
			vec.push(i);
		}

		// Test alternating front and back iteration
		let mut iter = vec.iter();
		assert_eq!(*iter.next().unwrap(), 0);
		assert_eq!(*iter.next_back().unwrap(), 9);
		assert_eq!(*iter.next().unwrap(), 1);
		assert_eq!(*iter.next_back().unwrap(), 8);
		assert_eq!(*iter.next().unwrap(), 2);
		assert_eq!(*iter.next_back().unwrap(), 7);
		assert_eq!(*iter.next().unwrap(), 3);
		assert_eq!(*iter.next_back().unwrap(), 6);
		assert_eq!(*iter.next().unwrap(), 4);
		assert_eq!(*iter.next_back().unwrap(), 5);

		// Both ends should be exhausted
		assert!(iter.next().is_none());
		assert!(iter.next_back().is_none());
	}

	#[test]
	fn test_iter_double_ended_across_buckets() {
		let vec = AppendVec::<usize>::new();

		// Add enough elements to span multiple buckets
		for i in 0..600 {
			vec.push(i);
		}

		// Test reverse iteration
		let mut iter = vec.iter();
		let mut collected_forward = Vec::new();
		let mut collected_backward = Vec::new();

		// Collect some from front
		for _ in 0..100 {
			collected_forward.push(*iter.next().unwrap());
		}

		// Collect some from back
		for _ in 0..100 {
			collected_backward.push(*iter.next_back().unwrap());
		}

		// Verify correct values
		assert_eq!(collected_forward, (0..100).collect::<Vec<_>>());
		assert_eq!(collected_backward, (500..600).rev().collect::<Vec<_>>());

		// Test full reverse iteration
		let reverse_collected: Vec<_> = vec.iter().rev().copied().collect();
		assert_eq!(reverse_collected, (0..600).rev().collect::<Vec<_>>());
	}

	#[test]
	fn test_iter_size_hint_with_double_ended() {
		let vec = AppendVec::<i32>::new();

		for i in 0..100 {
			vec.push(i);
		}

		let mut iter = vec.iter();

		// Initial size hint
		assert_eq!(iter.size_hint(), (100, Some(100)));
		assert_eq!(iter.len(), 100);

		// Consume from front
		iter.next();
		assert_eq!(iter.size_hint(), (99, Some(99)));
		assert_eq!(iter.len(), 99);

		// Consume from back
		iter.next_back();
		assert_eq!(iter.size_hint(), (98, Some(98)));
		assert_eq!(iter.len(), 98);

		// Consume multiple from both ends
		for _ in 0..48 {
			iter.next();
			iter.next_back();
		}

		assert_eq!(iter.size_hint(), (2, Some(2)));
		assert_eq!(iter.len(), 2);

		// Final two elements
		let a = iter.next().unwrap();
		let b = iter.next_back().unwrap();
		assert_ne!(a, b); // Should be different elements

		// Exhausted
		assert_eq!(iter.size_hint(), (0, Some(0)));
		assert_eq!(iter.len(), 0);
	}

	#[test]
	fn test_iter_fused_double_ended() {
		let vec = AppendVec::<i32>::new();

		for i in 0..10 {
			vec.push(i);
		}

		let mut iter = vec.iter();

		// Exhaust from both ends
		while iter.next().is_some() || iter.next_back().is_some() {}

		// Iterator should continue returning None from both ends
		assert!(iter.next().is_none());
		assert!(iter.next().is_none());
		assert!(iter.next_back().is_none());
		assert!(iter.next_back().is_none());
	}

	#[test]
	fn test_iter_collect_all() {
		// Test with various sizes
		for size in [100, 256, 257, 512, 1000, 2000] {
			let vec = AppendVec::<usize>::new();
			for i in 0..size {
				vec.push(i);
			}

			let collected: Vec<_> = vec.iter().copied().collect();
			assert_eq!(collected.len(), size, "Failed for size {size}");

			for (i, &val) in collected.iter().enumerate() {
				assert_eq!(val, i, "Wrong value at index {i} for size {size}");
			}
		}
	}

	#[test]
	fn test_grow_with() {
		let vec = AppendVec::<usize>::new();

		// Test growing empty vector
		let prev = vec.grow_with(5, |i| i * 10);
		assert_eq!(prev, 0);
		assert_eq!(vec.len(), 5);
		for i in 0..5 {
			assert_eq!(vec[i], i * 10);
		}

		// Test growing already populated vector
		vec.push(100);
		vec.push(101);
		let prev = vec.grow_with(10, |i| i * 100);
		assert_eq!(prev, 7); // Was at index 7 after previous operations
		assert_eq!(vec.len(), 10);
		assert_eq!(vec[7], 700);
		assert_eq!(vec[8], 800);
		assert_eq!(vec[9], 900);

		// Test no-op when size is smaller than current
		let prev = vec.grow_with(8, |_| panic!("Should not be called"));
		assert_eq!(prev, 10);
		assert_eq!(vec.len(), 10);
	}

	#[test]
	fn test_grow() {
		let vec = AppendVec::<i32>::new();

		// Test growing empty vector
		let prev = vec.grow_default(5);
		assert_eq!(prev, 0);
		assert_eq!(vec.len(), 5);
		for i in 0..5 {
			assert_eq!(vec[i], 0); // default value
		}

		// Test growing with existing elements
		vec.push(42);
		vec.push(43);
		let prev = vec.grow_default(10);
		assert_eq!(prev, 7);
		assert_eq!(vec.len(), 10);
		assert_eq!(vec[5], 42);
		assert_eq!(vec[6], 43);
		assert_eq!(vec[7], 0);
		assert_eq!(vec[9], 0);
	}

	#[test]
	fn test_grow_with_custom_types() {
		#[derive(Debug, PartialEq)]
		struct Custom {
			value:   usize,
			squared: usize,
		}

		let vec = AppendVec::<Custom>::new();

		vec.grow_with(5, |i| Custom { value: i, squared: i * i });

		assert_eq!(vec.len(), 5);
		assert_eq!(vec[0], Custom { value: 0, squared: 0 });
		assert_eq!(vec[2], Custom { value: 2, squared: 4 });
		assert_eq!(vec[4], Custom { value: 4, squared: 16 });
	}

	#[test]
	fn test_grow_across_buckets() {
		let vec = AppendVec::<usize>::new();

		// Grow to span multiple buckets
		let prev = vec.grow_with(600, |i| i * 2);
		assert_eq!(prev, 0);
		assert_eq!(vec.len(), 600);

		// Verify values across bucket boundaries
		assert_eq!(vec[0], 0);
		assert_eq!(vec[255], 255 * 2);
		assert_eq!(vec[256], 256 * 2); // Start of second bucket
		assert_eq!(vec[511], 511 * 2);
		assert_eq!(vec[512], 512 * 2); // Start of third bucket
		assert_eq!(vec[599], 599 * 2);
	}

	#[test]
	fn test_concurrent_grow() {
		let vec = Arc::new(AppendVec::<usize>::new());

		thread::scope(|scope| {
			for i in 0..10 {
				let vec = Arc::clone(&vec);
				scope.spawn(move || {
					let target_size = (i + 1) * 100;
					vec.grow_with(target_size, |idx| idx);
				});
			}
		});

		// Should grow to the maximum requested size
		assert_eq!(vec.len(), 1000);

		// Verify all values are correctly initialized
		for i in 0..1000 {
			assert_eq!(vec[i], i);
		}
	}

	#[test]
	fn test_grow_with_side_effects() {
		let counter = Arc::new(AtomicUsize::new(0));
		let vec = AppendVec::<usize>::new();

		// Ensure init function is called exactly once per new element
		let counter_clone = counter.clone();
		vec.grow_with(5, |i| {
			counter_clone.fetch_add(1, Ordering::SeqCst);
			i * 10
		});

		assert_eq!(counter.load(Ordering::SeqCst), 5);

		// Growing to same size should not call init
		let counter_clone = counter.clone();
		vec.grow_with(5, |_| {
			counter_clone.fetch_add(1, Ordering::SeqCst);
			0
		});

		assert_eq!(counter.load(Ordering::SeqCst), 5); // No additional calls
	}

	#[test]
	fn test_extend_unbounded() {
		let mut vec = AppendVec::<usize>::new();

		// Test extending with a basic iterator
		let items = vec![10, 20, 30, 40, 50];
		let result = vec.extend_unbounded(items);
		assert_eq!(result, 5);
		assert_eq!(vec.len(), 5);
		for i in 0..5 {
			assert_eq!(vec[i], (i + 1) * 10);
		}

		// Test extending with more items
		let more_items = (100..110).map(|x| x * 2);
		let result = vec.extend_unbounded(more_items);
		assert_eq!(result, 15);
		assert_eq!(vec.len(), 15);
		for i in 0..10 {
			assert_eq!(vec[i + 5], (100 + i) * 2);
		}
	}

	#[test]
	fn test_extend_unbounded_across_buckets() {
		let mut vec = AppendVec::<usize>::new();

		// Extend with enough items to span multiple buckets
		let items = (0..600).map(|i| i * 3);
		let result = vec.extend_unbounded(items);
		assert_eq!(result, 600);
		assert_eq!(vec.len(), 600);

		// Verify values across bucket boundaries
		assert_eq!(vec[0], 0);
		assert_eq!(vec[255], 255 * 3);
		assert_eq!(vec[256], 256 * 3); // Start of second bucket
		assert_eq!(vec[511], 511 * 3);
		assert_eq!(vec[512], 512 * 3); // Start of third bucket
		assert_eq!(vec[599], 599 * 3);
	}

	#[test]
	fn test_extend_unbounded_with_side_effects() {
		let counter = Arc::new(AtomicUsize::new(0));
		let mut vec = AppendVec::<usize>::new();

		// Ensure each item is processed exactly once
		let counter_clone = counter.clone();
		let items = (0..10).map(move |i| {
			counter_clone.fetch_add(1, Ordering::SeqCst);
			i * 100
		});

		vec.extend_unbounded(items);
		assert_eq!(counter.load(Ordering::SeqCst), 10);
		assert_eq!(vec.len(), 10);

		for i in 0..10 {
			assert_eq!(vec[i], i * 100);
		}
	}

	#[test]
	fn test_from_iterator() {
		// Test FromIterator implementation
		let items = vec![1, 2, 3, 4, 5];
		let vec: AppendVec<i32> = items.into_iter().collect();

		assert_eq!(vec.len(), 5);
		for i in 0..5 {
			assert_eq!(vec[i], (i + 1) as i32);
		}

		// Test with a larger iterator that spans buckets
		let large_items = (0..300).map(|i| i * 2);
		let vec2: AppendVec<usize> = large_items.collect();

		assert_eq!(vec2.len(), 300);
		for i in 0..300 {
			assert_eq!(vec2[i], i * 2);
		}
	}

	#[test]
	#[should_panic(expected = "must be idle with exclusive reference")]
	fn test_extend_unbounded_panics_on_concurrent_use() {
		let mut vec = AppendVec::<i32>::new();

		// Simulate concurrent modification by manipulating the counters
		vec.push(1);
		vec.push(2);

		// Force the last_safe to be different from next_index
		vec.last_safe.store(1, Ordering::Relaxed);

		// This should panic
		vec.extend_unbounded(vec![3, 4, 5]);
	}
}
