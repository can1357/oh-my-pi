use std::cell::RefCell;
#[cfg(not(feature = "noop"))]
use std::ffi::CStr;
#[cfg(all(not(feature = "noop"), feature = "node_version_detect"))]
use std::mem::MaybeUninit;
#[cfg(not(feature = "noop"))]
use std::ptr;
#[cfg(all(not(feature = "noop"), feature = "node_version_detect"))]
use std::sync::OnceLock;
#[cfg(not(feature = "noop"))]
use std::sync::{
  atomic::{AtomicBool, AtomicUsize, Ordering},
  LazyLock, RwLock,
};
use std::{any::TypeId, collections::HashMap};

#[cfg(not(feature = "noop"))]
use rustc_hash::FxBuildHasher;

#[cfg(all(
  not(feature = "noop"),
  any(feature = "napi4", feature = "node_version_detect")
))]
use crate::check_status_or_throw;
#[cfg(all(not(feature = "noop"), feature = "node_version_detect"))]
use crate::NodeVersion;
#[cfg(not(feature = "noop"))]
use crate::{check_status, Error, JsError, Status};
use crate::{sys, Property, Result};

// #[napi] fn
pub type ExportRegisterCallback = unsafe fn(sys::napi_env) -> Result<sys::napi_value>;
// #[napi(module_exports)] fn
pub type ExportRegisterHookCallback =
  unsafe fn(sys::napi_env, sys::napi_value) -> Result<sys::napi_value>;
pub type ModuleExportsCallback =
  unsafe fn(env: sys::napi_env, exports: sys::napi_value) -> Result<()>;

#[cfg(all(not(feature = "noop"), feature = "node_version_detect"))]
pub static NODE_VERSION: OnceLock<NodeVersion> = OnceLock::new();

#[cfg(feature = "node_version_detect")]
pub static mut NODE_VERSION_MAJOR: u32 = 0;
#[cfg(feature = "node_version_detect")]
pub static mut NODE_VERSION_MINOR: u32 = 0;
#[cfg(feature = "node_version_detect")]
pub static mut NODE_VERSION_PATCH: u32 = 0;

#[repr(transparent)]
pub(crate) struct PersistedPerInstanceHashMap<K, V, S>(RefCell<HashMap<K, V, S>>);

impl<K, V, S> PersistedPerInstanceHashMap<K, V, S> {
  #[allow(clippy::mut_from_ref)]
  pub(crate) fn borrow_mut<F, R>(&self, f: F) -> R
  where
    F: FnOnce(&mut HashMap<K, V, S>) -> R,
  {
    f(&mut *self.0.borrow_mut())
  }
}

impl<K, V, S: Default> Default for PersistedPerInstanceHashMap<K, V, S> {
  fn default() -> Self {
    Self(RefCell::new(HashMap::<K, V, S>::default()))
  }
}

#[cfg(not(feature = "noop"))]
type ModuleRegisterCallback =
  RwLock<Vec<(Option<&'static str>, (&'static str, ExportRegisterCallback))>>;

#[cfg(not(feature = "noop"))]
type ClassPropertyRegistry =
  HashMap<TypeId, HashMap<Option<&'static str>, ClassRegistration, FxBuildHasher>, FxBuildHasher>;

#[cfg(not(feature = "noop"))]
struct ClassRegistration {
  js_name: &'static str,
  props: Vec<Property>,
  implement_iterator: bool,
}

// Stores class metadata registered by napi macros.
// Since class properties do not contain any napi_value, ModuleClassProperty is thread-safe.
// `register_class` rejects accessor closures and JS values/names, so their non-thread-safe owners stay empty.
// This structure is shared between the main JS thread and worker threads.
#[cfg(not(feature = "noop"))]
#[derive(Default)]
struct ModuleClassProperty(RwLock<ClassPropertyRegistry>);

#[cfg(not(feature = "noop"))]
unsafe impl Send for ModuleClassProperty {}
#[cfg(not(feature = "noop"))]
unsafe impl Sync for ModuleClassProperty {}

#[cfg(not(feature = "noop"))]
impl ModuleClassProperty {
  pub(crate) fn borrow_mut<F, R>(&self, f: F) -> R
  where
    F: FnOnce(&mut ClassPropertyRegistry) -> R,
  {
    let mut write_lock = self.0.write().unwrap();
    f(&mut write_lock)
  }

  pub(crate) fn borrow<F, R>(&self, f: F) -> R
  where
    F: FnOnce(&ClassPropertyRegistry) -> R,
  {
    let write_lock = self.0.read().unwrap();
    f(&write_lock)
  }
}

#[cfg(not(feature = "noop"))]
static MODULE_REGISTER_CALLBACK: LazyLock<ModuleRegisterCallback> = LazyLock::new(Default::default);
#[cfg(not(feature = "noop"))]
static MODULE_REGISTER_HOOK_CALLBACK: LazyLock<RwLock<Option<ExportRegisterHookCallback>>> =
  LazyLock::new(Default::default);
#[cfg(not(feature = "noop"))]
static MODULE_CLASS_PROPERTIES: LazyLock<ModuleClassProperty> = LazyLock::new(Default::default);
#[cfg(not(feature = "noop"))]
static MODULE_COUNT: AtomicUsize = AtomicUsize::new(0);
#[cfg(not(feature = "noop"))]
static FIRST_MODULE_REGISTERED: AtomicBool = AtomicBool::new(false);
/// Monotonic, never-dereferenced cookie handed to each `thread_cleanup` env-cleanup-hook
/// registration. The same addon can be (re)loaded into the *same* env (see `unload.spec.js`),
/// and Node's `napi_add_env_cleanup_hook` asserts every `(fn, arg)` pair is unique within an
/// env — so a shared `null` arg would abort on the second load. A distinct cookie per
/// registration keeps the pairs unique; `thread_cleanup` ignores the value.
#[cfg(all(
  any(feature = "tokio_rt", feature = "async-runtime"),
  not(feature = "noop")
))]
static ENV_CLEANUP_HOOK_COOKIE: AtomicUsize = AtomicUsize::new(1);
// Per-env custom-GC infrastructure (#3357). One `CustomGcHandle` is created per env (per load of
// this addon) in `create_custom_gc`. Every Buffer/TypedArray/Error/FunctionRef/native-borrow
// reference released off its env's JS thread goes through it.
//
// References never travel through the TSFN: they wait in `pending`, and the TSFN only wakes the
// JS thread, with at most one wake in flight (`wake`). Node-API is called on `pending` only on
// the env's JS thread with the env alive, from three places:
//   1. the TSFN callback (`custom_gc`), while the env runs, at most `MAX_DRAIN` references per
//      call;
//   2. the registration record's cleanup hook (`CustomGcHandle::close`), which also moves the
//      phase to `Closing`;
//   3. the late sentinel's finalizer (`custom_gc_sentinel_finalize`), which moves the phase to
//      `Dead`.
// A reference is either with its owner or in `pending`, never both.
//
// Why not through the TSFN: at env teardown Node's `RunCleanup` first runs `CleanupHandles`,
// whose `uv_run(UV_RUN_ONCE)` still delivers queued TSFN items (up to 999 per dispatch) with a
// live env. Only then do the cleanup hooks run, and the TSFN's own hook hands every item still
// queued to the callback with a null env, where nothing can be deleted. One reference per item
// leaked all of that overflow (48 B each on Node). Now only a wake token can be queued, and the
// record's hook, which runs before the TSFN's, deletes what is pending.
//
// The late sentinel is for references released after the hook, while Node finalizes the env's
// wrapped objects: a `#[napi]` class instance whose field holds a Buffer or TypedArray drops it
// in its finalizer, on the JS thread, at env teardown. The sentinel is a plain object wrapped
// with `napi_wrap` and kept by a strong reference, so its finalizer runs only at env teardown.
// It is created before any module-init code, so it is older than every entry that code adds to
// the env's finalizer list. Node runs that list newest first (`RefTracker::Link` inserts at the
// head, and `FinalizeAll` finalizes from the head), so the sentinel's finalizer runs after every
// class instance finalizer, and before Node resets the plain references, so deleting them is
// still allowed. Bun runs its finalizers last first too (`NapiEnv::runFinalizers`). That order
// is not documented. If a runtime runs the sentinel earlier, or never, the references released
// after it leak, as they did before: nothing is ever deleted twice, or after the env is gone, so
// it is the old leak, never a crash. It is a wrapped object kept by a strong reference, not an
// external: Node frees an external's `ExternalWrapper` only from a GC weak callback, which never
// runs for an external still alive at env teardown, so an external would leak 48 B per env.
//
// What still leaks, 48 B per reference on Node:
// * a value still held when its env is freed (an `async fn` future still running, a static
//   cache, a value sent to another thread): after that no Node-API call can free it. Closing
//   that needs a registry of every live reference per env on the hot path, or a reference API
//   whose references the env frees at teardown (Node has none today).
// * on Bun, a value held in instance data: Bun finalizes instance data after every finalizer,
//   so after the sentinel.
// * on Deno, every reference still held at worker teardown. Deno runs the cleanup hook when a
//   worker exits or is terminated while idle, but finalizes no wrapped object there, so neither
//   the class instances nor the sentinel are finalized; a worker terminated while its JavaScript
//   runs does not run the hook either, so the references waiting in `pending` leak too. The
//   sentinel's own wrap, wrap data (a `Weak` and an `Arc`, about 40 B) and reference stay with
//   Deno's env.
// * on wasm, references released after the hook: there is no sentinel, because a strongly
//   referenced object would keep the whole emnapi instance alive.
//
// The env's registration record (`env_registration`) holds a strong `Arc` until its cleanup
// hook runs. After that, the first reference that waits for the sentinel hands one to the handle
// itself (`teardown_keep_alive`), which the sentinel takes back, so the handle and `pending`
// outlive every class instance finalizer. The sentinel's wrap data (`CustomGcSentinel`) holds
// only a `Weak` of the handle, and nothing waits for a sentinel that never runs unless a
// reference was released after the hook, so on Deno nothing keeps the handle alive longer than
// before. The wrap data also shares the sentinel's strong reference with the handle, so the
// finalizer deletes that reference even when the handle is already gone, which is the usual
// case: no value holds the handle after the hook. Otherwise every env would leak that reference
// (48 B on Node), because Node never frees a reference the addon created, not even at teardown.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) struct CustomGcHandle {
  /// Null once the TSFN is released.
  tsfn: std::sync::atomic::AtomicPtr<sys::napi_threadsafe_function__>,
  /// Only moves forward. A drop holds the read lock while it adds to `pending` and calls the
  /// TSFN, so a phase change (under the write lock) waits for it, and nothing is added between
  /// taking `pending` and changing the phase.
  phase: RwLock<CustomGcPhase>,
  /// References released off the JS thread, as addresses, waiting for the JS thread.
  pending: std::sync::Mutex<Vec<usize>>,
  /// Whether a wake is in flight. The callback clears it, under the `pending` lock, when it takes
  /// the last references, so a reference added after that sends a new wake.
  wake: AtomicBool,
  /// Strong reference to the late sentinel, shared with the sentinel's wrap data. Null when
  /// there is none (creating it failed, or it was given up at registration), and once its
  /// finalizer ran. Whoever swaps it out deletes it.
  #[cfg(not(target_family = "wasm"))]
  sentinel_ref: std::sync::Arc<std::sync::atomic::AtomicPtr<sys::napi_ref__>>,
  /// The handle itself, from the first reference that waits for the sentinel to the sentinel's
  /// finalizer.
  #[cfg(not(target_family = "wasm"))]
  teardown_keep_alive: std::sync::Mutex<Option<std::sync::Arc<CustomGcHandle>>>,
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CustomGcPhase {
  /// The env runs. A drop on its JS thread deletes its reference right away; a drop anywhere
  /// else adds it to `pending` and wakes the JS thread.
  Open,
  /// The registration record's cleanup hook ran (or, as a backstop, Node closed the TSFN): the
  /// TSFN is released. A drop on any thread, the JS thread too, adds its reference to `pending`,
  /// for the late sentinel. Without a sentinel it leaks the reference instead, as in `Dead`.
  Closing,
  /// The late sentinel ran: the env is about to be freed. A drop leaks its reference: env
  /// teardown resets the reference's V8 handle, but Node frees only references it owns, so the
  /// `napi_ref` box (48 B on Node) stays.
  Dead,
}

