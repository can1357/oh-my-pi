use std::os::raw::c_void;
use std::ptr;
#[cfg(target_family = "wasm")]
use std::sync::atomic::AtomicU32;
#[cfg(not(target_family = "wasm"))]
use std::sync::{atomic::AtomicU8, PoisonError};
use std::{
  marker::PhantomData,
  sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex, RwLock,
  },
};

/// The rejection message of a promise whose task was dropped before it completed: a `#[napi]
/// async fn`, `Env::spawn_future` or `AsyncBlock` task dropped by a runtime shutdown, or a task a
/// custom `AsyncRuntime` backend cancelled. The code is `GenericFailure` in both cases.
#[cfg(any(
  not(target_family = "wasm"),
  all(feature = "async-runtime", not(feature = "noop"))
))]
pub(crate) const TASK_CANCELLED_ERROR: &str = "task was cancelled before completion";

/// The rejection message of a promise whose user `JsDeferred` (`Env::create_deferred`) was
/// dropped unsettled on a thread other than its JavaScript thread.
#[cfg(not(target_family = "wasm"))]
const DEFERRED_DROPPED_ERROR: &str = "JsDeferred was dropped without being settled";

/// `JsDeferred`s dropped unsettled and cleaned up at once, inside the `Drop`, on their own
/// JavaScript thread. Read through [`js_deferred_abandoned_sync`].
static ABANDONED_SYNC: AtomicUsize = AtomicUsize::new(0);
/// `JsDeferred`s dropped unsettled whose cleanup (no rejection) was queued to the JavaScript
/// thread, counted when it runs there. Read through [`js_deferred_abandoned_queued`].
static ABANDONED_QUEUED: AtomicUsize = AtomicUsize::new(0);
/// `JsDeferred`s dropped unsettled whose promise was rejected, counted when the rejecting call
/// runs on the JavaScript thread. Read through [`js_deferred_abandon_rejected`].
static ABANDON_REJECTED: AtomicUsize = AtomicUsize::new(0);

/// How many `JsDeferred`s dropped unsettled were cleaned up synchronously, inside their `Drop`,
/// on their own JavaScript thread (their promise stays pending). Always 0 on wasm.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn js_deferred_abandoned_sync() -> usize {
  ABANDONED_SYNC.load(Ordering::Relaxed)
}

/// How many `JsDeferred`s dropped unsettled had their cleanup queued to the JavaScript thread
/// without a rejection (their promise stays pending), counted when it ran. Always 0 on wasm.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn js_deferred_abandoned_queued() -> usize {
  ABANDONED_QUEUED.load(Ordering::Relaxed)
}

/// How many `JsDeferred`s dropped unsettled had their promise rejected, counted when the
/// rejection ran on the JavaScript thread. Always 0 on wasm.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn js_deferred_abandon_rejected() -> usize {
  ABANDON_REJECTED.load(Ordering::Relaxed)
}

/// How many promise settlements this addon has handed to the threadsafe-function queue that
/// have not been dispatched back into JavaScript yet.
///
/// On wasm the queue is drained by the host, not by napi: `napi_call_threadsafe_function`
/// only appends to it, and `@emnapi/core` dispatches the appended item from a *macrotask* —
/// two coalescing turns later, even when the call was made on the JavaScript thread itself.
/// A loader that runs `napi_prepare_wasm_env_cleanup()` and `Context.destroy()` back to back
/// therefore disables JavaScript calls before the queue is dispatched, and the queued settles
/// are discarded with a null env instead of settling their promises.
///
/// This counter is what makes the drain observable: `napi_wasm_env_cleanup_pending` exports
/// it so the loader can yield real event-loop turns until it reaches zero before destroying
/// the environment. It is incremented once the settle is accepted into the queue and
/// decremented by `napi_resolve_deferred`, which every queued item reaches exactly once —
/// including the null-env drain during teardown.
#[cfg(target_family = "wasm")]
static PENDING_DEFERRED_SETTLES: AtomicU32 = AtomicU32::new(0);

/// Gated exactly like its only caller, the `napi_wasm_env_cleanup_pending` export: a `noop`
/// build exports nothing, so reading the counter there would be dead code.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn pending_deferred_settles() -> u32 {
  PENDING_DEFERRED_SETTLES.load(Ordering::SeqCst)
}

// Nesting depth of `napi_prepare_wasm_env_cleanup` on *this* thread.
//
// The barrier runs on the JavaScript thread, so a thread local is exactly the right scope: it is
// set only while that thread is inside the barrier, and a `wasm32-wasip1-threads` worker settling
// a deferred concurrently never observes it.
#[cfg(target_family = "wasm")]
thread_local! {
  static WASM_ENV_CLEANUP_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Whether a settle made right now, from this thread, must be delivered instead of queued.
///
/// `owner_thread` is the thread that created the deferred — the only thread whose `napi_env`
/// can resolve it. A settle produced on any other thread has to go through the
/// threadsafe-function queue no matter what, which is why the barrier still needs the
/// [`PENDING_DEFERRED_SETTLES`] handshake for those.
#[cfg(target_family = "wasm")]
fn settles_synchronously(owner_thread: std::thread::ThreadId) -> bool {
  owner_thread == std::thread::current().id()
    && WASM_ENV_CLEANUP_DEPTH.with(|depth| depth.get() != 0)
}

/// Whether *this* thread is the one running `napi_prepare_wasm_env_cleanup`.
///
/// Runs on: any thread. The JavaScript thread answers `true` for as long as it is inside the
/// barrier; a `wasm32-wasip1-threads` backend worker always answers `false`, because the depth
/// counter is a thread local.
///
/// [`settles_synchronously`] asks the same question *and* whether the deferred belongs to this
/// thread. The cancel mailbox in `tokio_runtime` needs only the first half: it parks a
/// cancellation raised on a worker so the JavaScript thread can invoke it later, and a
/// cancellation raised on the barrier thread itself must never be parked — that one already
/// settles straight through, and parking it would defer it past the drain that is calling it.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  feature = "async-runtime"
))]
pub(crate) fn in_wasm_env_cleanup() -> bool {
  WASM_ENV_CLEANUP_DEPTH.with(|depth| depth.get() != 0)
}

/// A `napi_handle_scope` held for the duration of a settle that the host is not dispatching.
///
/// The threadsafe-function dispatch opens one around the callback; a settle delivered straight
/// out of `napi_prepare_wasm_env_cleanup` has to open its own, because that export is entered
/// from JavaScript as a bare wasm function with no napi machinery around it. On native, the
/// cleanup of a `JsDeferred` dropped on its JavaScript thread opens one too: that `Drop` can run
/// outside any napi callback (an env cleanup hook, where Node has no `HandleScope` and aborts
/// the process on the first handle made without one; a thread-local destructor).
struct DeferredHandleScope {
  env: sys::napi_env,
  scope: sys::napi_handle_scope,
}

impl DeferredHandleScope {
  fn open(env: sys::napi_env) -> Option<Self> {
    let mut scope = ptr::null_mut();
    let status = unsafe { sys::napi_open_handle_scope(env, &mut scope) };
    // Not on native: there this runs inside a `Drop`, which must not panic, and a caller that
    // gets `None` makes no handle.
    #[cfg(target_family = "wasm")]
    debug_assert!(
      status == sys::Status::napi_ok,
      "Open handle scope in JsDeferred failed"
    );
    (status == sys::Status::napi_ok).then_some(Self { env, scope })
  }
}

impl Drop for DeferredHandleScope {
  fn drop(&mut self) {
    let status = unsafe { sys::napi_close_handle_scope(self.env, self.scope) };
    debug_assert!(
      status == sys::Status::napi_ok,
      "Close handle scope in JsDeferred failed"
    );
  }
}

/// Raise the wasm environment cleanup barrier on *this* thread: from here until the matching
/// [`leave_wasm_env_cleanup_barrier`], a `JsDeferred` settled on this thread delivers instead
/// of queueing.
///
/// `napi_prepare_wasm_env_cleanup` raises it across the backend shutdown. The tasks that
/// shutdown cancels reject their deferreds from inside it, on this very thread, and
/// `napi_call_threadsafe_function` would merely *append* those rejections to a queue
/// `@emnapi/core` dispatches from a macrotask two turns later — which a host that destroys the
/// environment in the same turn never reaches. Settling straight through, while the
/// environment is still fully alive, is what makes a purely synchronous `Context.destroy()`
/// work. Those settles never enter the queue, so they never enter
/// [`PENDING_DEFERRED_SETTLES`] either, and the loader's drain sees zero and returns at once.
///
/// # Why this is a pair of calls and not a stack guard
///
/// The two-phase handshake (`napi_prepare_wasm_env_cleanup_begin` /
/// `napi_prepare_wasm_env_cleanup_finish`) splits the shutdown across two separate bare wasm
/// exports so the host can turn its event loop in between. The barrier has to span *both*, and
/// a guard whose lifetime is a single Rust stack frame cannot: each export returns to
/// JavaScript. The counter is the state that outlives the frame, so it is raised and lowered
/// explicitly. The single-call export is the same two calls back to back, so it behaves exactly
/// as the guard did.
///
/// Every caller is on the JavaScript thread (the exports are entered from it), and the counter
/// is a thread local, so nesting is per-thread and a `wasm32-wasip1-threads` worker never
/// observes a raised barrier. Both wasm targets build `panic = "abort"`, so there is no unwind
/// path that could skip the lowering.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime")
))]
pub(crate) fn enter_wasm_env_cleanup_barrier() {
  WASM_ENV_CLEANUP_DEPTH.with(|depth| depth.set(depth.get().saturating_add(1)));
}

