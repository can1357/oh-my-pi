use std::cell::{LazyCell, RefCell};
#[cfg(not(feature = "noop"))]
use std::collections::HashSet;
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

use rustc_hash::FxBuildHasher;

#[cfg(all(not(feature = "noop"), feature = "node_version_detect"))]
use crate::NodeVersion;
#[cfg(not(feature = "noop"))]
use crate::{check_status, check_status_or_throw, JsError};
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
  not(target_family = "wasm"),
  not(feature = "noop")
))]
static ENV_CLEANUP_HOOK_COOKIE: AtomicUsize = AtomicUsize::new(1);
thread_local! {
  static REGISTERED_CLASSES: LazyCell<RegisteredClasses> = LazyCell::new(Default::default);
}
// Per-env custom-GC infrastructure (#3357). One `CustomGcHandle` is created + unref'd per isolate in
// `create_custom_gc`, and every Buffer/TypedArray drop routes through it.
// `AtomicPtr<_>` + `RwLock<bool>` are auto `Send + Sync`, so no `unsafe impl` is required.
// No `impl Drop`: freeing the `Arc` touches zero Node/V8 resources; Node owns the TSFN (created +
// unref'd at module load, destroyed at env teardown which fires `custom_gc_handle_finalize`).
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) struct CustomGcHandle {
  tsfn: std::sync::atomic::AtomicPtr<sys::napi_threadsafe_function__>,
  aborted: std::sync::RwLock<bool>,
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
impl CustomGcHandle {
  pub(crate) fn get_raw(&self) -> sys::napi_threadsafe_function {
    self.tsfn.load(std::sync::atomic::Ordering::SeqCst)
  }
  // drop path: read-lock held ACROSS the napi_call so finalize's write-lock blocks until the call returns
  pub(crate) fn with_read_aborted<RT>(&self, f: impl FnOnce(bool) -> RT) -> RT {
    let g = self
      .aborted
      .read()
      .expect("custom gc aborted lock poisoned");
    f(*g)
  }
  fn set_aborted(&self) {
    *self
      .aborted
      .write()
      .expect("custom gc aborted lock poisoned") = true;
  }
}

// INVARIANT: this per-OS-thread slot relies on ONE `napi_env` per OS thread, which holds for every
// supported runtime — Node's main thread, each `worker_threads` worker (its own V8 isolate + env +
// loop thread), and Electron. `create_custom_gc` installs the handle once per env on its registering
// thread, and `FromNapiValue` always runs on that same thread for that env, so a captured handle is
// always the value's OWNING env. An embedder hosting multiple `napi_env` on a single shared OS thread
// is out of scope: the per-env `Arc` identity (see `current_thread_owns_custom_gc`) is immune to
// env-pointer reuse, and the single public `Env::set_instance_data` slot is reserved for addon authors
// so it cannot be co-opted to key the handle by env.
thread_local! {
  #[cfg(all(feature = "napi4", not(feature = "noop")))]
  // Per-thread "this isolate's custom-GC handle".
  pub(crate) static CURRENT_CUSTOM_GC_HANDLE:
    std::cell::RefCell<Option<std::sync::Arc<CustomGcHandle>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn current_custom_gc_handle() -> Option<std::sync::Arc<CustomGcHandle>> {
  // clone = one refcount inc, at from_napi_value capture
  CURRENT_CUSTOM_GC_HANDLE.with(|c| c.borrow().clone())
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn current_thread_owns_custom_gc(handle: &std::sync::Arc<CustomGcHandle>) -> bool {
  // same-isolate-JS-thread test by ALLOCATION identity (immune to env-pointer reuse).
  // `is_some_and` (NOT `map_or(false, ..)`): clippy::unnecessary_map_or is denied by
  // `#![deny(clippy::all)]` and would turn CI's `cargo clippy` red.
  CURRENT_CUSTOM_GC_HANDLE.with(|c| {
    c.borrow()
      .as_ref()
      .is_some_and(|cur| std::sync::Arc::ptr_eq(cur, handle))
  })
}

// The env that last registered on this OS thread and has not been torn down since:
// `live_env_cleanup`, an env-cleanup hook, clears it at teardown. The per-thread slots
// below (`REGISTERED_CLASSES`, `CURRENT_CUSTOM_GC_HANDLE`, the `Reflect` cache in
// `error.rs`) assume one env per OS thread and simply overwrite the previous env's
// entry on re-registration, because under that assumption the previous env is gone and
// its teardown reclaimed everything. Bun breaks the assumption: `bun test --isolate`
// (implied by `--parallel`) gives every test file a fresh global object and `napi_env`
// on the same thread and never tears the old one down. The overwritten strong references
// then pin every earlier realm (its global object and full module graph) for the life of
// the process. A slot that still names a different env at registration therefore proves
// that env is alive, and its handles are released through it (see
// `release_superseded_env`). Under Node the slot is always cleared by teardown before a
// new env registers on the thread, so this path never runs there.
#[cfg(all(feature = "napi3", not(feature = "noop"), not(target_family = "wasm")))]
thread_local! {
  static LIVE_ENV: std::cell::Cell<sys::napi_env> = const { std::cell::Cell::new(ptr::null_mut()) };
}

#[cfg(all(feature = "napi3", not(feature = "noop"), not(target_family = "wasm")))]
unsafe extern "C" fn live_env_cleanup(arg: *mut std::ffi::c_void) {
  LIVE_ENV.with(|slot| {
    if slot.get().cast::<std::ffi::c_void>() == arg {
      slot.set(ptr::null_mut());
    }
  });
}

/// Marks `env` as this thread's live env and, when a different env that was never torn
/// down still holds the slot, releases the per-thread handles that pin that env's realm:
/// its class constructor references, its custom-GC threadsafe function, and its cached
/// `Reflect` pair. Must run before any of those slots is overwritten for `env`.
#[cfg(all(feature = "napi3", not(feature = "noop"), not(target_family = "wasm")))]
fn release_superseded_env(env: sys::napi_env) {
  let previous = LIVE_ENV.with(|slot| slot.replace(env));
  if previous == env {
    // Same env re-registering (`delete require.cache` + re-`require`): its hook is
    // already installed, and Node aborts on a duplicate `(fn, arg)` pair.
    return;
  }
  if !previous.is_null() {
    REGISTERED_CLASSES.with(|cell| {
      cell.borrow_mut(|map| {
        for (_, ctor_ref) in map.drain() {
          unsafe { sys::napi_delete_reference(previous, ctor_ref) };
        }
      })
    });
    #[cfg(feature = "napi4")]
    if let Some(handle) = CURRENT_CUSTOM_GC_HANDLE.with(|c| c.borrow_mut().take()) {
      let tsfn = handle.get_raw();
      if !tsfn.is_null() {
        // Abort first: values still holding this handle then take the `aborted` no-op
        // drop path instead of calling into a threadsafe function that is closing.
        handle.set_aborted();
        unsafe {
          sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::abort)
        };
      }
    }
    crate::error::release_reflect_intrinsics(previous);
  }
  unsafe { sys::napi_add_env_cleanup_hook(env, Some(live_env_cleanup), env.cast()) };
}

type RegisteredClasses = PersistedPerInstanceHashMap<
  /* export name */ String,
  /* constructor */ sys::napi_ref,
  FxBuildHasher,
>;

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

#[doc(hidden)]
pub fn get_class_constructor(js_name: &'static str) -> Option<sys::napi_ref> {
  REGISTERED_CLASSES.with(|cell| cell.borrow_mut(|map| map.get(js_name).copied()))
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
/// Native targets get this ordering from Node for free — `napi_register_module_v1` registers
/// `thread_cleanup` with `napi_add_env_cleanup_hook`, and Node runs cleanup hooks before it
/// finalizes threadsafe functions. wasm has no equivalent: the only teardown callback there is
/// the `exports` object finalizer that `napi_register_module_v1` installs with `napi_wrap`,
/// which runs deep inside the environment teardown, long after JavaScript calls are disabled.
/// This export is that missing pre-teardown barrier, and it performs exactly the same teardown
/// as the finalizer — only early enough to be useful.
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
/// Repeated calls are harmless — the loaders guard against them anyway, and the finalizer that
/// still fires later performs the same idempotent teardown.
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
/// stands. It reports the *runtime's* work, which is a different question from
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

  // Install the per-env custom-GC handle (#3357) BEFORE running ANY module-init
  // callback below (the export-register callbacks, `module_register_hook_callback`,
  // and the compat `MODULE_EXPORTS` callbacks). Those callbacks can capture a
  // `Buffer`/`TypedArray` via `from_napi_value`, which snapshots the thread-local
  // `CURRENT_CUSTOM_GC_HANDLE`. If the handle were installed afterwards (as it was
  // originally), such a value would record `None`; because `Buffer`/`TypedArray`
  // are `Send`, dropping it later on a non-JS thread would fall through to a direct
  // `napi_reference_unref(env, ..)` on the WRONG thread — the cross-isolate
  // use-after-free this change exists to prevent. `create_custom_gc` only needs a
  // valid `env` (it creates a dummy function + the per-env TSFN and never reads
  // `exports`), so running it this early is safe.
  #[cfg(all(feature = "napi3", not(target_family = "wasm")))]
  release_superseded_env(env);

  #[cfg(feature = "napi4")]
  create_custom_gc(env);

  // Resolve and cache this env's `Reflect.getOwnPropertyDescriptor` pair NOW,
  // at registration, so `Error::from_unknown_without_coercion` never reads
  // `Reflect` off the global object mid-capture. That read is an ordinary
  // `[[Get]]`: user code can redefine `globalThis.Reflect` as an accessor, and
  // a per-capture read would run that accessor — arbitrary user code, free to
  // reenter the addon — while an error is unwinding. Registration is the
  // defined moment where the one unavoidable `[[Get]]` may happen. Best effort:
  // a failure leaves capture degrading to an empty reason/cause.
  crate::error::cache_reflect_intrinsics_for_env(env);

  // Registration keys are compile-time strings. Avoid `RandomState` so WASI module
  // registration does not request randomness during workerd global initialization.
  let mut exports_objects: HashSet<String, FxBuildHasher> = HashSet::with_hasher(FxBuildHasher);

  {
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
        let mut exports_js_mod = ptr::null_mut();
        if let Some(js_mod_str) = js_mod {
          let mod_name_c_str =
            unsafe { CStr::from_bytes_with_nul_unchecked(js_mod_str.as_bytes()) };
          if exports_objects.contains(*js_mod_str) {
            check_status_or_throw!(
              env,
              unsafe {
                sys::napi_get_named_property(
                  env,
                  exports,
                  mod_name_c_str.as_ptr(),
                  &mut exports_js_mod,
                )
              },
              "Get mod {} from exports failed",
              js_mod_str,
            );
          } else {
            check_status_or_throw!(
              env,
              unsafe { sys::napi_create_object(env, &mut exports_js_mod) },
              "Create export JavaScript Object [{}] failed",
              js_mod_str
            );
            check_status_or_throw!(
              env,
              unsafe {
                sys::napi_set_named_property(env, exports, mod_name_c_str.as_ptr(), exports_js_mod)
              },
              "Set exports Object [{}] into exports object failed",
              js_mod_str
            );
            exports_objects.insert(js_mod_str.to_string());
          }
        }
        for (name, callback) in items {
          unsafe {
            let js_name = CStr::from_bytes_with_nul_unchecked(name.as_bytes());
            if let Err(e) = callback(env).and_then(|v| {
              let exported_object = if exports_js_mod.is_null() {
                exports
              } else {
                exports_js_mod
              };
              check_status!(
                sys::napi_set_named_property(env, exported_object, js_name.as_ptr(), v),
                "Failed to register export `{}`",
                name,
              )
            }) {
              JsError::from(e).throw_into(env)
            }
          }
        }
      });
  }

  let mut registered_classes = HashMap::default();

  MODULE_CLASS_PROPERTIES.borrow(|inner| {
    inner.iter().for_each(|(_, js_mods)| {
      for (js_mod, class_registration) in js_mods {
        let mut exports_js_mod = ptr::null_mut();
        unsafe {
          let js_name = class_registration.js_name;
          let props = &class_registration.props;
          if let Some(js_mod_str) = js_mod {
            let mod_name_c_str = CStr::from_bytes_with_nul_unchecked(js_mod_str.as_bytes());
            if exports_objects.contains(*js_mod_str) {
              check_status_or_throw!(
                env,
                sys::napi_get_named_property(
                  env,
                  exports,
                  mod_name_c_str.as_ptr(),
                  &mut exports_js_mod,
                ),
                "Get mod {} from exports failed",
                js_mod_str,
              );
            } else {
              check_status_or_throw!(
                env,
                sys::napi_create_object(env, &mut exports_js_mod),
                "Create export JavaScript Object [{}] failed",
                js_mod_str
              );
              check_status_or_throw!(
                env,
                sys::napi_set_named_property(env, exports, mod_name_c_str.as_ptr(), exports_js_mod),
                "Set exports Object [{}] into exports object failed",
                js_mod_str
              );
              exports_objects.insert(js_mod_str.to_string());
            }
          }
          let (ctor, props): (Vec<_>, Vec<_>) = props.iter().partition(|prop| prop.is_ctor);

          let ctor = ctor
            .first()
            .map(|c| c.raw().method.unwrap())
            .unwrap_or(noop);
          let raw_props: Vec<_> = props.iter().map(|prop| prop.raw()).collect();

          let js_class_name = CStr::from_bytes_with_nul_unchecked(js_name.as_bytes());
          let mut class_ptr = ptr::null_mut();

          check_status_or_throw!(
            env,
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
          );

          if class_registration.implement_iterator {
            crate::bindgen_runtime::iterator::setup_iterator_class(env, class_ptr);
          }

          let mut ctor_ref = ptr::null_mut();
          sys::napi_create_reference(env, class_ptr, 1, &mut ctor_ref);

          registered_classes.insert(js_name.to_string(), ctor_ref);

          check_status_or_throw!(
            env,
            sys::napi_set_named_property(
              env,
              if exports_js_mod.is_null() {
                exports
              } else {
                exports_js_mod
              },
              js_class_name.as_ptr(),
              class_ptr
            ),
            "Failed to register class `{}`",
            &js_name,
          );
        }
      }
    });
  });

  REGISTERED_CLASSES.with(|cell| {
    cell.borrow_mut(|map| {
      *map = registered_classes;
    })
  });

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

  #[cfg(feature = "napi4")]
  {
    // NOTE: `create_custom_gc(env)` is intentionally NOT called here. It now runs
    // earlier in `register` (before any module-init callback) so a value captured
    // during a hook gets a real per-env handle instead of `None` (#3357).
    #[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
    {
      crate::tokio_runtime::start_async_runtime();
      #[cfg(not(target_family = "wasm"))]
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
        let cleanup_cookie =
          ENV_CLEANUP_HOOK_COOKIE.fetch_add(1, Ordering::Relaxed) as *mut std::ffi::c_void;
        check_status_or_throw!(
          env,
          unsafe { sys::napi_add_env_cleanup_hook(env, Some(thread_cleanup), cleanup_cookie) },
          "Failed to add env cleanup hook"
        );
      }
    }
  }

  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4",
    target_family = "wasm"
  ))]
  check_status_or_throw!(
    env,
    unsafe {
      sys::napi_wrap(
        env,
        exports,
        std::ptr::null_mut(),
        Some(thread_cleanup),
        std::ptr::null_mut(),
        std::ptr::null_mut(),
      )
    },
    "Failed to add remove thread id cleanup hook"
  );

  FIRST_MODULE_REGISTERED.store(true, Ordering::SeqCst);
  exports
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

