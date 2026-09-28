#[cfg(all(
  not(feature = "noop"),
  any(
    all(feature = "async-runtime", feature = "tokio_rt"),
    target_family = "wasm"
  )
))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(feature = "noop"))]
use std::sync::OnceLock;
#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
use std::sync::{LazyLock, RwLock};
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::{future::Future, marker::PhantomData};
#[cfg(feature = "async-runtime")]
use std::{
  panic::{catch_unwind, AssertUnwindSafe},
  pin::Pin,
  task::{Context, Poll},
};

#[cfg(feature = "tokio_rt")]
use tokio::runtime::Runtime;

use crate::{bindgen_runtime::ToNapiValue, sys, Env, Error, Result};
#[cfg(not(feature = "noop"))]
use crate::{JsDeferred, SendableResolver, Unknown};

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
const DUPLICATE_RUNTIME_ERROR: &str =
  "register_async_runtime was called more than once for the same addon image";
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
const LATE_RUNTIME_REGISTRATION_ERROR: &str = "register_async_runtime must be called before the first Node-API environment begins activation or an earlier runtime-backed operation commits a backend choice";
#[cfg(all(
  feature = "async-runtime",
  not(feature = "tokio_rt"),
  not(feature = "noop")
))]
const MISSING_RUNTIME_BACKEND_ERROR: &str = "no AsyncRuntime backend is registered; call `register_async_runtime` from `#[module_init]` before invoking runtime-backed operations";
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
const TASK_CANCELLED_ERROR: &str = "task was cancelled before completion";

#[cfg(all(target_family = "wasm", not(feature = "noop")))]
const WASM_ENV_DISPOSING_ERROR: &str = "the wasm environment is being disposed: its async runtime was shut down by napi_prepare_wasm_env_cleanup and cannot accept new work";

/// Latched by the `napi_prepare_wasm_env_cleanup` export before it shuts the async runtime down,
/// and released only when a *new* environment registers this addon image.
///
/// # Why a latch is needed at all
///
/// The barrier is not the last thing that happens to the environment. It shuts the runtime down
/// while the environment is still fully alive, and the settlements it produces reject promises
/// whose handlers are ordinary JavaScript. Those handlers run before the environment is
/// destroyed — the generated loaders' drain deliberately yields real event-loop turns so the
/// threadsafe-function queue can be dispatched, and every one of those turns is a turn in which
/// arbitrary JavaScript runs.
///
/// Without a latch, an addon export called from one of those handlers walks straight back into
/// the dispatch path, where [`AsyncRuntimeRegistry::ensure_started`] finds the
/// [`LifecyclePhase::Idle`] the teardown left behind and starts the backend again — after its
/// `shutdown` already reported quiescence. The restarted work is not in the
/// threadsafe-function queue, so `napi_wasm_env_cleanup_pending` does not see it, the drain
/// reads zero, and `Context.destroy()` runs with that work still live: its promise is stranded,
/// which is the exact failure the barrier exists to prevent. On the built-in Tokio path the
/// same call instead reaches an `RT` slot the teardown drained and panics on it, which on wasm
/// traps the whole instance.
///
/// The Tokio compatibility helpers ([`spawn`], [`block_on`], [`spawn_blocking`]) reach [`RT`]
/// directly rather than through the dispatch path, so they need the latch too — and in a
/// combined build they need it *most*: a custom backend owns the runtime lifecycle, [`RT`]'s
/// `LazyLock` is typically never forced, so the teardown has nothing to drain and there is no
/// empty slot to panic on. A helper called after the barrier would construct a brand-new Tokio
/// runtime and run work on it, invisibly to the drain. They are refused instead; see
/// [`refuse_tokio_helper_during_wasm_env_disposal`] for why a panic is the only answer their
/// signatures can give.
///
/// # Scope
///
/// "The remainder of environment disposal" is the lifetime of this wasm instance's linear
/// memory, which is where this static lives. Rust statics are per-instance; a second
/// environment in the same process (another Worker, a re-`require` after a fresh
/// `WebAssembly.Memory`, a browser page reload) gets a fresh instance and a fresh, unlatched
/// static, so latching here can never poison an environment that legitimately follows this one.
///
/// The one case that *does* share this static is `wasm32-wasip1-threads`, whose worker threads
/// instantiate the same module over the same shared memory — but emnapi only runs module
/// registration on the main thread (`if (!napiModule.childThread)`), so a worker never releases
/// the latch mid-disposal. Registration is therefore the single event that unambiguously means
/// "a live environment needs this addon again", and it is where the latch is released.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
static WASM_ENV_DISPOSING: AtomicBool = AtomicBool::new(false);

/// Latch the runtime against restart for the remainder of this environment's disposal.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn latch_wasm_env_disposal() {
  WASM_ENV_DISPOSING.store(true, Ordering::SeqCst);
}

/// Release the latch because a new environment registered this addon image. See
/// [`WASM_ENV_DISPOSING`] for why registration is the only safe release point.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn release_wasm_env_disposal_latch() {
  WASM_ENV_DISPOSING.store(false, Ordering::SeqCst);
}

/// Whether the current environment is past its cleanup barrier. Every caller is wasm-gated: the
/// barrier is a wasm-only export, and native teardown runs after JavaScript is already disabled,
/// so there is no window for a reentrant call to restart anything and nothing on the native
/// paths changes.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
#[inline]
fn wasm_env_disposing() -> bool {
  WASM_ENV_DISPOSING.load(Ordering::SeqCst)
}

/// Marker trait for the guard returned by [`AsyncRuntime::enter`].
///
/// The type-erased guard is deliberately not `Send`, so the entered runtime context cannot
/// migrate to another thread. The unit type `()` implements it as the no-op guard used by the
/// default [`AsyncRuntime::enter`] implementation.
#[cfg(feature = "async-runtime")]
pub trait AsyncRuntimeGuard {}

#[cfg(feature = "async-runtime")]
impl AsyncRuntimeGuard for () {}

/// Carrier for work an [`AsyncRuntime`] backend declined to accept.
///
/// The backend must hand the work back **untouched** together with a diagnostic [`Error`]; napi
/// then drops the recovered work through its cancellation path (settling the associated
/// JavaScript promise) instead of leaving it pending forever.
#[cfg(feature = "async-runtime")]
pub struct AsyncRuntimeRejection<T> {
  work: T,
  error: Error,
}

#[cfg(feature = "async-runtime")]
impl<T> AsyncRuntimeRejection<T> {
  /// Create a rejection from the declined work and a diagnostic error.
  pub fn new(work: T, error: Error) -> Self {
    Self { work, error }
  }

  /// The diagnostic error describing why the work was declined.
  pub fn error(&self) -> &Error {
    &self.error
  }

  /// Recover the declined work and the diagnostic error.
  pub fn into_parts(self) -> (T, Error) {
    (self.work, self.error)
  }
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
type AsyncRuntimeTaskCancelCallback = Box<dyn FnOnce(Error) + Send + 'static>;

/// Invoke a task's cancellation callback with panic containment.
///
/// Cancellation rejections are best-effort: during environment teardown the promise machinery
/// may already be closing, and the rejection path can then panic (a debug assertion on
/// `napi_closing` from `napi_call_threadsafe_function`). This regularly runs inside
/// [`AsyncRuntimeTask`]'s `Drop` on a backend worker thread — possibly while that thread is
/// already unwinding, where a second panic aborts the process. Contain the panic and drop the
/// rejection instead of unwinding into backend code.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
fn invoke_cancel_callback(on_cancel: AsyncRuntimeTaskCancelCallback, error: Error) {
  // On wasm the environment cleanup barrier may want this rejection settled on the JavaScript
  // thread instead of here; see [`WASM_CANCEL_MAILBOX`]. Everywhere else — and whenever the
  // mailbox is closed — this is the unchanged direct invocation.
  #[cfg(target_family = "wasm")]
  let (on_cancel, error) = match park_cancel_for_js_thread(on_cancel, error) {
    Ok(()) => return,
    Err(returned) => returned,
  };
  invoke_cancel_callback_now(on_cancel, error);
}

/// Invoke a cancellation callback on *this* thread, with panic containment.
///
/// Runs on: whichever thread dropped the task — a backend worker in the ordinary case, the
/// JavaScript thread when [`drain_wasm_cancel_mailbox`] replays a parked cancellation.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
fn invoke_cancel_callback_now(on_cancel: AsyncRuntimeTaskCancelCallback, error: Error) {
  if let Err(payload) = catch_unwind(AssertUnwindSafe(move || on_cancel(error))) {
    drop_contained(payload);
  }
}

/// Cancellations raised off the JavaScript thread while the wasm environment cleanup barrier is
/// running, waiting for that thread to invoke them.
///
/// Runs on: written by backend worker threads (`wasm32-wasip1-threads`), opened and drained by
/// the JavaScript thread inside `napi_prepare_wasm_env_cleanup`. `None` means closed, which is
/// every moment outside that barrier — so nothing is ever parked that the barrier will not
/// immediately replay.
///
/// # Why it exists
///
/// `AsyncRuntime::shutdown` may drop a task on one of its own worker threads (with the
/// `napi-async-runtime` crate's MultiThread flavor it routinely does, and that crate's shutdown
/// joins those workers, so the drop strictly precedes the shutdown call's return). The task's
/// `Drop` rejects its `JsDeferred` from that worker, where
/// [`crate::js_values::in_wasm_env_cleanup`] is false and the deferred's owner thread is
/// somebody else — so the rejection goes into the threadsafe-function queue, which
/// `@emnapi/core` dispatches from a macrotask two turns later. A host that calls the raw,
/// synchronous `Context.destroy()` never reaches that dispatch: `destroy()` disables JavaScript
/// calls and then runs the threadsafe function's cleanup hook, which drains the queue with a
/// null env and discards the item. The promise never settles.
///
/// Parking the callback and invoking it on the JavaScript thread while the barrier is still
/// raised turns that queued settle into a synchronous one
/// (`js_values::deferred::settles_synchronously`), which is exactly how the threadless
/// `wasm32-wasip1` artifact has always behaved.
///
/// Moving the callback across threads is sound by its own bound:
/// [`AsyncRuntimeTaskCancelCallback`] is `Send + 'static`, and so is [`Error`].
///
/// See `crates/async-runtime/README.md` ("`shutdown` joins, without a bound") for the shutdown
/// contract this relies on.
#[cfg(all(
  target_family = "wasm",
  feature = "async-runtime",
  not(feature = "noop")
))]
static WASM_CANCEL_MAILBOX: Mutex<Option<Vec<(AsyncRuntimeTaskCancelCallback, Error)>>> =
  Mutex::new(None);

/// Open the mailbox so cancellations raised off the JavaScript thread are parked instead of
/// queued.
///
/// Runs on: the JavaScript thread, from `napi_prepare_wasm_env_cleanup`, before the backend
/// shutdown that produces those cancellations.
#[cfg(all(
  target_family = "wasm",
  feature = "async-runtime",
  not(feature = "noop")
))]
pub(crate) fn open_wasm_cancel_mailbox() {
  let mut mailbox = WASM_CANCEL_MAILBOX
    .lock()
    .unwrap_or_else(PoisonError::into_inner);
  if mailbox.is_none() {
    *mailbox = Some(Vec::new());
  }
}

/// Close the mailbox and invoke everything parked in it here and now.
///
/// Runs on: the JavaScript thread, from the `finish` half of the wasm environment cleanup,
/// after the backend shutdown returned and while the cleanup barrier is still raised
/// (`js_values::enter_wasm_env_cleanup_barrier`) — that raised barrier is what makes each
/// replayed rejection settle its promise directly instead of queueing it again. The barrier
/// spans both phases of the split teardown, so a cancellation raised while the host was turning
/// its event loop between them is replayed here too.
///
/// Taking the `Vec` out under the lock is also the close, so a cancellation that races this
/// (a worker the backend's shutdown did not join) finds the mailbox closed and falls through to
/// the queue, which is exactly today's behaviour.
#[cfg(all(
  target_family = "wasm",
  feature = "async-runtime",
  not(feature = "noop")
))]
pub(crate) fn drain_wasm_cancel_mailbox() {
  let parked = WASM_CANCEL_MAILBOX
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .take();
  for (on_cancel, error) in parked.into_iter().flatten() {
    invoke_cancel_callback_now(on_cancel, error);
  }
}

/// Close the mailbox and put everything parked in it beyond reach, without invoking any of it —
/// and without dropping it either.
///
/// Runs on: the JavaScript thread, from module registration, when a new environment takes over
/// an image whose two-phase cleanup was begun and never finished
/// (`bindgen_runtime::module_register::unwind_abandoned_wasm_env_cleanup`). Every parked callback
/// rejects a `JsDeferred` created by the environment that went away, so replaying them the way
/// [`drain_wasm_cancel_mailbox`] does would call into an environment that may be destroyed.
///
/// # Why it leaks instead of dropping
///
/// A parked entry is a callback *and* an [`Error`], and neither is inert. `Error` carries
/// `maybe_ref: Option<Arc<ErrorRef>>`, whose `Drop` calls `napi_delete_reference` on the owning
/// thread (`error.rs`) — this thread — against exactly the environment that must not be touched.
/// The callback owns the task's `JsDeferred`, whose `DeferredHandle` has no `Drop` at all, so
/// dropping it would not settle or release anything anyway. So each entry is `mem::forget`ed:
/// the leak is bounded by the cancellations of one abandoned teardown, it happens only on this
/// path, and it buys the guarantee that unwinding an abandoned cleanup makes no napi call.
///
/// The promises those entries would have rejected stay pending. That is the same outcome the
/// entry's own `Drop` would produce, without the napi call.
#[cfg(all(
  target_family = "wasm",
  feature = "async-runtime",
  not(feature = "noop")
))]
pub(crate) fn discard_wasm_cancel_mailbox() {
  let parked = WASM_CANCEL_MAILBOX
    .lock()
    .unwrap_or_else(PoisonError::into_inner)
    .take();
  for entry in parked.into_iter().flatten() {
    std::mem::forget(entry);
  }
}

/// Park a cancellation for the barrier thread, or hand it back to be invoked here.
///
/// Runs on: the thread that dropped the task. Returns `Err` — meaning "invoke it yourself" —
/// when the mailbox is closed (every moment outside the barrier) and when this *is* the barrier
/// thread, whose cancellations already settle synchronously.
#[cfg(all(
  target_family = "wasm",
  feature = "async-runtime",
  not(feature = "noop")
))]
fn park_cancel_for_js_thread(
  on_cancel: AsyncRuntimeTaskCancelCallback,
  error: Error,
) -> std::result::Result<(), (AsyncRuntimeTaskCancelCallback, Error)> {
  if crate::js_values::in_wasm_env_cleanup() {
    return Err((on_cancel, error));
  }
  let mut mailbox = WASM_CANCEL_MAILBOX
    .lock()
    .unwrap_or_else(PoisonError::into_inner);
  match mailbox.as_mut() {
    Some(parked) => {
      parked.push((on_cancel, error));
      Ok(())
    }
    None => Err((on_cancel, error)),
  }
}