/// Lower the barrier [`enter_wasm_env_cleanup_barrier`] raised on this thread.
///
/// Saturating, so an unpaired lowering cannot wrap the counter and leave the barrier stuck up.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime")
))]
pub(crate) fn leave_wasm_env_cleanup_barrier() {
  WASM_ENV_CLEANUP_DEPTH.with(|depth| depth.set(depth.get().saturating_sub(1)));
}

/// Force the barrier on this thread back down, for the one caller that has no raise to pair with:
/// module registration unwinding a wasm environment cleanup that began and never finished
/// (`bindgen_runtime::module_register::unwind_abandoned_wasm_env_cleanup`).
///
/// A [`leave_wasm_env_cleanup_barrier`] would do here too — phase 1 raises the counter exactly
/// once and a repeated phase 1 returns without raising it again — but this says what it means,
/// and it cannot leave a stuck barrier behind if that ever stops being true. Registration runs on
/// the main thread, the same thread phase 1 ran on, so this is that thread's counter; on any
/// other thread it is already zero and this is a no-op.
///
/// It runs on both of that unwind's outcomes, including the one that refuses the registration and
/// leaves the owed `finish` standing. A barrier left raised would outlive the environment that
/// raised it and make every later settle on this thread bypass the queue for the rest of the
/// process; a barrier lowered early costs that owed `finish` only the direct delivery of what it
/// replays, which by then is an empty mailbox. The lowering is saturating, so the `finish` that
/// arrives later cannot push the counter below zero.
#[cfg(all(
  target_family = "wasm",
  not(feature = "noop"),
  any(feature = "tokio_rt", feature = "async-runtime")
))]
pub(crate) fn reset_wasm_env_cleanup_barrier() {
  WASM_ENV_CLEANUP_DEPTH.with(|depth| depth.set(0));
}

#[cfg(feature = "deferred_trace")]
use crate::JsValue;
use crate::{
  bindgen_runtime::{Object, ToNapiValue},
  check_status, sys, Env, Error, Result,
};

#[cfg(feature = "deferred_trace")]
/// A javascript error which keeps a stack trace
/// to the original caller in an asynchronous context.
/// This is required as the stack trace is lost when
/// an error is created in a different thread.
///
/// See this issue for more details:
/// https://github.com/nodejs/node-addon-api/issues/595
#[repr(transparent)]
#[derive(Clone)]
struct DeferredTrace(sys::napi_ref);

#[cfg(feature = "deferred_trace")]
impl DeferredTrace {
  fn new(raw_env: sys::napi_env) -> Result<Self> {
    let env = Env::from_raw(raw_env);
    let reason = env.create_string("none")?;

    let mut js_error = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_error(raw_env, ptr::null_mut(), reason.raw(), &mut js_error) },
      "Create error in DeferredTrace failed"
    )?;

    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(raw_env, js_error, 1, &mut result) },
      "Create reference in DeferredTrace failed"
    )?;

    Ok(Self(result))
  }

  fn into_rejected(self, raw_env: sys::napi_env, err: Error) -> Result<sys::napi_value> {
    let env = Env::from_raw(raw_env);
    let mut raw = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(raw_env, self.0, &mut raw) },
      "Failed to get referenced value in DeferredTrace"
    )?;

    // Reject with the exact value the error retained. JavaScript may reject with
    // *anything*, and a value that reached Rust has to come back as itself — not
    // as a synthetic `Error` built around whatever message could be scraped off
    // it. Probing the retained value for a `message` used to decide this, which
    // both replaced every non-`Error` rejection and, for `null`/`undefined`, left
    // the `napi_has_named_property` type error pending so the promise never
    // settled at all. Only an error carrying no retained value — created in Rust,
    // or converted off the owning thread — falls back to the trace object. The
    // shared `napi_ref` is released when `err` drops at the end of the call.
    let err_value = (|| -> Result<sys::napi_value> {
      if let Some(err_raw_value) = unsafe { err.referenced_value(raw_env) } {
        return Ok(err_raw_value);
      }
      // Own data properties, never an assignment. An assignment of `code` runs a setter that
      // JavaScript put on `Error.prototype` or `Object.prototype`, and one that throws left the
      // rejection unbuilt: the promise stayed pending for ever, and the exception was reported
      // as uncaught. `message` keeps the attributes `napi_create_error` gave it (not
      // enumerable); `code` gets the attributes an assignment gave it.
      let message = env.create_string(&err.reason)?;
      let code = env.create_string_from_std(format!("{}", err.status))?;
      let own_data_property =
        |name: &'static std::ffi::CStr, value: sys::napi_value, attributes| {
          sys::napi_property_descriptor {
            utf8name: name.as_ptr(),
            name: ptr::null_mut(),
            method: None,
            getter: None,
            setter: None,
            value,
            attributes,
            data: ptr::null_mut(),
          }
        };
      let properties = [
        own_data_property(
          c"message",
          message.raw(),
          sys::PropertyAttributes::writable | sys::PropertyAttributes::configurable,
        ),
        own_data_property(
          c"code",
          code.raw(),
          sys::PropertyAttributes::writable
            | sys::PropertyAttributes::enumerable
            | sys::PropertyAttributes::configurable,
        ),
      ];
      check_status!(
        unsafe { sys::napi_define_properties(raw_env, raw, properties.len(), properties.as_ptr()) },
        "Failed to define the message and the code in DeferredTrace"
      )?;
      Ok(raw)
    })();
    // Delete the trace reference unconditionally. `self` is consumed here and
    // `DeferredTrace` has no `Drop`, so an early `?` out of the fallback above
    // used to be the last chance to release it — and leaked it instead.
    let delete_status = unsafe { sys::napi_delete_reference(raw_env, self.0) };
    // A failure building the rejection value is the more informative one, so it
    // wins over a failure to delete the reference.
    let err_value = err_value?;
    check_status!(
      delete_status,
      "Failed to delete the reference in DeferredTrace"
    )?;
    Ok(err_value)
  }
}

pub(crate) type FinalizeCallback = Arc<RwLock<Option<Box<dyn FnOnce(sys::napi_env)>>>>;

/// What settles the promise. A `napi_deferred` in deferred-mode envs (the Node and Bun main env,
/// wasm) and wherever the thenable path cannot be used; else the env's slot of a thenable-mode
/// promise (see `crate::async_work::promise`), which owns no `napi_deferred` and which the
/// env-teardown sweep frees if the settle never comes back. Only a `napi_deferred` leaks (16 B)
/// when the env is torn down first: `napi_resolve_deferred` / `napi_reject_deferred` are the only
/// calls that free it, and a tearing-down env refuses both. One whose `JsDeferred` was dropped
/// unsettled is either rejected (exactly one `napi_reject_deferred`), or freed by the cleanup
/// (`release_deferred_pending`), which leaves its promise pending; never both. A `JsDeferred`
/// made in a thenable-mode env can still have this variant (the fallback), so code that differs
/// between the two branches on the variant, not on the env's mode.
#[derive(Clone, Copy)]
enum SettleTarget {
  Deferred(sys::napi_deferred),
  Thenable(crate::async_work::DetachedPromise),
}

impl SettleTarget {
  /// Settles once. On the env's JavaScript thread.
  fn settle(self, env: sys::napi_env, fulfill: bool, value: sys::napi_value) -> sys::napi_status {
    match self {
      SettleTarget::Deferred(deferred) => unsafe {
        if fulfill {
          sys::napi_resolve_deferred(env, deferred, value)
        } else {
          sys::napi_reject_deferred(env, deferred, value)
        }
      },
      SettleTarget::Thenable(promise) => promise.settle(env, fulfill, value),
    }
  }

  /// Frees the thenable slot, settled or not. Nothing for a deferred: the settling call frees
  /// it, or nothing does.
  fn release(self, env: sys::napi_env) {
    if let SettleTarget::Thenable(promise) = self {
      promise.release(env);
    }
  }
}

/// What a queued item does on the JavaScript thread.
enum Outcome<Resolver> {
  /// Settle the promise: resolve it with what the resolver returns, or reject it.
  Settle(Result<Resolver>),
  /// Every `JsDeferred` clone was dropped unsettled, and the `Drop` could not clean up at once.
  ///
  /// * `None`: dropped on its JavaScript thread with a JavaScript exception pending, in deferred
  ///   mode. Release the thread count, delete the trace reference, free the `napi_deferred`
  ///   (or the thenable slot), and leave the promise pending, held by nothing
  ///   ([`abandon_on_js_thread`]).
  /// * `Some(reason)`: dropped on another thread, or a task's promise that was handed to
  ///   JavaScript. Reject the promise with the error of `reason`, through the normal settle path.
  ///
  /// The settle-time callback is not here: the dropping thread drops it without running it. The
  /// reason is a tag; the error is built on the JavaScript thread. Built only by
  /// [`queue_abandon`], from the `Drop` of [`DeferredInner`], which wasm does not have.
  #[cfg_attr(target_family = "wasm", allow(dead_code))]
  Abandon(Option<AbandonReason>),
}