/// The most references one custom-GC callback deletes (Node's TSFN dispatch also stops after
/// 1000 items, `kMaxIterationCount`), so each callback stays short. A larger backlog wakes the JS
/// thread again. That wake is sent from inside the callback, and Node runs it in the same
/// dispatch, after the callback's microtasks (`Send` while the dispatch runs only sets
/// `kDispatchPending`). So this bounds one callback, not one event-loop turn: one dispatch runs
/// up to 999 callbacks, about a million references. Measured in a Node 26 worker, a backlog of 1e6
/// references dropped off-thread is deleted in one turn of about 13 ms; one TSFN item per
/// reference spread it over many turns of about 1 to 2 ms, but cost about 70 ms in all.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
const MAX_DRAIN: usize = 1000;

static REFS_DELETED_RUNNING: std::sync::atomic::AtomicUsize =
  std::sync::atomic::AtomicUsize::new(0);
static REFS_DELETED_AT_TEARDOWN: std::sync::atomic::AtomicUsize =
  std::sync::atomic::AtomicUsize::new(0);
static REFS_LEAKED_AFTER_CLOSE: std::sync::atomic::AtomicUsize =
  std::sync::atomic::AtomicUsize::new(0);
static REFS_LEFT_PENDING: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static DRAIN_CALLBACKS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static LARGEST_DRAIN: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static SENTINEL_REFS_DELETED: std::sync::atomic::AtomicUsize =
  std::sync::atomic::AtomicUsize::new(0);

/// What happened to the references released through the custom-GC handles of this process, on
/// every env and every load of this addon. See [`custom_gc_ref_counters`].
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default)]
pub struct CustomGcRefCounters {
  /// Deleted by the custom-GC callback while their env ran.
  pub deleted_while_running: usize,
  /// Deleted at env teardown.
  pub deleted_at_teardown: usize,
  /// Released too late in env teardown to be deleted: leaked (48 B each on Node).
  pub leaked_at_teardown: usize,
  /// Still waiting when their handle was freed: leaked.
  pub left_pending: usize,
  /// Custom-GC callbacks that deleted references.
  pub drain_callbacks: usize,
  /// The most references one custom-GC callback deleted.
  pub largest_drain: usize,
  /// Strong references to late sentinels deleted (one per env that had a sentinel, at its
  /// teardown or when it was given up at registration).
  pub sentinel_refs_deleted: usize,
}

