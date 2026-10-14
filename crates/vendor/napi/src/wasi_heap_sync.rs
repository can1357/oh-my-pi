//! `wasm32-wasip1-threads` only: one lock around wasi-libc's allocator, so that a thread's view
//! of the shared memory size is current before it touches the heap.
//!
//! V8 updates the size of a shared wasm memory only on the thread that grew it; every other
//! thread keeps its old size until it handles V8's grow interrupt, and bounds-checks
//! `memory.fill`, `memory.copy` and atomics (on hosts without V8's wasm trap handler, every load
//! and store) against that old size. `memory.grow(0)` on the stale thread reloads it. The
//! mechanism, and the state this module shares with napi-async-runtime, are described in
//! `napi_sys::wasi_heap_sync`; the evidence and the rejected alternatives are in rolldown's
//! `internal-docs/wasi-shared-memory-grow/design.md`, where this code comes from.
//!
//! # The fix: refresh under the allocator lock
//!
//! `napi_build::setup()` links with `--wrap` for every entry point of wasi-libc's dlmalloc and
//! for `sbrk` (napi turns on napi-build's `wasi-heap-sync` feature for that), plus a small object
//! whose `malloc` / `free` exports, the ones `@emnapi/core` calls, go through the wrappers. So
//! every caller (Rust's `System`, wasi-libc, emnapi, JS) reaches a `__wrap_*` function below,
//! which runs the real dlmalloc call inside [`locked`]:
//!
//! ```text
//! LOCK (spin; sched_yield every 64 spins; never memory.atomic.wait)
//!   MAX_SEEN_PAGES > LOCAL_PAGES ? memory.grow(0)     catch up with every published growth
//!   __real_xxx()                                      dlmalloc writes chunk headers
//!     └─ __wrap_sbrk: hand out the reserve first, else memory.grow(n),
//!                     then memory.grow(0): LOCAL_PAGES = MAX_SEEN_PAGES = new size
//! UNLOCK (Release)                                    the next holder's Acquire sees it
//! ```
//!
//! The wrappers call `__real_*`, which only `--wrap` defines. When the addon's `setup()` runs a
//! napi-build other than the one napi turns the feature on in (two copies of napi-build in the
//! graph), the link has no `--wrap`, and `--import-undefined` would make those calls imports
//! that fail when the module loads. The object napi-build links with `--wrap` defines a data
//! symbol that [`__wrap_sbrk`] reads, so that link fails instead: `undefined symbol:
//! napi_wasi_heap_sync_needs_napi_build_setup_with_wasi_heap_sync`.
//!
//! Only `sbrk` grows the memory, and it only runs under `LOCK`, so the thread that grows
//! publishes the new size before any other thread can enter dlmalloc, and that thread
//! refreshes before dlmalloc touches a byte. A refresh before dlmalloc's own lock is not enough:
//! a thread waiting on that lock gets it right after the growing thread unlocks, before the new
//! size is published, and writes a chunk header into pages it cannot see yet (a trap on a host
//! without the trap handler).
//!
//! dlmalloc calls `sbrk` with `LOCK` already held. Any other caller (C code in the addon that
//! calls `sbrk` itself, or JS through the export) takes `LOCK` in [`__wrap_sbrk`], so two
//! callers never move the break at once and the new size is published the same way.
//!
//! calloc's memset and realloc's memcpy run after the refresh too. wasi-libc runs them after
//! dlmalloc has released its own lock, but still inside `LOCK`, so `LOCK` is wider than
//! dlmalloc's lock: a large zeroed allocation or realloc copy holds every other thread's
//! allocator calls. Kept on purpose: moving the fill and copy out of the lock did not help on
//! rolldown's measured loads, and dlmalloc has no in-place-only realloc entry, so a realloc
//! outside the lock would cost a second lock round trip and lose in-place growth (rolldown's
//! design.md, principle 1). The lock spins like dlmalloc's, so it is safe on a browser main
//! thread, where `memory.atomic.wait` traps and where emnapi frees memory from a
//! `FinalizationRegistry` callback.
//!
//! Not re-entrant, and it does not need to be: inside dlmalloc's object the public names are thin
//! wrappers over static functions, and the object's only calls out are `sbrk` and
//! `sched_yield`. [`locked`] marks the thread while it holds `LOCK`, and [`__wrap_sbrk`] takes
//! `LOCK` only when that mark is not set, so dlmalloc's `sbrk` runs under the lock it already
//! holds.
//!
//! # The break
//!
//! wasi-libc's `sbrk` starts at `memory.size`, the memory the loader created
//! (`napi.wasm.initialMemory`, 4000 pages by default), and leaves the pages between `__heap_end`
//! (the end of the module's own initial memory, where dlmalloc's first segment ends) and that
//! size unused. [`__wrap_sbrk`] keeps its own break that starts at `__heap_end`, so dlmalloc uses
//! those pages first: they exist on every thread from instantiation, so they never need a
//! refresh, and no thread grows the memory until the heap has used them. When it must grow, it
//! grows only the part of the new break past the memory end, at least
//! [`GROW_AHEAD`](crate::wasi_heap_break::GROW_AHEAD) at once: a request that starts inside the
//! reserve takes the rest of the reserve first. The page arithmetic is in
//! [`grow_plan`].
//!
//! The reserve ends at the memory size captured by a constructor at instantiation, not at the
//! size when `sbrk` first runs: another allocator in the module (a `#[global_allocator]` that
//! calls `memory.grow` itself) may have grown pages by then, and handing those to dlmalloc too
//! corrupts both heaps. Past the reserve the break only covers pages this hook grew itself.
//!
//! The break never passes 2^31. Node's `node:wasi` (v24 and later) answers `EINVAL` (os error 28)
//! to `clock_time_get` and `fd_seek` when a pointer argument is at or above 2^31: an `i32` above
//! `i32::MAX` reaches JS as a negative number. Thread stacks come from `malloc`, so once the heap
//! passes 2^31, `Instant::now` on a thread created later can fail. Failing `sbrk` there instead
//! makes dlmalloc return null: an allocation failure at the allocation, not an I/O error
//! elsewhere.
//!
//! # Invariant
//!
//! `LOCAL_PAGES` never exceeds the size V8 checks on this thread, and `MAX_SEEN_PAGES` is the
//! largest `LOCAL_PAGES` any thread has stored. dlmalloc only hands out memory below the break,
//! and the break never passes the `LOCAL_PAGES` of the thread that moved it, which publishes it
//! to `MAX_SEEN_PAGES` before it releases `LOCK`. So after taking `LOCK`, every block dlmalloc
//! returns lies within this thread's `LOCAL_PAGES`; [`after`] checks that and counts a violation
//! (`napi_wasm_heap_sync_stat(2)`, expected 0).
//!
//! # Remaining gaps
//!
//! - A block that reaches a running thread mid-poll (a channel message, an `Arc`) and is touched
//!   there before that thread's next allocation or scheduler handoff, when another thread grew
//!   the memory in between. Below the reserve nothing grows. A threadsafe-function call, deferred
//!   or async work delivered on the JS thread is covered: between taking it off its queue and
//!   calling back into the module, emnapi runs JavaScript frames (`napi_open_handle_scope`,
//!   `napi_get_reference_value`, `emnapi_is_node_binding_available`,
//!   `_emnapi_callback_into_module`), and a JavaScript frame handles V8's grow interrupt. What
//!   remains there is emnapi's own read of the queue node in C, on hosts without the trap
//!   handler.
//! - A `#[global_allocator]` that grows the memory itself (mimalloc's WASI build, talc,
//!   lol_alloc, the `dlmalloc` crate) is not locked, and its growth is never published. One that
//!   ends in libc `malloc`, like std's `System`, is locked.
//! - A thread that crashes while it holds `LOCK` leaves the others spinning, as a crash inside
//!   dlmalloc's own lock always did.
//!
//! # Cost
//!
//! Measured in rolldown on its copy of this code, before napi took it over (release wasm, Node
//! 24.21 on arm64, 10 interleaved rounds, medians): the lock and the break cost about 8% on 16
//! builds, 5% on 16 builds with a JS plugin, 10-11% on parse loads and 3% on transform, against
//! the code before them, which already grew
//! [`GROW_AHEAD`](crate::wasi_heap_break::GROW_AHEAD) at a time. That grow-ahead had made the
//! same loads 1.6-3.2x faster than growing in dlmalloc's own small steps, so most of that gain
//! stays. Other workloads and hosts are not measured. The table is in `cli/docs/wasi.md`.
//!
//! # Opting out
//!
//! `--cfg napi_wasi_no_heap_sync` in the target rustflags (for example
//! `RUSTFLAGS="--cfg napi_wasi_no_heap_sync"`) leaves this module out, and napi-build, which
//! reads the same cfg, leaves out the `--wrap` link arguments. See napi-build's README.
//!
//! Remove this module once the hosts napi-rs supports ship the V8 fix
//! (v8/v8@34241014663390c72e08c123faef6fedf395be8e).