#[cfg(all(feature = "napi4", not(feature = "noop")))]
fn create_custom_gc(env: sys::napi_env) {
  // Per-env custom-GC TSFN (#3357): created for EVERY isolate. It is `napi_unref`'d so it never pins
  // the event loop (worker terminate/exit cannot hang), and Node owns it (torn down via
  // `custom_gc_handle_finalize` at env teardown).
  let mut custom_gc_fn = ptr::null_mut();
  check_status_or_throw!(
    env,
    unsafe {
      sys::napi_create_function(
        env,
        c"custom_gc".as_ptr(),
        9,
        Some(empty),
        ptr::null_mut(),
        &mut custom_gc_fn,
      )
    },
    "Create Custom GC Function in napi_register_module_v1 failed"
  );
  let mut async_resource_name = ptr::null_mut();
  check_status_or_throw!(
    env,
    unsafe { sys::napi_create_string_utf8(env, c"CustomGC".as_ptr(), 8, &mut async_resource_name) },
    "Create async resource string in napi_register_module_v1"
  );
  let handle = std::sync::Arc::new(CustomGcHandle {
    tsfn: std::sync::atomic::AtomicPtr::new(ptr::null_mut()),
    aborted: std::sync::RwLock::new(false),
  });
  let weak_ptr = std::sync::Arc::downgrade(&handle).into_raw();
  let mut custom_gc_tsfn = ptr::null_mut();
  let status = unsafe {
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
  if status != sys::Status::napi_ok || custom_gc_tsfn.is_null() {
    // reclaim the leaked weak count before bailing
    drop(unsafe { std::sync::Weak::from_raw(weak_ptr) });
    check_status_or_throw!(
      env,
      status,
      "Create Custom GC ThreadsafeFunction in napi_register_module_v1 failed"
    );
    // `napi_create_threadsafe_function` only fails under resource exhaustion; `check_status_or_throw!`
    // above leaves a pending exception, which aborts the addon load (`require` throws). No user
    // `#[napi]` code then runs, so no Buffer/TypedArray is ever created with this env's (unset) handle.
    return;
  }
  handle
    .tsfn
    .store(custom_gc_tsfn, std::sync::atomic::Ordering::SeqCst);
  check_status_or_throw!(
    env,
    unsafe { sys::napi_unref_threadsafe_function(env, custom_gc_tsfn) },
    "Unref Custom GC ThreadsafeFunction in napi_register_module_v1 failed"
  );
  CURRENT_CUSTOM_GC_HANDLE.with(|c| *c.borrow_mut() = Some(handle));
}

#[cfg(all(
  not(feature = "noop"),
  all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ),
  not(target_family = "wasm")
))]
unsafe extern "C" fn thread_cleanup(_data: *mut std::ffi::c_void) {
  if MODULE_COUNT.fetch_sub(1, Ordering::Relaxed) == 1 {
    crate::tokio_runtime::shutdown_async_runtime();
  }
}