/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn custom_gc_ref_counters() -> CustomGcRefCounters {
  CustomGcRefCounters {
    deleted_while_running: REFS_DELETED_RUNNING.load(std::sync::atomic::Ordering::Relaxed),
    deleted_at_teardown: REFS_DELETED_AT_TEARDOWN.load(std::sync::atomic::Ordering::Relaxed),
    leaked_at_teardown: REFS_LEAKED_AFTER_CLOSE.load(std::sync::atomic::Ordering::Relaxed),
    left_pending: REFS_LEFT_PENDING.load(std::sync::atomic::Ordering::Relaxed),
    drain_callbacks: DRAIN_CALLBACKS.load(std::sync::atomic::Ordering::Relaxed),
    largest_drain: LARGEST_DRAIN.load(std::sync::atomic::Ordering::Relaxed),
    sentinel_refs_deleted: SENTINEL_REFS_DELETED.load(std::sync::atomic::Ordering::Relaxed),
  }
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
impl Drop for CustomGcHandle {
  fn drop(&mut self) {
    // Only counts what was never deleted; there is no env to delete it with.
    let left = self.pending.get_mut().map_or_else(
      |poisoned| poisoned.into_inner().len(),
      |pending| pending.len(),
    );
    if left != 0 {
      REFS_LEFT_PENDING.fetch_add(left, Ordering::Relaxed);
    }
  }
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
impl CustomGcHandle {
  pub(crate) fn new() -> Self {
    Self {
      tsfn: std::sync::atomic::AtomicPtr::new(ptr::null_mut()),
      phase: RwLock::new(CustomGcPhase::Open),
      pending: std::sync::Mutex::new(Vec::new()),
      wake: AtomicBool::new(false),
      #[cfg(not(target_family = "wasm"))]
      sentinel_ref: std::sync::Arc::new(std::sync::atomic::AtomicPtr::new(ptr::null_mut())),
      #[cfg(not(target_family = "wasm"))]
      teardown_keep_alive: std::sync::Mutex::new(None),
    }
  }

  fn read_phase(&self) -> std::sync::RwLockReadGuard<'_, CustomGcPhase> {
    self
      .phase
      .read()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  fn write_phase(&self) -> std::sync::RwLockWriteGuard<'_, CustomGcPhase> {
    self
      .phase
      .write()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  fn lock_pending(&self) -> std::sync::MutexGuard<'_, Vec<usize>> {
    self
      .pending
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  /// Whether the env is not torn down yet: its cleanup hook has not run.
  #[cfg(feature = "web_stream")]
  pub(crate) fn is_open(&self) -> bool {
    *self.read_phase() == CustomGcPhase::Open
  }

  /// Releases `reference`, created in this handle's env at refcount 1. On the env's JS thread
  /// while the env runs, calls `direct`, which must unref and delete it right now. Anywhere
  /// else, it waits for the env's JS thread.
  pub(crate) fn release_ref(
    handle: &std::sync::Arc<Self>,
    reference: sys::napi_ref,
    direct: impl FnOnce(),
  ) {
    let phase = handle.read_phase();
    match *phase {
      CustomGcPhase::Open if current_thread_owns_custom_gc(handle) => direct(),
      phase => handle.defer(phase, reference),
    }
  }

  /// Like [`Self::release_ref`], but never deletes right away, even on the env's JS thread.
  pub(crate) fn defer_ref(handle: &std::sync::Arc<Self>, reference: sys::napi_ref) {
    let phase = handle.read_phase();
    handle.defer(*phase, reference);
  }

  /// The caller holds the phase read lock, and `phase` is what it read.
  fn defer(self: &std::sync::Arc<Self>, phase: CustomGcPhase, reference: sys::napi_ref) {
    match phase {
      CustomGcPhase::Open => {
        self.lock_pending().push(reference as usize);
        if !self.wake.swap(true, Ordering::SeqCst) && !self.send_wake() {
          // The reference waits for the next wake or for the cleanup hook.
          self.wake.store(false, Ordering::SeqCst);
        }
      }
      CustomGcPhase::Closing if self.has_sentinel() => {
        self.lock_pending().push(reference as usize);
        self.keep_alive_until_sentinel();
      }
      CustomGcPhase::Closing | CustomGcPhase::Dead => {
        REFS_LEAKED_AFTER_CLOSE.fetch_add(1, Ordering::Relaxed);
      }
    }
  }

  /// Keeps the handle, and so `pending`, alive until the sentinel's finalizer takes it back.
  fn keep_alive_until_sentinel(self: &std::sync::Arc<Self>) {
    #[cfg(not(target_family = "wasm"))]
    self
      .teardown_keep_alive
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .get_or_insert_with(|| self.clone());
  }

  fn has_sentinel(&self) -> bool {
    #[cfg(not(target_family = "wasm"))]
    return !self.sentinel_ref.load(Ordering::SeqCst).is_null();
    #[cfg(target_family = "wasm")]
    false
  }

  /// Queues one wake. The caller holds the phase read lock, in `Open`, so the TSFN is not
  /// released meanwhile. The token is a `Weak`, consumed by the callback on every path.
  fn send_wake(self: &std::sync::Arc<Self>) -> bool {
    let tsfn = self.tsfn.load(Ordering::SeqCst);
    if tsfn.is_null() {
      return false;
    }
    let token = std::sync::Arc::downgrade(self).into_raw();
    let status = unsafe {
      sys::napi_call_threadsafe_function(
        tsfn,
        token.cast_mut().cast(),
        sys::ThreadsafeFunctionCallMode::nonblocking,
      )
    };
    if status != sys::Status::napi_ok {
      drop(unsafe { std::sync::Weak::from_raw(token) });
      return false;
    }
    true
  }

  /// From the custom-GC callback: deletes up to [`MAX_DRAIN`] pending references, and wakes the
  /// JS thread again when more are left. On `env`'s JS thread, env alive.
  fn drain_while_running(self: &std::sync::Arc<Self>, env: sys::napi_env) {
    let batch = {
      let phase = self.read_phase();
      if *phase == CustomGcPhase::Dead {
        return;
      }
      let mut pending = self.lock_pending();
      if pending.len() <= MAX_DRAIN {
        // Under the `pending` lock: a reference added after this sends a new wake.
        self.wake.store(false, Ordering::SeqCst);
        std::mem::take(&mut *pending)
      } else {
        let keep = pending.len() - MAX_DRAIN;
        let batch = pending.split_off(keep);
        drop(pending);
        // `wake` stays set while the next wake is in flight. In `Closing` no wake is sent; the
        // sentinel deletes the rest.
        if *phase != CustomGcPhase::Open || !self.send_wake() {
          self.wake.store(false, Ordering::SeqCst);
        }
        batch
      }
    };
    if batch.is_empty() {
      return;
    }
    let deleted = delete_refs(env, batch);
    REFS_DELETED_RUNNING.fetch_add(deleted, Ordering::Relaxed);
    DRAIN_CALLBACKS.fetch_add(1, Ordering::Relaxed);
    LARGEST_DRAIN.fetch_max(deleted, Ordering::Relaxed);
  }

  /// Moves the phase to `Closing`, releases the TSFN's only thread count with `mode`, and
  /// deletes every pending reference. Called from the registration record's cleanup hook, or
  /// right at registration when there is no record (after [`Self::give_up_sentinel`]).
  ///
  /// It must run before Node closes the TSFN at env teardown: the record's hook runs before the
  /// TSFN's own (hooks run newest first), so the release only drops the thread count to 0.
  /// Taking the write lock waits for any drop that is calling the TSFN right now, and no drop
  /// calls it afterwards. The pointer is swapped out under the lock, so the release happens at
  /// most once. Returns the release status, or `napi_ok` when there was nothing left to release.
  ///
  /// # Safety
  ///
  /// On `env`'s JS thread, while `env` can still delete references.
  pub(crate) unsafe fn close(
    &self,
    env: sys::napi_env,
    mode: sys::napi_threadsafe_function_release_mode,
  ) -> sys::napi_status {
    let (tsfn, refs) = {
      let mut phase = self.write_phase();
      if *phase != CustomGcPhase::Dead {
        *phase = CustomGcPhase::Closing;
      }
      (
        self.tsfn.swap(ptr::null_mut(), Ordering::SeqCst),
        std::mem::take(&mut *self.lock_pending()),
      )
    };
    let status = if tsfn.is_null() {
      sys::Status::napi_ok
    } else {
      unsafe { sys::napi_release_threadsafe_function(tsfn, mode) }
    };
    let deleted = delete_refs(env, refs);
    REFS_DELETED_AT_TEARDOWN.fetch_add(deleted, Ordering::Relaxed);
    status
  }

  /// Backstop for when Node closes the TSFN: no drop calls it again.
  fn mark_closing(&self) {
    let mut phase = self.write_phase();
    if *phase == CustomGcPhase::Open {
      *phase = CustomGcPhase::Closing;
    }
  }

  /// Deletes the sentinel's strong reference, so it is collected as an ordinary object and does
  /// nothing then. For a handle no registration record owns: nothing would keep it alive.
  ///
  /// # Safety
  ///
  /// On `env`'s JS thread, env alive.
  pub(crate) unsafe fn give_up_sentinel(&self, env: sys::napi_env) {
    #[cfg(not(target_family = "wasm"))]
    {
      let sentinel_ref = self.sentinel_ref.swap(ptr::null_mut(), Ordering::SeqCst);
      if !sentinel_ref.is_null() {
        delete_sentinel_ref(env, sentinel_ref);
      }
    }
    #[cfg(target_family = "wasm")]
    let _ = env;
  }

  /// From the late sentinel's finalizer, after it took the sentinel's reference: moves the phase
  /// to `Dead` and deletes every pending reference. On `env`'s JS thread, at env teardown.
  #[cfg(not(target_family = "wasm"))]
  fn finish_teardown(&self, env: sys::napi_env) {
    let (refs, keep_alive) = {
      let mut phase = self.write_phase();
      *phase = CustomGcPhase::Dead;
      (
        std::mem::take(&mut *self.lock_pending()),
        self
          .teardown_keep_alive
          .lock()
          .unwrap_or_else(std::sync::PoisonError::into_inner)
          .take(),
      )
    };
    let deleted = delete_refs(env, refs);
    REFS_DELETED_AT_TEARDOWN.fetch_add(deleted, Ordering::Relaxed);
    drop(keep_alive);
  }
}

/// Deletes the sentinel's strong reference, which the caller swapped out of `sentinel_ref`, so it
/// is deleted once. On `env`'s JS thread, env alive or tearing down: the reference is on the env's
/// plain-reference list, which Node finalizes after the list of wrapped objects
/// (`napi_env__::DeleteMe`), so deleting it from the sentinel's finalizer is allowed.
#[cfg(all(feature = "napi4", not(feature = "noop"), not(target_family = "wasm")))]
fn delete_sentinel_ref(env: sys::napi_env, sentinel_ref: sys::napi_ref) {
  if unsafe { sys::napi_delete_reference(env, sentinel_ref) } == sys::Status::napi_ok {
    SENTINEL_REFS_DELETED.fetch_add(1, Ordering::Relaxed);
  }
}

/// Unrefs each reference and deletes it at refcount 0, as each was created at refcount 1. Returns
/// how many were deleted. On `env`'s JS thread, env alive. Neither call has a `NAPI_PREAMBLE`, on
/// Node or on emnapi, so this works while the env refuses JavaScript.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
fn delete_refs(env: sys::napi_env, refs: Vec<usize>) -> usize {
  let mut deleted = 0;
  for reference in refs {
    let reference = reference as sys::napi_ref;
    let mut ref_count = 0;
    if unsafe { sys::napi_reference_unref(env, reference, &mut ref_count) } == sys::Status::napi_ok
      && ref_count == 0
      && unsafe { sys::napi_delete_reference(env, reference) } == sys::Status::napi_ok
    {
      deleted += 1;
    }
  }
  deleted
}

/// The custom-GC handle of `env`, to capture when a value takes a reference in `env`. Call it on
/// `env`'s JS thread.
///
/// Keyed by env, not by thread: one addon image can be registered into several live envs on one
/// thread (`process.dlopen` twice, a hardlinked `.node`, Electron frames), and each load has its
/// own TSFN that is released at its own env's teardown. `None` when `env` has no live
/// registration record (registration failed, or teardown already ran).
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn custom_gc_handle_for_env(
  env: sys::napi_env,
) -> Option<std::sync::Arc<CustomGcHandle>> {
  // clone = one refcount inc, at from_napi_value capture
  crate::bindgen_runtime::env_registration::custom_gc(env)
}

/// Whether the current thread is the JS thread of `handle`'s env and that env is not torn down:
/// a live registration record on this thread holds this exact handle. Compares allocations, so it
/// is immune to env-pointer reuse.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn current_thread_owns_custom_gc(handle: &std::sync::Arc<CustomGcHandle>) -> bool {
  crate::bindgen_runtime::env_registration::holds_custom_gc(handle)
}

#[cfg(all(feature = "compat-mode", not(feature = "noop")))]
// compatibility for #[module_exports]
static MODULE_EXPORTS: LazyLock<RwLock<Vec<ModuleExportsCallback>>> =
  LazyLock::new(Default::default);

#[cfg(not(feature = "noop"))]
#[inline]
fn wait_first_thread_registered() {
  while !FIRST_MODULE_REGISTERED.load(Ordering::SeqCst) {
    std::hint::spin_loop();
  }
}

#[doc(hidden)]
#[cfg(all(feature = "compat-mode", not(feature = "noop")))]
// compatibility for #[module_exports]
pub fn register_module_exports(callback: ModuleExportsCallback) {
  MODULE_EXPORTS
    .write()
    .expect("Register module exports failed")
    .push(callback);
}

#[cfg(feature = "noop")]
#[doc(hidden)]
pub fn register_module_exports(_: ModuleExportsCallback) {}

#[cfg(not(feature = "noop"))]
#[doc(hidden)]
pub fn register_module_export(
  js_mod: Option<&'static str>,
  name: &'static str,
  cb: ExportRegisterCallback,
) {
  MODULE_REGISTER_CALLBACK
    .write()
    .expect("Register module export failed")
    .push((js_mod, (name, cb)));
}

#[cfg(feature = "noop")]
#[doc(hidden)]
pub fn register_module_export(
  _js_mod: Option<&'static str>,
  _name: &'static str,
  _cb: ExportRegisterCallback,
) {
}

#[cfg(not(feature = "noop"))]
#[doc(hidden)]
pub fn register_module_export_hook(cb: ExportRegisterHookCallback) {
  let mut inner = MODULE_REGISTER_HOOK_CALLBACK
    .write()
    .expect("Write MODULE_REGISTER_HOOK_CALLBACK failed");
  *inner = Some(cb);
}

#[cfg(feature = "noop")]
#[doc(hidden)]
pub fn register_module_export_hook(_cb: ExportRegisterHookCallback) {}

/// The constructor reference of the `#[napi]` class `js_name` (its JS name with a trailing
/// NUL) that this addon defined in `env`.
///
/// Every load of the addon (`process.dlopen` twice, a cache-busted `require`, a hardlinked
/// `.node`, Electron frames) gets its own env and defines its own classes, so the lookup is by
/// env: a load builds, validates and checks instances of its own classes only. `None` when
/// `env` has no live registration (never registered, or already torn down) or that load
/// defined no such class.
#[doc(hidden)]
pub fn get_class_constructor_in_env(
  env: sys::napi_env,
  js_name: &'static str,
) -> Option<sys::napi_ref> {
  crate::bindgen_runtime::env_registration::class_constructor_in_env(env, js_name)
}

/// Legacy lookup, for code generated by napi-derive older than `get_class_constructor_in_env`.
///
/// Returns the constructor reference of class `js_name` from the newest live registration of
/// this addon on the current thread. When the addon is loaded into several envs on one thread,
/// that can be another env's class, so old generated code can still mix up two loads' classes.
/// It never returns a deleted reference: a registration is removed from the lookups before its
/// references are deleted at env teardown.
#[doc(hidden)]
pub fn get_class_constructor(js_name: &'static str) -> Option<sys::napi_ref> {
  crate::bindgen_runtime::env_registration::class_constructor_on_thread(js_name)
}

#[cfg(not(feature = "noop"))]
#[doc(hidden)]
pub fn register_class(
  rust_type_id: TypeId,
  js_mod: Option<&'static str>,
  js_name: &'static str,
  props: Vec<Property>,
  implement_iterator: bool,
) {
  // Worker threads read this registry, and closure owners and retained JS values
  // are not thread-safe.
  #[cfg(feature = "napi5")]
  assert!(
    !props.iter().any(|prop| prop.has_owned_closure()),
    "register_class does not accept closure-backed properties"
  );
  assert!(
    !props.iter().any(|prop| prop.has_js_value()),
    "register_class does not accept properties with JS values or names"
  );
  MODULE_CLASS_PROPERTIES.borrow_mut(|inner| {
    let val = inner.entry(rust_type_id).or_default();
    let val = val.entry(js_mod).or_insert_with(|| ClassRegistration {
      js_name,
      props: Vec::new(),
      implement_iterator,
    });
    val.js_name = js_name;
    val.implement_iterator |= implement_iterator;
    val.props.extend(props);
  });
}

#[cfg(feature = "noop")]
#[doc(hidden)]
#[allow(unused_variables)]
pub fn register_class(
  rust_type_id: TypeId,
  js_mod: Option<&'static str>,
  js_name: &'static str,
  props: Vec<Property>,
  implement_iterator: bool,
) {
}

#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
unsafe extern "C" fn napi_register_wasm_v1(
  env: sys::napi_env,
  exports: sys::napi_value,
) -> sys::napi_value {
  unsafe { napi_register_module_v1(env, exports) }
}

/// Shut this addon's async runtime down while the WebAssembly environment can still call into
/// JavaScript.
///
/// The generated WASI loaders look this export up on the instantiated module and call it,
/// synchronously and on the main thread, as the *first* step of disposing the environment,
/// before `Context::destroy` flips emnapi's `canCallIntoJs` to `false`. It is therefore the
/// last moment at which a background task may still reach its `JsDeferred`: afterwards
/// `napi_call_threadsafe_function` reports `napi_closing`, a settle from a task that is still
/// running traps the instance, and the promise it owned can never settle.
///
/// On every target `napi_register_module_v1` registers `thread_cleanup` with
/// `napi_add_env_cleanup_hook`. Node runs that hook while the env can still call into
/// JavaScript; emnapi runs it from `Context.destroy()`, after JavaScript calls are disabled.
/// This export is the pre-teardown barrier wasm lacks, and it performs the same teardown as the
/// hook, only early enough to be useful.
///
/// # Ordering this guarantees
///
/// 1. The loader calls this export. The environment is still fully active.
/// 2. A registered `AsyncRuntime` backend's `shutdown` hook runs and, per its documented
///    contract, returns only once every backend-owned thread, task, and blocking closure has
///    quiesced.
///    Tasks dropped by that shutdown reject their promises through the cancellation callback,
///    which reaches JavaScript from here.
/// 3. This export returns. Every settle produced on *this* thread has already been delivered —
///    the promises are rejected, their `.then` handlers queued as microtasks. The set of
///    settles left waiting in the threadsafe-function queue is complete: the backend is
///    stopped, so nothing can append to it any more.
///
/// # Delivery, and the part that still needs the loader
///
/// `napi_call_threadsafe_function` only *appends* to the queue; on wasm the queue is dispatched
/// by the host, and `@emnapi/core` dispatches a main-thread call from a *macrotask*, two
/// coalescing turns later. Calling this export and `Context::destroy()` back to back — with no
/// turn of the event loop between them — would therefore strand every promise, because
/// `destroy()` runs the threadsafe function's cleanup hook, which drains the queue with a null
/// env and discards the settles.
///
/// So a settle made on this thread while this export is running does not go through the queue
/// at all: it runs straight into the promise, with the environment still fully alive. That
/// covers `wasm32-wasip1` outright, and every `wasm32-wasip1-threads` task whose cancellation
/// runs on the JavaScript thread. A host that cannot yield — a raw synchronous
/// `Context::destroy()`, a Node `process.on('exit')` handler — gets those promises settled.
///
/// What it cannot cover is a settle produced on *another* thread, which has no way to reach the
/// promise except the queue. [`napi_wasm_env_cleanup_pending`] counts exactly those. A loader
/// that can yield must, after this returns, yield real event-loop turns until that count reports
/// zero and only then destroy the environment; the generated loaders do. A host that cannot
/// yield still cannot get that half of the guarantee — it is the documented limitation of
/// `process.on('exit')`.
///
/// The built-in Tokio path keeps `shutdown_async_runtime`'s existing best-effort
/// `shutdown_background` semantics: it starts the drain here instead of
/// after teardown, but it does not join Tokio's workers. Blocking on them would be the wrong
/// trade on wasm, where this runs on the only thread that can drain the threadsafe-function
/// queue and, in a browser, may not block at all. Addons that need the hard guarantee register
/// an `AsyncRuntime` backend, whose `shutdown` contract provides it.
///
/// # The runtime stays down
///
/// Calling this declares the environment to be disposing, and that declaration outlives the
/// call: the runtime is latched against restart until a *new* environment registers this addon
/// image. Yielding to the event loop — which the drain above requires — lets arbitrary
/// JavaScript run, and an addon export called from it would otherwise restart the runtime this
/// just quiesced, behind the back of a drain that has no way to see the new work. From here on,
/// `start_async_runtime` is a no-op and every runtime-backed call returns a promise rejected
/// with [`Status::Cancelled`](crate::Status) rather than starting work the environment is about
/// to destroy.
///
/// Synchronous exports keep working, with one exception: the built-in Tokio compatibility
/// helpers (`napi::spawn`, `napi::block_on`, `napi::spawn_blocking`) hand back a `JoinHandle`
/// or the future's own output, so they have no way to answer "declined" — they panic instead of
/// accepting work the environment is about to destroy. That is what they already did in every
/// configuration whose runtime the teardown actually drained; the latch extends it to the
/// combined `async-runtime` + `tokio_rt` build, where the built-in runtime is typically never
/// constructed and a post-barrier call would otherwise construct one. See
/// `tokio_runtime::refuse_tokio_helper_during_wasm_env_disposal`.
///
/// Repeated calls are harmless — the loaders guard against them anyway, and the env cleanup hook
/// that `Context.destroy()` runs later performs the same idempotent teardown.
///
/// # The two-phase form
///
/// This export waits: step 2 above returns only once the backend has quiesced, and on
/// `wasm32-wasip1-threads` the thread it waits on is the same JavaScript thread a running
/// blocking closure may be waiting for a turn from. [`napi_prepare_wasm_env_cleanup_begin`],
/// [`napi_wasm_runtime_work_pending`] and [`napi_prepare_wasm_env_cleanup_finish`] are the same
/// teardown split so a loader can put real event-loop turns between the two halves. This export
/// is exactly `begin(); finish();` — a host that cannot yield keeps calling it and keeps
/// today's behaviour, and a loader that has not been taught the split keeps working unchanged.
/// The barrier spans both halves, so the delivery guarantee above is the same either way.
///
/// A loader must feature-detect the split (`typeof … === 'function'`) and fall back to this
/// export, for the same reason it already feature-detects this one: `napi-build` and `napi` are
/// versioned independently.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_prepare_wasm_env_cleanup() {
  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  {
    // Byte for byte the sequence this export has always run, now expressed as its two halves
    // back to back with nothing in between: open the mailbox, latch, raise the barrier, shut the
    // backend down, drain the mailbox, lower the barrier. The split exports exist so a loader
    // can put event-loop turns in the middle; a host that cannot yield calls this one and gets
    // exactly today's behaviour.
    let _ = wasm_env_cleanup_begin();
    wasm_env_cleanup_finish();
  }
}