/// Why the promise of a `JsDeferred` dropped unsettled is rejected. A tag only: the item that
/// carries it must own nothing user-owned (see [`queue_abandon`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(target_family = "wasm", allow(dead_code))]
enum AbandonReason {
  /// The task of a promise napi-rs hands to JavaScript (`#[napi] async fn`, `Env::spawn_future`,
  /// `AsyncBlock`) was dropped before it completed, or the task's deferred was dropped on
  /// another thread.
  TaskDropped,
  /// A user `JsDeferred` (`Env::create_deferred`) was dropped on another thread.
  DeferredDropped,
}

#[cfg(not(target_family = "wasm"))]
impl AbandonReason {
  /// The rejection. On the JavaScript thread.
  fn error(self) -> Error {
    let reason = match self {
      AbandonReason::TaskDropped => TASK_CANCELLED_ERROR,
      AbandonReason::DeferredDropped => DEFERRED_DROPPED_ERROR,
    };
    Error::new(crate::Status::GenericFailure, reason)
  }
}

/// [`DeferredHandle::origin`] of a user deferred (`Env::create_deferred`).
#[cfg(not(target_family = "wasm"))]
const ORIGIN_USER: u8 = 0;
/// [`DeferredHandle::origin`] of a task's deferred whose promise is not sure to reach
/// JavaScript yet.
#[cfg(all(
  not(target_family = "wasm"),
  any(
    test,
    all(
      not(feature = "noop"),
      any(feature = "tokio_rt", feature = "async-runtime")
    )
  )
))]
const ORIGIN_TASK: u8 = 1;
/// [`DeferredHandle::origin`] of a task's deferred whose promise is handed to JavaScript.
#[cfg(not(target_family = "wasm"))]
const ORIGIN_TASK_RETURNED: u8 = 2;

/// What the `Drop` of the last [`DeferredInner`] does with a promise still pending.
#[cfg(not(target_family = "wasm"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AbandonAction {
  /// Clean up now, on this thread (its JavaScript thread): [`abandon_on_js_thread`].
  Sync,
  /// Queue an [`Outcome::Abandon`] item to the JavaScript thread.
  Queue(Option<AbandonReason>),
}

/// The abandon rule (see [`JsDeferred`]).
///
/// * Another thread: the deferred was sent away, so its promise went to JavaScript: reject it.
/// * Its JavaScript thread, a task's promise already handed to JavaScript (a `current_thread`
///   runtime shut down on the JavaScript thread drops its tasks there): reject it.
/// * Its JavaScript thread otherwise: clean up at once, before control returns to JavaScript.
///   In deferred mode that resolves the `napi_deferred` with an inert thenable, which the env
///   refuses while an exception is pending: then queue the cleanup instead, so the exception is
///   never touched. A thenable slot is freed without running JavaScript, so always at once.
///
/// `exception_pending` is only asked for (and only meaningful) on the JavaScript thread with a
/// deferred target.
#[cfg(not(target_family = "wasm"))]
fn abandon_action(
  on_owner: bool,
  origin: u8,
  is_deferred: bool,
  exception_pending: bool,
) -> AbandonAction {
  if !on_owner {
    return AbandonAction::Queue(Some(if origin == ORIGIN_USER {
      AbandonReason::DeferredDropped
    } else {
      AbandonReason::TaskDropped
    }));
  }
  if origin == ORIGIN_TASK_RETURNED {
    return AbandonAction::Queue(Some(AbandonReason::TaskDropped));
  }
  if is_deferred && exception_pending {
    return AbandonAction::Queue(None);
  }
  AbandonAction::Sync
}

struct DeferredData<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> {
  outcome: Outcome<Resolver>,
  target: SettleTarget,
  /// `None` when the promise's slot keeps the trace reference (see [`JsDeferred::trace`]).
  #[cfg(feature = "deferred_trace")]
  trace: Option<DeferredTrace>,
  tsfn: sys::napi_threadsafe_function,
  finalize_callback: FinalizeCallback,
}

/// Shared between the deferred (and its clones) and the threadsafe function's env teardown hook
/// and finalize callback. Owns the pending threadsafe function: a settle or the `Drop` of the last
/// clone's [`DeferredInner`] takes it (moving the release duty into the queued `DeferredData`),
/// the env teardown hook abort-releases it, whichever locks first. The lock is held across those
/// calls so env teardown cannot finalize the threadsafe function while a call on a foreign thread
/// is inside it.
///
/// `Some(t)` under the lock means: this side still owns `t`'s single thread count, and `t`'s
/// finalize callback has not run, so `t` is alive. Only these take it, always under the lock: a
/// settle, the `Drop`, the teardown hook, the finalize callback, and the error paths of `new`. The
/// lock is always taken before the host's own threadsafe-function mutex, never the other way.
struct DeferredHandle {
  pending_tsfn: Mutex<Option<sys::napi_threadsafe_function>>,
  /// How many `JsDeferred` values (the first one and its clones) are alive. The last one dropped
  /// abandons the promise. Not the `Arc` count: [`DeferredHookData`] holds one too.
  #[cfg(not(target_family = "wasm"))]
  owners: AtomicUsize,
  /// The env that made the deferred. The `Drop` reads it only after it took the threadsafe
  /// function out of `pending_tsfn` under the lock: that proves the env teardown hook has not
  /// run, so the env is alive (the hook is newer than everything that frees the env and its
  /// promise slots).
  #[cfg(not(target_family = "wasm"))]
  env: sys::napi_env,
  /// The thread that made the deferred: the env's JavaScript thread.
  #[cfg(not(target_family = "wasm"))]
  owner_thread: std::thread::ThreadId,
  /// [`ORIGIN_USER`], `ORIGIN_TASK` or [`ORIGIN_TASK_RETURNED`]. Read only by an abandon on the
  /// owner thread, which is program-ordered after the store: `Relaxed` is enough.
  #[cfg(not(target_family = "wasm"))]
  origin: AtomicU8,
}

/// Shared by the env teardown hook and the threadsafe function's finalize callback; boxed, and
/// freed exactly once, by the finalize callback (which during an env teardown runs after the
/// LIFO-ordered cleanup hooks).
struct DeferredHookData {
  /// Strong, so the teardown hook and the finalize callback always reach the lock, also while the
  /// last `JsDeferred` is inside its `Drop`. A `Weak` would fail to upgrade there, and nothing
  /// would order that `Drop` against the host freeing the threadsafe function.
  handle: Arc<DeferredHandle>,
  /// Whether the env cleanup hook is currently registered: set once registration succeeds,
  /// cleared when the teardown hook runs (Node's teardown drain consumes hooks as it runs them).
  /// The finalize callback only unregisters the hook while this is set — Node-API requires the
  /// removed pair to still be registered, otherwise the process may abort (Bun ≤ 1.2.20 aborts via
  /// `NAPI_PERISH`; fixed in 1.2.21 to match Node's silent no-op).
  hook_registered: AtomicBool,
}

// The raw threadsafe-function pointer makes the handle neither `Send` nor `Sync`, but calling a
// threadsafe function from any thread is its documented purpose, and the mutex hands it to
// exactly one consumer.
unsafe impl Send for DeferredHandle {}
unsafe impl Sync for DeferredHandle {}