#[cfg(all(
  not(feature = "noop"),
  all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ),
  target_family = "wasm"
))]
unsafe extern "C" fn thread_cleanup(
  _env: sys::napi_env,
  _id: *mut std::ffi::c_void,
  _data: *mut std::ffi::c_void,
) {
  if MODULE_COUNT.fetch_sub(1, Ordering::Relaxed) == 1 {
    crate::tokio_runtime::shutdown_async_runtime();
  }
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
#[allow(unused)]
unsafe extern "C" fn empty(env: sys::napi_env, info: sys::napi_callback_info) -> sys::napi_value {
  ptr::null_mut()
}

// Per-env custom-GC finalize (#3357): sets the per-handle `aborted` flag when Node tears down the
// owner env's TSFN. `finalize_data` is the `Weak<CustomGcHandle>` smuggled in via
// `thread_finalize_data`; we reclaim that weak count here.
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
    // owner env gone, ref already invalidated by V8 -> mark aborted (write-lock)
    handle.set_aborted();
  }
  // temp Weak dropped here -> reclaims the weak count
}

#[cfg(all(feature = "napi4", not(feature = "noop")))]
// recycle a napi_ref (ArrayBuffer/Buffer/Error) that is not dropped on the main thread
extern "C" fn custom_gc(
  env: sys::napi_env,
  _js_callback: sys::napi_value,
  _context: *mut std::ffi::c_void,
  data: *mut std::ffi::c_void,
) {
  // env can be null while the owning env/TSFN is shutting down and Node drains the
  // queue (mirrors the generic call_js_cb guard in threadsafe_function.rs). The owner
  // env is gone and V8 has already invalidated the ref, so this is a safe no-op.
  if env.is_null() || data.is_null() {
    return;
  }
  let mut ref_count = 0;
  check_status_or_throw!(
    env,
    unsafe { sys::napi_reference_unref(env, data.cast(), &mut ref_count) },
    "Failed to unref reference in Custom GC"
  );
  // Both ArrayBuffer/Buffer and `Error` references reach 0 here: each is created
  // at refcount 1 and routed through this TSFN exactly once, by its owner's drop
  // (for `Error`, the last `Arc<ErrorRef>`), so the unref above always hits 0.
  if ref_count == 0 {
    check_status_or_throw!(
      env,
      unsafe { sys::napi_delete_reference(env, data.cast()) },
      "Failed to delete reference in Custom GC"
    );
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