use std::{
  cell::Cell,
  ffi::c_void,
  sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
};

use napi_sys::wasi_heap_sync::{
  grow_zero, handoff_refreshes, local_pages, max_seen_pages, needs_refresh, HANDOFF_REFRESHES_STAT,
};

use crate::wasi_heap_break::{fits, grow_plan, pages_below, Grow, HEAP_LIMIT_PAGES, PAGE_BYTES};

/// The lock and the break, alone in one cache line: every allocation takes the lock, and
/// `napi_sys::wasi_heap_sync`'s `MAX_SEEN_PAGES`, which every scheduler handoff reads, sits in a
/// line of its own.
#[repr(align(128))]
struct HeapState {
  /// The allocator lock. Held around every call into dlmalloc; see [`locked`].
  lock: AtomicBool,
  /// dlmalloc's break, owned by [`__wrap_sbrk`]. 0 until the first `sbrk` call.
  brk: AtomicUsize,
  /// End (bytes) of the pages [`__wrap_sbrk`] may hand out without growing: first the reserve
  /// `[__heap_end, init_pages)`, later the end of the last region the hook grew itself. Pages
  /// another allocator grew are never inside it.
  own_end: AtomicUsize,
  /// Memory size (pages) when this module's constructors ran; 0 when they have not.
  init_pages: AtomicUsize,
}