/// The settling side of a promise ([`Env::create_deferred`], `#[napi] async fn`,
/// `Env::spawn_future`), which any thread may resolve or reject once. The settle goes back to
/// the env's JavaScript thread through a threadsafe function.
///
/// How the promise is made depends on the env (see `crate::async_work::promise`):
///
/// * On the main thread of Node and Bun, and on wasm, with `napi_create_promise`, as before
///   #3689. A promise still pending when such an env is torn down (process exit) leaks its 16 B
///   deferred.
/// * Everywhere else (workers, Electron and NW.js renderers, Bun on Windows, Deno), by a small
///   per-env JavaScript function, so no `napi_deferred` exists. A promise still pending, or a
///   settle still queued, when the env is torn down leaves nothing behind: env teardown frees its
///   state. This costs about 0.5 to 1.3 µs (about 10%) more JavaScript-thread CPU per
///   `async fn` call in a worker (release builds, Node 20 to 26), and is observable:
///   * one extra microtask job right after the promise is made, and one extra
///     `async_hooks` / `v8.promiseHooks` `before`/`after` pair for the promise (standard for a
///     promise resolved with a thenable);
///   * a settle that comes back before that job ran (only inside a nested event loop) is kept,
///     and settles the promise at the next microtask checkpoint;
///   * the env's first such promise may pick the env's settle mode (it reads
///     `process.versions`, once) and compiles the function (`napi_run_script`: one anonymous
///     script in the inspector);
///   * near the stack limit, calling that function can throw where `napi_create_promise` did
///     not. The exception is cleared and that one promise is made with `napi_create_promise`,
///     which keeps the old 16 B leak if its env is torn down before it settles. So does every
///     promise of an env that has no registration record of this addon, or whose host blocks
///     the compile.
///
/// Dropping every clone without settling (native targets):
///
/// * The promise of a `#[napi] async fn`, `Env::spawn_future`, `Env::spawn_future_with_callback`
///   or `AsyncBlock` is **rejected** when its task is dropped before it completed, for example
///   by a runtime shutdown:
///   `Error("task was cancelled before completion")`, `code` `GenericFailure` (what a custom
///   `AsyncRuntime` backend that cancels a task already did).
/// * A deferred of [`Env::create_deferred`] dropped on **another thread** was sent away, so its
///   promise went to JavaScript: it is **rejected** with
///   `Error("JsDeferred was dropped without being settled")`, `code` `GenericFailure`.
/// * A deferred of [`Env::create_deferred`] dropped on **its own JavaScript thread** (the common
///   case: `let (d, p) = env.create_deferred()?; step()?;` returns the error, so the promise never
///   reaches JavaScript) is **cleaned up at once**, inside the `Drop`, before control returns to
///   JavaScript: the threadsafe function is released, the trace reference and the thenable slot
///   are freed. In deferred mode (the main thread of Node and Bun) the `napi_deferred` is freed
///   too, by resolving it with an inert thenable (one extra microtask job and `async_hooks`
///   `before`/`after` pair, as in thenable mode). The promise is not rejected: it stays pending
///   for ever, held by nothing, so it and its awaiters can be collected. With a JavaScript
///   exception pending in deferred mode, the cleanup is queued to the JavaScript thread instead,
///   and the exception is left untouched.
///
/// A rejection is built and delivered on the JavaScript thread; with `deferred_trace` its stack
/// is the JavaScript caller that made the promise. Limits:
///
/// * A deferred of [`Env::create_deferred`] dropped on its own JavaScript thread is cleaned up
///   silently and stays pending **even when JavaScript already holds its promise**: dropped in a
///   later call, after its promise was handed to a JavaScript callback, or after it was sent to
///   another thread and came back (dropped inside a threadsafe-function callback or another
///   deferred's resolver). Settle it explicitly when JavaScript may await it.
/// * A deferred of [`Env::create_deferred`] dropped on another thread is rejected **even when its
///   promise never reached JavaScript** (a `?` after the deferred was sent away). Nothing handles
///   that rejection: Node reports an unhandled rejection, which ends the process with exit code
///   1 on the main thread and emits `'error'` on a worker (Bun does the same). Settle it
///   explicitly instead of dropping it.
/// * `Env::spawn_future`, `Env::spawn_future_with_callback` and `AsyncBlockBuilder::build` give
///   the promise to the Rust caller. A caller that drops it instead of returning it to JavaScript
///   leaves a promise that nothing can handle: when its task is dropped (or fails), the rejection
///   is unhandled, with the same result as above.
/// * In deferred mode the cleanup on the JavaScript thread calls `napi_resolve_deferred` inside
///   the `Drop`, so an `async_hooks` / `v8.promiseHooks` callback can run JavaScript there.
/// * On wasm, dropping does nothing, as before, also for the task of an `async fn` dropped by a
///   runtime shutdown: its promise stays pending.
///
/// A deferred that is neither settled nor dropped (for example one passed to `mem::forget`) still
/// holds its threadsafe function, so the event loop of its thread stays alive: the process or the
/// worker does not exit on its own. Only an end of the env from outside releases it. In a worker
/// (`worker.terminate()`, `process.exit()` in the worker, or the parent exiting) the env cleanup
/// hook releases the threadsafe function, and only the memory the leaked value owns stays
/// allocated. `process.exit()` on the main thread runs no env cleanup hooks: the process ends and
/// the operating system takes the memory back.
///
/// The settle-time callback (see [`JsDeferred::set_finalize_callback`]) does not run then, not
/// even when the promise is rejected: it is dropped without running, as before, by the last
/// holder of its slot (normally the thread that drops the last clone). Nothing user-owned travels
/// to the JavaScript thread with the abandon (a rejection carries only a tag),
/// because a host may never deliver it (Deno does not run the env cleanup hooks of a busy worker
/// that is terminated, and then accepts the call but never runs it).
///
/// A `#[napi] async fn` roots each of its `&T` arguments in its borrow scope. When the task is
/// dropped unsettled (runtime shutdown, a dropped future), dropping the settle-time callback hands
/// those roots to the env's custom-GC handle, which deletes them on the JavaScript thread, so the
/// values can be collected (on wasm the instance of an abandoned async `&self` method was still
/// seen alive after that; not investigated). Known limit: output of `napi-derive` older than this
/// release keeps one extra reference per argument that only the settle deletes; dropped
/// unsettled, it is never deleted and keeps its value alive until the env is torn down.
pub struct JsDeferred<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> {
  /// Everything a settle or an abandon needs, and the drop duty. Not generic, so dropping a
  /// `JsDeferred` never needs `Data` or `Resolver` to be alive (no drop-check constraint on them).
  inner: DeferredInner,
  /// What the threadsafe-function callback would otherwise receive as `env`. Kept so a settle
  /// made on the owning thread *inside* the wasm environment cleanup barrier can reach the
  /// promise directly, without the host's macrotask dispatch. wasm only: every other target
  /// settles through the queue exclusively.
  #[cfg(target_family = "wasm")]
  env: sys::napi_env,
  #[cfg(target_family = "wasm")]
  owner_thread: std::thread::ThreadId,
  _data: PhantomData<Data>,
  _resolver: PhantomData<Resolver>,
}

// A trick to send the resolver into the `panic` handler
// Do not use clone in the other place besides the `fn execute_tokio_future`
impl<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> Clone
  for JsDeferred<Data, Resolver>
{
  fn clone(&self) -> Self {
    Self {
      inner: self.inner.clone(),
      #[cfg(target_family = "wasm")]
      env: self.env,
      #[cfg(target_family = "wasm")]
      owner_thread: self.owner_thread,
      _data: PhantomData,
      _resolver: PhantomData,
    }
  }
}

unsafe impl<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> Send
  for JsDeferred<Data, Resolver>
{
}

impl<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> JsDeferred<Data, Resolver> {
  /// A user deferred ([`Env::create_deferred`]): napi-rs cannot see whether its promise reaches
  /// JavaScript (see the type docs for what a drop does).
  pub(crate) fn new(env: &Env) -> Result<(Self, Object<'_>)> {
    #[cfg(not(target_family = "wasm"))]
    return Self::new_with_origin(env, ORIGIN_USER);
    #[cfg(target_family = "wasm")]
    Self::new_with_origin(env)
  }