/// Phase 1 of [`napi_prepare_wasm_env_cleanup`]: shut the addon's async runtime down without
/// waiting for the work that is still running, and report whether any is.
///
/// Returns 1 while the announced stop still owes a wait — backend-owned work that is still
/// live, or a rejected submission whose destructor is still running on another thread — and 0
/// when [`napi_prepare_wasm_env_cleanup_finish`] will not block. A loader that can yield calls this,
/// then turns its event loop — polling [`napi_wasm_runtime_work_pending`] — until it reports the
/// work finished, and calls `finish` then; the poll carries no bound, because a bound would not
/// end the wait, only move it out of reach. Those turns are the whole point: on
/// `wasm32-wasip1-threads` this export is entered from the JavaScript thread, which is also the
/// only thread that can give a running blocking closure the JavaScript turn *it* is waiting for,
/// so joining inside a single call waits for work that can never finish.
///
/// Everything [`napi_prepare_wasm_env_cleanup`] documents about the barrier, the disposal latch
/// and the runtime staying down applies from here — the barrier is raised by this call and stays
/// raised until `finish`, which is what keeps the cancellations the backend produces *during the
/// host's turns* settling straight into their promises instead of into a queue a synchronous
/// `Context.destroy()` would discard.
///
/// A second call before `finish` starts no second teardown and never waits: it just re-reports
/// the poll, so a loader may call it again from a host turn. A backend that does not implement
/// [`AsyncRuntime::begin_shutdown`](crate::bindgen_prelude::AsyncRuntime::begin_shutdown)
/// performs its whole teardown here and reports 0, which is exactly the single-call behaviour.
///
/// Calling `finish` is not optional. It is the call that joins, so a loader that gives up on the
/// poll must still make it — the degradation is back to today's blocking teardown, never to a
/// stranded promise.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_prepare_wasm_env_cleanup_begin() -> u32 {
  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  {
    wasm_env_cleanup_begin()
  }
  #[cfg(not(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  )))]
  {
    0
  }
}

/// Whether the announced stop still owes a wait that
/// [`napi_prepare_wasm_env_cleanup_finish`] would have to make — backend-owned work that is
/// still live, or a rejected submission whose destructor is still running on another thread:
/// 1 yes, 0 no.
///
/// The poll for the window between the two phases. Never blocks and is safe to call at any
/// time, including before any `begin` and after `finish` — it then answers for the runtime as it
/// stands. Never blocking includes locks: the backend answers 1 while a lock its answer is read
/// under is held elsewhere (see
/// [`AsyncRuntime::shutdown_work_pending`](crate::bindgen_prelude::AsyncRuntime::shutdown_work_pending)),
/// so a worker that trapped while holding one costs the loader another turn, in which it sees
/// the crash, instead of parking the JavaScript thread for good. It reports the *runtime's*
/// work, which is a different question from
/// [`napi_wasm_env_cleanup_pending`] (settlements already queued for dispatch) and from
/// [`napi_wasm_async_work_pending`] (`napi_async_work` items); a full disposal drains all three.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_wasm_runtime_work_pending() -> u32 {
  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  {
    wasm_env_cleanup_work_pending()
  }
  #[cfg(not(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  )))]
  {
    0
  }
}

/// Raises the flag the JavaScript thread's cleanup waits check, on `wasm32-wasip1-threads`: a
/// wasm thread of this instance died.
///
/// A pool thread that traps unwinds nothing, so a lock it held stays held and work it was
/// running never retires. [`napi_prepare_wasm_env_cleanup_begin`],
/// [`napi_prepare_wasm_env_cleanup_finish`] and [`napi_prepare_wasm_env_cleanup`] would then
/// wait on the JavaScript thread for good, where the loader cannot see the crash. With the flag
/// up, the `napi-async-runtime` backend's shutdown waits there (they wait in short slices) trap
/// instead, and the loader turns the throw into its crash rejection.
///
/// The generated worker raises the flag through [`napi_wasm_thread_crash_flag_address`] and
/// calls this only when it has no view of that word but has an instance. Either way it does so
/// after it raised the loader's own crash flag, so the loader sees that flag once the trap
/// reaches it.
///
/// Safe to call from the thread that just trapped: it stores one atomic, with no lock and no
/// allocation.
#[cfg(all(target_family = "wasm", napi_wasi_threads, not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_wasm_thread_crashed() {
  napi_sys::wasi_thread_crash::mark_thread_crashed();
}

/// The address in linear memory of the flag [`napi_wasm_thread_crashed`] raises: one 4-byte,
/// 4-aligned word, 0 until a wasm thread of this instance dies.
///
/// The loader reads it once, on the JavaScript thread, and gives each pool worker an
/// `Int32Array` over that word of the shared memory. A worker raises the flag with
/// `Atomics.store`, which needs no instance, so a worker that fails while it loads — after the
/// thread spawn that created it already returned — raises it too; the export above needs the
/// instance that worker never got. The loader and worker feature-detect this export, so an addon
/// built against an older napi keeps the unbounded waits.
#[cfg(all(target_family = "wasm", napi_wasi_threads, not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_wasm_thread_crash_flag_address() -> *const std::sync::atomic::AtomicI32 {
  napi_sys::wasi_thread_crash::thread_crash_flag()
}

/// Phase 2 of [`napi_prepare_wasm_env_cleanup`]: join what
/// [`napi_prepare_wasm_env_cleanup_begin`] left running, replay the cancellations that were
/// parked for this thread, and lower the barrier.
///
/// This is the call that delivers the quiescence guarantee, so it may block — a loader that
/// exhausted its poll budget still has to make it, and simply blocks as a single-call teardown
/// would have. Afterwards the addon is in exactly the state one `napi_prepare_wasm_env_cleanup`
/// leaves it in, and the loader continues with the settlement drain
/// ([`napi_wasm_env_cleanup_pending`]) and `Context.destroy()`.
///
/// Idempotent: a `finish` with no `begin` outstanding is a no-op — it tears nothing down,
/// replays nothing and lowers no barrier — so an unpaired or repeated call cannot leave the
/// barrier counter below zero or shut a restarted runtime down behind a loader's back.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_prepare_wasm_env_cleanup_finish() {
  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  {
    wasm_env_cleanup_finish();
  }
}

/// Whether a [`wasm_env_cleanup_begin`] is outstanding — that is, whether the barrier is raised
/// and a [`wasm_env_cleanup_finish`] is owed.
///
/// A plain static rather than a thread local: the cleanup exports are entered from the
/// JavaScript thread only (emnapi runs module registration, and therefore the whole disposal
/// handshake, on the main thread), and this also has to be observable from the module
/// registration that releases it.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
static WASM_ENV_CLEANUP_BEGUN: AtomicBool = AtomicBool::new(false);

/// The shared body of `napi_prepare_wasm_env_cleanup_begin` and the first half of
/// `napi_prepare_wasm_env_cleanup`.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
fn wasm_env_cleanup_begin() -> u32 {
  // A second phase 1 re-reports the poll and does nothing else: it must not raise the barrier
  // again (the matching `finish` lowers it once), must not re-open the mailbox, and must not
  // start a second backend teardown over the one already outstanding.
  if WASM_ENV_CLEANUP_BEGUN.load(Ordering::SeqCst) {
    return wasm_env_cleanup_work_pending();
  }
  // Park, then replay on this thread: a backend that drops a cancelled task on one of its own
  // worker threads (the `napi-async-runtime` crate's MultiThread flavor on
  // `wasm32-wasip1-threads` routinely does) would otherwise reject that task's promise from
  // the worker, where the settle can only go into the threadsafe-function queue — and a host
  // that calls the raw, synchronous `Context.destroy()` drains that queue with a null env and
  // discards it. Opening before the shutdown covers every cancellation it produces; draining in
  // `finish`, still inside the barrier, is what makes each of those rejections settle its
  // promise directly. See `tokio_runtime::WASM_CANCEL_MAILBOX`.
  #[cfg(feature = "async-runtime")]
  crate::tokio_runtime::open_wasm_cancel_mailbox();
  // Latch *before* the shutdown, and leave it latched after this returns: the drain that
  // follows is an event loop, so the rejections this shutdown delivers run their JavaScript
  // handlers while the environment is still alive, and an addon export called from one of them
  // would otherwise restart the very runtime that just quiesced — behind the back of a drain
  // that cannot see the restarted work. Runtime-backed calls made from here on reject with a
  // defined error instead.
  crate::tokio_runtime::latch_wasm_env_disposal();
  // Deliver, do not queue: for as long as the barrier is raised, a `JsDeferred` settled on this
  // thread settles its promise directly instead of appending to a queue the host dispatches two
  // macrotasks later — which a caller that destroys the environment synchronously never
  // reaches. It stays raised across the host's turns and is lowered by `finish`, so ordinary
  // settles after the teardown go back through the queue.
  crate::js_values::enter_wasm_env_cleanup_barrier();
  // Record the outstanding phase BEFORE the backend call: that call runs cancellation callbacks,
  // and anything they reach must see a handshake in progress.
  WASM_ENV_CLEANUP_BEGUN.store(true, Ordering::SeqCst);
  u32::from(crate::tokio_runtime::begin_shutdown_async_runtime())
}

/// The shared body of `napi_wasm_runtime_work_pending`.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
fn wasm_env_cleanup_work_pending() -> u32 {
  u32::from(crate::tokio_runtime::async_runtime_work_pending())
}

/// The shared body of `napi_prepare_wasm_env_cleanup_finish` and the second half of
/// `napi_prepare_wasm_env_cleanup`.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
fn wasm_env_cleanup_finish() {
  // No phase 1 outstanding: tear nothing down and, crucially, lower no barrier — the counter
  // this would decrement belongs to whoever raised it.
  if !WASM_ENV_CLEANUP_BEGUN.swap(false, Ordering::SeqCst) {
    return;
  }
  crate::tokio_runtime::finish_shutdown_async_runtime();
  // Still inside the barrier, so every parked rejection settles its promise directly.
  #[cfg(feature = "async-runtime")]
  crate::tokio_runtime::drain_wasm_cancel_mailbox();
  crate::js_values::leave_wasm_env_cleanup_barrier();
}