/// `brk` and `own_end` are only read and written under `LOCK` (and dlmalloc's own lock), and
/// `init_pages` is written once before any thread starts, so `Relaxed` is enough for them.
static STATE: HeapState = HeapState {
  lock: AtomicBool::new(false),
  brk: AtomicUsize::new(0),
  own_end: AtomicUsize::new(0),
  init_pages: AtomicUsize::new(0),
};

/// Counters read by tests through the `napi_wasm_heap_sync_stat` export. Each one is only
/// written on a cold path.
mod stat {
  /// `memory.grow(n > 0)` calls made by `__wrap_sbrk`.
  pub const GROWS: usize = 0;
  /// Refreshes run after taking `LOCK`.
  pub const LOCK_REFRESHES: usize = 1;
  /// Blocks that ended past this thread's refreshed size after dlmalloc returned them. The
  /// invariant says 0; [`super::after`] refreshes and counts one if it ever happens.
  pub const LATE_REFRESHES: usize = 2;
  /// The break, in pages (rounded up).
  pub const BREAK_PAGES: usize = 3;
  /// `__heap_end`, in pages: where the break starts.
  pub const HEAP_END_PAGES: usize = 4;
  pub const COUNT: usize = 5;
}

static STATS: [AtomicU32; stat::COUNT] = [const { AtomicU32::new(0) }; stat::COUNT];

thread_local! {
  /// Whether this thread is inside [`locked`]'s call, holding `LOCK`. [`__wrap_sbrk`] reads it
  /// to tell dlmalloc's `sbrk` calls (under `LOCK`) from any other caller's.
  static IN_LOCKED: Cell<bool> = const { Cell::new(false) };
}

#[inline]
fn bump(index: usize) {
  STATS[index].fetch_add(1, Ordering::Relaxed);
}

#[inline]
fn store_pages(index: usize, pages: usize) {
  STATS[index].store(u32::try_from(pages).unwrap_or(u32::MAX), Ordering::Relaxed);
}

/// Test-only view of the heap-sync counters. Exported from the wasm module (a `#[no_mangle]`
/// function in a cdylib), not through napi.
///
/// - 0: heap growths (`memory.grow(n > 0)` by [`__wrap_sbrk`]);
/// - 1: refreshes after taking `LOCK`, including each thread's first;
/// - 2: blocks past the thread's refreshed size when dlmalloc returned them; the invariant says 0;
/// - 3: the break, in pages (rounded up); 0 before the first `sbrk`;
/// - 4: `__heap_end`, in pages; 0 before the first `sbrk`;
/// - 5: handoff refreshes (napi-async-runtime's scheduler and napi's own cross-thread entries);
/// - any other index: `u32::MAX`.
///
/// Downstream stress tests (rolldown's) read these by index, so an index keeps its meaning; a
/// new counter takes a new index.
#[no_mangle]
pub extern "C" fn napi_wasm_heap_sync_stat(index: u32) -> u32 {
  if index == HANDOFF_REFRESHES_STAT {
    return handoff_refreshes();
  }
  STATS
    .get(index as usize)
    .map_or(u32::MAX, |counter| counter.load(Ordering::Relaxed))
}