  /// The deferred of a task whose promise napi-rs hands to JavaScript (`#[napi] async fn`,
  /// `Env::spawn_future`, `AsyncBlock`). Dropped unsettled on another thread, or on its own
  /// thread after [`Self::mark_returned`], its promise is rejected.
  #[cfg(all(
    not(feature = "noop"),
    any(feature = "tokio_rt", feature = "async-runtime")
  ))]
  pub(crate) fn new_task(env: &Env) -> Result<(Self, Object<'_>)> {
    #[cfg(not(target_family = "wasm"))]
    return Self::new_with_origin(env, ORIGIN_TASK);
    #[cfg(target_family = "wasm")]
    Self::new_with_origin(env)
  }

  /// Marks the promise of a [`Self::new_task`] deferred as handed to JavaScript: from now on, a
  /// drop on the JavaScript thread rejects it too (a `current_thread` runtime shut down on the
  /// JavaScript thread drops its tasks there). One `Relaxed` store. Nothing on wasm, where a
  /// dropped deferred does nothing. Gated like its only caller, the Tokio spawn in
  /// `execute_erased_future`.
  #[cfg(all(
    not(feature = "noop"),
    feature = "tokio_rt",
    any(not(target_family = "wasm"), tokio_unstable)
  ))]
  pub(crate) fn mark_returned(&self) {
    #[cfg(not(target_family = "wasm"))]
    self
      .inner
      .handle
      .origin
      .store(ORIGIN_TASK_RETURNED, Ordering::Relaxed);
  }

  fn new_with_origin(
    env: &Env,
    #[cfg(not(target_family = "wasm"))] origin: u8,
  ) -> Result<(Self, Object<'_>)> {
    let handle = Arc::new(DeferredHandle {
      pending_tsfn: Mutex::new(None),
      #[cfg(not(target_family = "wasm"))]
      owners: AtomicUsize::new(1),
      #[cfg(not(target_family = "wasm"))]
      env: env.0,
      #[cfg(not(target_family = "wasm"))]
      owner_thread: std::thread::current().id(),
      #[cfg(not(target_family = "wasm"))]
      origin: AtomicU8::new(origin),
    });
    let hook_data_ptr = Box::into_raw(Box::new(DeferredHookData {
      handle: handle.clone(),
      hook_registered: AtomicBool::new(false),
    }));

    let (tsfn, target, promise) = match js_deferred_new_raw(
      env,
      Some(napi_resolve_deferred::<Data, Resolver>),
      hook_data_ptr.cast(),
    ) {
      Ok(created) => created,
      Err(err) => {
        drop(unsafe { Box::from_raw(hook_data_ptr) });
        return Err(err);
      }
    };
    *handle
      .pending_tsfn
      .lock()
      .expect("JsDeferred pending lock failed") = Some(tsfn);

    // Pre-abort the threadsafe function when the environment tears down, before Node finalizes
    // it: a deferred settled from a foreign thread after (or while) its env tears down (e.g. a
    // future resolving after a worker thread terminated, see napi-rs#2460) would otherwise call
    // into a freed threadsafe function. Node registers the threadsafe function's own teardown as
    // a cleanup hook at creation, and hooks run in reverse registration order, so this hook runs
    // before Node finalizes the threadsafe function.
    #[cfg(not(target_family = "wasm"))]
    {
      if let Err(err) = check_status!(
        unsafe {
          sys::napi_add_env_cleanup_hook(
            env.0,
            Some(deferred_env_teardown_cb),
            hook_data_ptr.cast(),
          )
        },
        "Register env cleanup hook in JsDeferred failed"
      ) {
        // The tsfn exists but no teardown hook guards it yet. Release it so it cannot keep the loop
        // alive; its finalize callback owns the boxed `DeferredHookData`, frees it, and — seeing
        // `hook_registered == false` — skips the unregister. Do NOT free the box here: that would
        // double-free against the finalize callback. No `JsDeferred` exists yet, so no `Drop` runs.
        if let Some(tsfn) = handle
          .pending_tsfn
          .lock()
          .expect("JsDeferred pending lock failed")
          .take()
        {
          unsafe {
            sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::abort)
          };
        }
        // The promise is never handed out.
        target.release(env.0);
        return Err(err);
      }
      unsafe { &*hook_data_ptr }
        .hook_registered
        .store(true, Ordering::Release);
    }

    // Create the trace ref LAST, after every fallible step. `DeferredTrace` has no `Drop` (its
    // `napi_ref` is deleted by hand when the promise settles), so building it before a step that can
    // still fail would leak that ref on the error path. On its own failure there is no trace ref yet
    // to leak, and we release the still-`Some` tsfn so it cannot strand the loop either — its
    // finalize still frees the boxed `DeferredHookData`, so (as above) we must not free it here.
    #[cfg(feature = "deferred_trace")]
    let trace = match DeferredTrace::new(env.0) {
      // Thenable mode: the slot keeps the reference, so the env-teardown sweep deletes it if the
      // settle never comes back.
      Ok(trace) => match target {
        SettleTarget::Thenable(promise) if promise.set_extra(env.0, trace.0) => None,
        _ => Some(trace),
      },
      Err(err) => {
        if let Some(tsfn) = handle
          .pending_tsfn
          .lock()
          .expect("JsDeferred pending lock failed")
          .take()
        {
          unsafe {
            sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::abort)
          };
        }
        target.release(env.0);
        return Err(err);
      }
    };

    let deferred = Self {
      inner: DeferredInner {
        handle,
        target,
        #[cfg(feature = "deferred_trace")]
        trace,
        finalize_callback: Default::default(),
        #[cfg(not(target_family = "wasm"))]
        abandon: queue_abandon::<Data, Resolver>,
      },
      #[cfg(target_family = "wasm")]
      env: env.0,
      #[cfg(target_family = "wasm")]
      owner_thread: std::thread::current().id(),
      _data: PhantomData,
      _resolver: PhantomData,
    };

    Ok((deferred, promise))
  }

  /// Consumes the deferred, and resolves the promise. The provided function will be called
  /// from the JavaScript thread, and should return the resolved value.
  pub fn resolve(self, resolver: Resolver) {
    self.call_tsfn(Ok(resolver))
  }

  /// Consumes the deferred, and rejects the promise with the provided error.
  pub fn reject(self, error: Error) {
    self.call_tsfn(Err(error))
  }

  /// Replaces the settle-time callback through the shared slot.
  ///
  /// Written through the lock rather than swapped for a new `Arc` so a slot cloned
  /// earlier — `AsyncBlock` installs its deferred borrow scope this way — can never
  /// detach from the callback `settle_deferred` reads.
  ///
  /// The callback runs once, on the JavaScript thread, when the promise settles. It does not run
  /// when every clone is dropped without settling, also when that rejects the promise: it is then
  /// dropped, without running, on the thread that drops the last clone, as before. It does not
  /// run either when the env is torn down first.
  #[allow(clippy::arc_with_non_send_sync)]
  pub fn set_finalize_callback(
    &mut self,
    finalize_callback: Option<Box<dyn FnOnce(sys::napi_env)>>,
  ) {
    *RwLock::write(&self.inner.finalize_callback).expect("RwLock Poison") = finalize_callback;
  }

  /// The settle-time callback slot this deferred's clones share. Claimants that only
  /// learn which scope is theirs at conversion time keep a clone of this handle and
  /// install their release callback into it later; [`settle_deferred`] takes whatever
  /// is written when the promise settles on the owner thread.
  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4",
    not(feature = "noop")
  ))]
  pub(crate) fn finalize_callback_handle(&self) -> FinalizeCallback {
    self.inner.finalize_callback.clone()
  }

  /// Queues the settle for the JavaScript thread, once per promise: the first caller takes the
  /// threadsafe function out of the shared slot, every later one (another clone, a call after env
  /// teardown) finds it empty and does nothing. `self` drops at the end, after the unlock; its
  /// [`DeferredInner`] then finds the slot empty.
  fn call_tsfn(mut self, result: Result<Resolver>) {
    let inner = &mut self.inner;
    let mut pending = inner
      .handle
      .pending_tsfn
      .lock()
      .expect("JsDeferred pending lock failed");
    let Some(tsfn) = pending.take() else {
      // The environment tore down (or another clone already settled the promise): the promise no
      // longer exists and the threadsafe function is gone. Drop the resolver instead of calling
      // into freed memory.
      return;
    };

    let data = DeferredData::<Data, Resolver> {
      outcome: Outcome::Settle(result),
      target: inner.target,
      #[cfg(feature = "deferred_trace")]
      trace: inner.trace.take(),
      tsfn,
      finalize_callback: inner.finalize_callback.clone(),
    };

    // Inside `napi_prepare_wasm_env_cleanup`, on the thread that owns this deferred: settle
    // now, while the environment is still fully alive, instead of appending to a queue the
    // host dispatches two macrotasks later. A caller that destroys the environment in the same
    // synchronous turn — `emnapiContext.destroy()` called by hand, a `process.on('exit')`
    // handler — never reaches that dispatch, and the promise this settle owns would be
    // discarded with the rest of the queue.
    //
    // The lock is released first, deliberately. Delivering releases the threadsafe function's
    // last thread count, which can run `deferred_finalize_cb` — and that takes this very lock.
    // Nothing else can race for it here: this is the owning JavaScript thread, and the tsfn has
    // already been taken out of the handle, so a concurrent settle from a worker returns early.
    #[cfg(target_family = "wasm")]
    let data = if settles_synchronously(self.owner_thread) {
      let env = self.env;
      // `napi_prepare_wasm_env_cleanup` is a bare wasm export: JavaScript enters it directly,
      // not through a napi entry point, so — unlike the threadsafe-function dispatch that
      // normally runs the settle — there is no handle scope open. Settling creates
      // `napi_value`s, so open the scope the dispatcher would have opened.
      match DeferredHandleScope::open(env) {
        Some(_scope) => {
          drop(pending);
          settle_deferred::<Data, Resolver>(env, data);
          return;
        }
        // No scope, so nothing here may create a `napi_value`. Fall back to the queue: worse,
        // never wrong — this is the behaviour every caller had before the barrier delivered.
        None => data,
      }
    } else {
      data
    };

    // Count the settle *before* it is queued: on wasm32-wasip1-threads this may run on a
    // backend-owned thread, and the JavaScript thread must be able to observe the pending
    // settle the moment `AsyncRuntime::shutdown` returns.
    #[cfg(target_family = "wasm")]
    PENDING_DEFERRED_SETTLES.fetch_add(1, Ordering::SeqCst);

    // Call back into the JS thread via a threadsafe function. This results in napi_resolve_deferred being called.
    let status = unsafe {
      sys::napi_call_threadsafe_function(
        tsfn,
        Box::into_raw(Box::from(data)).cast(),
        sys::ThreadsafeFunctionCallMode::blocking,
      )
    };
    // A rejected call queued nothing, so `napi_resolve_deferred` will never run for it and
    // would otherwise leave the counter permanently above zero.
    #[cfg(target_family = "wasm")]
    if status != sys::Status::napi_ok {
      release_pending_deferred_settle();
    }
    // Unlock before `self` drops: its `DeferredInner` takes this lock (and finds the slot empty).
    drop(pending);
    debug_assert!(
      status == sys::Status::napi_ok,
      "Call threadsafe function in JsDeferred failed"
    );
  }
}