/// Unwind a phase 1 whose phase 2 never ran, at the only point where a new environment can take
/// over this image: [`napi_register_module_v1`].
///
/// Phase 1 leaves four pieces of state behind — [`WASM_ENV_CLEANUP_BEGUN`], the registry's phase
/// (`begin_deactivate` does not reset it; only `finish_deactivate` does), the cancel mailbox and
/// the cleanup barrier on this thread. A host that walked away between the phases and then
/// registered a new environment over the same linear memory would otherwise inherit all four:
/// its first dispatch would spawn into a backend that already stopped and that nothing will
/// start again, every `JsDeferred` settled on this thread would bypass the threadsafe-function
/// queue for the rest of the process, and the next teardown's drain would invoke cancellation
/// callbacks belonging to the environment that went away.
///
/// # Two outcomes, and neither of them joins
///
/// Registration must never block. It runs on the JavaScript thread with no host turn available
/// until it returns, which is the very thing phase 2 may need: on `wasm32-wasip1-threads` the
/// backend work phase 1 left running can be waiting for a JavaScript turn of its own (see
/// `examples/custom-async-runtime/src/lib.rs`, `begin_shutdown`). Joining here would wait for
/// work that only this thread could release — the deadlock the two-phase split exists to avoid.
/// So the poll decides:
///
/// * **[`crate::tokio_runtime::async_runtime_work_pending`] reads false** — phase 2 has nothing
///   to wait for, so run it. It delivers the quiescence the abandoned disposal owed and resets
///   the registry to `Idle`, which is what lets the new environment start the backend again.
///   Registration continues normally.
/// * **It reads true** — do not join. Lower the barrier, take the mailbox out of the way, leave
///   the registry phase, the owed `finish` ([`WASM_ENV_CLEANUP_BEGUN`] stays set) and the
///   disposal latch exactly as phase 1 left them, and refuse the registration with an error
///   naming the call the host skipped. The image stays in the state a loader can still finish:
///   once the work is released, `napi_prepare_wasm_env_cleanup_finish` joins it from a real host
///   turn and the next registration takes the branch above.
///
/// The barrier comes down in both, and neither replays what is parked: see
/// [`crate::tokio_runtime::discard_wasm_cancel_mailbox`].
///
/// Runs on the JavaScript thread: emnapi registers modules on the main thread only, which is the
/// same thread phase 1 ran on, so the barrier lowered here is the one that was raised — and the
/// same thread the cleanup exports are entered from, so the non-atomic read/write pair below
/// races with nobody.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
fn unwind_abandoned_wasm_env_cleanup() -> std::result::Result<(), &'static CStr> {
  if !WASM_ENV_CLEANUP_BEGUN.load(Ordering::SeqCst) {
    return Ok(());
  }
  // Lower the barrier *first*, before anything below can produce a single cancellation. A
  // cancellation raised on this thread while the barrier is up is invoked on the spot
  // (`tokio_runtime::park_cancel_for_js_thread`), and "on the spot" now means rejecting a
  // deferred whose environment is gone. With the barrier down, a cancellation from any thread
  // is parked in the still-open mailbox instead — and taken out of the way below.
  crate::js_values::reset_wasm_env_cleanup_barrier();
  if crate::tokio_runtime::async_runtime_work_pending() {
    // The abandoned teardown still owes a join, and this is the one place that must not perform
    // it. Everything that outlives this call is left standing on purpose: the registry phase, so
    // a later `finish` still joins the real backend; `WASM_ENV_CLEANUP_BEGUN`, so that `finish`
    // is not a no-op; and the disposal latch, so nothing restarts a runtime that is still
    // stopping. Only the mailbox goes, because its entries belong to the environment that walked
    // away.
    #[cfg(feature = "async-runtime")]
    crate::tokio_runtime::discard_wasm_cancel_mailbox();
    return Err(c"Cannot register a new environment over this addon image: the previous environment's two-phase wasm env cleanup was abandoned with async runtime work still pending, and finishing it here would join work that is waiting for a JavaScript turn this registration is holding. Call napi_prepare_wasm_env_cleanup_finish (once napi_wasm_runtime_work_pending reads 0) before re-registering.");
  }
  // Phase 2 for real — it cannot wait, because nothing is pending — and the handshake is over.
  WASM_ENV_CLEANUP_BEGUN.store(false, Ordering::SeqCst);
  crate::tokio_runtime::finish_shutdown_async_runtime();
  #[cfg(feature = "async-runtime")]
  crate::tokio_runtime::discard_wasm_cancel_mailbox();
  Ok(())
}

/// How many promise settlements are queued in the threadsafe-function queue and have not been
/// dispatched back into JavaScript yet.
///
/// This is the settlement half of the [`napi_prepare_wasm_env_cleanup`] handshake. The barrier
/// makes the queued set complete; this export makes it observable, so the generated loaders can
/// yield event-loop turns until it reads zero and destroy the environment only then. Without
/// it a loader could only guess a turn count, and the guess would be wrong the moment
/// `@emnapi/core` changed how it coalesces wakeups — or the moment the settle came from a
/// `wasm32-wasip1-threads` worker, whose wakeup needs a `postMessage` round trip first.
///
/// It counts only settles that are already in the queue, never promises that are merely
/// pending, so a long-running task that shutdown did not cancel cannot make a loader spin.
///
/// Loaders must still bound their wait: this reaching zero is the success condition, not a
/// promise that it always will.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_wasm_env_cleanup_pending() -> u32 {
  #[cfg(feature = "napi4")]
  {
    crate::js_values::pending_deferred_settles()
  }
  #[cfg(not(feature = "napi4"))]
  {
    0
  }
}

/// How many `napi_async_work` this addon has queued that have not completed yet.
///
/// The async-work half of the same teardown handshake as
/// [`napi_wasm_env_cleanup_pending`]. That counter covers promise settlements sitting in the
/// threadsafe-function queue; it says nothing about `napi_async_work`, which
/// [`napi_prepare_wasm_env_cleanup`] does not touch at all. A loader that destroys the
/// environment — or terminates the pool threads — with a work still outstanding strands it:
/// the completion callback can no longer run, so the promise never settles and the emnapi
/// waiting-request counter that brackets the work never returns to zero, which on Node keeps a
/// `MessageChannel` port referenced and the process alive.
///
/// So the generated loaders drain first: cancel with
/// [`napi_wasm_cancel_pending_async_work`], then poll this until it reads zero, and only then
/// run the barrier and destroy. Unlike the settlement drain this one has no bound — reaching
/// zero is not merely the success condition, it is the only outcome that is not the stranding
/// it exists to prevent, and a task whose `execute` never returns would keep an *undisposed*
/// process alive in exactly the same way.
///
/// Counts work that is merely queued as well as work already executing: both still owe a
/// completion callback.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_wasm_async_work_pending() -> u32 {
  crate::async_work::pending_async_work()
}

/// Cancels every outstanding `napi_async_work`, and answers how many cancellations were
/// accepted.
///
/// The cancelling half of the handshake above, so that a drain waits only for work that is
/// actually running. `napi_cancel_async_work` succeeds only for a work no thread has started;
/// its completion callback then runs with `napi_cancelled`, which this crate turns into a
/// promise rejected with an `AbortError`. A refused cancellation means the work is already
/// executing and is left to finish normally — which it can, because a loader calls this before
/// terminating anything.
///
/// Either way the work reaches the same completion callback as an ordinary one, so the
/// registry behind [`napi_wasm_async_work_pending`] and the emnapi waiting-request counter
/// balance themselves. The return value is informational; a loader still polls the count.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[no_mangle]
extern "C" fn napi_wasm_cancel_pending_async_work() -> u32 {
  crate::async_work::cancel_pending_async_work()
}