extern "C" {
  fn __real_malloc(size: usize) -> *mut c_void;
  fn __real_free(ptr: *mut c_void);
  fn __real_calloc(count: usize, size: usize) -> *mut c_void;
  fn __real_realloc(ptr: *mut c_void, size: usize) -> *mut c_void;
  fn __real_posix_memalign(out: *mut *mut c_void, align: usize, size: usize) -> i32;
  fn __real_aligned_alloc(align: usize, size: usize) -> *mut c_void;
  fn __real_malloc_usable_size(ptr: *mut c_void) -> usize;
  fn __real___libc_malloc(size: usize) -> *mut c_void;
  fn __real___libc_free(ptr: *mut c_void);
  fn __real___libc_calloc(count: usize, size: usize) -> *mut c_void;
  fn sched_yield() -> i32;
  /// End of the module's own initial memory (wasm-ld), where dlmalloc's first segment ends.
  static __heap_end: u8;
  /// Defined only in the object napi-build links when it wraps the allocator
  /// (`crates/build/src/wasi_heap_sync_exports.c`). [`sbrk_under_lock`] reads it, so a link
  /// without that object, and so without the `--wrap` arguments, fails with `undefined symbol`
  /// naming it. Without the read, `--import-undefined` turns the `__real_*` calls above into
  /// imports, and the module links but fails to load.
  static napi_wasi_heap_sync_needs_napi_build_setup_with_wasi_heap_sync: u8;
}

#[inline]
fn lock() {
  if STATE
    .lock
    .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
    .is_err()
  {
    lock_slow();
  }
}

/// Spin like dlmalloc's own lock: `sched_yield` every 64 spins, never `memory.atomic.wait`
/// (which traps on a browser main thread).
#[cold]
fn lock_slow() {
  let mut spins: u32 = 0;
  loop {
    while STATE.lock.load(Ordering::Relaxed) {
      spins = spins.wrapping_add(1);
      if spins.is_multiple_of(64) {
        unsafe { sched_yield() };
      } else {
        core::hint::spin_loop();
      }
    }
    if STATE
      .lock
      .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
      .is_ok()
    {
      return;
    }
  }
}

/// Take `LOCK`, catch up with every growth published before it, run `f` (one real dlmalloc
/// call, or one `sbrk` call from outside dlmalloc), release. Not re-entrant: `f` must not call
/// a `__wrap_*` symbol other than [`__wrap_sbrk`], which sees `IN_LOCKED` and does not lock
/// again. dlmalloc's only calls out of its object are `sbrk` and `sched_yield`.
#[inline]
fn locked<R>(f: impl FnOnce() -> R) -> R {
  lock();
  let local = local_pages();
  // `local == 0`: this thread has never refreshed; do it once so `after` has a real bound.
  if local == 0 || max_seen_pages() > local {
    lock_refresh();
  }
  IN_LOCKED.with(|in_locked| in_locked.set(true));
  let result = f();
  IN_LOCKED.with(|in_locked| in_locked.set(false));
  STATE.lock.store(false, Ordering::Release);
  result
}

#[cold]
fn lock_refresh() {
  bump(stat::LOCK_REFRESHES);
  grow_zero();
}

/// Check the invariant on a block dlmalloc just returned (under `LOCK`): it must end within
/// this thread's refreshed size. If it ever does not, refresh and count it.
#[inline]
fn after(ptr: *mut c_void, size: usize) -> *mut c_void {
  if !ptr.is_null() && needs_refresh(ptr as usize as u64 + size as u64, local_pages()) {
    late_refresh();
  }
  ptr
}

#[cold]
fn late_refresh() {
  bump(stat::LATE_REFRESHES);
  grow_zero();
}