/// The trace reference a deferred carries, or nothing without `deferred_trace`. Lets
/// [`QueueAbandon`] have one signature for both builds.
#[cfg(all(not(target_family = "wasm"), feature = "deferred_trace"))]
type MaybeTrace = Option<DeferredTrace>;
#[cfg(all(not(target_family = "wasm"), not(feature = "deferred_trace")))]
type MaybeTrace = ();

/// Builds and queues the abandon item of one `JsDeferred<Data, Resolver>` (see [`queue_abandon`]).
/// A plain function pointer, so [`DeferredInner`] needs no type parameter.
#[cfg(not(target_family = "wasm"))]
type QueueAbandon = unsafe fn(
  sys::napi_threadsafe_function,
  SettleTarget,
  MaybeTrace,
  Option<AbandonReason>,
) -> sys::napi_status;

/// Whether a JavaScript exception is pending on `env`. The call has no `NAPI_PREAMBLE`.
#[cfg(any(not(target_family = "wasm"), feature = "deferred_trace"))]
fn exception_pending(env: sys::napi_env) -> bool {
  let mut pending = false;
  let status = unsafe { sys::napi_is_exception_pending(env, &mut pending) };
  status == sys::Status::napi_ok && pending
}

/// What a `JsDeferred` and each of its clones own, and the drop duty: the last one dropped with
/// the promise still pending abandons it (see the `Drop` impl).
///
/// Not generic on purpose. A `Drop` impl on the generic `JsDeferred<Data, Resolver>` makes the
/// compiler require `Resolver` (and what it borrows) to outlive every `JsDeferred` (drop check):
/// a resolver closure borrowing a local declared after the deferred then fails to compile
/// (E0597) where the deferred is not consumed on every path. This type owns everything the
/// abandon needs, and reaches `Data` and `Resolver` only through `abandon`, a plain function
/// pointer, so its `Drop` never touches either.
struct DeferredInner {
  handle: Arc<DeferredHandle>,
  target: SettleTarget,
  /// `None` in thenable mode: the promise's slot keeps the trace reference, so the env-teardown
  /// sweep deletes it if the settle never comes back.
  #[cfg(feature = "deferred_trace")]
  trace: Option<DeferredTrace>,
  finalize_callback: FinalizeCallback,
  /// `queue_abandon::<Data, Resolver>`, chosen in `JsDeferred::new_with_origin`.
  #[cfg(not(target_family = "wasm"))]
  abandon: QueueAbandon,
}

impl Clone for DeferredInner {
  fn clone(&self) -> Self {
    #[cfg(not(target_family = "wasm"))]
    self.handle.owners.fetch_add(1, Ordering::Relaxed);
    Self {
      handle: self.handle.clone(),
      target: self.target,
      #[cfg(feature = "deferred_trace")]
      trace: self.trace.clone(),
      finalize_callback: self.finalize_callback.clone(),
      #[cfg(not(target_family = "wasm"))]
      abandon: self.abandon,
    }
  }
}

/// The last clone dropped with the promise still pending abandons it, by the rule of
/// [`abandon_action`]: on its JavaScript thread it is cleaned up here, at once
/// ([`abandon_on_js_thread`]); otherwise an item is queued to the JavaScript thread, which
/// rejects the promise or (with an exception pending) cleans up. Either way the threadsafe
/// function is released. Unreleased, it is ref'd and keeps the event loop alive for ever, and
/// Node >= 24.13.1 / 25.4 / 26 leaks it at env teardown.
///
/// The settle-time callback stays here: the `finalize_callback` field drops after this function,
/// so after the unlock, on this thread, without running, as before the abandon existed. Nothing
/// user-owned goes into the item (a rejection carries a tag, its error is built on the JavaScript
/// thread): no host promises to deliver an item queued after its env stopped running. Deno 2.6.1
/// does not run the env cleanup hooks of a busy worker that is terminated, so the teardown hook
/// never empties the slot; the call then returns `napi_ok` and the item is never delivered nor
/// freed.
///
/// The lock is held across the queue call, like a settle, so the env teardown hook and the
/// finalize callback (which take it) cannot let the host free the threadsafe function meanwhile.
/// The cleanup here unlocks first: releasing the threadsafe function can run its finalize
/// callback at once (Bun, emnapi), which takes the lock. Nothing else can take the slot meanwhile:
/// it is already empty. After a settle or an env teardown the slot is empty, and this is one
/// atomic decrement and one uncontended lock, with no napi call and no read of the env. Never
/// panics: a poisoned lock is taken anyway.
///
/// Not on wasm, where nothing changes: there is no env teardown hook to order a `Drop` against, and
/// `discard_wasm_cancel_mailbox` relies on a dropped deferred making no napi call.
#[cfg(not(target_family = "wasm"))]
impl Drop for DeferredInner {
  fn drop(&mut self) {
    if self.handle.owners.fetch_sub(1, Ordering::AcqRel) != 1 {
      return;
    }
    let mut pending = self
      .handle
      .pending_tsfn
      .lock()
      .unwrap_or_else(PoisonError::into_inner);
    let Some(tsfn) = pending.take() else {
      // Settled, or the env teardown hook or the finalize callback ran: the env may be gone.
      return;
    };
    #[cfg(feature = "deferred_trace")]
    let trace = self.trace.take();
    #[cfg(not(feature = "deferred_trace"))]
    let trace = ();
    // Only now may the env be read: the slot was `Some`, so the env teardown hook has not run,
    // and the env is alive (see `DeferredHandle::env`). The thread alone proves nothing: a
    // thread may run several envs, and outlive them.
    let env = self.handle.env;
    let on_owner = self.handle.owner_thread == std::thread::current().id();
    let origin = self.handle.origin.load(Ordering::Relaxed);
    let is_deferred = matches!(self.target, SettleTarget::Deferred(_));
    let exception_pending = on_owner && is_deferred && exception_pending(env);
    match abandon_action(on_owner, origin, is_deferred, exception_pending) {
      AbandonAction::Queue(reason) => {
        let status = unsafe { (self.abandon)(tsfn, self.target, trace, reason) };
        release_unqueued_count(tsfn, status);
      }
      AbandonAction::Sync => {
        drop(pending);
        abandon_on_js_thread(env, tsfn, self.target, trace, true);
        ABANDONED_SYNC.fetch_add(1, Ordering::Relaxed);
      }
    }
  }
}

/// Cleans up the promise of a `JsDeferred` dropped unsettled, on its env's JavaScript thread with
/// the env alive, and leaves it pending: frees the `napi_deferred` (an inert thenable, refused
/// and so leaked, 16 B, while the env cannot run JavaScript), releases the threadsafe function's
/// thread count, deletes the trace reference and frees the thenable slot. Runs from the `Drop`
/// itself (`open_scope`: it may run outside any napi callback, where Node has no handle scope),
/// or from the queued [`Outcome::Abandon`]`(None)` item (the dispatch has a scope open).
///
/// Never reads, clears or replaces a pending exception that is not its own. Called without the
/// `pending_tsfn` lock: the release can run the finalize callback at once, which takes it.
#[cfg(not(target_family = "wasm"))]
fn abandon_on_js_thread(
  env: sys::napi_env,
  tsfn: sys::napi_threadsafe_function,
  target: SettleTarget,
  trace: MaybeTrace,
  open_scope: bool,
) {
  if let SettleTarget::Deferred(deferred) = target {
    let scope = if open_scope {
      DeferredHandleScope::open(env)
    } else {
      None
    };
    // No scope where one is needed: make no handle, and leak the 16 B deferred.
    if !open_scope || scope.is_some() {
      // Returns at once with an exception pending; clears only the exceptions it made.
      crate::async_work::release_deferred_pending(env, deferred);
    }
    drop(scope);
  }
  unsafe {
    sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::release)
  };
  // Deferred mode. Thenable mode keeps the reference in the slot, which `release` deletes.
  #[cfg(feature = "deferred_trace")]
  if let Some(trace) = trace {
    unsafe { sys::napi_delete_reference(env, trace.0) };
  }
  #[cfg(not(feature = "deferred_trace"))]
  let () = trace;
  // No JavaScript, no handle: legal with an exception pending and during teardown.
  target.release(env);
}

/// [`QueueAbandon`] for one `Data` / `Resolver`: queues an [`Outcome::Abandon`] item. The item
/// holds no resolver, a trace reference with no `Drop`, an empty callback slot and at most a
/// [`AbandonReason`] tag: nothing user-owned, so an item the host never delivers leaks only
/// napi-rs state (this box, the empty slot, the trace reference). A call that queued nothing
/// hands the item back, and it is freed here, under the caller's lock; that runs no user code.
#[cfg(not(target_family = "wasm"))]
unsafe fn queue_abandon<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>>(
  tsfn: sys::napi_threadsafe_function,
  target: SettleTarget,
  trace: MaybeTrace,
  reason: Option<AbandonReason>,
) -> sys::napi_status {
  #[cfg(not(feature = "deferred_trace"))]
  let () = trace;
  let item = Box::into_raw(Box::new(DeferredData::<Data, Resolver> {
    outcome: Outcome::Abandon(reason),
    target,
    #[cfg(feature = "deferred_trace")]
    trace,
    tsfn,
    // Empty. The settle-time callback stays with the dropping thread (see the `Drop`).
    finalize_callback: Default::default(),
  }));
  let status = unsafe {
    sys::napi_call_threadsafe_function(tsfn, item.cast(), sys::ThreadsafeFunctionCallMode::blocking)
  };
  if status != sys::Status::napi_ok {
    drop(unsafe { Box::from_raw(item) });
  }
  status
}