/// An opaque unit of work napi submits to a custom [`AsyncRuntime`] backend.
///
/// There is no public constructor: tasks are built only inside napi (wrapping the future behind
/// a generated `#[napi] async fn`, [`crate::Env::spawn_future`], and friends together with the
/// promise-settling machinery).
///
/// Behavioral contract for backends:
/// - it is `Future<Output = ()> + Send + 'static`; poll it to completion,
/// - or drop it: dropping a task before completion fires its cancellation callback exactly once,
///   rejecting the associated JavaScript promise instead of leaving it pending,
/// - or hand it back untouched in an [`AsyncRuntimeRejection`] when declining the submission.
///
/// Dropping a task destroys its captured promise/resolver state on the dropping thread —
/// exactly as the built-in Tokio path does for `Err`-completing futures and for futures dropped
/// at shutdown, so the hazard is not specific to custom backends.
///
/// The first poll commits ownership and may run user code immediately. napi wraps every poll in
/// `catch_unwind` on unwind-enabled builds, so a panicking future settles its promise as rejected
/// instead of tearing down the backend's worker; do not add another panic-containment layer.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
pub struct AsyncRuntimeTask {
  fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>,
  on_cancel: Option<AsyncRuntimeTaskCancelCallback>,
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
impl AsyncRuntimeTask {
  fn new(
    fut: Pin<Box<dyn Future<Output = ()> + Send + 'static>>,
    on_cancel: AsyncRuntimeTaskCancelCallback,
  ) -> Self {
    Self {
      fut,
      on_cancel: Some(on_cancel),
    }
  }

  /// Settle the task's promise with the given diagnostic (used when a backend declines the
  /// submission), consuming the task without running its future. The regular cancellation
  /// callback is disarmed, so the subsequent drop is a no-op.
  fn reject_with(mut self, error: Error) {
    if let Some(on_cancel) = self.on_cancel.take() {
      invoke_cancel_callback(on_cancel, error);
    }
  }
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
impl Future for AsyncRuntimeTask {
  type Output = ();

  fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
    let this = self.get_mut();
    if this.on_cancel.is_none() {
      // Already completed, panicked, or rejected — never touch the inner future again.
      return Poll::Ready(());
    }
    match catch_unwind(AssertUnwindSafe(|| this.fut.as_mut().poll(cx))) {
      Ok(Poll::Pending) => Poll::Pending,
      Ok(Poll::Ready(())) => {
        // Completed: disarm the cancellation callback without invoking it.
        this.on_cancel = None;
        Poll::Ready(())
      }
      Err(panic_payload) => {
        // A panicking future settles its promise as rejected rather than aborting the
        // backend's worker thread. Exactly-once is guaranteed by taking the callback.
        if let Some(on_cancel) = this.on_cancel.take() {
          invoke_cancel_callback(on_cancel, async_task_panic_error(panic_payload));
        }
        Poll::Ready(())
      }
    }
  }
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
impl Drop for AsyncRuntimeTask {
  fn drop(&mut self) {
    // Dropping an accepted task before completion (backend shutdown, queue teardown, …)
    // cancels it: the callback fires exactly once and rejects the associated promise.
    if let Some(on_cancel) = self.on_cancel.take() {
      invoke_cancel_callback(
        on_cancel,
        Error::new(crate::Status::GenericFailure, TASK_CANCELLED_ERROR),
      );
    }
  }
}

/// `noop` builds still need the type so the [`AsyncRuntime`] trait compiles; it is inert.
#[cfg(all(feature = "async-runtime", feature = "noop"))]
pub struct AsyncRuntimeTask {
  _private: (),
}

#[cfg(all(feature = "async-runtime", feature = "noop"))]
impl Future for AsyncRuntimeTask {
  type Output = ();

  fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
    Poll::Ready(())
  }
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
fn async_task_panic_error(panic_payload: Box<dyn std::any::Any + Send>) -> Error {
  let reason = if let Some(reason) = panic_payload.downcast_ref::<&str>() {
    (*reason).to_string()
  } else if let Some(reason) = panic_payload.downcast_ref::<String>() {
    reason.clone()
  } else {
    "Panic in async function".to_owned()
  };
  // This runs outside poll's `catch_unwind`; a payload whose own `Drop` panics must not
  // unwind into the backend executor.
  drop_contained(panic_payload);
  Error::new(crate::Status::GenericFailure, reason)
}

/// Service-provider interface for plugging a custom async runtime into NAPI-RS.
///
/// The `async-runtime` feature exposes this SPI without by itself imposing a module-load
/// requirement. Implement this trait to back napi with your own scheduler (for example, a
/// single-threaded or WASI-friendly runtime) and register exactly one instance from
/// `#[module_init]`. A pure `async-runtime` addon with no registration can still load and expose
/// synchronous APIs; runtime-backed operations reject with a missing-backend error.
///
/// If no custom backend has been registered, the registration window closes when napi begins
/// activating the first Node-API environment, or earlier when a runtime-backed operation commits
/// a backend choice. In a combined `async-runtime` + `tokio_rt` build, that choice defaults
/// generated `#[napi]` futures to the built-in Tokio runtime. The established free `spawn`,
/// `spawn_blocking`, `block_on`, and `within_runtime_if_available` names remain Tokio
/// compatibility APIs whenever `tokio_rt` is enabled, so Cargo feature unification cannot
/// silently change their signatures or routing; generated `#[napi] async fn` futures follow the
/// *selection* (the custom backend if one was registered before the window closed, otherwise
/// Tokio). Selecting and starting a custom backend does not construct Tokio; the first Tokio
/// compatibility helper call constructs it lazily. In a pure `async-runtime` build there is no
/// Tokio at all, and a missing-backend error before any environment is activated leaves the
/// selection undecided and does not prevent later registration.
///
/// Under the `noop` feature this SPI cannot be installed: [`try_register_async_runtime`] safely
/// retires the supplied backend and reports [`crate::Status::InvalidArg`], while the infallible
/// [`register_async_runtime`] wrapper retires it and preserves its no-op result.
///
/// The implementation is stored once per linked addon image and shared across its threads, hence
/// the `Send + Sync + 'static` bound. The backend's [`Drop`] implementation is not guaranteed to
/// run; [`shutdown`](AsyncRuntime::shutdown) is the sole resource-release and quiescence hook.
/// Keep a newly constructed backend dormant, create active resources in
/// [`start`](AsyncRuntime::start), and release them in `shutdown`. See
/// [`register_async_runtime`] for duplicate registration behavior.
///
/// Panic containment described by this API requires a `panic = "unwind"` build. With
/// `panic = "abort"`, including Rust's currently shipped `wasm32-wasip1` and
/// `wasm32-wasip1-threads` targets, `catch_unwind` cannot intercept a panic: generated async
/// functions may trap or abort before their JavaScript promise is settled.
///
/// # Safety
///
/// Node may unload an addon's native image immediately after its last environment cleanup
/// returns. Implementations must ensure that, after [`shutdown`](AsyncRuntime::shutdown) returns,
/// no backend-owned thread, task, closure, destructor, cancellation callback, or future Node-API
/// callback can execute code or access data from that image. This includes externally retained
/// [`Waker`](std::task::Waker) or [`RawWaker`](std::task::RawWaker) clones and any other
/// task-owned callback, function pointer, or vtable reference whose later wake, clone, or drop
/// path could enter addon code. This requirement applies to both `Ok` and `Err` returns. A
/// backend that cannot prove those references inert must keep the native image loaded itself or
/// terminate the process rather than return.
#[cfg(feature = "async-runtime")]
pub unsafe trait AsyncRuntime: Send + Sync + 'static {
  /// Submit a task to run to completion in the background.
  ///
  /// Return `Ok(())` only after taking ownership of the task. Return
  /// `Err(AsyncRuntimeRejection::new(task, error))` when the runtime is stopped, saturated, or
  /// otherwise unable to accept it. The error is surfaced through the generated promise
  /// rejection. Dropping an accepted task invokes its cancellation callback, so shutdown
  /// implementations may cancel queued work by dropping it without leaving JavaScript promises
  /// pending forever; cleanup-driven cancellation rejections are best-effort and are dropped
  /// when the promise machinery is already closing. Never forget an accepted task: retain it
  /// until completion or drop it on cancellation.
  ///
  /// Submissions can arrive before the first [`start`](AsyncRuntime::start) of an environment
  /// cycle completes, or after a `start` that failed: module-init and module-export hooks may
  /// invoke runtime-backed APIs during first-env registration (napi runs the
  /// start-with-rollback sequence before its first dispatch, but a `start` failure does not
  /// gate dispatch). A dormant or not-ready backend must decline such work with an
  /// [`AsyncRuntimeRejection`] or accept it and defer execution.
  ///
  /// A backend may poll the task synchronously before this hook returns. The first poll commits
  /// ownership and may run user work immediately; after that point returning the task in an
  /// [`AsyncRuntimeRejection`] or panicking cannot roll back effects that already occurred. On
  /// unwind-enabled builds, napi already catches task panics. Poll the task directly and do not
  /// bypass its `Drop` implementation.
  fn spawn(
    &self,
    task: AsyncRuntimeTask,
  ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>>;

  /// Block the current thread, fully driving the pinned future to completion before
  /// returning.
  ///
  /// Return a backend-specific error if the drive cannot be started or completed. Run the future
  /// to completion rather than returning on the first pending poll. The borrowed future must not
  /// be retained, moved to another thread, or accessed after this method returns. On either `Ok`
  /// or `Err`, the backend must stop accessing the borrowed future before returning.
  fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()>;

  /// Enter the runtime context and return a guard that establishes it for the calling
  /// thread.
  ///
  /// In pure `async-runtime` builds `within_runtime_if_available` delegates here; combined
  /// `tokio_rt` builds retain its established Tokio routing. The returned guard MUST keep the
  /// runtime context active for the whole duration of the closure and tear it down on drop.
  /// Return a backend-specific error if the context cannot be entered. The default
  /// implementation returns a no-op guard, which is correct for backends that do not need an
  /// ambient context.
  fn enter(&self) -> Result<Box<dyn AsyncRuntimeGuard + '_>> {
    Ok(Box::new(()))
  }

  /// Start (or restart) the runtime.
  ///
  /// napi calls this when the first live Node environment for the addon starts, or earlier
  /// when a module-init or module-export hook triggers the first runtime-backed dispatch of
  /// the cycle. Worker isolates and Electron renderer reloads can take the live environment
  /// count from zero to one repeatedly, so this may run more than once over the backend's
  /// lifetime. Implement it idempotently. Return success only after the backend can accept tasks. Do not
  /// call napi's runtime registration or lifecycle functions recursively from this hook. If this
  /// returns an error, or panics on an unwind-enabled build, napi calls
  /// [`shutdown`](AsyncRuntime::shutdown) to roll back resources created by the partial start.
  /// With `panic = "abort"`, a panic traps or aborts before rollback can run. The default is a
  /// no-op.
  fn start(&self) -> Result<()> {
    Ok(())
  }

  /// Shut the runtime down.
  ///
  /// napi installs its environment-cleanup ownership once per addon image — on the **first**
  /// Node environment that loads the addon — and calls this hook when that accounting observes
  /// the last live environment exit. In processes with additional environments (for example
  /// `worker_threads`) or with environment re-creation, the automatic call is therefore not
  /// guaranteed to fire; embedders can call `shutdown_async_runtime` explicitly, including
  /// while environments remain live. Stop accepting work before returning
  /// and drop queued [`AsyncRuntimeTask`] values and queued
  /// [`spawn_blocking`](AsyncRuntime::spawn_blocking) closures so their promises are cancelled.
  /// Those cancellation-driven promise rejections are best-effort: when the promise machinery
  /// is already closing during environment teardown, napi drops the rejection.
  /// Return `Ok(())` only after backend-owned worker threads, running tasks, and running
  /// blocking closures have fully quiesced: Node may unload a worker's addon image as soon as
  /// its environment cleanup returns. Do not wait for JavaScript callbacks triggered by
  /// cancellation, and do not call napi's runtime registration or lifecycle functions
  /// recursively from this hook. The hook must be idempotent and tolerate being called before
  /// `start`, after a partial failed `start`, and repeatedly without an intervening `start`. If
  /// this returns an error, the same quiescence guarantee still applies.
  fn shutdown(&self) -> Result<()>;

  /// Optional hook: phase 1 of a two-phase [`shutdown`](AsyncRuntime::shutdown).
  ///
  /// **Never wait here.** Publish the stop, close admission, cancel and drop everything that is
  /// merely queued, wake whatever is parked — and return. `Ok(true)` reports that the announced
  /// stop still owes a wait: backend work that is still live, or a rejected submission whose
  /// destructor is still running on another thread. The host should then let its event loop turn
  /// and poll [`shutdown_work_pending`](AsyncRuntime::shutdown_work_pending) before calling
  /// [`finish_shutdown`](AsyncRuntime::finish_shutdown); `Ok(false)` reports that
  /// `finish_shutdown` has nothing to wait for.
  ///
  /// # The contract across the two phases
  ///
  /// Between the phases the host may run arbitrary event-loop turns — that is the entire point:
  /// on the threaded WASI artifact the shutdown is entered from the JavaScript thread, which is
  /// also the only thread that can give a running blocking closure the JavaScript turn it is
  /// waiting for, so a single-call `shutdown` there waits for work that can never finish. The
  /// backend must therefore keep rejecting submissions for the whole window, and must tolerate
  /// its own cancellation callbacks running JavaScript in it. napi does not call
  /// [`start`](AsyncRuntime::start) between the phases and a backend need not support it.
  ///
  /// Only `finish_shutdown` joins, so only it may block; the quiescence guarantee
  /// [`shutdown`](AsyncRuntime::shutdown) documents is owed by `finish_shutdown`, not by this
  /// hook. A second `begin_shutdown` before the matching `finish_shutdown` must neither start a
  /// second shutdown nor wait — re-reporting `shutdown_work_pending` is the expected answer.
  ///
  /// # Not splitting is a valid implementation
  ///
  /// The default performs the whole of [`shutdown`](AsyncRuntime::shutdown) here and reports no
  /// pending work, which makes `finish_shutdown` a no-op — so a backend that does not opt in
  /// behaves exactly as it does today: the host's `begin` blocks for the full teardown and its
  /// `finish` returns immediately.
  fn begin_shutdown(&self) -> Result<bool> {
    self.shutdown().map(|()| false)
  }

  /// Optional hook: non-blocking poll for the window between
  /// [`begin_shutdown`](AsyncRuntime::begin_shutdown) and
  /// [`finish_shutdown`](AsyncRuntime::finish_shutdown).
  ///
  /// `true` means the announced stop still owes a wait: backend work, or a rejected submission
  /// whose destructor is still running on another thread. `false` means `finish_shutdown` will
  /// not wait. Must never block and must be safe to call at any time, including with no shutdown
  /// outstanding. The default answers `false`, which is correct for a backend whose
  /// `begin_shutdown` already finished the teardown.
  fn shutdown_work_pending(&self) -> bool {
    false
  }

  /// Optional hook: phase 2 of a two-phase [`shutdown`](AsyncRuntime::shutdown).
  ///
  /// Wait for the work [`begin_shutdown`](AsyncRuntime::begin_shutdown) reported, join
  /// backend-owned threads, release resources. This is the call that owes the quiescence
  /// guarantee in [`shutdown`](AsyncRuntime::shutdown): return `Ok(())` only once every
  /// backend-owned thread, task and blocking closure has quiesced, and deliver that guarantee
  /// even when returning an error. napi calls it exactly once per `begin_shutdown`, on the same
  /// thread. The default is a no-op, because the default `begin_shutdown` already did all of it.
  fn finish_shutdown(&self) -> Result<()> {
    Ok(())
  }

