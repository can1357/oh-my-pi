use std::{
	alloc::{Layout, alloc, alloc_zeroed, dealloc},
	ffi::c_void,
	ptr::NonNull,
	sync::atomic::{AtomicUsize, Ordering},
};

const BACKING_STORE_ALIGN: usize = align_of::<u128>();

struct BoundedArrayBufferAllocator {
	allocated: AtomicUsize,
	limit:     usize,
}

impl BoundedArrayBufferAllocator {
	fn try_reserve(&self, len: usize) -> bool {
		self
			.allocated
			.try_update(Ordering::AcqRel, Ordering::Acquire, |cur| {
				cur.checked_add(len).filter(|&next| next <= self.limit)
			})
			.is_ok()
	}
}

unsafe fn ab_alloc_inner(
	handle: &BoundedArrayBufferAllocator,
	len: usize,
	zeroed: bool,
) -> *mut c_void {
	if len == 0 {
		return NonNull::<u128>::dangling().as_ptr().cast();
	}
	let Ok(layout) = Layout::from_size_align(len, BACKING_STORE_ALIGN) else {
		return std::ptr::null_mut();
	};
	if !handle.try_reserve(len) {
		return std::ptr::null_mut();
	}
	// SAFETY: `layout` has non-zero size and power-of-two alignment 16.
	let ptr = unsafe {
		if zeroed {
			alloc_zeroed(layout)
		} else {
			alloc(layout)
		}
	};
	if ptr.is_null() {
		handle.allocated.fetch_sub(len, Ordering::AcqRel);
		return std::ptr::null_mut();
	}
	ptr.cast()
}

unsafe extern "C" fn ab_allocate(handle: &BoundedArrayBufferAllocator, len: usize) -> *mut c_void {
	// SAFETY: `handle` is valid for the lifetime of the V8 allocator.
	unsafe { ab_alloc_inner(handle, len, true) }
}

unsafe extern "C" fn ab_allocate_uninitialized(
	handle: &BoundedArrayBufferAllocator,
	len: usize,
) -> *mut c_void {
	// SAFETY: `handle` is valid for the lifetime of the V8 allocator.
	unsafe { ab_alloc_inner(handle, len, false) }
}

unsafe extern "C" fn ab_free(handle: &BoundedArrayBufferAllocator, data: *mut c_void, len: usize) {
	if len == 0 || data.is_null() {
		return;
	}
	if let Ok(layout) = Layout::from_size_align(len, BACKING_STORE_ALIGN) {
		// SAFETY: `data` was allocated by `ab_alloc_inner` with the same `len`
		// and `BACKING_STORE_ALIGN`.
		unsafe { dealloc(data.cast(), layout) };
		handle.allocated.fetch_sub(len, Ordering::AcqRel);
	}
}

unsafe extern "C" fn ab_drop(handle: *const BoundedArrayBufferAllocator) {
	if !handle.is_null() {
		// SAFETY: `handle` was created with `Box::into_raw` in
		// `bounded_allocator`.
		unsafe { drop(Box::from_raw(handle.cast_mut())) };
	}
}

static AB_VTABLE: v8::RustAllocatorVtable<BoundedArrayBufferAllocator> = v8::RustAllocatorVtable {
	allocate:               ab_allocate,
	allocate_uninitialized: ab_allocate_uninitialized,
	free:                   ab_free,
	drop:                   ab_drop,
};

pub fn bounded_allocator(limit: usize) -> v8::UniqueRef<v8::Allocator> {
	let boxed = Box::new(BoundedArrayBufferAllocator { allocated: AtomicUsize::new(0), limit });
	// SAFETY: `AB_VTABLE` matches `BoundedArrayBufferAllocator` and `ab_drop`
	// reclaims the `Box` when V8 destroys the allocator.
	unsafe { v8::new_rust_allocator(Box::into_raw(boxed).cast_const(), &AB_VTABLE) }
}