/// After a `napi_call_threadsafe_function` on a deferred's threadsafe function. `napi_closing`
/// used up our thread count. Any other failure did not: release it, so the threadsafe function
/// cannot stay alive (it is ref'd: it would keep the event loop alive). Called under the
/// `pending_tsfn` lock, so the finalize callback (which takes the lock) cannot let the host free
/// the threadsafe function before the call is done with it. Used by the abandon only: the settle
/// path keeps its old handling of a failed call.
#[cfg(not(target_family = "wasm"))]
fn release_unqueued_count(tsfn: sys::napi_threadsafe_function, status: sys::napi_status) {
  if status != sys::Status::napi_ok && status != sys::Status::napi_closing {
    unsafe {
      sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::release)
    };
  }
}

/// Aborts the deferred's threadsafe function when its environment starts tearing down, before
/// Node finalizes it. Runs on the environment's thread; the `pending_tsfn` lock serializes it
/// against settles on foreign threads.
#[cfg(not(target_family = "wasm"))]
unsafe extern "C" fn deferred_env_teardown_cb(data: *mut c_void) {
  let hook_data = unsafe { &*data.cast::<DeferredHookData>() };
  // The teardown drain consumes this hook as it runs it; the threadsafe function's finalize
  // callback, which runs later in the teardown, must not unregister it a second time.
  hook_data.hook_registered.store(false, Ordering::Release);

  let mut pending = hook_data
    .handle
    .pending_tsfn
    .lock()
    .expect("JsDeferred pending lock failed");
  if let Some(tsfn) = pending.take() {
    let status = unsafe {
      sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::abort)
    };
    debug_assert!(
      status == sys::Status::napi_ok,
      "Abort deferred threadsafe function on env teardown failed"
    );
  }
}

/// Finalize callback of the deferred's threadsafe function: unregisters the teardown hook (when
/// it is still registered — during an env teardown the drain already consumed it) and frees the
/// shared hook data exactly once.
unsafe extern "C" fn deferred_finalize_cb(
  env: sys::napi_env,
  finalize_data: *mut c_void,
  _finalize_hint: *mut c_void,
) {
  let hook_registered = unsafe { &*finalize_data.cast::<DeferredHookData>() }
    .hook_registered
    .load(Ordering::Acquire);
  #[cfg(not(target_family = "wasm"))]
  if !env.is_null() && hook_registered {
    unsafe {
      sys::napi_remove_env_cleanup_hook(env, Some(deferred_env_teardown_cb), finalize_data)
    };
  }
  #[cfg(target_family = "wasm")]
  {
    let _ = env;
    let _ = hook_registered;
  }

  let hook_data = unsafe { Box::from_raw(finalize_data.cast::<DeferredHookData>()) };
  hook_data
    .handle
    .pending_tsfn
    .lock()
    .expect("JsDeferred pending lock failed")
    .take();
}

fn js_deferred_new_raw(
  env: &Env,
  resolve_deferred: sys::napi_threadsafe_function_call_js,
  finalize_data: *mut c_void,
) -> Result<(sys::napi_threadsafe_function, SettleTarget, Object<'_>)> {
  // Same reasoning as `ThreadsafeFunction::create`: a `JsDeferred` is `Send`
  // precisely so a foreign thread can settle it, so this addon's code becomes
  // reachable from a thread that can outlive the environment. `Env::create_deferred`
  // needs only `napi4`, so this path is reachable in a build where no runtime
  // pins the image. Pin on the environment's own thread, at creation.
  #[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
  crate::bindgen_runtime::retain_current_module_for_unload_safety();

  // Thenable mode: a promise without a `napi_deferred`, so an env torn down before the settle
  // comes back leaks nothing (see `crate::async_work::promise`). Else, as before.
  let (raw_promise, target) = match crate::async_work::create_detached(env.0)? {
    Some((promise, detached)) => (promise, SettleTarget::Thenable(detached)),
    None => {
      let mut raw_promise = ptr::null_mut();
      let mut raw_deferred = ptr::null_mut();
      check_status!(
        unsafe { sys::napi_create_promise(env.0, &mut raw_deferred, &mut raw_promise) },
        "Create promise in JsDeferred failed"
      )?;
      (raw_promise, SettleTarget::Deferred(raw_deferred))
    }
  };
  // The promise is never handed out on an error below: free its slot (thenable mode).
  let fail = |err: Error| {
    target.release(env.0);
    err
  };

  // Create a threadsafe function so we can call back into the JS thread when we are done.
  let mut async_resource_name = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_create_string_utf8(
        env.0,
        c"napi_resolve_deferred".as_ptr().cast(),
        22,
        &mut async_resource_name,
      )
    },
    "Create async resource name in JsDeferred failed"
  )
  .map_err(fail)?;

  let mut tsfn = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_create_threadsafe_function(
        env.0,
        ptr::null_mut(),
        ptr::null_mut(),
        async_resource_name,
        0,
        1,
        finalize_data,
        Some(deferred_finalize_cb),
        // The settle target travels in each queued `DeferredData`.
        ptr::null_mut(),
        resolve_deferred,
        &mut tsfn,
      )
    },
    "Create threadsafe function in JsDeferred failed"
  )
  .map_err(fail)?;

  let promise = Object::from_raw(env.0, raw_promise);

  Ok((tsfn, target, promise))
}

/// Saturating decrement, so a decrement that is somehow unpaired cannot wrap the counter to
/// `u32::MAX` and make every later disposal spin until its bound.
#[cfg(target_family = "wasm")]
fn release_pending_deferred_settle() {
  let _ = PENDING_DEFERRED_SETTLES.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |pending| {
    Some(pending.saturating_sub(1))
  });
}

extern "C" fn napi_resolve_deferred<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>>(
  env: sys::napi_env,
  _js_callback: sys::napi_value,
  _context: *mut c_void,
  data: *mut c_void,
) {
  // The item has left the queue, whichever branch below handles it. Release it first so an
  // early return — or a resolver that traps the instance — cannot strand the count.
  #[cfg(target_family = "wasm")]
  release_pending_deferred_settle();

  let deferred_data: Box<DeferredData<Data, Resolver>> = unsafe { Box::from_raw(data.cast()) };

  // A leftover queue item is drained with a null env while the threadsafe function closes during env
  // teardown. There is no promise left to settle, but this item still owns the release of the
  // threadsafe function's thread count (moved here by the settle in `call_tsfn`). Recent Node (its
  // `MaybeDelete` only frees the threadsafe function once the count reaches zero) and emnapi will
  // otherwise leak the threadsafe function, so we must release it here too instead of only on the
  // settle path below. This is safe during the teardown drain: `EmptyQueue` runs this callback
  // without holding the tsfn lock, and while it is closing the release only drops the count — the
  // object is deleted exactly once by the finalize that immediately follows.
  if env.is_null() {
    unsafe {
      sys::napi_release_threadsafe_function(
        deferred_data.tsfn,
        sys::ThreadsafeFunctionReleaseMode::release,
      )
    };
    return;
  }

  settle_deferred::<Data, Resolver>(env, *deferred_data);
}

/// Settles the promise this deferred owns, releasing the threadsafe function's thread count on
/// the way.
///
/// Reached two ways, doing the same thing both times: dispatched out of the threadsafe-function
/// queue by the host (`napi_resolve_deferred`), or called straight from `call_tsfn` on wasm when
/// the environment cleanup barrier is running on the owning thread and the queue would not be
/// dispatched in time. It must therefore assume nothing about which one it is: `env` is a live
/// environment on the owning thread in both.
/// Whether `err` is an env's refusal to run JavaScript, not an exception: the status of a
/// refused call (`napi_pending_exception`, or `napi_cannot_run_js` for a Node-API 10 module,
/// which has no [`Status`](crate::Status) of its own) with no exception pending.
fn refused_by_env(env: sys::napi_env, err: &Error) -> bool {
  let mut pending = false;
  matches!(
    err.status,
    crate::Status::PendingException | crate::Status::Unknown
  ) && unsafe { sys::napi_is_exception_pending(env, &mut pending) } == sys::Status::napi_ok
    && !pending
}