  /// Optional hook: run `work` on the backend's blocking-capable lane.
  ///
  /// Return `Ok(())` once the work is accepted; the backend should run the closure exactly once
  /// on a thread where blocking is acceptable. Dropping accepted work, for example while
  /// shutting down, safely cancels the caller's pending operation. Return
  /// `Err(AsyncRuntimeRejection::new(work, error))` to decline; napi surfaces that diagnostic
  /// and does not create an unbounded fallback thread. Never forget accepted work: run it
  /// exactly once or drop it during cancellation. The default implementation declines with
  /// [`crate::Status::GenericFailure`].
  ///
  /// The backend may invoke the closure synchronously before this hook returns. Invocation
  /// commits ownership, so a later hook panic cannot replace the closure's result.
  fn spawn_blocking(
    &self,
    work: Box<dyn FnOnce() + Send + 'static>,
  ) -> std::result::Result<(), AsyncRuntimeRejection<Box<dyn FnOnce() + Send + 'static>>> {
    Err(AsyncRuntimeRejection::new(
      work,
      Error::new(
        crate::Status::GenericFailure,
        "The AsyncRuntime backend does not support blocking work",
      ),
    ))
  }
}

/// Process-global (per addon image) registry holding the custom [`AsyncRuntime`] selection.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
struct AsyncRuntimeRegistry {
  backend: OnceLock<Box<dyn AsyncRuntime>>,
  /// Registration-window and lifecycle state. Every check-then-act transition (the duplicate
  /// check, window check, and publication in [`Self::try_register`]; the backend read and
  /// freeze in [`Self::commit_selection`] and [`Self::activate`]; every
  /// [`RegistryState::phase`] transition) runs under this single lock, so the transitions are
  /// linearized: a freeze can no longer slip between registration's checks and its
  /// publication, and a commit cannot interleave with a late registration.
  /// Backend hooks (`start`/`spawn`/`shutdown`) are never called while the lock is held.
  state: Mutex<RegistryState>,
  /// Serializes the backend's lifecycle hooks: the start-with-rollback sequence
  /// ([`Self::run_claimed_start`]) and the teardown `shutdown` ([`Self::deactivate`]) run under
  /// this lock, so a teardown waits out an in-flight start and never reports quiescence while
  /// `start` may still be creating backend resources.
  ///
  /// Lock ordering: `lifecycle` before `state`, NEVER the reverse (a thread holding `state`
  /// must not acquire `lifecycle`). Dispatch (`backend.spawn`) happens outside both locks.
  /// Holding `lifecycle` across the hooks cannot deadlock because the [`AsyncRuntime`]
  /// contract forbids `start`/`shutdown` from re-entering napi's runtime registration or
  /// lifecycle functions.
  lifecycle: Mutex<()>,
  /// A duplicate/late registration error recorded by the infallible [`register_async_runtime`];
  /// surfaced by every later runtime-backed call.
  deferred_registration_error: Mutex<Option<&'static str>>,
}

/// Lifecycle phase of the selected custom backend for the current zero-to-live environment
/// cycle. Transitions happen under the registry's `state` lock; the `Starting → Started/Idle`
/// completion additionally runs under the `lifecycle` lock.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum LifecyclePhase {
  /// No start-with-rollback sequence ran for this cycle, the last one was rolled back, or a
  /// teardown completed. The next dispatch or activation claims a fresh start.
  Idle,
  /// A dispatch or activation claimed the start; its start-with-rollback sequence has not
  /// completed yet. Further dispatches proceed without waiting — submissions may arrive before
  /// `start` completes, which the [`AsyncRuntime::spawn`] contract requires backends to
  /// tolerate.
  Starting,
  /// The start-with-rollback sequence completed successfully for this cycle.
  Started,
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
struct RegistryState {
  /// Once `true`, the registration window is closed: either an environment began activation or
  /// a runtime-backed operation committed a backend choice.
  selection_frozen: bool,
  /// Where the selected custom backend stands in the current zero-to-live environment cycle.
  /// [`AsyncRuntimeRegistry::deactivate`] resets it to [`LifecyclePhase::Idle`], so restart
  /// cycles start the backend again.
  phase: LifecyclePhase,
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
impl AsyncRuntimeRegistry {
  const fn new() -> Self {
    Self {
      backend: OnceLock::new(),
      state: Mutex::new(RegistryState {
        selection_frozen: false,
        phase: LifecyclePhase::Idle,
      }),
      lifecycle: Mutex::new(()),
      deferred_registration_error: Mutex::new(None),
    }
  }

  fn lock_state(&self) -> MutexGuard<'_, RegistryState> {
    // The lock only ever guards plain flag reads/writes, so a poisoned guard (impossible in
    // practice: no code below can panic while holding it) is still consistent to reuse.
    self.state.lock().unwrap_or_else(PoisonError::into_inner)
  }

  fn lock_lifecycle(&self) -> MutexGuard<'_, ()> {
    // The guarded data is `()` and the hooks that run under this lock are unwind-contained
    // (`start_backend_with_rollback` catches, `deactivate` aborts), so a poisoned guard is
    // still consistent to reuse.
    self
      .lifecycle
      .lock()
      .unwrap_or_else(PoisonError::into_inner)
  }

  /// First-writer-wins registration. On rejection the backend is handed back to the caller for
  /// retirement together with the reason.
  fn try_register(
    &self,
    runtime: Box<dyn AsyncRuntime>,
  ) -> std::result::Result<(), (&'static str, Box<dyn AsyncRuntime>)> {
    let state = self.lock_state();
    if self.backend.get().is_some() {
      return Err((DUPLICATE_RUNTIME_ERROR, runtime));
    }
    if state.selection_frozen {
      return Err((LATE_RUNTIME_REGISTRATION_ERROR, runtime));
    }
    match self.backend.set(runtime) {
      Ok(()) => {
        // A published backend is reachable for the rest of the process: `backend` is a
        // `OnceLock` that is never cleared, and its trait object's vtable — plus every
        // thread, waker, and destructor the backend creates in `start` — lives in this
        // addon's image. Node unloads an addon as soon as the environment that loaded it
        // goes away, so without pinning, `shutdown` at a later teardown (or any backend
        // thread that outlives its environment) would run unmapped code. The built-in Tokio
        // paths pin for the same reason in `create_runtime` and `create_custom_tokio_runtime`;
        // pinning here is what gives a pure `async-runtime` build (no `tokio_rt`) the same
        // protection. Publication is the earliest safe point: it happens once, and it happens
        // before `start` can be called.
        #[cfg(not(target_family = "wasm"))]
        crate::bindgen_runtime::retain_current_module_for_unload_safety();
        Ok(())
      }
      // Unreachable while every publication goes through the state lock; kept for robustness.
      Err(rejected) => Err((DUPLICATE_RUNTIME_ERROR, rejected)),
    }
  }

  fn record_registration_error(&self, reason: &'static str) {
    if let Ok(mut slot) = self.deferred_registration_error.lock() {
      if slot.is_none() {
        *slot = Some(reason);
      }
    }
  }

  fn deferred_registration_error(&self) -> Option<&'static str> {
    self
      .deferred_registration_error
      .lock()
      .ok()
      .and_then(|slot| *slot)
  }

  /// Commit the backend selection for a runtime-backed operation and return the custom backend
  /// if one is selected. `fallback_commits` is `true` when a built-in Tokio fallback exists
  /// (combined builds): taking the fallback also commits a choice and closes the registration
  /// window. In pure `async-runtime` builds a missing backend leaves the selection undecided.
  fn commit_selection(&self, fallback_commits: bool) -> Option<&dyn AsyncRuntime> {
    let mut state = self.lock_state();
    let backend = self.backend.get().map(|backend| backend.as_ref());
    if backend.is_some() || fallback_commits {
      state.selection_frozen = true;
    }
    backend
  }

  /// Make sure the selected backend received its `start()` before a dispatch.
  ///
  /// Module-export hooks (`#[napi(module_exports)]` and the compat callbacks) run with a live
  /// `Env` before `start_async_runtime`, so a runtime-backed call (for example
  /// [`crate::Env::spawn_future`]) can dispatch to the backend before environment activation.
  /// The start-with-rollback sequence runs at most once per zero-to-live cycle: the
  /// `Idle → Starting` claim happens under the state lock, and the claim is completed under
  /// the lifecycle lock in [`Self::run_claimed_start`]. A dispatch that observes an in-flight
  /// `Starting` proceeds without waiting; spawning before `start` completes is
  /// contract-legal (see [`AsyncRuntime::spawn`]).
  ///
  /// Past the wasm environment cleanup barrier this claims nothing: the `Idle` phase there is
  /// the one the barrier's teardown left behind, and restarting the backend from a JavaScript
  /// callback that runs during disposal would create resources the already-returned `shutdown`
  /// can never stop (see [`WASM_ENV_DISPOSING`]). The dispatch then proceeds against the
  /// stopped backend, exactly like a dispatch that races a teardown.
  fn ensure_started(&self, backend: &dyn AsyncRuntime) {
    #[cfg(all(target_family = "wasm", not(feature = "noop")))]
    if wasm_env_disposing() {
      return;
    }
    {
      let mut state = self.lock_state();
      match state.phase {
        LifecyclePhase::Starting | LifecyclePhase::Started => return,
        LifecyclePhase::Idle => state.phase = LifecyclePhase::Starting,
      }
    }
    self.run_claimed_start(backend);
  }

  /// Run `f` inside the registered backend's context — the pure `async-runtime` sync path behind
  /// [`within_runtime_if_available`]. Mirrors the async dispatch path in `execute_future_impl`:
  ///
  /// 1. `ensure_started` before entering, because a sync `#[napi(async_runtime)]` wrapper can
  ///    reach here from a module-export hook before `start_async_runtime` runs, or after an
  ///    explicit `shutdown_async_runtime` while the env stays live (the backend is then dormant).
  /// 2. A panicking `enter()` hook is contained like every other custom-backend hook: the
  ///    generated sync trampoline only wraps the body in `catch_unwind` when the user opts into
  ///    `#[napi(catch_unwind)]`, so an uncontained `enter()` panic would unwind across the
  ///    `extern "C"` boundary and abort the process. Containment also extends to what `enter()`
  ///    returns: a backend `Error` (whose `Drop` can panic when it owns a JS reference) and the
  ///    guard (whose `Drop` runs after `f`, possibly while `f` is unwinding) are both disposed
  ///    through [`drop_contained`].
  ///
  /// With no backend registered, `f` runs directly (no selection is frozen).
  #[cfg(all(
    feature = "async-runtime",
    not(feature = "tokio_rt"),
    not(feature = "noop")
  ))]
  fn within_runtime<F: FnOnce() -> T, T>(&self, f: F) -> T {
    // Past the wasm environment cleanup barrier the backend has been shut down and must not be
    // brought back up or entered again (see [`WASM_ENV_DISPOSING`]). A synchronous export still
    // has to run — it has a value to return — so it runs without the runtime context, exactly
    // like it would on a build with no backend registered.
    #[cfg(all(target_family = "wasm", not(feature = "noop")))]
    if wasm_env_disposing() {
      return f();
    }
    if let Some(backend) = self.commit_selection(false) {
      self.ensure_started(backend);
      let _guard = match catch_unwind(AssertUnwindSafe(|| backend.enter())) {
        // Hold the guard in a `ContainedGuard` so its own `Drop` (after `f`) is contained too.
        Ok(Ok(guard)) => Some(ContainedGuard(Some(guard))),
        // Dispose the returned error through `drop_contained` rather than letting `result.ok()`
        // drop it uncontained (a JS-reference-owning `Error` can panic on drop).
        Ok(Err(error)) => {
          drop_contained(error);
          None
        }
        Err(payload) => {
          drop_contained(payload);
          None
        }
      };
      return f();
    }
    f()
  }

  /// Complete a claimed `Idle → Starting` transition: under the lifecycle lock, re-validate
  /// the claim and run the start-with-rollback sequence, then record the outcome
  /// (`Started` on success, back to `Idle` on rollback, so a later cycle can try again).
  ///
  /// The claim is re-validated because it can be revoked between the claim and this call: a
  /// concurrently completing teardown resets the phase to `Idle` after its `shutdown`
  /// returned ([`Self::deactivate`]). Starting after that would create backend resources the
  /// already-returned environment cleanup can never stop — Node may have unloaded the addon
  /// image. A revoked claimant therefore skips the start; its dispatch proceeds against the
  /// stopped backend, which rejects the submission. The claim may also have been fulfilled by
  /// another claimant queued on the lifecycle lock (phase already `Started`); skipping is
  /// equally correct then.
  fn run_claimed_start(&self, backend: &dyn AsyncRuntime) {
    let _lifecycle = self.lock_lifecycle();
    if self.lock_state().phase != LifecyclePhase::Starting {
      return;
    }
    let phase = if start_backend_with_rollback(backend) {
      // The combined-build refill lives HERE rather than only in `ensure_started`, so that
      // "successful start ⇒ both halves live" is an invariant of every claim path: a
      // dispatch-driven self-heal after an explicit `shutdown_async_runtime` restores the
      // drained Tokio peer together with the custom backend (otherwise
      // `within_runtime_if_available` and friends panic on the empty slot until a NEW env
      // registers), and the env-activation claim reaches here too — its caller
      // (`start_async_runtime`) refills again, which is harmless because the refill is
      // guarded and idempotent. Runs before `Started` is published, so a dispatch that
      // observes `Started` (the `ensure_started` fast path) always finds the slot refilled.
      #[cfg(feature = "tokio_rt")]
      refill_drained_tokio_runtime();
      LifecyclePhase::Started
    } else {
      LifecyclePhase::Idle
    };
    self.lock_state().phase = phase;
  }

  /// First-env-activation hook: close the registration window and start the custom backend if
  /// one is selected and not already starting or started (by an earlier activation without an
  /// intervening [`Self::deactivate`], or by a pre-activation dispatch through
  /// [`Self::ensure_started`]). Returns `true` when a custom backend owns the runtime
  /// lifecycle.
  fn activate(&self) -> bool {
    let backend = {
      let mut state = self.lock_state();
      state.selection_frozen = true;
      let Some(backend) = self.backend.get() else {
        return false;
      };
      match state.phase {
        LifecyclePhase::Starting | LifecyclePhase::Started => return true,
        LifecyclePhase::Idle => state.phase = LifecyclePhase::Starting,
      }
      backend
    };
    self.run_claimed_start(backend.as_ref());
    true
  }

  /// Last-env-teardown hook. Returns `true` when a custom backend owned the lifecycle.
  ///
  /// Takes the lifecycle lock first, so an in-flight start-with-rollback sequence completes
  /// (and, on this teardown's `shutdown`, is fully quiesced) before this returns — teardown
  /// never reports quiescence while `start` may still be creating backend resources. Resetting
  /// the phase to `Idle` only after `shutdown` returned also revokes any start claim made
  /// before this teardown completed (see [`Self::run_claimed_start`]), so a dispatch racing
  /// the teardown cannot start the backend afterwards — it spawns into the stopped backend and
  /// gets rejected instead. The next dispatch or activation begins a new cycle and starts the
  /// backend again.
  fn deactivate(&self) -> bool {
    let Some(backend) = self.backend.get() else {
      return false;
    };
    let _lifecycle = self.lock_lifecycle();
    match catch_unwind(AssertUnwindSafe(|| backend.shutdown())) {
      // A `shutdown` that returned has delivered quiescence even when it reports an error;
      // dispose of that error with `Drop`-panic containment so nothing unwinds past here.
      Ok(shutdown_result) => drop_contained(shutdown_result),
      Err(payload) => {
        // Same rationale as the `start` rollback: quiescence is only guaranteed when
        // `shutdown` returns, and this runs at last-env teardown right before Node may unload
        // the image. Nothing may drop before the abort — a panicking payload `Drop` would
        // unwind first and could dodge the mandated abort under a caller's `catch_unwind` —
        // so the payload is leaked instead.
        std::mem::forget(payload);
        std::process::abort();
      }
    }
    self.lock_state().phase = LifecyclePhase::Idle;
    true
  }
}