#[cfg(not(feature = "noop"))]
#[no_mangle]
/// Register the n-api module exports.
///
/// # Safety
/// This method is meant to be called by Node.js while importing the n-api module.
/// Only call this method if the current module is **not** imported by a node-like runtime.
///
/// Arguments `env` and `exports` must **not** be null.
pub unsafe extern "C" fn napi_register_module_v1(
  env: sys::napi_env,
  exports: sys::napi_value,
) -> sys::napi_value {
  #[cfg(any(
    target_env = "msvc",
    all(not(target_family = "wasm"), feature = "dyn-symbols")
  ))]
  unsafe {
    sys::setup();
  }
  // A disposal that began and was never finished (a host that walked away between the phases)
  // must not make the new environment's first `begin` a no-op, leave it dispatching into a
  // backend that already stopped, or hand it a raised barrier and a mailbox holding the previous
  // environment's cancellations. This runs before any module-init callback, so no addon code can
  // observe the half-unwound state in between — and before the latch release below, so the
  // runtime stays refused for the whole of it (see `tokio_runtime::WASM_ENV_DISPOSING`).
  //
  // Two outcomes, neither of which joins: with no backend work pending it completes the
  // abandoned phase 2 and registration continues; with work still pending it cannot complete
  // anything without blocking this thread forever, so it leaves the owed `finish` standing and
  // registration fails loudly instead. See `unwind_abandoned_wasm_env_cleanup`.
  #[cfg(all(
    target_family = "wasm",
    not(feature = "noop"),
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  if let Err(message) = unwind_abandoned_wasm_env_cleanup() {
    unsafe { sys::napi_throw_error(env, ptr::null_mut(), message.as_ptr()) };
    return ptr::null_mut();
  }
  // A new environment is registering this addon image, so whatever disposal latched the runtime
  // against restart is over. This is the only release point, and the only one that is safe:
  // emnapi runs module registration on the main thread only, so a `wasm32-wasip1-threads` worker
  // sharing this linear memory can never reach it mid-disposal. See
  // `tokio_runtime::WASM_ENV_DISPOSING`.
  #[cfg(all(
    target_family = "wasm",
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  crate::tokio_runtime::release_wasm_env_disposal_latch();
  #[cfg(feature = "node_version_detect")]
  {
    NODE_VERSION.get_or_init(|| {
      let mut node_version = MaybeUninit::uninit();
      check_status_or_throw!(
        env,
        unsafe { sys::napi_get_node_version(env, node_version.as_mut_ptr()) },
        "Failed to get node version"
      );
      let node_version = *node_version.assume_init();
      unsafe {
        NODE_VERSION_MAJOR = node_version.major;
        NODE_VERSION_MINOR = node_version.minor;
        NODE_VERSION_PATCH = node_version.patch;
      }
      NodeVersion {
        major: node_version.major,
        minor: node_version.minor,
        patch: node_version.patch,
        release: unsafe { CStr::from_ptr(node_version.release).to_str().unwrap() },
      }
    });
  }

  if MODULE_COUNT.fetch_add(1, Ordering::SeqCst) != 0 {
    wait_first_thread_registered();
  }

  // Create the per-env custom-GC handle (#3357) BEFORE running ANY module-init
  // callback below (the export-register callbacks, `module_register_hook_callback`,
  // and the compat `MODULE_EXPORTS` callbacks). Those callbacks can capture a
  // `Buffer`/`TypedArray` via `from_napi_value`, which looks up this env's handle
  // in its registration record. If the handle were stored afterwards (as it was
  // originally), such a value would record `None`; because `Buffer`/`TypedArray`
  // are `Send`, dropping it later on a non-JS thread would fall through to a direct
  // `napi_reference_unref(env, ..)` on the WRONG thread — the cross-isolate
  // use-after-free this change exists to prevent. `create_custom_gc` only needs a
  // valid `env` (it creates the per-env TSFN with no JS callback and never reads
  // `exports`), so running it this early is safe. It must also run BEFORE
  // `env_registration::begin` below, so the record's cleanup hook (added later)
  // runs before Node's own cleanup for the TSFN (added by its creation).
  // Local change: release the records of earlier envs on this thread that were
  // never torn down (see `env_registration::release_superseded_envs`).
  #[cfg(all(feature = "napi3", not(target_family = "wasm")))]
  crate::bindgen_runtime::env_registration::release_superseded_envs(env);

  #[cfg(feature = "napi4")]
  let custom_gc = create_custom_gc(env);

  // Record this load's per-env state and add the one env cleanup hook that
  // tears it down. Keep this AFTER `create_custom_gc` and BEFORE the first
  // module-init callback: hooks run newest first, so the record's hook then runs
  // after every hook the module's exports add (they can still use the record)
  // and before Node's own custom-GC TSFN cleanup. `None` means teardown cannot
  // be observed, so nothing may be cached for this env, and the load fails: the
  // export callbacks, the classes and the module-init hooks below are skipped,
  // because class lookups read the record. The async runtime and its cleanup hook
  // still run, because `MODULE_COUNT` was already bumped above and
  // `thread_cleanup` is its only decrement.
  let registration = crate::bindgen_runtime::env_registration::begin(env);
  // The record stays marked as registering until this function returns, on every path. How
  // this env's `AsyncTask` promises settle is picked at its first task after that (see
  // `crate::async_work::promise`): the check reads `process.versions`, whose getter may load
  // another addon, and Node holds its addon-loader lock, which is not re-entrant, while this
  // addon registers. Tasks that the module-init callbacks below create take the thenable path.
  let _registering =
    registration.map(crate::bindgen_runtime::env_registration::RegisteringGuard::new);
  if registration.is_none() {
    unsafe {
      sys::napi_throw_error(
        env,
        ptr::null_mut(),
        c"Failed to add env cleanup hook".as_ptr(),
      )
    };
  }

  // Hand the custom-GC handle to the record, which releases the TSFN from its
  // cleanup hook. Without a record nothing would ever release it (and on Node
  // >= 24.13.1, >= 25.4.0 and emnapi it would never be freed), so release it
  // right away instead. No value can capture it, because captures look the
  // handle up in the record: values captured in this env then record no
  // handle, as when `create_custom_gc` fails.
  #[cfg(feature = "napi4")]
  if let Some(custom_gc) = custom_gc {
    let unowned = match registration {
      Some(registration) => {
        crate::bindgen_runtime::env_registration::set_custom_gc(registration, custom_gc).err()
      }
      None => Some(custom_gc),
    };
    if let Some(custom_gc) = unowned {
      unsafe {
        custom_gc.give_up_sentinel(env);
        custom_gc.close(env, sys::ThreadsafeFunctionReleaseMode::abort);
      }
    }
  }

  // Resolve and cache this env's `Reflect.getOwnPropertyDescriptor` pair NOW,
  // at registration, so `Error::from_unknown_without_coercion` never reads
  // `Reflect` off the global object mid-capture. That read is an ordinary
  // `[[Get]]`: user code can redefine `globalThis.Reflect` as an accessor, and
  // a per-capture read would run that accessor — arbitrary user code, free to
  // reenter the addon — while an error is unwinding. Registration is the
  // defined moment where the one unavoidable `[[Get]]` may happen. Best effort:
  // a failure, or no registration record, leaves capture degrading to an empty
  // reason/cause.
  if let Some(registration) = registration {
    crate::error::cache_reflect_intrinsics_for_env(env, registration);
  }

  // Registration keys are compile-time strings. Avoid `RandomState` so WASI module
  // registration does not request randomness during workerd global initialization.
  let mut namespaces = Namespaces::default();

  if registration.is_some() {
    let mut register_callback = MODULE_REGISTER_CALLBACK
      .write()
      .expect("Write MODULE_REGISTER_CALLBACK in napi_register_module_v1 failed");
    register_callback
      .iter_mut()
      .fold(
        HashMap::<
          Option<&'static str>,
          Vec<(&'static str, ExportRegisterCallback)>,
          FxBuildHasher,
        >::with_hasher(FxBuildHasher),
        |mut acc, (js_mod, item)| {
          if let Some(k) = acc.get_mut(js_mod) {
            k.push(*item);
          } else {
            acc.insert(*js_mod, vec![*item]);
          }
          acc
        },
      )
      .iter()
      .for_each(|(js_mod, items)| {
        for (name, callback) in items {
          unsafe {
            if let Err(e) = callback(env)
              .and_then(|v| namespaces.export(env, exports, *js_mod, name, v, "export"))
            {
              JsError::from(e).throw_into(env)
            }
          }
        }
      });
  }

  // Class registration is all or nothing. Each load keeps its classes in its own
  // registration record, which is what every class lookup of that load reads
  // (class-returning exports, strict and `Either` validation, `instance_of`), so a
  // load never reads or replaces another load's classes. A load that fails part way
  // stops at the first failure, deletes the constructor references it made, and
  // leaves its record without classes, so its lookups fail with a clean "Failed to
  // get constructor". The module-init hooks below assume a complete registration
  // and are skipped too; the async runtime and its cleanup hook still run, because
  // `MODULE_COUNT` was already bumped above and `thread_cleanup` is its only
  // decrement.
  //
  // The record's cleanup hook deletes the references at env teardown, after it has
  // removed the record from the lookups.
  let classes_registered = registration.is_some_and(|registration| {
    let mut ctor_refs = Vec::new();
    if let Err(error) = unsafe { register_classes(env, exports, &mut namespaces, &mut ctor_refs) } {
      for (_, ctor_ref) in ctor_refs {
        unsafe { sys::napi_delete_reference(env, ctor_ref) };
      }
      unsafe { JsError::from(error).throw_into(env) };
      return false;
    }
    let mut classes = crate::bindgen_runtime::env_registration::ClassConstructors::default();
    for (js_name, ctor_ref) in ctor_refs {
      // Two classes under one JS name: the last one wins the lookup, as it always
      // did, and the reference nothing can find any more is deleted.
      if let Some(superseded) = classes.insert(js_name, ctor_ref) {
        unsafe { sys::napi_delete_reference(env, superseded) };
      }
    }
    match crate::bindgen_runtime::env_registration::set_classes(registration, classes) {
      Ok(()) => true,
      // Unreachable: the record was created above on this thread and only its own
      // env's teardown removes it.
      Err(classes) => {
        for ctor_ref in classes.into_values() {
          unsafe { sys::napi_delete_reference(env, ctor_ref) };
        }
        unsafe {
          sys::napi_throw_error(
            env,
            ptr::null_mut(),
            c"Failed to record the classes of this addon".as_ptr(),
          )
        };
        false
      }
    }
  });

  // Namespaces go on after every top-level export and class, so a namespace merges into the
  // value exported under its name instead of replacing it, whatever the registration order.
  // Skipped when the classes failed: that path has already thrown, and the load fails.
  let namespaces_attached = classes_registered
    && match unsafe { namespaces.attach(env, exports) } {
      Ok(()) => true,
      Err(error) => {
        unsafe { JsError::from(error).throw_into(env) };
        false
      }
    };

  if namespaces_attached {
    let module_register_hook_callback = MODULE_REGISTER_HOOK_CALLBACK
      .read()
      .expect("Read MODULE_REGISTER_HOOK_CALLBACK failed");
    if let Some(cb) = module_register_hook_callback.as_ref() {
      if let Err(e) = cb(env, exports) {
        JsError::from(e).throw_into(env);
      }
    }

    #[cfg(feature = "compat-mode")]
    {
      let module_exports = MODULE_EXPORTS.read().expect("Read MODULE_EXPORTS failed");
      module_exports.iter().for_each(|callback| unsafe {
        if let Err(e) = callback(env, exports) {
          JsError::from(e).throw_into(env);
        }
      })
    }
  }

  #[cfg(feature = "napi4")]
  {
    // NOTE: `create_custom_gc(env)` is intentionally NOT called here. It now runs
    // earlier in `register` (before any module-init callback) so a value captured
    // during a hook gets a real per-env handle instead of `None` (#3357).
    #[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
    {
      crate::tokio_runtime::start_async_runtime();
      {
        // Register a cleanup hook for EVERY registration, not just the first one.
        // `MODULE_COUNT` is incremented on every `napi_register_module_v1` call and
        // `thread_cleanup` decrements it once per env teardown, shutting the shared
        // async runtime down only when the count reaches zero (the last live env).
        // A process-wide one-shot gate used to install the hook for the first
        // registration only, so additional or recreated envs (`worker_threads`,
        // Electron renderer reload) bumped the count with no matching cleanup hook:
        // the count never returned to zero and `shutdown_async_runtime` was never
        // called, leaking backend threads/tasks that outlived the addon image.
        //
        // Each registration gets a distinct cookie so repeated loads of the same
        // addon into one env (`unload.spec.js`) don't collide on Node's unique
        // `(fn, arg)` assertion; the cookie is opaque and never dereferenced.
        //
        // wasm uses the hook too (emnapi runs it from `Context.destroy()`), never a
        // finalizer on `exports`: emnapi's finalizer registry would keep the whole
        // instance alive through such a finalizer, so a dropped instance is never
        // collected.
        let cleanup_cookie =
          ENV_CLEANUP_HOOK_COOKIE.fetch_add(1, Ordering::Relaxed) as *mut std::ffi::c_void;
        #[cfg(not(target_family = "wasm"))]
        let status =
          unsafe { sys::napi_add_env_cleanup_hook(env, Some(thread_cleanup), cleanup_cookie) };
        // `sys::` would import the symbol from the `env` wasm module; emnapi provides it
        // under `napi` (see `crate::napi_add_env_cleanup_hook`).
        #[cfg(target_family = "wasm")]
        let status =
          unsafe { crate::napi_add_env_cleanup_hook(env, Some(thread_cleanup), cleanup_cookie) };
        check_status_or_throw!(env, status, "Failed to add env cleanup hook");
      }
    }
  }

  FIRST_MODULE_REGISTERED.store(true, Ordering::SeqCst);
  exports
}

/// The namespaced exports of one load, kept until every top-level export and class exists.
#[cfg(not(feature = "noop"))]
#[derive(Default)]
struct Namespaces {
  /// The members of each namespace by path (`"a.b"`, no trailing NUL), in registration order.
  /// Member names keep their trailing NUL.
  members: HashMap<&'static str, Vec<(&'static str, sys::napi_value)>, FxBuildHasher>,
}

#[cfg(not(feature = "noop"))]
impl Namespaces {
  /// Sets a top-level export (`js_mod` is `None`) on `exports` now, or keeps a namespaced one
  /// for [`Namespaces::attach`]. `name` ends with a NUL.
  unsafe fn export(
    &mut self,
    env: sys::napi_env,
    exports: sys::napi_value,
    js_mod: Option<&'static str>,
    name: &'static str,
    value: sys::napi_value,
    kind: &str,
  ) -> Result<()> {
    if let Some(js_mod) = js_mod {
      self
        .members
        .entry(strip_nul(js_mod))
        .or_default()
        .push((name, value));
      return Ok(());
    }
    let js_name = unsafe { CStr::from_bytes_with_nul_unchecked(name.as_bytes()) };
    check_status!(
      unsafe { sys::napi_set_named_property(env, exports, js_name.as_ptr(), value) },
      "Failed to register {} `{}`",
      kind,
      strip_nul(name),
    )
  }

