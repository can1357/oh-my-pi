use std::os::raw::c_void;
use std::ptr;
#[cfg(target_family = "wasm")]
use std::sync::atomic::AtomicU32;
use std::{
  marker::PhantomData,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock, Weak,
  },
};

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
/// from JavaScript as a bare wasm function with no napi machinery around it.
#[cfg(target_family = "wasm")]
struct WasmHandleScope {
  env: sys::napi_env,
  scope: sys::napi_handle_scope,
}

#[cfg(target_family = "wasm")]
impl WasmHandleScope {
  fn open(env: sys::napi_env) -> Option<Self> {
    let mut scope = ptr::null_mut();
    let status = unsafe { sys::napi_open_handle_scope(env, &mut scope) };
    debug_assert!(
      status == sys::Status::napi_ok,
      "Open handle scope in JsDeferred failed"
    );
    (status == sys::Status::napi_ok).then_some(Self { env, scope })
  }
}

#[cfg(target_family = "wasm")]
impl Drop for WasmHandleScope {
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
use crate::{bindgen_runtime::JsObjectValue, JsValue};
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
      let mut obj = Object::from_raw(raw_env, raw);
      obj.set_named_property("message", &err.reason)?;
      obj.set_named_property(
        "code",
        env.create_string_from_std(format!("{}", err.status))?,
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

type FinalizeCallback = Arc<RwLock<Option<Box<dyn FnOnce(sys::napi_env)>>>>;

struct DeferredData<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> {
  resolver: Result<Resolver>,
  #[cfg(feature = "deferred_trace")]
  trace: DeferredTrace,
  tsfn: sys::napi_threadsafe_function,
  finalize_callback: FinalizeCallback,
}

/// Shared between the deferred (and its clones) and the threadsafe function's env teardown hook
/// and finalize callback. Owns the pending threadsafe function: a settle takes it (moving the
/// release duty into the queued `DeferredData`), the env teardown hook abort-releases it,
/// whichever locks first. The lock is held across those calls so env teardown cannot finalize
/// the threadsafe function while a settle on a foreign thread is inside it.
struct DeferredHandle {
  pending_tsfn: Mutex<Option<sys::napi_threadsafe_function>>,
}

/// Shared by the env teardown hook and the threadsafe function's finalize callback; boxed, and
/// freed exactly once, by the finalize callback (which during an env teardown runs after the
/// LIFO-ordered cleanup hooks).
struct DeferredHookData {
  handle: Weak<DeferredHandle>,
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

pub struct JsDeferred<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>> {
  handle: Arc<DeferredHandle>,
  #[cfg(feature = "deferred_trace")]
  trace: DeferredTrace,
  finalize_callback: FinalizeCallback,
  /// What the threadsafe-function callback would otherwise receive as `env` and `context`.
  /// Kept so a settle made on the owning thread *inside* the wasm environment cleanup barrier
  /// can reach the promise directly, without the host's macrotask dispatch. wasm only: every
  /// other target settles through the queue exclusively.
  #[cfg(target_family = "wasm")]
  env: sys::napi_env,
  #[cfg(target_family = "wasm")]
  raw_deferred: sys::napi_deferred,
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
      handle: self.handle.clone(),
      #[cfg(feature = "deferred_trace")]
      trace: self.trace.clone(),
      finalize_callback: self.finalize_callback.clone(),
      #[cfg(target_family = "wasm")]
      env: self.env,
      #[cfg(target_family = "wasm")]
      raw_deferred: self.raw_deferred,
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
  pub(crate) fn new(env: &Env) -> Result<(Self, Object<'_>)> {
    let handle = Arc::new(DeferredHandle {
      pending_tsfn: Mutex::new(None),
    });
    let hook_data_ptr = Box::into_raw(Box::new(DeferredHookData {
      handle: Arc::downgrade(&handle),
      hook_registered: AtomicBool::new(false),
    }));

    let (tsfn, _raw_deferred, promise) = match js_deferred_new_raw(
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
        // double-free against the finalize callback.
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
      Ok(trace) => trace,
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
        return Err(err);
      }
    };

    let deferred = Self {
      handle,
      #[cfg(feature = "deferred_trace")]
      trace,
      finalize_callback: Default::default(),
      #[cfg(target_family = "wasm")]
      env: env.0,
      #[cfg(target_family = "wasm")]
      raw_deferred: _raw_deferred,
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

  #[allow(clippy::arc_with_non_send_sync)]
  pub fn set_finalize_callback(
    &mut self,
    finalize_callback: Option<Box<dyn FnOnce(sys::napi_env)>>,
  ) {
    self.finalize_callback = Arc::new(RwLock::new(finalize_callback));
  }

  fn call_tsfn(self, result: Result<Resolver>) {
    let mut pending = self
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

    let data = DeferredData {
      resolver: result,
      #[cfg(feature = "deferred_trace")]
      trace: self.trace,
      tsfn,
      finalize_callback: self.finalize_callback.clone(),
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
      let (env, raw_deferred) = (self.env, self.raw_deferred);
      // `napi_prepare_wasm_env_cleanup` is a bare wasm export: JavaScript enters it directly,
      // not through a napi entry point, so — unlike the threadsafe-function dispatch that
      // normally runs the settle — there is no handle scope open. Settling creates
      // `napi_value`s, so open the scope the dispatcher would have opened.
      match WasmHandleScope::open(env) {
        Some(_scope) => {
          drop(pending);
          settle_deferred::<Data, Resolver>(env, raw_deferred, data);
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
    debug_assert!(
      status == sys::Status::napi_ok,
      "Call threadsafe function in JsDeferred failed"
    );
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
  let Some(handle) = hook_data.handle.upgrade() else {
    return;
  };

  let mut pending = handle
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
  if let Some(handle) = hook_data.handle.upgrade() {
    handle
      .pending_tsfn
      .lock()
      .expect("JsDeferred pending lock failed")
      .take();
  }
}

fn js_deferred_new_raw(
  env: &Env,
  resolve_deferred: sys::napi_threadsafe_function_call_js,
  finalize_data: *mut c_void,
) -> Result<(
  sys::napi_threadsafe_function,
  sys::napi_deferred,
  Object<'_>,
)> {
  // Same reasoning as `ThreadsafeFunction::create`: a `JsDeferred` is `Send`
  // precisely so a foreign thread can settle it, so this addon's code becomes
  // reachable from a thread that can outlive the environment. `Env::create_deferred`
  // needs only `napi4`, so this path is reachable in a build where no runtime
  // pins the image. Pin on the environment's own thread, at creation.
  #[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
  crate::bindgen_runtime::retain_current_module_for_unload_safety();

  let mut raw_promise = ptr::null_mut();
  let mut raw_deferred = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_promise(env.0, &mut raw_deferred, &mut raw_promise) },
    "Create promise in JsDeferred failed"
  )?;

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
  )?;

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
        raw_deferred.cast(),
        resolve_deferred,
        &mut tsfn,
      )
    },
    "Create threadsafe function in JsDeferred failed"
  )?;

  let promise = Object::from_raw(env.0, raw_promise);

  Ok((tsfn, raw_deferred, promise))
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
  context: *mut c_void,
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

  settle_deferred::<Data, Resolver>(env, context.cast(), *deferred_data);
}

/// Settles the promise this deferred owns, releasing the threadsafe function's thread count on
/// the way.
///
/// Reached two ways, doing the same thing both times: dispatched out of the threadsafe-function
/// queue by the host (`napi_resolve_deferred`), or called straight from `call_tsfn` on wasm when
/// the environment cleanup barrier is running on the owning thread and the queue would not be
/// dispatched in time. It must therefore assume nothing about which one it is: `env` is a live
/// environment on the owning thread in both.
fn settle_deferred<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>>(
  env: sys::napi_env,
  deferred: sys::napi_deferred,
  deferred_data: DeferredData<Data, Resolver>,
) {
  let tsfn: sys::napi_threadsafe_function = deferred_data.tsfn;
  let finalize_callback = RwLock::write(&deferred_data.finalize_callback)
    .expect("RwLock Poison")
    .take();
  let result = deferred_data
    .resolver
    .and_then(|resolver| resolver(Env::from_raw(env)))
    .and_then(|res| unsafe { ToNapiValue::to_napi_value(env, res) });

  let release_tsfn_result = check_status!(
    unsafe {
      sys::napi_release_threadsafe_function(tsfn, sys::ThreadsafeFunctionReleaseMode::release)
    },
    "Release threadsafe function in JsDeferred failed"
  );

  if let Err(e) = release_tsfn_result.and(result).and_then(|res| {
    check_status!(
      unsafe { sys::napi_resolve_deferred(env, deferred, res) },
      "Resolve deferred value failed"
    )
    .map(|_| {
      #[cfg(feature = "deferred_trace")]
      {
        let _status = unsafe { sys::napi_delete_reference(env, deferred_data.trace.0) };
        if _status != sys::Status::napi_ok && cfg!(debug_assertions) {
          eprintln!(
            "Failed to delete reference in deferred {}",
            crate::Status::from(_status)
          );
        }
      }
    })
  }) {
    #[cfg(feature = "deferred_trace")]
    let error = deferred_data.trace.into_rejected(env, e);
    // `ToNapiValue for Error` hands back the retained value verbatim and only
    // synthesizes a fresh `Error` when there is nothing to hand back.
    // `JsError::into_value` cannot be used here: it gates the reuse on
    // `napi_is_error`, so a promise rejected with a string, a number or a plain
    // object would settle with a newly created `Error` instead of the value
    // JavaScript actually rejected with.
    #[cfg(not(feature = "deferred_trace"))]
    let error = unsafe { ToNapiValue::to_napi_value(env, e) };

    match error {
      Ok(error) => {
        unsafe { sys::napi_reject_deferred(env, deferred, error) };
        if let Some(finalize_callback) = finalize_callback {
          finalize_callback(env);
        }
      }
      Err(err) => {
        if let Some(finalize_callback) = finalize_callback {
          finalize_callback(env);
        }
        if cfg!(debug_assertions) {
          eprintln!("Failed to reject deferred: {err:?}");
          let mut err = ptr::null_mut();
          let mut err_msg = ptr::null_mut();
          unsafe {
            sys::napi_create_string_utf8(env, c"Rejection failed".as_ptr().cast(), 0, &mut err_msg);
            sys::napi_create_error(env, ptr::null_mut(), err_msg, &mut err);
            sys::napi_reject_deferred(env, deferred, err);
          }
        }
      }
    }
  } else if let Some(finalize_callback) = finalize_callback {
    finalize_callback(env);
  }
}