#[cfg(all(
  target_family = "wasm",
  feature = "async-runtime",
  not(feature = "noop")
))]
impl AsyncRuntimeRegistry {
  /// Phase 1 of [`Self::deactivate`]: everything up to and including the backend's
  /// [`AsyncRuntime::begin_shutdown`], which never waits.
  ///
  /// `None` means no custom backend owns the lifecycle, so the caller falls through to the
  /// built-in Tokio teardown exactly as [`shutdown_async_runtime`] does. `Some(pending)` means
  /// phase 1 ran and `pending` reports whether [`Self::finish_deactivate`] still has work to
  /// wait for.
  ///
  /// # Why the lifecycle lock is released between the phases
  ///
  /// [`Self::deactivate`] holds it across its single call so a teardown never reports quiescence
  /// while a `start` may still be creating resources. Each phase takes it for itself instead of
  /// one phase parking it for the other, because the window between them is a *host event loop*:
  /// arbitrary JavaScript runs in it, and an addon export reaching `shutdown_async_runtime` while
  /// this thread held a non-reentrant lock would hang the instance rather than merely misbehave.
  /// Nothing is lost by releasing it — the exclusion is against `run_claimed_start`, whose two
  /// callers (`start_async_runtime` and [`Self::ensure_started`]) both return early on wasm for
  /// the whole window, because phase 1 sets the disposal latch before it takes the lock. See
  /// [`WASM_ENV_DISPOSING`].
  ///
  /// Whether a phase 1 is outstanding is tracked by the caller (the cleanup exports in
  /// `bindgen_runtime::module_register`), which is the one latch for it; this function does not
  /// second-guess it.
  fn begin_deactivate(&self) -> Option<bool> {
    let backend = self.backend.get()?;
    let _lifecycle = self.lock_lifecycle();
    match catch_unwind(AssertUnwindSafe(|| backend.begin_shutdown())) {
      Ok(Ok(pending)) => Some(pending),
      // Phase 1 owes no quiescence — phase 2 does — so a reported error is not fatal here: it
      // is disposed of with `Drop`-panic containment and the poll answers for the backend
      // instead. Phase 2 still runs, and still has to deliver the guarantee.
      Ok(Err(error)) => {
        drop_contained(error);
        Some(backend.shutdown_work_pending())
      }
      // Same rationale as [`Self::deactivate`]: an unwinding lifecycle hook leaves the backend
      // unprovably live while Node may unload the addon image, and nothing may drop before the
      // mandated abort, so the payload is leaked instead.
      Err(payload) => {
        std::mem::forget(payload);
        std::process::abort();
      }
    }
  }

  /// Non-blocking poll for the window between the phases: `true` means
  /// [`Self::finish_deactivate`] still has backend work to wait for.
  fn deactivate_work_pending(&self) -> bool {
    self
      .backend
      .get()
      .is_some_and(|backend| backend.shutdown_work_pending())
  }

  /// Phase 2 of [`Self::deactivate`]: the backend's [`AsyncRuntime::finish_shutdown`] — the call
  /// that owes quiescence — and then the `Idle` phase reset, under the lifecycle lock and in the
  /// order [`Self::deactivate`] does them.
  ///
  /// Returns `true` when a custom backend owned the lifecycle, like [`Self::deactivate`]. The
  /// caller only calls this for a phase 1 it started.
  fn finish_deactivate(&self) -> bool {
    let Some(backend) = self.backend.get() else {
      return false;
    };
    let _lifecycle = self.lock_lifecycle();
    match catch_unwind(AssertUnwindSafe(|| backend.finish_shutdown())) {
      // Like [`Self::deactivate`]: a hook that returned has delivered quiescence even when it
      // reports an error; dispose of that error with `Drop`-panic containment.
      Ok(finish_result) => drop_contained(finish_result),
      Err(payload) => {
        std::mem::forget(payload);
        std::process::abort();
      }
    }
    self.lock_state().phase = LifecyclePhase::Idle;
    true
  }
}

/// Dispose of a value recovered from a backend hook — a caught panic payload or a returned
/// [`Error`] — without letting a panicking `Drop` escape containment. A panic payload is
/// arbitrary user data, and an [`Error`] can own a JS reference whose release asserts; if the
/// drop panics, the second payload is leaked (`mem::forget`) rather than allowed to unwind out
/// of the lifecycle and dispatch paths that promised containment.
#[cfg(feature = "async-runtime")]
fn drop_contained<T>(value: T) {
  if let Err(second_payload) = catch_unwind(AssertUnwindSafe(move || drop(value))) {
    // Leak rather than unwind again: an unwind here would escape into extern "C" frames or
    // dodge a mandated abort.
    std::mem::forget(second_payload);
  }
}

/// Wraps a backend-provided [`AsyncRuntimeGuard`] so its `Drop` is disposed through
/// [`drop_contained`]. A panicking guard teardown — including one that fires while `f()` is
/// already unwinding, which would otherwise double-panic and abort — is contained instead of
/// crossing the sync `extern "C"` trampoline. Used only on the pure `async-runtime` sync path.
#[cfg(all(
  feature = "async-runtime",
  not(feature = "tokio_rt"),
  not(feature = "noop")
))]
struct ContainedGuard<'a>(Option<Box<dyn AsyncRuntimeGuard + 'a>>);

#[cfg(all(
  feature = "async-runtime",
  not(feature = "tokio_rt"),
  not(feature = "noop")
))]
impl Drop for ContainedGuard<'_> {
  fn drop(&mut self) {
    if let Some(guard) = self.0.take() {
      drop_contained(guard);
    }
  }
}

/// Run a backend's `start` hook; a failed or panicking start is rolled back through `shutdown`.
/// If the rollback `shutdown` itself unwinds, the process aborts (like
/// [`retire_rejected_async_runtime`]): the safety contract only guarantees quiescence when
/// `shutdown` *returns*, so an unwinding rollback leaves the backend unprovably live while Node
/// may unload the addon image. Returns `true` when `start` succeeded, `false` when it was
/// rolled back. Whatever the failed `start` returned or threw is disposed of through
/// [`drop_contained`], so a panicking payload `Drop` cannot unwind out and skip the caller's
/// `Starting → Idle` phase bookkeeping.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
fn start_backend_with_rollback(backend: &dyn AsyncRuntime) -> bool {
  match catch_unwind(AssertUnwindSafe(|| backend.start())) {
    Ok(Ok(())) => return true,
    // Bind and dispose of the failure value BEFORE the rollback: left unbound in the match
    // scrutinee, the caught panic payload would drop only after this function computed its
    // value — a panicking payload `Drop` would then unwind out, skip the caller's phase write
    // (phase stuck `Starting`), and escape into the extern "C" registration path despite the
    // documented rollback.
    Ok(Err(start_error)) => drop_contained(start_error),
    Err(payload) => drop_contained(payload),
  }
  match catch_unwind(AssertUnwindSafe(|| backend.shutdown())) {
    Ok(shutdown_result) => drop_contained(shutdown_result),
    Err(payload) => {
      // Nothing may drop before the mandated abort (see [`AsyncRuntimeRegistry::deactivate`]):
      // leak the payload instead.
      std::mem::forget(payload);
      std::process::abort();
    }
  }
  false
}

#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
static ASYNC_RUNTIME_REGISTRY: AsyncRuntimeRegistry = AsyncRuntimeRegistry::new();

/// Retire a backend that was rejected (duplicate/late registration or `noop` build): the unsafe
/// [`AsyncRuntime`] contract does not permit assuming that `Drop` quiesces backend work, so
/// [`AsyncRuntime::shutdown`] runs first. If shutdown or the destructor panics the process
/// aborts, because a half-torn-down backend cannot be proven quiescent.
#[cfg(feature = "async-runtime")]
fn retire_rejected_async_runtime(runtime: Box<dyn AsyncRuntime>) {
  match catch_unwind(AssertUnwindSafe(|| runtime.shutdown())) {
    Ok(shutdown_result) => drop_contained(shutdown_result),
    Err(payload) => {
      // Nothing may drop before the mandated abort: a panicking payload `Drop` would unwind
      // first and could dodge it under a caller's `catch_unwind`. Leak both the payload and
      // the half-torn-down backend.
      std::mem::forget(payload);
      std::mem::forget(runtime);
      std::process::abort();
    }
  }
  if let Err(payload) = catch_unwind(AssertUnwindSafe(move || drop(runtime))) {
    std::mem::forget(payload);
    std::process::abort();
  }
}

/// Register the custom [`AsyncRuntime`] backend for this linked addon image.
///
/// Call this once from `#[module_init]`. That hook is a library constructor and runs before napi
/// owns a Node-API environment, so registration only publishes a dormant backend; napi calls
/// [`AsyncRuntime::start`] before the backend's first dispatch — normally during environment
/// activation, or earlier when a module-init or module-export hook invokes a runtime-backed API
/// during first-env registration. A `start` failure does not gate dispatch, so a backend that is
/// not ready must decline submissions via [`AsyncRuntimeRejection`] or accept and defer them.
///
/// Registration is once per linked addon image and first-writer-wins. `#[module_init]` runs as a
/// library constructor where panicking would abort the process before Node can see an exception,
/// so this infallible wrapper never panics: a duplicate or late registration records the error,
/// and every later runtime-backed operation (for example a generated `#[napi] async fn`)
/// surfaces it by rejecting its promise. The fallible [`try_register_async_runtime`] form
/// returns the error directly. napi invokes [`AsyncRuntime::shutdown`] before dropping a
/// rejected backend, because the unsafe [`AsyncRuntime`] contract does not permit assuming that
/// `Drop` quiesces backend work.
///
/// A successfully registered backend remains reusable across zero-environment shutdown/start
/// cycles, and its `Drop` implementation is not guaranteed to run. Construct it without starting
/// threads or other active resources; acquire those in [`AsyncRuntime::start`] and release them
/// in [`AsyncRuntime::shutdown`].
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
pub fn register_async_runtime<R: AsyncRuntime>(runtime: R) {
  if let Err((reason, rejected)) = ASYNC_RUNTIME_REGISTRY.try_register(Box::new(runtime)) {
    retire_rejected_async_runtime(rejected);
    ASYNC_RUNTIME_REGISTRY.record_registration_error(reason);
  }
}

/// Try to register a custom async runtime without deferring errors.
///
/// Library constructors should normally use [`register_async_runtime`], which defers reporting
/// until Node provides an environment where napi can surface the failure. Registration after
/// napi begins activating an environment, or after an earlier runtime-backed operation commits a
/// backend choice, returns an error and safely retires the rejected backend through its own
/// [`AsyncRuntime::shutdown`]. A missing-backend error before any environment is activated does
/// not freeze registration.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
pub fn try_register_async_runtime<R: AsyncRuntime>(runtime: R) -> Result<()> {
  match ASYNC_RUNTIME_REGISTRY.try_register(Box::new(runtime)) {
    Ok(()) => Ok(()),
    Err((reason, rejected)) => {
      retire_rejected_async_runtime(rejected);
      Err(Error::new(crate::Status::GenericFailure, reason))
    }
  }
}

/// `noop` builds cannot install an async runtime backend; the supplied backend is retired
/// (shut down, then dropped) and the error is swallowed to preserve the no-op result.
#[cfg(all(feature = "async-runtime", feature = "noop"))]
pub fn register_async_runtime<R: AsyncRuntime>(runtime: R) {
  retire_rejected_async_runtime(Box::new(runtime));
}

/// `noop` builds cannot install an async runtime backend; the supplied backend is retired
/// (shut down, then dropped) and [`crate::Status::InvalidArg`] is reported.
#[cfg(all(feature = "async-runtime", feature = "noop"))]
pub fn try_register_async_runtime<R: AsyncRuntime>(runtime: R) -> Result<()> {
  retire_rejected_async_runtime(Box::new(runtime));
  Err(Error::new(
    crate::Status::InvalidArg,
    "The `noop` feature is enabled; no AsyncRuntime backend can be registered",
  ))
}

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
fn create_runtime() -> Runtime {
  // `RT` is process-global and its worker threads are never joined at
  // environment teardown, so their task wakers keep vtable pointers into this
  // addon's image after Node may have unloaded it. Pin the image first.
  #[cfg(not(target_family = "wasm"))]
  crate::bindgen_runtime::retain_current_module_for_unload_safety();

  // Check if we're supposed to use a user-defined runtime
  if IS_USER_DEFINED_RT.get().copied().unwrap_or(false) {
    // Try to take the user-defined runtime if it's still available
    if let Some(user_defined_rt) = USER_DEFINED_RT
      .get()
      .and_then(|rt| rt.write().ok().and_then(|mut rt| rt.take()))
    {
      return user_defined_rt;
    }
    // If the user-defined runtime was already taken, fall back to creating a default runtime
    // This handles the case where the runtime was shutdown and needs to be restarted
  }

  #[cfg(any(
    all(target_family = "wasm", tokio_unstable),
    not(target_family = "wasm")
  ))]
  {
    tokio::runtime::Builder::new_multi_thread()
      .enable_all()
      .build()
      .expect("Create tokio runtime failed")
  }
  #[cfg(all(target_family = "wasm", not(tokio_unstable)))]
  {
    tokio::runtime::Builder::new_current_thread()
      .enable_all()
      .build()
      .expect("Create tokio runtime failed")
  }
}

/// Whether `RT`'s construction has been observed (set at the top of its initializer, so a
/// `true` here means dereferencing `RT` either finds the runtime or blocks on an in-flight
/// construction — it can never trigger a fresh one). Lets the combined-build shutdown path
/// drain a lazily-created runtime without forcing `RT`'s construction. (`LazyLock::get` would
/// express this directly, but it is stable only since Rust 1.89 and MSRV is 1.88.)
#[cfg(all(feature = "async-runtime", feature = "tokio_rt", not(feature = "noop")))]
static RT_CONSTRUCTED: AtomicBool = AtomicBool::new(false);

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
static RT: LazyLock<RwLock<Option<Runtime>>> = LazyLock::new(|| {
  #[cfg(feature = "async-runtime")]
  RT_CONSTRUCTED.store(true, Ordering::SeqCst);
  RwLock::new(Some(create_runtime()))
});