  /// Puts every namespace on `exports`, parents before children, and then its members.
  ///
  /// When the path of a namespace already holds a function or an object as an own property
  /// (a `#[napi]` function, a class, an enum or another namespace), the namespace merges into
  /// that value, the way TypeScript merges `function f` with `namespace f`. The generated d.ts
  /// already declares both. These fail the load instead of dropping or replacing a value:
  /// - the path holds a primitive, such as a `const` (TypeScript rejects it too, TS2451);
  /// - the value is a function and the namespace or a member would replace one of its own
  ///   properties, such as a class static or `prototype` (TS2300).
  ///
  /// In a plain object (a namespace or an enum), a member replaces an own property of the
  /// same name, as a set did before. So a second load into the same `module.exports` works.
  unsafe fn attach(&self, env: sys::napi_env, exports: sys::napi_value) -> Result<()> {
    let paths = namespace_paths(self.members.keys().copied())?;
    // Each namespace's object, and whether it is a function (a `#[napi]` function or a class).
    let mut objects: HashMap<&str, (sys::napi_value, bool), FxBuildHasher> =
      HashMap::with_capacity_and_hasher(paths.len(), FxBuildHasher);
    for path in paths {
      let (parent, name) = match path.rsplit_once('.') {
        // The parent is shallower, so it is already in `objects`.
        Some((parent_path, name)) => {
          let (parent, parent_is_function) = objects[parent_path];
          let key = unsafe { property_key(env, name) }?;
          // Under a function, only a member of the parent namespace can hold this namespace.
          // Any other own property (a class static, `prototype`, `name`) belongs to the class.
          if parent_is_function
            && !self.is_member(parent_path, name)
            && unsafe { has_own(env, parent, key, path) }?
          {
            return Err(Error::new(
              Status::InvalidArg,
              format!(
                "Cannot export namespace `{path}`: `{parent_path}` already has a property `{name}`"
              ),
            ));
          }
          (parent, name)
        }
        None => (exports, path),
      };
      let key = unsafe { property_key(env, name) }?;
      let mut value_type = sys::ValueType::napi_object;
      let object = if unsafe { has_own(env, parent, key, path) }? {
        let mut value = ptr::null_mut();
        check_status!(
          unsafe { sys::napi_get_property(env, parent, key, &mut value) },
          "Failed to read export `{}`",
          path
        )?;
        check_status!(
          unsafe { sys::napi_typeof(env, value, &mut value_type) },
          "Failed to read export `{}`",
          path
        )?;
        if value_type != sys::ValueType::napi_object && value_type != sys::ValueType::napi_function
        {
          return Err(Error::new(
            Status::InvalidArg,
            format!(
              "Cannot export namespace `{path}`: `{path}` already holds a value that is not a function or an object"
            ),
          ));
        }
        value
      } else {
        let mut object = ptr::null_mut();
        check_status!(
          unsafe { sys::napi_create_object(env, &mut object) },
          "Create export JavaScript Object [{}] failed",
          path
        )?;
        unsafe { define_property(env, parent, ptr::null(), key, object, path) }?;
        object
      };
      let is_function = value_type == sys::ValueType::napi_function;
      objects.insert(path, (object, is_function));

      let members = self.members.get(path).map_or(&[][..], Vec::as_slice);
      for (i, &(member, value)) in members.iter().enumerate() {
        let full_name = format!("{path}.{}", strip_nul(member));
        // A member must not replace a property of a function, such as a class static or
        // `prototype` (TypeScript rejects it too, TS2300). A repeat of a member replaces the
        // earlier one, as it always did.
        if is_function && !members[..i].iter().any(|(earlier, _)| *earlier == member) {
          let member_key = unsafe { property_key(env, strip_nul(member)) }?;
          if unsafe { has_own(env, object, member_key, &full_name) }? {
            return Err(Error::new(
              Status::InvalidArg,
              format!(
                "Cannot export `{full_name}`: `{path}` already has a property `{}`",
                strip_nul(member)
              ),
            ));
          }
        }
        let utf8name = unsafe { CStr::from_bytes_with_nul_unchecked(member.as_bytes()) };
        unsafe {
          define_property(
            env,
            object,
            utf8name.as_ptr(),
            ptr::null_mut(),
            value,
            &full_name,
          )
        }?;
      }
    }
    Ok(())
  }

  fn is_member(&self, path: &str, name: &str) -> bool {
    self
      .members
      .get(path)
      .is_some_and(|members| members.iter().any(|(member, _)| strip_nul(member) == name))
  }
}

#[cfg(not(feature = "noop"))]
unsafe fn has_own(
  env: sys::napi_env,
  object: sys::napi_value,
  key: sys::napi_value,
  path: &str,
) -> Result<bool> {
  let mut has = false;
  check_status!(
    unsafe { sys::napi_has_own_property(env, object, key, &mut has) },
    "Failed to read export `{}`",
    path
  )?;
  Ok(has)
}

/// Every namespace path in `paths` and all of its parents, parents first. Within one depth the
/// paths are in name order, so the first error is the same on every load.
#[cfg(not(feature = "noop"))]
fn namespace_paths<'a>(paths: impl IntoIterator<Item = &'a str>) -> Result<Vec<&'a str>> {
  let mut all = Vec::new();
  for mut path in paths {
    loop {
      all.push(path);
      match path.rsplit_once('.') {
        Some((parent, _)) => path = parent,
        None => break,
      }
    }
  }
  all.sort_unstable_by_key(|path| (path.matches('.').count(), *path));
  all.dedup();
  if let Some(path) = all.iter().find(|path| path.contains('\0')) {
    return Err(Error::new(
      Status::InvalidArg,
      format!("Namespace `{}` contains a NUL byte", path.escape_debug()),
    ));
  }
  Ok(all)
}

#[cfg(not(feature = "noop"))]
fn strip_nul(name: &'static str) -> &'static str {
  name.strip_suffix('\0').unwrap_or(name)
}

#[cfg(not(feature = "noop"))]
unsafe fn property_key(env: sys::napi_env, name: &str) -> Result<sys::napi_value> {
  let mut key = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_create_string_utf8(env, name.as_ptr().cast(), name.len() as isize, &mut key)
    },
    "Failed to create the property key `{}`",
    name
  )?;
  Ok(key)
}

/// Defines a writable, enumerable and configurable data property, as a set would make. A set
/// would also run an inherited setter, such as `Function.prototype.caller` on a merged
/// function, which drops the value. The name is `utf8name` when it is not null, else `key`.
#[cfg(not(feature = "noop"))]
unsafe fn define_property(
  env: sys::napi_env,
  object: sys::napi_value,
  utf8name: *const std::ffi::c_char,
  key: sys::napi_value,
  value: sys::napi_value,
  path: &str,
) -> Result<()> {
  let descriptor = sys::napi_property_descriptor {
    utf8name,
    name: key,
    method: None,
    getter: None,
    setter: None,
    value,
    attributes: sys::PropertyAttributes::writable
      | sys::PropertyAttributes::enumerable
      | sys::PropertyAttributes::configurable,
    data: ptr::null_mut(),
  };
  check_status!(
    unsafe { sys::napi_define_properties(env, object, 1, &descriptor) },
    "Failed to register export `{}`",
    path
  )
}