/// `sbrk`, dlmalloc's `MORECORE`. dlmalloc calls it from inside its entry points, which run
/// inside [`locked`], so it runs under the `LOCK` the thread already holds. Any other caller
/// (C code in the addon that calls `sbrk` itself, or JS through the export) is not inside
/// [`locked`], so it takes `LOCK` here. The break is only ever moved under `LOCK`.
#[no_mangle]
pub unsafe extern "C" fn __wrap_sbrk(increment: isize) -> *mut c_void {
  if IN_LOCKED.with(Cell::get) {
    unsafe { sbrk_under_lock(increment) }
  } else {
    locked(|| unsafe { sbrk_under_lock(increment) })
  }
}

/// The body of [`__wrap_sbrk`]; the caller holds `LOCK`, so it is never entered twice at once.
///
/// It hands out the reserve `[__heap_end, memory size at instantiation)` first: those pages
/// exist on every thread, so they never need a refresh. When a request passes the reserve's end
/// (or the end of the last region it grew), it grows only the part of the new break past the
/// memory end, at least [`GROW_AHEAD`](crate::wasi_heap_break::GROW_AHEAD) at once, refreshes
/// this thread and publishes the new size before the caller releases `LOCK`; the page
/// arithmetic is in [`grow_plan`]. It never hands out pages it did not grow itself beyond the
/// reserve, and never a byte at or above 2^31; it returns `(void *)-1` instead, and dlmalloc
/// returns null.
unsafe fn sbrk_under_lock(increment: isize) -> *mut c_void {
  const FAIL: *mut c_void = usize::MAX as *mut c_void;
  let mut brk = STATE.brk.load(Ordering::Relaxed);
  if brk == 0 {
    // Keeps the reference that fails a link without napi-build's wrap; see the declaration.
    unsafe {
      core::ptr::read_volatile(
        &raw const napi_wasi_heap_sync_needs_napi_build_setup_with_wasi_heap_sync,
      )
    };
    // Page-aligned by wasm-ld (it is the end of the module's initial memory); rounding up
    // only matters if that ever changes, and dlmalloc copes with a non-contiguous break.
    let start = pages_below(&raw const __heap_end as usize) * PAGE_BYTES;
    if start == 0 {
      return FAIL;
    }
    store_pages(stat::HEAP_END_PAGES, start / PAGE_BYTES);
    brk = start;
    STATE.brk.store(brk, Ordering::Relaxed);
    let now = grow_zero();
    let init = STATE.init_pages.load(Ordering::Relaxed);
    // The reserve ends at the memory size seen at instantiation. Without a capture (a
    // constructor that runs before ours allocated), at the size now: nothing but that
    // constructor's own code has run, so nothing else has grown the memory yet.
    let reserve_end = if init == 0 { now } else { init.min(now) };
    STATE.own_end.store(
      reserve_end.min(HEAP_LIMIT_PAGES) * PAGE_BYTES,
      Ordering::Relaxed,
    );
  }
  if increment == 0 {
    return brk as *mut c_void;
  }
  // wasm memory cannot shrink. dlmalloc only asks for less on a failure path it ignores.
  let Ok(increment) = usize::try_from(increment) else {
    return FAIL;
  };
  let mut own_end = STATE.own_end.load(Ordering::Relaxed);
  if let Some(new_brk) = fits(brk, own_end, increment) {
    // Below the reserve's or the last grown region's end: no growth, and no refresh needed.
    STATE.brk.store(new_brk, Ordering::Relaxed);
    store_pages(stat::BREAK_PAGES, pages_below(new_brk));
    return brk as *mut c_void;
  }
  // A second pass only after another allocator grew the memory between `now` and our grow.
  for _ in 0..2 {
    // Grow fresh pages. memory.grow returns the old size, so [old, old + n) is ours alone.
    let now = grow_zero();
    let Some(Grow { need, ahead }) = grow_plan(brk, own_end, increment, now) else {
      return FAIL;
    };
    let mut grown = ahead;
    let mut old = core::arch::wasm32::memory_grow::<0>(ahead);
    if old == usize::MAX && ahead != need {
      grown = need;
      old = core::arch::wasm32::memory_grow::<0>(need);
    }
    if old == usize::MAX {
      return FAIL;
    }
    bump(stat::GROWS);
    // Refresh this thread and publish the new size before the caller releases `LOCK`.
    grow_zero();
    // `old` is below 65536 because the grow succeeded, so neither product overflows. Another
    // allocator may have grown the memory since `now`, which moves `old` up; only the part of
    // the new pages below 2^31 is handed out.
    let region = old * PAGE_BYTES;
    let end = (old + grown).min(HEAP_LIMIT_PAGES) * PAGE_BYTES;
    // Contiguous with the last region (the usual case): extend the break. Otherwise another
    // allocator owns the pages after `own_end`: start a new segment, which dlmalloc takes as a
    // non-contiguous MORECORE result.
    let base = if region == own_end { brk } else { region };
    if let Some(new_brk) = fits(base, end, increment) {
      STATE.own_end.store(end, Ordering::Relaxed);
      STATE.brk.store(new_brk, Ordering::Relaxed);
      store_pages(stat::BREAK_PAGES, pages_below(new_brk));
      return base as *mut c_void;
    }
    // `grow_plan` counted on extending `[brk, own_end)`, but another allocator grew the memory
    // first, so the pages grown here start a new segment too short for the whole request. They
    // are ours: keep them as the break's region and plan again from their end. Pages that all
    // lie at or above 2^31 are never handed out.
    if region >= end {
      return FAIL;
    }
    brk = region;
    own_end = end;
    STATE.brk.store(brk, Ordering::Relaxed);
    STATE.own_end.store(own_end, Ordering::Relaxed);
  }
  FAIL
}