/// Refill the built-in Tokio runtime's slot after a combined-build drain: when a custom
/// backend owns the runtime lifecycle, `shutdown_async_runtime` takes a lazily-created
/// runtime out of `RT`, and every Tokio compatibility helper (`spawn`, `block_on`,
/// `spawn_blocking`, `within_runtime_if_available`) panics on the empty slot until it is
/// refilled. Gated on `RT_CONSTRUCTED` so this never forces a first `LazyLock` construction,
/// preserving the "selecting a custom backend never constructs Tokio" promise.
#[cfg(all(feature = "async-runtime", feature = "tokio_rt", not(feature = "noop")))]
fn refill_drained_tokio_runtime() {
  if RT_CONSTRUCTED.load(Ordering::SeqCst) {
    if let Ok(mut rt) = RT.write() {
      if rt.is_none() {
        *rt = Some(create_runtime());
      }
    }
  }
}

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
static USER_DEFINED_RT: OnceLock<RwLock<Option<Runtime>>> = OnceLock::new();

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
static IS_USER_DEFINED_RT: OnceLock<bool> = OnceLock::new();

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
/// Create a custom Tokio runtime used by the NAPI-RS.
/// You can control the tokio runtime configuration by yourself.
/// ### Example
/// ```no_run
/// use tokio::runtime::Builder;
/// use napi::create_custom_tokio_runtime;
///
/// #[napi_derive::module_init]
/// fn init() {
///    let rt = Builder::new_multi_thread().enable_all().thread_stack_size(32 * 1024 * 1024).build().unwrap();
///    create_custom_tokio_runtime(rt);
/// }
pub fn create_custom_tokio_runtime(rt: Runtime) {
  // A supplied runtime already owns worker threads by the time it gets here, so
  // pin the image before storing it rather than at first use.
  #[cfg(not(target_family = "wasm"))]
  crate::bindgen_runtime::retain_current_module_for_unload_safety();

  USER_DEFINED_RT.get_or_init(move || RwLock::new(Some(rt)));
  IS_USER_DEFINED_RT.get_or_init(|| true);
}

#[cfg(all(feature = "tokio_rt", feature = "noop"))]
pub fn create_custom_tokio_runtime(_: Runtime) {}

#[cfg(not(feature = "noop"))]
/// Start the async runtime.
///
/// When the `async-runtime` feature is enabled and a custom [`AsyncRuntime`] backend has been
/// registered through [`register_async_runtime`], this closes the registration window and calls
/// the backend's [`AsyncRuntime::start`] hook. If that hook returns an error or panics,
/// [`AsyncRuntime::shutdown`] is called to roll back the partial start. Selecting a custom
/// backend never constructs the built-in Tokio runtime.
///
/// Otherwise (the `tokio_rt` path):
///
/// In Node.js native targets the async runtime will be dropped when Node env exits.
/// But in Electron renderer process, the Node env will exits and recreate when the window reloads.
/// So we need to ensure that the async runtime is initialized when the Node env is created.
///
/// In wasm targets, the async runtime will not been shutdown automatically due to the limitation of the wasm runtime.
/// So, you need to call `shutdown_async_runtime` function to manually shutdown the async runtime.
/// In some scenarios, you may want to start the async runtime again like in tests.
pub fn start_async_runtime() {
  // Past the wasm environment cleanup barrier this is a no-op, so an addon export called from a
  // JavaScript callback that runs during disposal cannot bring the runtime back up behind the
  // loader's back — neither the custom backend (through `activate`) nor the built-in Tokio
  // runtime the teardown drained. See [`WASM_ENV_DISPOSING`]. Module registration releases the
  // latch before calling this, so a new environment still starts normally.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    return;
  }
  #[cfg(feature = "async-runtime")]
  if ASYNC_RUNTIME_REGISTRY.activate() {
    // A custom backend owns the runtime lifecycle; do not construct Tokio. But in combined
    // builds the Tokio compatibility helpers (`spawn`, `block_on`, `spawn_blocking`,
    // `within_runtime_if_available`) stay Tokio-backed and may have constructed the built-in
    // runtime lazily; a previous `shutdown_async_runtime` then drained it. Refill it on
    // re-activation (worker restart, Electron renderer reload) — otherwise every later helper
    // call panics on the drained slot until the next dispatch-driven self-heal.
    // `run_claimed_start` already refills on any successful start, but `activate` can return
    // with the phase already `Starting`/`Started` without running it; the direct call keeps
    // the guarantee that the helpers work as soon as this function returns.
    #[cfg(feature = "tokio_rt")]
    refill_drained_tokio_runtime();
    // The return only exists to skip the built-in Tokio (re)construction below, which is
    // `tokio_rt`-only; in a pure `async-runtime` build there is nothing to skip.
    #[cfg(feature = "tokio_rt")]
    return;
  }
  #[cfg(feature = "tokio_rt")]
  if let Ok(mut rt) = RT.write() {
    if rt.is_none() {
      *rt = Some(create_runtime());
    }
  }
}

#[cfg(not(feature = "noop"))]
/// Shutdown the async runtime.
///
/// When a custom [`AsyncRuntime`] backend has been registered, this calls the backend's
/// [`AsyncRuntime::shutdown`] hook — the backend's sole resource-release and quiescence hook.
/// In combined `async-runtime` + `tokio_rt` builds a built-in Tokio runtime that a Tokio
/// compatibility helper constructed lazily is also drained, on a best-effort basis: a helper's
/// very first Tokio construction racing this teardown can leave the built-in runtime running,
/// the same teardown-race window the plain `tokio_rt` path has (whose background shutdown never
/// waits for Tokio quiescence either). The drained pair is restored together: the next
/// [`start_async_runtime`] *or* the next runtime-backed dispatch (which self-heals the idle
/// custom backend) refills the drained Tokio runtime alongside the backend restart. Tokio
/// compatibility helpers called after this shutdown but before either of those still panic on
/// the empty slot, exactly as they do after a `tokio_rt`-only shutdown. Otherwise the built-in
/// Tokio runtime is shut down in the background.
///
/// On wasm targets this is a no-op past the environment cleanup barrier, mirroring
/// [`start_async_runtime`]: from the moment `napi_prepare_wasm_env_cleanup`(`_begin`) latches the
/// disposal, the loader owns the teardown and its `…_finish` call is the one that joins.
pub fn shutdown_async_runtime() {
  // Past the wasm environment cleanup barrier the loader owns the teardown, so this must not
  // perform the join itself. The two-phase handshake yields real event-loop turns between
  // `napi_prepare_wasm_env_cleanup_begin` and `…_finish`, and an addon export called from one of
  // those turns would otherwise wait for backend work on the JavaScript thread — the same thread
  // a parked blocking closure needs a turn from — wedging the disposal that was split apart to
  // avoid exactly that. Returning here loses nothing: phase 1 already published the stop, and the
  // `finish` the loader still owes performs the join. The cleanup exports never reach this
  // function (they call `begin_shutdown_async_runtime` / `finish_shutdown_async_runtime`
  // directly), so the guard cannot disarm the teardown it protects. See `WASM_ENV_DISPOSING`.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    return;
  }
  #[cfg(feature = "async-runtime")]
  if ASYNC_RUNTIME_REGISTRY.deactivate() {
    drain_tokio_peer_after_backend_shutdown();
    // The return only exists to skip the built-in Tokio teardown below, which is
    // `tokio_rt`-only; in a pure `async-runtime` build there is nothing to skip.
    #[cfg(feature = "tokio_rt")]
    return;
  }
  #[cfg(feature = "tokio_rt")]
  if let Some(rt) = RT.write().ok().and_then(|mut rt| rt.take()) {
    rt.shutdown_background();
  }
}

/// Drain a built-in Tokio runtime that lives *beside* a custom backend, after that backend's
/// teardown has run.
///
/// The custom backend owns the runtime lifecycle, but the Tokio compatibility helpers
/// (`spawn`, `block_on`, `spawn_blocking`, `within_runtime_if_available`) stay Tokio-backed in
/// combined builds and may have constructed the built-in runtime lazily AFTER the backend was
/// selected.
///
/// Called from [`shutdown_async_runtime`] and, on wasm, from the second phase of the split
/// teardown — the same position in the sequence either way: after the backend's shutdown
/// returned.
#[cfg(all(feature = "async-runtime", not(feature = "noop")))]
fn drain_tokio_peer_after_backend_shutdown() {
  // Gated on `RT_CONSTRUCTED` so this never forces a construction, preserving the "selecting a
  // custom backend never constructs Tokio" promise.
  #[cfg(feature = "tokio_rt")]
  if let Some(rt) = RT_CONSTRUCTED
    .load(Ordering::SeqCst)
    .then(|| RT.write().ok().and_then(|mut rt| rt.take()))
    .flatten()
  {
    rt.shutdown_background();
  }
  // Also drain a user-supplied runtime that `create_custom_tokio_runtime` parked in
  // `USER_DEFINED_RT` but no Tokio helper ever forced into `RT` (so `RT_CONSTRUCTED` is
  // false and the drain above was a no-op). Unlike the `tokio_rt`-only fall-through in
  // [`shutdown_async_runtime`], this path is reached without ever constructing `RT`, so that
  // runtime's worker threads would otherwise outlive the env. Idempotent: once `RT` was built,
  // `create_runtime` already took `USER_DEFINED_RT`, so this is `None`; and like the drain
  // above it never forces `RT`, preserving the "never constructs Tokio" promise.
  #[cfg(feature = "tokio_rt")]
  if let Some(user_rt) = USER_DEFINED_RT
    .get()
    .and_then(|rt| rt.write().ok().and_then(|mut rt| rt.take()))
  {
    user_rt.shutdown_background();
  }
}

/// Phase 1 of [`shutdown_async_runtime`], for the wasm environment cleanup exports: everything
/// that never waits.
///
/// Answers whether the announced stop still owes a wait — backend work that is still live, or a
/// rejected submission whose destructor is still running on another thread — so the
/// `napi_prepare_wasm_env_cleanup_begin` export can tell its loader to turn the event loop before
/// calling [`finish_shutdown_async_runtime`].
///
/// Call it once per teardown: the cleanup exports hold the latch that makes a repeated `begin`
/// re-report the poll instead of reaching this.
///
/// With no custom backend the built-in Tokio teardown is `shutdown_background`, which never
/// waits either, so it belongs entirely to this phase and phase 2 has nothing left to do — the
/// `tokio_rt`-only path keeps its exact current behaviour.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn begin_shutdown_async_runtime() -> bool {
  #[cfg(feature = "async-runtime")]
  if let Some(pending) = ASYNC_RUNTIME_REGISTRY.begin_deactivate() {
    // The Tokio peer is drained in phase 2, which is where `shutdown_async_runtime` drains it:
    // after the backend's teardown.
    return pending;
  }
  #[cfg(feature = "tokio_rt")]
  if let Some(rt) = RT.write().ok().and_then(|mut rt| rt.take()) {
    rt.shutdown_background();
  }
  false
}

/// Non-blocking poll for the window between the two phases: `true` means the announced stop still
/// owes a wait — backend work, or a rejected submission whose destructor is still running on
/// another thread — and `false` means [`finish_shutdown_async_runtime`] will not wait.
///
/// Safe to call at any time, including with no teardown outstanding.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn async_runtime_work_pending() -> bool {
  #[cfg(feature = "async-runtime")]
  {
    ASYNC_RUNTIME_REGISTRY.deactivate_work_pending()
  }
  #[cfg(not(feature = "async-runtime"))]
  {
    false
  }
}

/// Phase 2 of [`shutdown_async_runtime`], for the wasm environment cleanup exports: the part
/// that waits and joins, plus the Tokio peer drain that follows it.
///
/// Only for a phase 1 the caller started — the cleanup exports hold that latch, and an unpaired
/// `finish` never reaches here.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn finish_shutdown_async_runtime() {
  #[cfg(feature = "async-runtime")]
  if ASYNC_RUNTIME_REGISTRY.finish_deactivate() {
    drain_tokio_peer_after_backend_shutdown();
  }
}

/// Refuse a built-in Tokio compatibility helper for the remainder of a wasm environment's
/// disposal.
///
/// [`spawn`], [`block_on`] and [`spawn_blocking`] hand back a `JoinHandle` or the future's own
/// output. Neither can express "declined": a `JoinHandle` cannot be built without a runtime to
/// build it on, and `F::Output` cannot be conjured at all. So unlike an async export — which
/// [`execute_future_impl`] degrades to a promise rejected with [`crate::Status::Cancelled`] — a call
/// made past the barrier has only three possible answers: accept the work, drop it, or panic.
///
/// Accepting it is the bug this exists to close: in a combined `async-runtime` + `tokio_rt`
/// build a custom backend owns the runtime lifecycle, so [`RT`]'s `LazyLock` is typically never
/// forced and `shutdown_async_runtime` has nothing to drain — a helper called after the barrier
/// would *construct a brand-new Tokio runtime* and run work on it, work no threadsafe-function
/// queue entry represents, so `napi_wasm_env_cleanup_pending` reads zero, the drain stops, and
/// `Context.destroy()` arrives with the work still live. Dropping it would silently lose work
/// the caller is holding a handle to. That leaves the panic.
///
/// It is not a new failure mode. Every *other* configuration already panics here: once the
/// barrier's `shutdown_async_runtime` has taken the runtime out of [`RT`], the `.expect` below
/// fires on the empty slot, which is the documented post-`shutdown_async_runtime` behaviour of
/// these helpers. This only makes the one configuration that silently deviated behave like the
/// rest, and replaces "Access tokio runtime failed in spawn" with a message that says what
/// actually happened.
///
/// On wasm a panic aborts to an `unreachable` trap (both wasm targets build `panic = "abort"`),
/// which JavaScript sees as a thrown error from the offending call — loud, attributable, and
/// exactly what a call that cannot be answered deserves.
#[cfg(all(target_family = "wasm", feature = "tokio_rt", not(feature = "noop")))]
#[cold]
#[inline(never)]
fn refuse_tokio_helper_during_wasm_env_disposal(helper: &'static str) -> ! {
  panic!("napi::{helper} cannot run: {WASM_ENV_DISPOSING_ERROR}");
}

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
/// Spawns a future onto the Tokio runtime.
///
/// Depending on where you use it, you should await or abort the future in your drop function.
/// To avoid undefined behavior and memory corruptions.
///
/// On wasm this panics when called after `napi_prepare_wasm_env_cleanup` rather than accept
/// work the environment is about to destroy.
pub fn spawn<F>(fut: F) -> tokio::task::JoinHandle<F::Output>
where
  F: 'static + Send + Future<Output = ()>,
{
  // Checked before `RT` is touched, because touching it is the problem: reading it forces the
  // `LazyLock`, and in a combined build that has never used a Tokio helper that construction
  // happens *after* the cleanup barrier declared the environment quiescent. See
  // [`WASM_ENV_DISPOSING`].
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    refuse_tokio_helper_during_wasm_env_disposal("spawn");
  }
  RT.read()
    .ok()
    .and_then(|rt| rt.as_ref().map(|rt| rt.spawn(fut)))
    .expect("Access tokio runtime failed in spawn")
}

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
/// Runs a future to completion
/// This is blocking, meaning that it pauses other execution until the future is complete,
/// only use it when it is absolutely necessary, in other places use async functions instead.
///
/// On wasm this panics when called after `napi_prepare_wasm_env_cleanup` rather than accept
/// work the environment is about to destroy.
pub fn block_on<F: Future>(fut: F) -> F::Output {
  // See the note in [`spawn`]: the check has to precede the first `RT` access.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    refuse_tokio_helper_during_wasm_env_disposal("block_on");
  }
  RT.read()
    .ok()
    .and_then(|rt| rt.as_ref().map(|rt| rt.block_on(fut)))
    .expect("Access tokio runtime failed in block_on")
}