/// Defines every registered class and sets it on `exports`, or adds it to the members of
/// its `js_mod` namespace for `Namespaces::attach`.
///
/// Stops at the first failure and returns it without throwing. Every constructor
/// reference made before that point is in `ctor_refs`, so the caller can delete them.
#[cfg(not(feature = "noop"))]
unsafe fn register_classes(
  env: sys::napi_env,
  exports: sys::napi_value,
  namespaces: &mut Namespaces,
  ctor_refs: &mut Vec<(&'static str, sys::napi_ref)>,
) -> Result<()> {
  MODULE_CLASS_PROPERTIES.borrow(|inner| {
    for js_mods in inner.values() {
      for (js_mod, class_registration) in js_mods {
        unsafe {
          let js_name = class_registration.js_name;
          let props = &class_registration.props;
          let (ctor, props): (Vec<_>, Vec<_>) = props.iter().partition(|prop| prop.is_ctor);

          let ctor = ctor
            .first()
            .map(|c| c.raw(env))
            .transpose()?
            .and_then(|c| c.method)
            .unwrap_or(noop);
          let raw_props = props
            .iter()
            .map(|prop| prop.raw(env))
            .collect::<Result<Vec<_>>>()?;

          let js_class_name = CStr::from_bytes_with_nul_unchecked(js_name.as_bytes());
          let mut class_ptr = ptr::null_mut();

          check_status!(
            sys::napi_define_class(
              env,
              js_class_name.as_ptr(),
              js_name.len() as isize - 1,
              Some(ctor),
              ptr::null_mut(),
              raw_props.len(),
              raw_props.as_ptr(),
              &mut class_ptr,
            ),
            "Failed to register class `{}`",
            &js_name,
          )?;

          if class_registration.implement_iterator {
            crate::bindgen_runtime::iterator::setup_iterator_class(env, class_ptr);
            // `setup_iterator_class` throws instead of returning its error.
            let mut is_pending = false;
            check_status!(
              sys::napi_is_exception_pending(env, &mut is_pending),
              "Failed to register class `{}`",
              &js_name,
            )?;
            if is_pending {
              return Err(Error::new(
                Status::PendingException,
                format!("Failed to set up the iterator of class `{}`", js_name),
              ));
            }
          }

          let mut ctor_ref = ptr::null_mut();
          check_status!(
            sys::napi_create_reference(env, class_ptr, 1, &mut ctor_ref),
            "Failed to register class `{}`",
            &js_name,
          )?;

          ctor_refs.push((js_name, ctor_ref));

          // A namespaced class reaches `exports` only in `Namespaces::attach`, so it is
          // never left on `exports` when a later class fails.
          namespaces.export(env, exports, *js_mod, js_name, class_ptr, "class")?;
        }
      }
    }
    Ok(())
  })
}

#[cfg(not(feature = "noop"))]
pub(crate) unsafe extern "C" fn noop(
  env: sys::napi_env,
  _info: sys::napi_callback_info,
) -> sys::napi_value {
  if !crate::bindgen_runtime::___CALL_FROM_FACTORY.with(|s| s.get()) {
    unsafe {
      sys::napi_throw_error(
        env,
        ptr::null_mut(),
        c"Class contains no `constructor`, can not new it!".as_ptr(),
      );
    }
  }
  ptr::null_mut()
}

/// Creates this env's custom-GC TSFN and its handle. Publishes nothing and adds no hook: the
/// caller hands the handle to the env's registration record, whose cleanup hook releases the
/// TSFN. `None` when the TSFN could not be created (an exception is then pending).
#[cfg(all(feature = "napi4", not(feature = "noop")))]
fn create_custom_gc(env: sys::napi_env) -> Option<std::sync::Arc<CustomGcHandle>> {
  // Per-env custom-GC TSFN (#3357): created for EVERY env. It is `napi_unref`'d so it never pins
  // the event loop (worker terminate/exit cannot hang), and passes null for `func` because
  // `custom_gc` never invokes a JS callback — avoiding an unused JS function allocation and
  // strong root per load on modern runtimes (Node >= 10.17 / >= 12.6, Bun, Deno, emnapi).
  // Early Node-API 4 hosts (Node 10.6–10.16, 12.0–12.5) reject a null `func` with
  // `napi_invalid_arg`, so we fall back to a dummy JS function only on that error. Its initial
  // thread count of 1 is released by the registration record's cleanup hook; Node then closes it
  // at env teardown and calls `custom_gc_handle_finalize`.
  let mut async_resource_name = ptr::null_mut();
  check_status_or_throw!(
    env,
    unsafe { sys::napi_create_string_utf8(env, c"CustomGC".as_ptr(), 8, &mut async_resource_name) },
    "Create async resource string in napi_register_module_v1"
  );
  let handle = std::sync::Arc::new(CustomGcHandle::new());
  let weak_ptr = std::sync::Arc::downgrade(&handle).into_raw();
  let mut custom_gc_tsfn = ptr::null_mut();
  let mut status = unsafe {
    sys::napi_create_threadsafe_function(
      env,
      ptr::null_mut(),
      ptr::null_mut(),
      async_resource_name,
      0,
      1,
      weak_ptr.cast_mut().cast(),
      Some(custom_gc_handle_finalize),
      ptr::null_mut(),
      Some(custom_gc),
      &mut custom_gc_tsfn,
    )
  };
  if status == sys::Status::napi_invalid_arg {
    let mut is_pending = false;
    if unsafe { sys::napi_is_exception_pending(env, &mut is_pending) } == sys::Status::napi_ok
      && !is_pending
    {
      let mut custom_gc_fn = ptr::null_mut();
      if unsafe {
        sys::napi_create_function(
          env,
          c"custom_gc".as_ptr(),
          9,
          Some(empty),
          ptr::null_mut(),
          &mut custom_gc_fn,
        )
      } == sys::Status::napi_ok
      {
        custom_gc_tsfn = ptr::null_mut();
        status = unsafe {
          sys::napi_create_threadsafe_function(
            env,
            custom_gc_fn,
            ptr::null_mut(),
            async_resource_name,
            0,
            1,
            weak_ptr.cast_mut().cast(),
            Some(custom_gc_handle_finalize),
            ptr::null_mut(),
            Some(custom_gc),
            &mut custom_gc_tsfn,
          )
        };
      }
    }
  }
  if status != sys::Status::napi_ok || custom_gc_tsfn.is_null() {
    // reclaim the leaked weak count before bailing
    drop(unsafe { std::sync::Weak::from_raw(weak_ptr) });
    check_status_or_throw!(
      env,
      status,
      "Create Custom GC ThreadsafeFunction in napi_register_module_v1 failed"
    );
    // `napi_create_threadsafe_function` only fails under resource exhaustion;
    // `check_status_or_throw!` above leaves a pending exception. Values captured in this env then
    // record no handle.
    return None;
  }
  handle
    .tsfn
    .store(custom_gc_tsfn, std::sync::atomic::Ordering::SeqCst);
  // Unreachable in practice: Node and emnapi (with threads) both return `napi_ok` for a TSFN
  // they just created. The handle is still returned, so the record releases the TSFN at teardown.
  check_status_or_throw!(
    env,
    unsafe { sys::napi_unref_threadsafe_function(env, custom_gc_tsfn) },
    "Unref Custom GC ThreadsafeFunction in napi_register_module_v1 failed"
  );
  #[cfg(not(target_family = "wasm"))]
  create_custom_gc_sentinel(env, &handle);
  Some(handle)
}

/// Wrap data of a late sentinel.
#[cfg(all(feature = "napi4", not(feature = "noop"), not(target_family = "wasm")))]
struct CustomGcSentinel {
  /// Only a `Weak`: the sentinel must not keep the handle alive (on Deno it is never finalized).
  handle: std::sync::Weak<CustomGcHandle>,
  /// The handle's `sentinel_ref`. The finalizer deletes the reference through it even when the
  /// handle is gone.
  sentinel_ref: std::sync::Arc<std::sync::atomic::AtomicPtr<sys::napi_ref__>>,
}

/// Adds the late sentinel of `handle` (see `CustomGcHandle`): a plain object wrapped with
/// `napi_wrap`, whose wrap data is a `CustomGcSentinel`, kept by a strong reference. Called
/// before any module-init code. Best effort: without it, references released after the cleanup
/// hook leak, as they did before.
#[cfg(all(feature = "napi4", not(feature = "noop"), not(target_family = "wasm")))]
fn create_custom_gc_sentinel(env: sys::napi_env, handle: &std::sync::Arc<CustomGcHandle>) {
  let mut object = ptr::null_mut();
  if unsafe { sys::napi_create_object(env, &mut object) } != sys::Status::napi_ok {
    return;
  }
  let data = Box::into_raw(Box::new(CustomGcSentinel {
    handle: std::sync::Arc::downgrade(handle),
    sentinel_ref: handle.sentinel_ref.clone(),
  }));
  if unsafe {
    sys::napi_wrap(
      env,
      object,
      data.cast(),
      Some(custom_gc_sentinel_finalize),
      ptr::null_mut(),
      ptr::null_mut(),
    )
  } != sys::Status::napi_ok
  {
    drop(unsafe { Box::from_raw(data) });
    return;
  }
  let mut sentinel_ref = ptr::null_mut();
  // Without the reference the object is collected some time later, and its finalizer, finding no
  // `sentinel_ref`, does nothing.
  if unsafe { sys::napi_create_reference(env, object, 1, &mut sentinel_ref) }
    == sys::Status::napi_ok
  {
    handle.sentinel_ref.store(sentinel_ref, Ordering::SeqCst);
  }
}

/// Finalizer of the late sentinel. Kept by a strong reference, it runs at env teardown, on the
/// env's JS thread, while the env can still delete references. `data` is the `CustomGcSentinel`.
#[cfg(all(feature = "napi4", not(feature = "noop"), not(target_family = "wasm")))]
unsafe extern "C" fn custom_gc_sentinel_finalize(
  env: sys::napi_env,
  data: *mut std::ffi::c_void,
  _hint: *mut std::ffi::c_void,
) {
  if data.is_null() {
    return;
  }
  let sentinel = unsafe { Box::from_raw(data.cast::<CustomGcSentinel>()) };
  // Taken first, as before the phase change: a drop that finds no sentinel leaks its reference
  // instead of waiting. Null when the sentinel was given up at registration and then collected
  // as an ordinary object, or never got its reference: nothing to do.
  let sentinel_ref = sentinel
    .sentinel_ref
    .swap(ptr::null_mut(), Ordering::SeqCst);
  if sentinel_ref.is_null() {
    return;
  }
  if let Some(handle) = sentinel.handle.upgrade() {
    handle.finish_teardown(env);
  }
  // Deleted whether or not the handle is still alive.
  delete_sentinel_ref(env, sentinel_ref);
}

#[cfg(all(
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
unsafe extern "C" fn thread_cleanup(_data: *mut std::ffi::c_void) {
  if MODULE_COUNT.fetch_sub(1, Ordering::Relaxed) == 1 {
    crate::tokio_runtime::shutdown_async_runtime();
  }
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
unsafe extern "C" fn empty(_env: sys::napi_env, _info: sys::napi_callback_info) -> sys::napi_value {
  ptr::null_mut()
}

// Per-env custom-GC finalize (#3357): moves the handle to `Closing` when Node closes the TSFN.
// `CustomGcHandle::close` (from the registration record's cleanup hook, or right at registration
// when there is no record) has already done it; this is a backstop. `finalize_data` is the
// `Weak<CustomGcHandle>` smuggled in via `thread_finalize_data`; we reclaim that weak count here.
// It stays a `Weak`, so a runtime that never runs TSFN finalizers (Deno at worker terminate) does
// not leak the handle.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
unsafe extern "C" fn custom_gc_handle_finalize(
  _env: sys::napi_env,
  finalize_data: *mut std::ffi::c_void,
  _finalize_hint: *mut std::ffi::c_void,
) {
  if finalize_data.is_null() {
    return;
  }
  if let Some(handle) =
    unsafe { std::sync::Weak::<CustomGcHandle>::from_raw(finalize_data.cast()) }.upgrade()
  {
    handle.mark_closing();
  }
  // temp Weak dropped here -> reclaims the weak count
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
// The custom-GC TSFN's wake: deletes pending references on the env's JS thread. `data` is a
// `Weak<CustomGcHandle>` token, one per wake, consumed on every path (a `Weak` drop needs no env).
extern "C" fn custom_gc(
  env: sys::napi_env,
  _js_callback: sys::napi_value,
  _context: *mut std::ffi::c_void,
  data: *mut std::ffi::c_void,
) {
  if data.is_null() {
    return;
  }
  let token = unsafe { std::sync::Weak::<CustomGcHandle>::from_raw(data.cast()) };
  // A null env: Node empties the queue while it closes the TSFN at env teardown (mirrors the
  // generic call_js_cb guard in threadsafe_function.rs). Nothing is lost: references wait in
  // `pending`, never in the queue, for the cleanup hook (which ran before) or the sentinel.
  if env.is_null() {
    return;
  }
  if let Some(handle) = token.upgrade() {
    handle.drain_while_running(env);
  }
}

/// A function whose address is guaranteed to live inside this addon's image.
/// The loader APIs below identify the image to retain by looking up the module
/// that owns this address, which works for a `cdylib` without knowing its path.
#[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
#[inline(never)]
fn module_retention_anchor() {}

/// Takes one extra loader reference to the image this addon was loaded from and
/// never releases it, so the addon's code stays mapped for the lifetime of the
/// process.
///
/// Node unloads an addon when the environment that loaded it goes away and no
/// other environment holds it. On Windows that is a `FreeLibrary` which drops
/// the module's reference count to zero and unmaps the image. Any native code
/// still reachable from a thread that outlives the environment then points into
/// unmapped memory: the reported symptom is a `0xC0000005` access violation
/// raised from a Tokio waker vtable when an addon was loaded only inside a
/// worker and that worker exited.
///
/// Call this before creating anything that can outlive a single environment —
/// process-global runtimes, worker threads, or a waker/vtable handed to one.
/// Repeated calls are cheap: the reference is taken at most once per process.
///
/// This is best effort. Platforms with no loader-pinning primitive and failures
/// of the underlying call leave the image unpinned, which is exactly the
/// behavior addons had before this existed, so it never makes things worse.
#[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
pub fn retain_current_module_for_unload_safety() {
  static RETAIN_MODULE: std::sync::Once = std::sync::Once::new();
  // Counted on every call, not just the first, so a test can observe that a
  // given code path asked for retention even though the pin itself is taken
  // once per process. One relaxed increment next to an N-API call is noise.
  MODULE_RETENTION_REQUESTS.fetch_add(1, Ordering::Relaxed);
  RETAIN_MODULE.call_once(retain_current_module);
}

/// How many times [`retain_current_module_for_unload_safety`] has been asked to
/// pin this addon's image. The pin happens at most once per process; this
/// counts requests, so a caller can check that a particular path requested it.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
#[doc(hidden)]
pub fn module_retention_requests() -> usize {
  MODULE_RETENTION_REQUESTS.load(Ordering::Relaxed)
}

#[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
static MODULE_RETENTION_REQUESTS: AtomicUsize = AtomicUsize::new(0);

/// `noop` stub: nothing registers, so nothing ever requests a pin.
#[cfg(all(feature = "noop", not(target_family = "wasm")))]
#[doc(hidden)]
pub fn module_retention_requests() -> usize {
  0
}

#[cfg(all(not(feature = "noop"), not(target_family = "wasm"), windows))]
fn retain_current_module() {
  const GET_MODULE_HANDLE_EX_FLAG_PIN: u32 = 0x0000_0001;
  const GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS: u32 = 0x0000_0004;

  #[link(name = "kernel32")]
  unsafe extern "system" {
    fn GetModuleHandleExW(
      flags: u32,
      module_name: *const u16,
      module: *mut *mut std::ffi::c_void,
    ) -> i32;
  }

  let mut module = ptr::null_mut();
  // With `FROM_ADDRESS` the "module name" argument is an address inside the
  // wanted module, and `PIN` makes the loader hold the module until the process
  // exits. The returned handle is intentionally never freed.
  let _ = unsafe {
    GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
      module_retention_anchor as *const () as *const u16,
      &mut module,
    )
  };
}

#[cfg(all(
  not(feature = "noop"),
  not(target_family = "wasm"),
  any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  )
))]
fn retain_current_module() {
  // glibc before 2.34 keeps the `dl*` symbols in a separate library.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  #[link(name = "dl")]
  unsafe extern "C" {}

  let anchor = module_retention_anchor as *const () as *const std::ffi::c_void;
  let mut info = std::mem::MaybeUninit::<libc::Dl_info>::zeroed();
  // SAFETY: `anchor` is the address of a function in this image and `info` is a
  // live, correctly sized out-parameter.
  let info = unsafe {
    if libc::dladdr(anchor, info.as_mut_ptr()) == 0 {
      return;
    }
    info.assume_init()
  };
  if info.dli_fname.is_null() {
    return;
  }
  // `RTLD_NOLOAD` resolves the already-mapped image instead of loading anything
  // new; it only increments the reference count. The handle is deliberately
  // leaked — releasing it is the very thing being prevented.
  // SAFETY: `dli_fname` is a NUL-terminated path owned by the loader.
  unsafe {
    libc::dlopen(
      info.dli_fname,
      libc::RTLD_LAZY | libc::RTLD_LOCAL | libc::RTLD_NOLOAD,
    );
  }
}

/// Fallback for targets with no portable way to pin the running image (AIX and
/// OpenBSD among them). Unloading stays possible there, unchanged from before.
#[cfg(all(
  not(feature = "noop"),
  not(target_family = "wasm"),
  not(any(
    windows,
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  ))
))]
fn retain_current_module() {}

#[cfg(all(test, not(feature = "noop")))]
mod namespace_tests {
  use super::namespace_paths;

  #[test]
  fn parents_come_first_in_name_order() {
    assert_eq!(
      namespace_paths(["a.b.c", "x", "a.d", "a"]).unwrap(),
      ["a", "x", "a.b", "a.d", "a.b.c"]
    );
  }

  #[test]
  fn empty_segments_are_kept() {
    assert_eq!(namespace_paths([".lead"]).unwrap(), ["", ".lead"]);
    assert_eq!(namespace_paths(["m..n"]).unwrap(), ["m", "m.", "m..n"]);
  }

  #[test]
  fn a_nul_byte_names_the_namespace() {
    let error = namespace_paths(["ok", "nul\0x.y"]).unwrap_err();
    assert_eq!(error.reason, "Namespace `nul\\0x` contains a NUL byte");
  }
}