fn settle_deferred<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>>(
  env: sys::napi_env,
  deferred_data: DeferredData<Data, Resolver>,
) {
  let target = deferred_data.target;
  let tsfn: sys::napi_threadsafe_function = deferred_data.tsfn;
  // An abandon that rejects goes down the normal settle path below, with an error built here
  // from its tag. The settle-time callback is not in the item (the dropping thread dropped it,
  // unrun), so nothing user-owned runs.
  #[cfg(not(target_family = "wasm"))]
  let mut abandon_rejects = false;
  let resolver = match deferred_data.outcome {
    Outcome::Settle(resolver) => resolver,
    #[cfg(not(target_family = "wasm"))]
    Outcome::Abandon(Some(reason)) => {
      abandon_rejects = true;
      Err(reason.error())
    }
    #[cfg(not(target_family = "wasm"))]
    Outcome::Abandon(None) => {
      // Dropped on this thread with an exception pending, in deferred mode: free the settle state
      // and leave the promise pending, but held by nothing, so it and its awaiters can be
      // collected. The dispatch has a handle scope open.
      #[cfg(feature = "deferred_trace")]
      let trace = deferred_data.trace;
      #[cfg(not(feature = "deferred_trace"))]
      let trace = ();
      abandon_on_js_thread(env, tsfn, target, trace, false);
      ABANDONED_QUEUED.fetch_add(1, Ordering::Relaxed);
      return;
    }
    // Never built on wasm.
    #[cfg(target_family = "wasm")]
    Outcome::Abandon(_) => return,
  };
  let finalize_callback = RwLock::write(&deferred_data.finalize_callback)
    .expect("RwLock Poison")
    .take();
  // Thenable mode keeps the trace reference in the slot: take it back before settling.
  #[cfg(feature = "deferred_trace")]
  let trace = deferred_data.trace.or_else(|| match target {
    SettleTarget::Thenable(promise) => promise.take_extra(env).map(DeferredTrace),
    SettleTarget::Deferred(_) => None,
  });
  let result = resolver
    .and_then(|resolver| resolver(Env::from_raw(env)))
    .and_then(|res| unsafe { ToNapiValue::to_napi_value(env, res) });

  let release_tsfn_result = check_status!(
    unsafe {
      sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::release)
    },
    "Release threadsafe function in JsDeferred failed"
  );

  // Whether the resolving call ran. It may have freed a `napi_deferred` even when it failed, so
  // only a promise it never touched is rejected with an exception from building the rejection.
  #[cfg(feature = "deferred_trace")]
  let mut resolve_attempted = false;
  if let Err(e) = release_tsfn_result.and(result).and_then(|res| {
    #[cfg(feature = "deferred_trace")]
    {
      resolve_attempted = true;
    }
    check_status!(
      target.settle(env, true, res),
      "Resolve deferred value failed"
    )
    .map(|_| {
      #[cfg(feature = "deferred_trace")]
      if let Some(trace) = &trace {
        let _status = unsafe { sys::napi_delete_reference(env, trace.0) };
        if _status != sys::Status::napi_ok && cfg!(debug_assertions) {
          eprintln!(
            "Failed to delete reference in deferred {}",
            crate::Status::from(_status)
          );
        }
      }
    })
  }) {
    // An exception pending now is not from building the rejection (the resolver left it).
    #[cfg(feature = "deferred_trace")]
    let pending_before_build = exception_pending(env);
    #[cfg(feature = "deferred_trace")]
    let error = match trace {
      Some(trace) => trace.into_rejected(env, e),
      // No trace: the slot is gone, so the settle below finds nothing to settle.
      None => unsafe { ToNapiValue::to_napi_value(env, e) },
    };
    // `ToNapiValue for Error` hands back the retained value verbatim and only
    // synthesizes a fresh `Error` when there is nothing to hand back.
    // `JsError::into_value` cannot be used here: it gates the reuse on
    // `napi_is_error`, so a promise rejected with a string, a number or a plain
    // object would settle with a newly created `Error` instead of the value
    // JavaScript actually rejected with.
    #[cfg(not(feature = "deferred_trace"))]
    let error = unsafe { ToNapiValue::to_napi_value(env, e) };
    // Building the rejection on the trace error can throw. On wasm, emnapi defines a property
    // through a JavaScript descriptor object, which a polluted `Object.prototype` (`get`, `set`)
    // makes invalid. The promise must not stay pending for ever, with the exception reported as
    // uncaught (or, for an abandon that rejects, cleared below and never reported): reject with
    // what was thrown. Only an exception that building the rejection made is taken, and only
    // when nothing called the promise's settling function yet, so this is its one settling call.
    #[cfg(feature = "deferred_trace")]
    let error = match error {
      Err(err) if !resolve_attempted && !pending_before_build => {
        crate::async_work::take_pending_exception(env).ok_or(err)
      }
      error => error,
    };

    match error {
      Ok(error) => {
        target.settle(env, false, error);
        #[cfg(not(target_family = "wasm"))]
        if abandon_rejects {
          ABANDON_REJECTED.fetch_add(1, Ordering::Relaxed);
        }
        if let Some(finalize_callback) = finalize_callback {
          finalize_callback(env);
        }
      }
      Err(err) => {
        if let Some(finalize_callback) = finalize_callback {
          finalize_callback(env);
        }
        if cfg!(debug_assertions) {
          // An env that cannot run JavaScript any more (worker terminate, env teardown) refuses
          // to build the rejection, and would refuse to deliver it. That is expected, and it
          // happens once per promise in flight: say nothing.
          if !refused_by_env(env, &err) {
            eprintln!("Failed to reject deferred: {err:?}");
          }
          let mut err = ptr::null_mut();
          let mut err_msg = ptr::null_mut();
          unsafe {
            sys::napi_create_string_utf8(env, c"Rejection failed".as_ptr().cast(), 0, &mut err_msg);
            sys::napi_create_error(env, ptr::null_mut(), err_msg, &mut err);
          }
          target.settle(env, false, err);
        }
      }
    }
  } else if let Some(finalize_callback) = finalize_callback {
    finalize_callback(env);
  }
  // Settled, refused or failed: the slot goes. A kept outcome stays for `then` (or the sweep).
  target.release(env);
  #[cfg(not(target_family = "wasm"))]
  if abandon_rejects {
    // Entered with no exception pending (see above), so one pending now came from the calls
    // above. Left pending, Node would report it as uncaught.
    let _ = crate::async_work::take_pending_exception(env);
  }
}

/// Compile-only: never called. A resolver that borrows a local declared after the deferred, with
/// the deferred not consumed on every path. A `Drop` impl on the generic `JsDeferred` fails this
/// with E0597 (`s` dropped while still borrowed); [`DeferredInner`] keeps it compiling.
#[cfg(all(test, feature = "napi4"))]
#[allow(dead_code)]
fn dropck_resolver_borrows_later_local(env: &Env, cond: bool) -> Result<()> {
  let (deferred, _p) = env.create_deferred()?;
  let s = String::from("x");
  let resolver = |_env: Env| Ok(s.len() as u32);
  if cond {
    deferred.resolve(resolver);
  }
  Ok(())
}

/// The abandon rule, row by row: every combination of thread, origin, settle target and pending
/// exception.
#[cfg(all(test, not(target_family = "wasm")))]
mod abandon_action_tests {
  use super::AbandonAction::{Queue, Sync};
  use super::*;

  const U: u8 = ORIGIN_USER;
  const T: u8 = ORIGIN_TASK;
  const R: u8 = ORIGIN_TASK_RETURNED;
  const REJECT_DROPPED: AbandonAction = Queue(Some(AbandonReason::DeferredDropped));
  const REJECT_TASK: AbandonAction = Queue(Some(AbandonReason::TaskDropped));
  const QUEUE_CLEANUP: AbandonAction = Queue(None);

  #[test]
  fn abandon_action_table() {
    // (on_owner, origin, is_deferred, exception_pending, expected)
    let table = [
      (false, U, false, false, REJECT_DROPPED),
      (false, U, false, true, REJECT_DROPPED),
      (false, U, true, false, REJECT_DROPPED),
      (false, U, true, true, REJECT_DROPPED),
      (false, T, false, false, REJECT_TASK),
      (false, T, false, true, REJECT_TASK),
      (false, T, true, false, REJECT_TASK),
      (false, T, true, true, REJECT_TASK),
      (false, R, false, false, REJECT_TASK),
      (false, R, false, true, REJECT_TASK),
      (false, R, true, false, REJECT_TASK),
      (false, R, true, true, REJECT_TASK),
      (true, U, false, false, Sync),
      (true, U, false, true, Sync),
      (true, U, true, false, Sync),
      (true, U, true, true, QUEUE_CLEANUP),
      (true, T, false, false, Sync),
      (true, T, false, true, Sync),
      (true, T, true, false, Sync),
      (true, T, true, true, QUEUE_CLEANUP),
      (true, R, false, false, REJECT_TASK),
      (true, R, false, true, REJECT_TASK),
      (true, R, true, false, REJECT_TASK),
      (true, R, true, true, REJECT_TASK),
    ];
    assert_eq!(table.len(), 2 * 3 * 2 * 2);
    for (on_owner, origin, is_deferred, exception_pending, expected) in table {
      assert_eq!(
        abandon_action(on_owner, origin, is_deferred, exception_pending),
        expected,
        "on_owner={on_owner} origin={origin} is_deferred={is_deferred} exception_pending={exception_pending}",
      );
    }
  }
}