#[cfg(all(feature = "tokio_rt", feature = "noop"))]
/// Runs a future to completion
/// This is blocking, meaning that it pauses other execution until the future is complete,
/// only use it when it is absolutely necessary, in other places use async functions instead.
pub fn block_on<F: Future>(_: F) -> F::Output {
  unreachable!("noop feature is enabled, block_on is not available")
}

#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
/// spawn_blocking on the current Tokio runtime.
///
/// On wasm this panics when called after `napi_prepare_wasm_env_cleanup` rather than accept
/// work the environment is about to destroy.
pub fn spawn_blocking<F, R>(func: F) -> tokio::task::JoinHandle<R>
where
  F: FnOnce() -> R + Send + 'static,
  R: Send + 'static,
{
  // See the note in [`spawn`]: the check has to precede the first `RT` access.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    refuse_tokio_helper_during_wasm_env_disposal("spawn_blocking");
  }
  RT.read()
    .ok()
    .and_then(|rt| rt.as_ref().map(|rt| rt.spawn_blocking(func)))
    .expect("Access tokio runtime failed in spawn_blocking")
}

// This function's signature must be kept in sync with the one in lib.rs, otherwise napi
// will fail to compile with the `tokio_rt` feature.
#[cfg(all(feature = "tokio_rt", not(feature = "noop")))]
/// If the feature `tokio_rt` has been enabled this will enter the runtime context and
/// then call the provided closure. Otherwise it will just call the provided closure.
///
/// In combined `tokio_rt` + `async-runtime` builds this established helper stays Tokio-backed,
/// so Cargo feature unification cannot silently change its routing.
pub fn within_runtime_if_available<F: FnOnce() -> T, T>(f: F) -> T {
  // Past the wasm environment cleanup barrier the built-in runtime has been drained, and the
  // `.expect` below would abort on the empty slot — a wasm trap that poisons the whole instance,
  // from a synchronous export a disposal-time JavaScript callback is free to call. Run the
  // closure without a runtime context instead; it is the same thing this helper does when no
  // runtime is available at all. See [`WASM_ENV_DISPOSING`].
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    return f();
  }
  RT.read()
    .ok()
    .and_then(|rt| {
      rt.as_ref().map(|rt| {
        let rt_guard = rt.enter();
        let ret = f();
        drop(rt_guard);
        ret
      })
    })
    .expect("Access tokio runtime failed in within_runtime_if_available")
}

// This function's signature must be kept in sync with the one in lib.rs, otherwise napi
// will fail to compile with the `async-runtime` feature.
#[cfg(all(
  feature = "async-runtime",
  not(feature = "tokio_rt"),
  not(feature = "noop")
))]
/// Enter the registered [`AsyncRuntime`] backend's context (via [`AsyncRuntime::enter`]) around
/// the provided closure. When no backend is registered, or entering the context fails, the
/// closure is called directly.
pub fn within_runtime_if_available<F: FnOnce() -> T, T>(f: F) -> T {
  ASYNC_RUNTIME_REGISTRY.within_runtime(f)
}

#[cfg(feature = "noop")]
pub fn within_runtime_if_available<F: FnOnce() -> T, T>(f: F) -> T {
  f()
}

#[cfg(feature = "noop")]
#[allow(unused)]
pub fn execute_tokio_future<
  Data: 'static + Send,
  Fut: 'static + Send + Future<Output = std::result::Result<Data, impl Into<Error>>>,
  Resolver: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>,
>(
  env: sys::napi_env,
  fut: Fut,
  resolver: Resolver,
) -> Result<sys::napi_value> {
  Ok(std::ptr::null_mut())
}

#[cfg(not(feature = "noop"))]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn execute_tokio_future<
  Data: 'static + Send,
  Fut: 'static + Send + Future<Output = std::result::Result<Data, impl Into<Error>>>,
  Resolver: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>,
>(
  env: sys::napi_env,
  fut: Fut,
  resolver: Resolver,
) -> Result<sys::napi_value> {
  execute_future_impl(env, fut, resolver, None)
}

/// Shared future → Promise bridge behind [`execute_tokio_future`] and
/// [`execute_tokio_future_with_finalize_callback`].
///
/// Routing:
/// 1. a deferred duplicate/late registration error rejects the promise (loud misconfiguration),
/// 2. a registered custom [`AsyncRuntime`] backend receives the work as an [`AsyncRuntimeTask`],
/// 3. otherwise the built-in Tokio runtime is used (combined and `tokio_rt`-only builds); in a
///    pure `async-runtime` build the promise rejects with a missing-backend error instead.
#[cfg(not(feature = "noop"))]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
fn execute_future_impl<
  Data: 'static + Send,
  Fut: 'static + Send + Future<Output = std::result::Result<Data, impl Into<Error>>>,
  Resolver: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>,
>(
  env: sys::napi_env,
  fut: Fut,
  resolver: Resolver,
  finalize_callback: Option<Box<dyn FnOnce(sys::napi_env)>>,
) -> Result<sys::napi_value> {
  let env = Env::from_raw(env);
  let (mut deferred, promise) = JsDeferred::new(&env)?;
  deferred.set_finalize_callback(finalize_callback);
  let promise_value = promise.0.value;

  // Past the wasm environment cleanup barrier the runtime is gone for good: the custom backend
  // has been shut down and, on the built-in Tokio path, `RT` has been drained (where `spawn`
  // would `.expect` on the empty slot and trap the instance). Reject rather than dispatch, so a
  // call made from a JavaScript callback that runs during disposal gets a defined, settled
  // promise instead of one that is stranded when `Context.destroy()` arrives. The rejection goes
  // through the ordinary settle path: made on this thread outside the barrier it is queued and
  // therefore counted, so the loader's drain waits for it and it reaches JavaScript before the
  // environment is destroyed.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  if wasm_env_disposing() {
    deferred.reject(Error::new(
      crate::Status::Cancelled,
      WASM_ENV_DISPOSING_ERROR,
    ));
    return Ok(promise_value);
  }

  #[cfg(feature = "async-runtime")]
  if let Some(reason) = ASYNC_RUNTIME_REGISTRY.deferred_registration_error() {
    deferred.reject(Error::new(crate::Status::GenericFailure, reason));
    return Ok(promise_value);
  }

  #[cfg(all(feature = "async-runtime", not(feature = "tokio_rt")))]
  if ASYNC_RUNTIME_REGISTRY.commit_selection(false).is_none() {
    // Pure `async-runtime` build with no registered backend: reject rather than hang. The
    // selection is deliberately NOT frozen, so a later registration can still succeed.
    deferred.reject(Error::new(
      crate::Status::GenericFailure,
      MISSING_RUNTIME_BACKEND_ERROR,
    ));
    return Ok(promise_value);
  }

  #[cfg(feature = "async-runtime")]
  let deferred_for_cancel = deferred.clone();
  #[cfg(all(
    feature = "tokio_rt",
    any(
      all(target_family = "wasm", tokio_unstable),
      not(target_family = "wasm")
    )
  ))]
  let deferred_for_panic = deferred.clone();
  #[cfg(all(feature = "tokio_rt", target_family = "wasm", not(tokio_unstable)))]
  let deferred_for_threadless = deferred.clone();
  let sendable_resolver = SendableResolver::new(resolver);

  let inner = async move {
    match fut.await {
      Ok(v) => deferred.resolve(move |env| {
        sendable_resolver
          .resolve(env.raw(), v)
          .map(|v| unsafe { Unknown::from_raw_unchecked(env.raw(), v) })
      }),
      Err(e) => deferred.reject(e.into()),
    }
  };

  #[cfg(feature = "async-runtime")]
  if let Some(backend) = ASYNC_RUNTIME_REGISTRY.commit_selection(cfg!(feature = "tokio_rt")) {
    // Module-export hooks can dispatch here before `start_async_runtime` runs; make sure the
    // backend received its `start()` before its first task.
    ASYNC_RUNTIME_REGISTRY.ensure_started(backend);
    let task = AsyncRuntimeTask::new(
      Box::pin(inner),
      Box::new(move |error| deferred_for_cancel.reject(error)),
    );
    match catch_unwind(AssertUnwindSafe(|| backend.spawn(task))) {
      Ok(Ok(())) => {}
      Ok(Err(rejection)) => {
        // The backend declined and handed the task back untouched: settle the promise
        // with the diagnostic instead of leaving it pending.
        let (task, error) = rejection.into_parts();
        task.reject_with(error);
      }
      // The hook panicked. The task's `Drop` during unwinding already fired the
      // cancellation path unless the future had settled first (first poll commits
      // ownership), so there is nothing left to settle here — only the payload to dispose
      // of without letting a panicking payload `Drop` unwind into the extern "C" trampoline.
      Err(payload) => drop_contained(payload),
    }
    return Ok(promise_value);
  }

  #[cfg(feature = "tokio_rt")]
  {
    #[cfg(any(
      all(target_family = "wasm", tokio_unstable),
      not(target_family = "wasm")
    ))]
    let jh = spawn(inner);

    #[cfg(any(
      all(target_family = "wasm", tokio_unstable),
      not(target_family = "wasm")
    ))]
    spawn(async move {
      if let Err(err) = jh.await {
        if let Ok(reason) = err.try_into_panic() {
          if let Some(s) = reason.downcast_ref::<&str>() {
            deferred_for_panic.reject(Error::new(crate::Status::GenericFailure, s));
          } else {
            deferred_for_panic.reject(Error::new(
              crate::Status::GenericFailure,
              "Panic in async function",
            ));
          }
        }
      }
    });

    #[cfg(all(target_family = "wasm", not(tokio_unstable)))]
    {
      // Plain `wasm32-wasip1` has no threads and builds `panic = "abort"`, so the old
      // `std::thread::spawn(|| block_on(inner))` fallback would trap: the unsupported thread
      // spawn makes its internal `.expect` panic, which aborts to an `unreachable` wasm trap
      // surfaced to JS as `RuntimeError: unreachable`, poisoning the whole instance. Instead
      // drop the future without running it and reject the deferred with a friendly diagnostic,
      // matching the old fat base's behavior. A registered custom `AsyncRuntime` backend
      // (async-runtime builds) is selected above and returns before reaching here, and
      // `wasm32-wasip1-threads` compiles with `tokio_unstable`, taking the spawn path instead —
      // so this branch is only the genuinely threadless built-in Tokio case.
      drop(inner);
      deferred_for_threadless.reject(Error::new(
        crate::Status::GenericFailure,
        "Built-in Tokio async tasks require a threaded WASI target. Use wasm32-wasip1-threads, or enable async-runtime and register a custom AsyncRuntime backend for wasm32-wasip1.",
      ));
    }

    Ok(promise_value)
  }

  // Pure `async-runtime` build: unreachable in practice — the missing-backend check above
  // already returned, and a published backend cannot be unregistered. Kept for type checking.
  #[cfg(all(feature = "async-runtime", not(feature = "tokio_rt")))]
  {
    drop(inner);
    Ok(promise_value)
  }
}

#[doc(hidden)]
#[cfg(not(feature = "noop"))]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub fn execute_tokio_future_with_finalize_callback<
  Data: 'static + Send,
  Fut: 'static + Send + Future<Output = std::result::Result<Data, impl Into<Error>>>,
  Resolver: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>,
>(
  env: sys::napi_env,
  fut: Fut,
  resolver: Resolver,
  finalize_callback: Option<Box<dyn FnOnce(sys::napi_env)>>,
) -> Result<sys::napi_value> {
  execute_future_impl(env, fut, resolver, finalize_callback)
}

#[cfg(feature = "noop")]
#[doc(hidden)]
pub fn execute_tokio_future_with_finalize_callback<
  Data: 'static + Send,
  Fut: 'static + Send + Future<Output = std::result::Result<Data, impl Into<Error>>>,
  Resolver: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>,
>(
  _env: sys::napi_env,
  _fut: Fut,
  _resolver: Resolver,
  _finalize_callback: Option<Box<dyn FnOnce(sys::napi_env)>>,
) -> Result<sys::napi_value> {
  Ok(std::ptr::null_mut())
}

pub struct AsyncBlockBuilder<
  V: Send + 'static,
  F: Future<Output = Result<V>> + Send + 'static,
  Dispose: FnOnce(Env) -> Result<()> + 'static = fn(Env) -> Result<()>,
> {
  inner: F,
  dispose: Option<Dispose>,
}

impl<V: ToNapiValue + Send + 'static, F: Future<Output = Result<V>> + Send + 'static>
  AsyncBlockBuilder<V, F>
{
  /// Create a new `AsyncBlockBuilder` with the given future, without dispose
  pub fn new(inner: F) -> Self {
    Self {
      inner,
      dispose: None,
    }
  }
}

impl<
    V: ToNapiValue + Send + 'static,
    F: Future<Output = Result<V>> + Send + 'static,
    Dispose: FnOnce(Env) -> Result<()> + 'static,
  > AsyncBlockBuilder<V, F, Dispose>
{
  pub fn with(inner: F) -> Self {
    Self {
      inner,
      dispose: None,
    }
  }

  pub fn with_dispose(mut self, dispose: Dispose) -> Self {
    self.dispose = Some(dispose);
    self
  }

  pub fn build(self, env: &Env) -> Result<AsyncBlock<V>> {
    Ok(AsyncBlock {
      inner: execute_tokio_future(env.0, self.inner, |env, v| unsafe {
        if let Some(dispose) = self.dispose {
          let env = Env::from_raw(env);
          dispose(env)?;
        }
        V::to_napi_value(env, v)
      })?,
      _phantom: PhantomData,
    })
  }
}

impl<V: Send + 'static, F: Future<Output = Result<V>> + Send + 'static> AsyncBlockBuilder<V, F> {
  /// Create a new `AsyncBlockBuilder` with the given future, without dispose
  pub fn build_with_map<T: ToNapiValue, Map: FnOnce(Env, V) -> Result<T> + 'static>(
    env: &Env,
    inner: F,
    map: Map,
  ) -> Result<AsyncBlock<T>> {
    Ok(AsyncBlock {
      inner: execute_tokio_future(env.0, inner, |env, v| unsafe {
        let v = map(Env::from_raw(env), v)?;
        T::to_napi_value(env, v)
      })?,
      _phantom: PhantomData,
    })
  }
}

pub struct AsyncBlock<T: ToNapiValue + 'static> {
  inner: sys::napi_value,
  _phantom: PhantomData<T>,
}

impl<T: ToNapiValue + 'static> ToNapiValue for AsyncBlock<T> {
  unsafe fn to_napi_value(_: napi_sys::napi_env, val: Self) -> Result<napi_sys::napi_value> {
    Ok(val.inner)
  }
}