/// Record the memory size at instantiation, where the break's reserve ends; see "The break"
/// above. The first run wins, in case a host ever runs the constructors again on a thread.
extern "C" fn capture_init_pages() {
  let _ = STATE.init_pages.compare_exchange(
    0,
    core::arch::wasm32::memory_size::<0>(),
    Ordering::Relaxed,
    Ordering::Relaxed,
  );
}

/// Runs from `__wasm_call_ctors` (inside `_initialize`), before the constructors of the default
/// priority (napi's own registrations, the `ctor` crate), so before any user code can grow the
/// memory.
#[used]
#[link_section = ".init_array.00099"]
static CAPTURE_INIT_PAGES: extern "C" fn() = capture_init_pages;

#[no_mangle]
pub unsafe extern "C" fn __wrap_malloc(size: usize) -> *mut c_void {
  locked(|| after(unsafe { __real_malloc(size) }, size))
}

#[no_mangle]
pub unsafe extern "C" fn __wrap_free(ptr: *mut c_void) {
  if !ptr.is_null() {
    locked(|| unsafe { __real_free(ptr) });
  }
}

#[no_mangle]
pub unsafe extern "C" fn __wrap_calloc(count: usize, size: usize) -> *mut c_void {
  locked(|| {
    after(
      unsafe { __real_calloc(count, size) },
      count.saturating_mul(size),
    )
  })
}

#[no_mangle]
pub unsafe extern "C" fn __wrap_realloc(ptr: *mut c_void, size: usize) -> *mut c_void {
  locked(|| after(unsafe { __real_realloc(ptr, size) }, size))
}

#[no_mangle]
pub unsafe extern "C" fn __wrap_posix_memalign(
  out: *mut *mut c_void,
  align: usize,
  size: usize,
) -> i32 {
  locked(|| {
    let rc = unsafe { __real_posix_memalign(out, align, size) };
    if rc == 0 {
      after(unsafe { *out }, size);
    }
    rc
  })
}

#[no_mangle]
pub unsafe extern "C" fn __wrap_aligned_alloc(align: usize, size: usize) -> *mut c_void {
  locked(|| after(unsafe { __real_aligned_alloc(align, size) }, size))
}

#[no_mangle]
pub unsafe extern "C" fn __wrap_malloc_usable_size(ptr: *mut c_void) -> usize {
  // Reads the chunk header, which may sit in pages another thread grew.
  locked(|| unsafe { __real_malloc_usable_size(ptr) })
}

#[no_mangle]
pub unsafe extern "C" fn __wrap___libc_malloc(size: usize) -> *mut c_void {
  locked(|| after(unsafe { __real___libc_malloc(size) }, size))
}

#[no_mangle]
pub unsafe extern "C" fn __wrap___libc_free(ptr: *mut c_void) {
  if !ptr.is_null() {
    locked(|| unsafe { __real___libc_free(ptr) });
  }
}

#[no_mangle]
pub unsafe extern "C" fn __wrap___libc_calloc(count: usize, size: usize) -> *mut c_void {
  locked(|| {
    after(
      unsafe { __real___libc_calloc(count, size) },
      count.saturating_mul(size),
    )
  })
}