#[cfg(all(test, feature = "async-runtime", not(feature = "noop")))]
mod spi_tests {
  use std::{
    sync::{
      atomic::{AtomicBool as TestAtomicBool, AtomicUsize, Ordering as AtomicOrdering},
      mpsc, Arc, Mutex,
    },
    time::Duration,
  };

  use super::*;

  const BACKEND_STOPPED_ERROR: &str = "mock backend is stopped";
  /// Hang protection only — the tests below never rely on timing for their assertions.
  const HANG_PROTECTION: Duration = Duration::from_secs(30);

  /// Observations shared between a test and its mock backend, surviving backend retirement.
  #[derive(Default)]
  struct BackendProbe {
    start_calls: AtomicUsize,
    shutdown_calls: AtomicUsize,
    spawn_calls: AtomicUsize,
    /// Spawns observed while the backend had never received a `start()`.
    spawns_before_start: AtomicUsize,
    /// `true` between a successful `start()` and the next `shutdown()`.
    running: TestAtomicBool,
  }

  struct MockRuntime {
    probe: Arc<BackendProbe>,
    fail_start: bool,
  }

  impl MockRuntime {
    fn new(probe: &Arc<BackendProbe>) -> Self {
      Self {
        probe: probe.clone(),
        fail_start: false,
      }
    }

    fn failing_start(probe: &Arc<BackendProbe>) -> Self {
      Self {
        probe: probe.clone(),
        fail_start: true,
      }
    }
  }

  unsafe impl AsyncRuntime for MockRuntime {
    fn spawn(
      &self,
      task: AsyncRuntimeTask,
    ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
      if self.probe.start_calls.load(AtomicOrdering::SeqCst) == 0 {
        self
          .probe
          .spawns_before_start
          .fetch_add(1, AtomicOrdering::SeqCst);
      }
      self.probe.spawn_calls.fetch_add(1, AtomicOrdering::SeqCst);
      if !self.probe.running.load(AtomicOrdering::SeqCst) {
        // A conforming stopped backend stops accepting work (see `AsyncRuntime::shutdown`).
        return Err(AsyncRuntimeRejection::new(
          task,
          Error::new(crate::Status::GenericFailure, BACKEND_STOPPED_ERROR),
        ));
      }
      futures::executor::block_on(task);
      Ok(())
    }

    fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()> {
      futures::executor::block_on(future);
      Ok(())
    }

    fn start(&self) -> Result<()> {
      self.probe.start_calls.fetch_add(1, AtomicOrdering::SeqCst);
      if self.fail_start {
        return Err(Error::new(crate::Status::GenericFailure, "start failed"));
      }
      self.probe.running.store(true, AtomicOrdering::SeqCst);
      Ok(())
    }

    fn shutdown(&self) -> Result<()> {
      self.probe.running.store(false, AtomicOrdering::SeqCst);
      self
        .probe
        .shutdown_calls
        .fetch_add(1, AtomicOrdering::SeqCst);
      Ok(())
    }
  }

  /// A cancellation callback recording how often it fired and with which error message.
  fn recording_cancel_callback() -> (
    Arc<AtomicUsize>,
    Arc<Mutex<Option<String>>>,
    AsyncRuntimeTaskCancelCallback,
  ) {
    let fired = Arc::new(AtomicUsize::new(0));
    let message = Arc::new(Mutex::new(None));
    let fired_in_callback = fired.clone();
    let message_in_callback = message.clone();
    let callback: AsyncRuntimeTaskCancelCallback = Box::new(move |error: Error| {
      fired_in_callback.fetch_add(1, AtomicOrdering::SeqCst);
      *message_in_callback.lock().unwrap() = Some(error.reason.to_string());
    });
    (fired, message, callback)
  }

  /// A backend whose `enter()` hook panics, to prove the sync `within_runtime` path contains it.
  #[cfg(not(feature = "tokio_rt"))]
  struct PanicOnEnterRuntime {
    probe: Arc<BackendProbe>,
  }

  #[cfg(not(feature = "tokio_rt"))]
  unsafe impl AsyncRuntime for PanicOnEnterRuntime {
    fn spawn(
      &self,
      task: AsyncRuntimeTask,
    ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
      futures::executor::block_on(task);
      Ok(())
    }

    fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()> {
      futures::executor::block_on(future);
      Ok(())
    }

    fn start(&self) -> Result<()> {
      self.probe.start_calls.fetch_add(1, AtomicOrdering::SeqCst);
      self.probe.running.store(true, AtomicOrdering::SeqCst);
      Ok(())
    }

    fn enter(&self) -> Result<Box<dyn AsyncRuntimeGuard + '_>> {
      panic!("enter hook panic");
    }

    fn shutdown(&self) -> Result<()> {
      self.probe.running.store(false, AtomicOrdering::SeqCst);
      self
        .probe
        .shutdown_calls
        .fetch_add(1, AtomicOrdering::SeqCst);
      Ok(())
    }
  }

  /// The sync `within_runtime` path (pure `async-runtime`) starts a dormant backend before
  /// entering it, mirroring the async dispatch path — a backend that builds its ambient context
  /// in `start()` must not be `enter()`ed while it has never been started.
  #[cfg(not(feature = "tokio_rt"))]
  #[test]
  fn within_runtime_starts_dormant_backend_before_enter() {
    let registry = AsyncRuntimeRegistry::new();
    let probe = Arc::new(BackendProbe::default());
    assert!(registry
      .try_register(Box::new(MockRuntime::new(&probe)))
      .is_ok());
    // Registered but never activated/started.
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 0);

    let ran = registry.within_runtime(|| true);

    assert!(ran, "the wrapped closure must run");
    assert_eq!(
      probe.start_calls.load(AtomicOrdering::SeqCst),
      1,
      "within_runtime must start the backend before entering its context"
    );
  }

  /// A panicking `enter()` hook is contained on the sync path: the closure still runs and the
  /// process does not abort across the `extern \"C\"` trampoline (this test surviving is the
  /// assertion). Matches the containment the async `spawn` path already provides.
  #[cfg(not(feature = "tokio_rt"))]
  #[test]
  fn within_runtime_contains_panicking_enter_hook() {
    let registry = AsyncRuntimeRegistry::new();
    let probe = Arc::new(BackendProbe::default());
    assert!(registry
      .try_register(Box::new(PanicOnEnterRuntime {
        probe: probe.clone()
      }))
      .is_ok());

    let ran = registry.within_runtime(|| true);

    assert!(
      ran,
      "the wrapped closure must still run after a contained enter() panic"
    );
    assert_eq!(
      probe.start_calls.load(AtomicOrdering::SeqCst),
      1,
      "the backend is still started before the (panicking) enter()"
    );
  }

  /// A guard whose `Drop` panics. The sync path drops it *after* the wrapped closure — on a normal
  /// return or while the closure is unwinding — so `ContainedGuard` must route it through
  /// `drop_contained`. Counts its own drops so a test can prove the destructor actually ran.
  #[cfg(not(feature = "tokio_rt"))]
  struct PanicOnDropGuard {
    dropped: Arc<AtomicUsize>,
  }

  #[cfg(not(feature = "tokio_rt"))]
  impl AsyncRuntimeGuard for PanicOnDropGuard {}

  #[cfg(not(feature = "tokio_rt"))]
  impl Drop for PanicOnDropGuard {
    fn drop(&mut self) {
      self.dropped.fetch_add(1, AtomicOrdering::SeqCst);
      panic!("guard drop panic");
    }
  }

  /// A backend whose `enter()` succeeds but hands back a guard that panics on drop.
  #[cfg(not(feature = "tokio_rt"))]
  struct GuardDropPanicRuntime {
    guard_dropped: Arc<AtomicUsize>,
  }

  #[cfg(not(feature = "tokio_rt"))]
  unsafe impl AsyncRuntime for GuardDropPanicRuntime {
    fn spawn(
      &self,
      task: AsyncRuntimeTask,
    ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
      futures::executor::block_on(task);
      Ok(())
    }

    fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()> {
      futures::executor::block_on(future);
      Ok(())
    }

    fn start(&self) -> Result<()> {
      Ok(())
    }

    fn enter(&self) -> Result<Box<dyn AsyncRuntimeGuard + '_>> {
      Ok(Box::new(PanicOnDropGuard {
        dropped: self.guard_dropped.clone(),
      }))
    }

    fn shutdown(&self) -> Result<()> {
      Ok(())
    }
  }

  /// Registers a backend whose `enter()` returns a guard that panics on drop; returns the counter
  /// the guard bumps when its destructor runs.
  #[cfg(not(feature = "tokio_rt"))]
  fn register_guard_drop_panic_backend(registry: &AsyncRuntimeRegistry) -> Arc<AtomicUsize> {
    let guard_dropped = Arc::new(AtomicUsize::new(0));
    assert!(registry
      .try_register(Box::new(GuardDropPanicRuntime {
        guard_dropped: guard_dropped.clone(),
      }))
      .is_ok());
    guard_dropped
  }

  /// After a normally-returning closure, a successful `enter()`'s guard is dropped by
  /// `ContainedGuard`; a panicking guard destructor is contained rather than unwinding across the
  /// sync `extern "C"` trampoline, and the closure's value still flows out. (Fails cleanly — as a
  /// propagating panic, not an abort — if the guard is dropped uncontained.)
  #[cfg(not(feature = "tokio_rt"))]
  #[test]
  fn within_runtime_contains_panicking_guard_drop() {
    let registry = AsyncRuntimeRegistry::new();
    let guard_dropped = register_guard_drop_panic_backend(&registry);

    let value = registry.within_runtime(|| 7);

    assert_eq!(
      value, 7,
      "the closure's return value must flow out unaffected"
    );
    assert_eq!(
      guard_dropped.load(AtomicOrdering::SeqCst),
      1,
      "the panicking guard destructor must run (and be contained)"
    );
  }

  /// The guard drops *while the closure is unwinding*: without `ContainedGuard`, a guard destructor
  /// panicking during that unwind is a second panic in flight and aborts the process (uncatchable).
  /// With it, only the closure's own panic escapes — caught here — and the guard panic is contained.
  /// This test aborting the whole binary is the failure signal; surviving with `is_err()` is the pass.
  #[cfg(not(feature = "tokio_rt"))]
  #[test]
  fn within_runtime_contains_guard_drop_panic_during_closure_unwind() {
    let registry = AsyncRuntimeRegistry::new();
    let guard_dropped = register_guard_drop_panic_backend(&registry);

    let escaped = catch_unwind(AssertUnwindSafe(|| {
      registry.within_runtime(|| panic!("closure panic"));
    }));

    assert!(
      escaped.is_err(),
      "the closure's own panic must still propagate (only the guard panic is contained)"
    );
    assert_eq!(
      guard_dropped.load(AtomicOrdering::SeqCst),
      1,
      "the guard destructor ran during the unwind and was contained (no double-panic abort)"
    );
  }

  #[test]
  fn duplicate_registration_defers_error_and_retires_backend() {
    let registry = AsyncRuntimeRegistry::new();
    let first_probe = Arc::new(BackendProbe::default());
    let second_probe = Arc::new(BackendProbe::default());

    assert!(registry
      .try_register(Box::new(MockRuntime::new(&first_probe)))
      .is_ok());

    let (reason, rejected) = registry
      .try_register(Box::new(MockRuntime::new(&second_probe)))
      .expect_err("second registration must be rejected");
    assert_eq!(reason, DUPLICATE_RUNTIME_ERROR);

    // The rejected backend is retired through its own shutdown, never bare-dropped.
    retire_rejected_async_runtime(rejected);
    assert_eq!(second_probe.shutdown_calls.load(AtomicOrdering::SeqCst), 1);
    // The first backend stays selected and untouched.
    assert!(registry.commit_selection(false).is_some());
    assert_eq!(first_probe.shutdown_calls.load(AtomicOrdering::SeqCst), 0);

    // The infallible wrapper records the error for later runtime-backed calls to surface.
    registry.record_registration_error(reason);
    assert_eq!(
      registry.deferred_registration_error(),
      Some(DUPLICATE_RUNTIME_ERROR)
    );
  }

  #[test]
  fn late_registration_after_env_activation_rejected() {
    let registry = AsyncRuntimeRegistry::new();
    // First env activation with no backend registered: freezes the (empty) selection.
    assert!(!registry.activate());

    let probe = Arc::new(BackendProbe::default());
    let (reason, _rejected) = registry
      .try_register(Box::new(MockRuntime::new(&probe)))
      .expect_err("registration after env activation must be rejected");
    assert_eq!(reason, LATE_RUNTIME_REGISTRATION_ERROR);
  }

  #[test]
  fn tokio_fallback_selection_commits_and_closes_registration() {
    let registry = AsyncRuntimeRegistry::new();
    // A runtime-backed operation in a combined build takes the Tokio fallback: that commits
    // a backend choice and closes the registration window.
    assert!(registry.commit_selection(true).is_none());

    let probe = Arc::new(BackendProbe::default());
    let (reason, _rejected) = registry
      .try_register(Box::new(MockRuntime::new(&probe)))
      .expect_err("registration after a committed fallback choice must be rejected");
    assert_eq!(reason, LATE_RUNTIME_REGISTRATION_ERROR);
  }

  #[test]
  fn missing_backend_does_not_freeze_selection() {
    let registry = AsyncRuntimeRegistry::new();
    // A runtime-backed operation in a pure build with no backend errors but does NOT commit:
    assert!(registry.commit_selection(false).is_none());

    // …so a later registration still succeeds.
    let probe = Arc::new(BackendProbe::default());
    assert!(registry
      .try_register(Box::new(MockRuntime::new(&probe)))
      .is_ok());
    assert!(registry.commit_selection(false).is_some());
  }

  #[test]
  fn task_drop_fires_cancellation_exactly_once() {
    let (fired, message, callback) = recording_cancel_callback();
    let task = AsyncRuntimeTask::new(Box::pin(async {}), callback);
    drop(task);
    assert_eq!(fired.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
      message.lock().unwrap().as_deref(),
      Some(TASK_CANCELLED_ERROR)
    );
  }

  #[test]
  fn task_completion_disarms_cancellation() {
    let (fired, _message, callback) = recording_cancel_callback();
    let task = AsyncRuntimeTask::new(Box::pin(async {}), callback);
    // Polling to completion consumes and then drops the task…
    futures::executor::block_on(task);
    // …without firing the cancellation callback.
    assert_eq!(fired.load(AtomicOrdering::SeqCst), 0);
  }

  #[test]
  fn rejection_returns_task_untouched() {
    let (fired, message, callback) = recording_cancel_callback();
    let task = AsyncRuntimeTask::new(Box::pin(async {}), callback);

    let rejection = AsyncRuntimeRejection::new(
      task,
      Error::new(crate::Status::GenericFailure, "queue is full"),
    );
    assert_eq!(rejection.error().reason, "queue is full");

    // napi recovers the task and settles its promise with the diagnostic; the cancellation
    // path still fires exactly once and the subsequent drop is a no-op.
    let (task, error) = rejection.into_parts();
    assert_eq!(fired.load(AtomicOrdering::SeqCst), 0);
    task.reject_with(error);
    assert_eq!(fired.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(message.lock().unwrap().as_deref(), Some("queue is full"));
  }

  #[test]
  fn spawn_blocking_default_declines_with_work_returned() {
    struct SpawnOnlyRuntime;
    unsafe impl AsyncRuntime for SpawnOnlyRuntime {
      fn spawn(
        &self,
        task: AsyncRuntimeTask,
      ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
        futures::executor::block_on(task);
        Ok(())
      }
      fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()> {
        futures::executor::block_on(future);
        Ok(())
      }
      fn shutdown(&self) -> Result<()> {
        Ok(())
      }
    }

    let ran = Arc::new(AtomicUsize::new(0));
    let ran_in_work = ran.clone();
    let rejection = SpawnOnlyRuntime
      .spawn_blocking(Box::new(move || {
        ran_in_work.fetch_add(1, AtomicOrdering::SeqCst);
      }))
      .expect_err("the default spawn_blocking implementation must decline");
    assert_eq!(rejection.error().status, crate::Status::GenericFailure);

    // The closure comes back untouched and still runnable.
    let (work, _error) = rejection.into_parts();
    assert_eq!(ran.load(AtomicOrdering::SeqCst), 0);
    work();
    assert_eq!(ran.load(AtomicOrdering::SeqCst), 1);
  }

  #[test]
  fn panic_in_task_fires_cancellation_with_panic_message() {
    let (fired, message, callback) = recording_cancel_callback();
    let task = AsyncRuntimeTask::new(
      Box::pin(async {
        panic!("boom in async task");
      }),
      callback,
    );
    // The per-poll catch_unwind converts the panic into the cancellation/rejection path
    // instead of unwinding into (and aborting) the backend's executor.
    futures::executor::block_on(task);
    assert_eq!(fired.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
      message.lock().unwrap().as_deref(),
      Some("boom in async task")
    );
  }

  #[test]
  fn pre_activation_dispatch_starts_backend_before_first_spawn() {
    let registry = AsyncRuntimeRegistry::new();
    let probe = Arc::new(BackendProbe::default());
    assert!(registry
      .try_register(Box::new(MockRuntime::new(&probe)))
      .is_ok());

    // Module-export hooks run with a live Env BEFORE `start_async_runtime`, so a runtime-backed
    // call (`Env::spawn_future`) dispatches before `activate`. The dispatch path
    // (`execute_future_impl`) commits the selection, then must run the start-with-rollback
    // sequence before handing the backend its first task.
    let backend = registry
      .commit_selection(cfg!(feature = "tokio_rt"))
      .expect("custom backend must be selected");
    registry.ensure_started(backend);
    let (_fired, _message, callback) = recording_cancel_callback();
    assert!(backend
      .spawn(AsyncRuntimeTask::new(Box::pin(async {}), callback))
      .is_ok());

    // The backend never observed a spawn without a preceding start …
    assert_eq!(probe.spawn_calls.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(probe.spawns_before_start.load(AtomicOrdering::SeqCst), 0);
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 1);

    // … the later first-env activation does not start it a second time …
    assert!(registry.activate());
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 1);

    // … and a full teardown/reactivation cycle starts it again.
    assert!(registry.deactivate());
    assert!(registry.activate());
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 2);
  }

  #[test]
  fn deactivate_waits_out_inflight_start() {
    /// A backend whose `start()` blocks until the test driver releases it, logging every
    /// lifecycle event in order.
    struct GatedStartRuntime {
      events: Arc<Mutex<Vec<&'static str>>>,
      start_entered: mpsc::Sender<()>,
      release_start: Mutex<mpsc::Receiver<()>>,
    }

    unsafe impl AsyncRuntime for GatedStartRuntime {
      fn spawn(
        &self,
        task: AsyncRuntimeTask,
      ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
        futures::executor::block_on(task);
        Ok(())
      }

      fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()> {
        futures::executor::block_on(future);
        Ok(())
      }

      fn start(&self) -> Result<()> {
        self.events.lock().unwrap().push("start:enter");
        self
          .start_entered
          .send(())
          .expect("test driver dropped the start-entered channel");
        self
          .release_start
          .lock()
          .unwrap()
          .recv_timeout(HANG_PROTECTION)
          .expect("test driver never released the gated start");
        self.events.lock().unwrap().push("start:exit");
        Ok(())
      }

      fn shutdown(&self) -> Result<()> {
        self.events.lock().unwrap().push("shutdown");
        Ok(())
      }
    }

    let events: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let (start_entered_tx, start_entered_rx) = mpsc::channel();
    let (release_start_tx, release_start_rx) = mpsc::channel();
    let (deactivate_called_tx, deactivate_called_rx) = mpsc::channel();

    let registry = AsyncRuntimeRegistry::new();
    assert!(registry
      .try_register(Box::new(GatedStartRuntime {
        events: events.clone(),
        start_entered: start_entered_tx,
        release_start: Mutex::new(release_start_rx),
      }))
      .is_ok());

    std::thread::scope(|scope| {
      let starter = scope.spawn(|| assert!(registry.activate()));
      // Once `start` signals, the starter holds the lifecycle lock with `start` in flight.
      start_entered_rx
        .recv_timeout(HANG_PROTECTION)
        .expect("start was never entered");

      let stopper = scope.spawn(|| {
        deactivate_called_tx
          .send(())
          .expect("test driver dropped the deactivate-called channel");
        assert!(registry.deactivate());
        events.lock().unwrap().push("deactivate:returned");
      });
      // Wait until the teardown is underway, then let the gated start finish. `deactivate`
      // must wait out the in-flight start: it may run `shutdown` (and return) only after
      // `start` completed.
      deactivate_called_rx
        .recv_timeout(HANG_PROTECTION)
        .expect("deactivate was never called");
      release_start_tx
        .send(())
        .expect("the gated start is no longer waiting for its release");

      starter.join().expect("starter thread panicked");
      stopper.join().expect("stopper thread panicked");
    });

    assert_eq!(
      *events.lock().unwrap(),
      [
        "start:enter",
        "start:exit",
        "shutdown",
        "deactivate:returned"
      ]
    );
  }

  #[test]
  fn completed_teardown_revokes_pending_start_claim() {
    let registry = AsyncRuntimeRegistry::new();
    let probe = Arc::new(BackendProbe::default());
    assert!(registry
      .try_register(Box::new(MockRuntime::new(&probe)))
      .is_ok());

    // A dispatch claimed the start (`Idle → Starting`) but has not taken the lifecycle lock
    // yet …
    registry.lock_state().phase = LifecyclePhase::Starting;
    // … when a teardown runs to completion: `shutdown` returns and the claim is revoked.
    assert!(registry.deactivate());
    assert_eq!(probe.shutdown_calls.load(AtomicOrdering::SeqCst), 1);

    // The claimant resumes. It must NOT start the backend now: `shutdown` already reported
    // quiescence to the (possibly last) environment cleanup, so a start here would create
    // backend resources nobody can stop before Node unloads the image.
    let backend = registry
      .commit_selection(cfg!(feature = "tokio_rt"))
      .expect("custom backend must stay selected");
    registry.run_claimed_start(backend);
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 0);

    // The claimant's dispatch then spawns into the stopped backend and gets rejected; the
    // promise settles through the cancellation diagnostic instead.
    let (fired, message, callback) = recording_cancel_callback();
    let rejection = backend
      .spawn(AsyncRuntimeTask::new(Box::pin(async {}), callback))
      .expect_err("a stopped conforming backend must reject the spawn");
    let (task, error) = rejection.into_parts();
    task.reject_with(error);
    assert_eq!(fired.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(
      message.lock().unwrap().as_deref(),
      Some(BACKEND_STOPPED_ERROR)
    );

    // A fresh claim afterwards begins a new cycle and starts the backend again.
    registry.ensure_started(backend);
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 1);
  }

  #[test]
  fn start_error_triggers_shutdown_rollback() {
    let registry = AsyncRuntimeRegistry::new();
    let probe = Arc::new(BackendProbe::default());
    assert!(registry
      .try_register(Box::new(MockRuntime::failing_start(&probe)))
      .is_ok());

    // A failing `start` is rolled back through `shutdown`.
    assert!(registry.activate());
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(probe.shutdown_calls.load(AtomicOrdering::SeqCst), 1);

    // Env teardown still routes to the backend's shutdown hook.
    assert!(registry.deactivate());
    assert_eq!(probe.shutdown_calls.load(AtomicOrdering::SeqCst), 2);
  }

  #[test]
  fn panicking_payload_drop_from_start_is_contained() {
    /// A panic payload whose own `Drop` panics, recording that it ran.
    struct PanickingDropPayload {
      drops: Arc<AtomicUsize>,
    }

    impl Drop for PanickingDropPayload {
      fn drop(&mut self) {
        self.drops.fetch_add(1, AtomicOrdering::SeqCst);
        panic!("panic payload drop");
      }
    }

    /// Panics with the payload above on its first `start()`; starts normally afterwards.
    struct PanicOnFirstStartRuntime {
      probe: Arc<BackendProbe>,
      payload_drops: Arc<AtomicUsize>,
    }

    unsafe impl AsyncRuntime for PanicOnFirstStartRuntime {
      fn spawn(
        &self,
        task: AsyncRuntimeTask,
      ) -> std::result::Result<(), AsyncRuntimeRejection<AsyncRuntimeTask>> {
        futures::executor::block_on(task);
        Ok(())
      }

      fn block_on(&self, future: Pin<&mut dyn Future<Output = ()>>) -> Result<()> {
        futures::executor::block_on(future);
        Ok(())
      }

      fn start(&self) -> Result<()> {
        if self.probe.start_calls.fetch_add(1, AtomicOrdering::SeqCst) == 0 {
          std::panic::panic_any(PanickingDropPayload {
            drops: self.payload_drops.clone(),
          });
        }
        self.probe.running.store(true, AtomicOrdering::SeqCst);
        Ok(())
      }

      fn shutdown(&self) -> Result<()> {
        self.probe.running.store(false, AtomicOrdering::SeqCst);
        self
          .probe
          .shutdown_calls
          .fetch_add(1, AtomicOrdering::SeqCst);
        Ok(())
      }
    }

    let registry = AsyncRuntimeRegistry::new();
    let probe = Arc::new(BackendProbe::default());
    let payload_drops = Arc::new(AtomicUsize::new(0));
    assert!(registry
      .try_register(Box::new(PanicOnFirstStartRuntime {
        probe: probe.clone(),
        payload_drops: payload_drops.clone(),
      }))
      .is_ok());

    // First activation: `start` panics with a payload whose own `Drop` panics. The activate
    // path must contain both panics instead of unwinding out (in production the unwind would
    // escape into extern "C" `napi_register_module_v1` and abort despite the documented
    // rollback).
    let activated = catch_unwind(AssertUnwindSafe(|| registry.activate()))
      .expect("a panicking payload Drop must not unwind out of the activate path");
    assert!(activated);

    // The payload was dropped inside the containment (not leaked wholesale): its panicking
    // `Drop` ran exactly once and the second panic was swallowed.
    assert_eq!(payload_drops.load(AtomicOrdering::SeqCst), 1);
    // The panicking start was rolled back through `shutdown` …
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 1);
    assert_eq!(probe.shutdown_calls.load(AtomicOrdering::SeqCst), 1);
    // … and the rollback was recorded: the phase is back to `Idle`, not stuck `Starting`.
    assert!(registry.lock_state().phase == LifecyclePhase::Idle);

    // The registry stays restartable: a fresh cycle claims and runs the start again.
    assert!(registry.activate());
    assert_eq!(probe.start_calls.load(AtomicOrdering::SeqCst), 2);
    assert!(probe.running.load(AtomicOrdering::SeqCst));
  }

  /// The only test touching the process-global registry (and, in combined builds, the global
  /// Tokio compatibility runtime): exercises the public `register_async_runtime` /
  /// `try_register_async_runtime` wiring end to end, then a full
  /// `start_async_runtime` / `shutdown_async_runtime` re-activation cycle.
  #[test]
  fn public_registration_flow_is_first_writer_wins() {
    let first_probe = Arc::new(BackendProbe::default());
    let second_probe = Arc::new(BackendProbe::default());

    register_async_runtime(MockRuntime::new(&first_probe));
    assert_eq!(first_probe.shutdown_calls.load(AtomicOrdering::SeqCst), 0);

    let error = try_register_async_runtime(MockRuntime::new(&second_probe))
      .expect_err("duplicate registration must error");
    assert_eq!(error.status, crate::Status::GenericFailure);
    assert_eq!(error.reason, DUPLICATE_RUNTIME_ERROR);
    // The rejected duplicate was retired through its own shutdown.
    assert_eq!(second_probe.shutdown_calls.load(AtomicOrdering::SeqCst), 1);

    // Combined builds: the Tokio compatibility helpers must survive a full environment
    // recreation cycle (shutdown + start) even though the custom backend owns the runtime
    // lifecycle — the drained built-in runtime has to be refilled on re-activation.
    #[cfg(all(
      feature = "tokio_rt",
      any(
        all(target_family = "wasm", tokio_unstable),
        not(target_family = "wasm")
      )
    ))]
    {
      start_async_runtime();
      assert_eq!(first_probe.start_calls.load(AtomicOrdering::SeqCst), 1);

      // A Tokio compatibility helper constructs the built-in runtime lazily, after the
      // custom backend was selected and started.
      let (first_tx, first_rx) = mpsc::channel();
      spawn(async move {
        first_tx.send(()).expect("deliver the first task signal");
      });
      first_rx
        .recv_timeout(HANG_PROTECTION)
        .expect("the first spawned task must run");

      // Last-env teardown: the backend shuts down and the lazily-created Tokio runtime is
      // drained as well.
      shutdown_async_runtime();
      assert_eq!(first_probe.shutdown_calls.load(AtomicOrdering::SeqCst), 1);

      // Environment recreation (worker restart, Electron renderer reload): re-activation
      // must refill the drained Tokio runtime, so the helpers keep working instead of
      // panicking on the empty slot forever.
      start_async_runtime();
      assert_eq!(first_probe.start_calls.load(AtomicOrdering::SeqCst), 2);

      let (second_tx, second_rx) = mpsc::channel();
      spawn(async move {
        second_tx.send(()).expect("deliver the second task signal");
      });
      second_rx
        .recv_timeout(HANG_PROTECTION)
        .expect("a spawn after re-activation must run instead of panicking");

      // Reproduced field failure: after an explicit shutdown drains both halves, the next
      // runtime-backed dispatch — NOT a new env registration — self-heals the idle custom
      // backend through `ensure_started`. The heal must restore the drained Tokio peer too,
      // or the very next Tokio compatibility helper call aborts on the empty slot
      // ("Access tokio runtime failed in within_runtime_if_available").
      shutdown_async_runtime();
      assert_eq!(first_probe.shutdown_calls.load(AtomicOrdering::SeqCst), 2);

      // Mimic the dispatch path (`execute_future_impl`): commit the selection, then
      // self-heal the backend before its first task of the new cycle.
      let backend = ASYNC_RUNTIME_REGISTRY
        .commit_selection(cfg!(feature = "tokio_rt"))
        .expect("custom backend must stay selected");
      ASYNC_RUNTIME_REGISTRY.ensure_started(backend);
      assert_eq!(first_probe.start_calls.load(AtomicOrdering::SeqCst), 3);

      // The healed state is coherent: the helper runs its closure inside a live Tokio
      // runtime context instead of panicking on the drained slot.
      assert!(within_runtime_if_available(|| {
        tokio::runtime::Handle::try_current().is_ok()
      }));
    }
  }
}
