use std::cell::Cell;
use std::marker::PhantomData;
use std::mem;
use std::os::raw::c_void;
use std::panic::UnwindSafe;
use std::ptr;
use std::rc::Rc;

use crate::bindgen_runtime::JsObjectValue;
use crate::{
  bindgen_runtime::{PromiseRaw, ToNapiValue},
  check_status, sys, Env, Error, JsError, Result, ScopedTask, Status,
};

struct AsyncWork<'task, T: ScopedTask<'task>> {
  inner_task: T,
  deferred: sys::napi_deferred,
  value: mem::MaybeUninit<Result<T::Output>>,
  napi_async_work: sys::napi_async_work,
  status: Rc<Cell<u8>>,
}

pub struct AsyncWorkPromise<T> {
  pub(crate) napi_async_work: sys::napi_async_work,
  raw_promise: sys::napi_value,
  env: sys::napi_env,
  /// share with AsyncWork
  /// 0: not started
  /// 1: completed
  /// 2: canceled
  pub(crate) status: Rc<Cell<u8>>,
  _phantom: PhantomData<T>,
}

impl<T> UnwindSafe for AsyncWorkPromise<T> {}
impl<T> std::panic::RefUnwindSafe for AsyncWorkPromise<T> {}

/// The `napi_async_work` this addon has queued and whose completion callback has not run yet,
/// as `(napi_env, napi_async_work)` addresses.
///
/// On wasm a loader disposes the binding by destroying the emnapi context and terminating the
/// pool threads. Neither can run a completion callback, so a work still outstanding at that
/// point never settles its promise — and it also never balances the emnapi waiting-request
/// counter, which brackets every queued work. On Node a nonzero counter keeps a
/// `MessageChannel` port referenced, so the process cannot exit either.
///
/// Nothing observable from JavaScript can stand in for this registry. The threadless archive
/// (`emnapi-basic-napi-rs`) resolves `napi_*_async_work` through the `@emnapi/core` JavaScript
/// plugins, but the threaded one (`emnapi-napi-rs-mt`) links the C `async_work.c` backed by the
/// uv threadpool — see `emnapi_link_library` in `crates/build/src/wasi.rs` — so there the wasm
/// neither imports nor exports those symbols, and the only brackets a loader could see
/// (`_emnapi_ctx_*_waiting_request_counter`) are shared with threadsafe functions. This crate is
/// the one choke point both flavors go through.
///
/// Exported to the loader as [`napi_wasm_async_work_pending`] and
/// [`napi_wasm_cancel_pending_async_work`], the async-work half of the
/// `napi_wasm_env_cleanup_pending` handshake.
///
/// A `Mutex` rather than a thread local: queueing and completing both happen on the JavaScript
/// thread, but the registry is process-wide and this keeps it sound without depending on that.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
static OUTSTANDING_ASYNC_WORK: std::sync::Mutex<Vec<(usize, usize)>> =
  std::sync::Mutex::new(Vec::new());

/// A lock this addon poisoned is not worth aborting a teardown over: the registry only ever
/// makes disposal wait *longer*, so a failure to read it degrades to today's behavior.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
fn register_outstanding_async_work(env: sys::napi_env, work: sys::napi_async_work) {
  if let Ok(mut outstanding) = OUTSTANDING_ASYNC_WORK.lock() {
    outstanding.push((env as usize, work as usize));
  }
}

/// Keeps a work registered for as long as its completion callback is running, and unregisters
/// it however that callback leaves — including through one of its several `?` paths.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
struct OutstandingAsyncWorkGuard(sys::napi_async_work);

#[cfg(all(target_family = "wasm", not(feature = "noop")))]
impl Drop for OutstandingAsyncWorkGuard {
  fn drop(&mut self) {
    unregister_outstanding_async_work(self.0);
  }
}

#[cfg(all(target_family = "wasm", not(feature = "noop")))]
fn unregister_outstanding_async_work(work: sys::napi_async_work) {
  if let Ok(mut outstanding) = OUTSTANDING_ASYNC_WORK.lock() {
    let handle = work as usize;
    if let Some(index) = outstanding.iter().position(|(_, queued)| *queued == handle) {
      outstanding.swap_remove(index);
    }
  }
}

/// How many `napi_async_work` are queued and have not completed yet.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn pending_async_work() -> u32 {
  OUTSTANDING_ASYNC_WORK
    .lock()
    .map(|outstanding| outstanding.len() as u32)
    .unwrap_or(0)
}

/// Cancels every outstanding `napi_async_work`, returning how many cancellations were accepted.
///
/// `napi_cancel_async_work` succeeds only for a work no thread has started. The completion
/// callback then runs with `napi_cancelled`, which [`complete_impl`] turns into an `AbortError`
/// rejection — so a cancelled work leaves this registry and balances the waiting-request counter
/// through exactly the same path an ordinary completion does. A refused cancellation means the
/// work is already executing; it is left alone to finish normally, which it can, because the
/// loader calls this *before* terminating anything.
#[cfg(all(target_family = "wasm", not(feature = "noop")))]
pub(crate) fn cancel_pending_async_work() -> u32 {
  // Snapshot and release: cancelling is the host's call, and holding the registry lock across
  // it would deadlock the moment a host delivered the cancelled completion synchronously.
  let Ok(outstanding) = OUTSTANDING_ASYNC_WORK.lock().map(|guard| guard.clone()) else {
    return 0;
  };
  let mut cancelled = 0;
  for (env, work) in outstanding {
    // SAFETY: both addresses were handed to us by `napi_create_async_work` / the `napi_env` it
    // was created with, and an entry is removed from the registry by `complete_impl` before
    // `napi_delete_async_work` frees the work — so a registered handle is always still live.
    if unsafe { sys::napi_cancel_async_work(env as sys::napi_env, work as sys::napi_async_work) }
      == sys::Status::napi_ok
    {
      cancelled += 1;
    }
  }
  cancelled
}

impl<T> AsyncWorkPromise<T> {
  pub fn promise_object<'env>(&self) -> PromiseRaw<'env, T> {
    PromiseRaw::new(self.env, self.raw_promise)
  }

  pub fn cancel(&mut self) -> Result<()> {
    // The complete callback frees the `napi_async_work` handle once it has run;
    // after that there is nothing left to cancel and `napi_cancel_async_work`
    // would touch freed memory.
    if self.status.get() == 1 {
      return Ok(());
    }
    // must be happened in the main thread, relaxed is enough
    self.status.set(2);
    check_status!(
      unsafe { sys::napi_cancel_async_work(self.env, self.napi_async_work) },
      "Cancel async work failed"
    )
  }
}

pub fn run<'task, T: ScopedTask<'task>>(
  env: sys::napi_env,
  task: T,
  abort_status: Option<Rc<Cell<u8>>>,
) -> Result<AsyncWorkPromise<T::JsValue>> {
  let mut undefined = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_get_undefined(env, &mut undefined) },
    "Get undefined failed in async_work::run"
  )?;
  let mut raw_promise = ptr::null_mut();
  let mut deferred = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_promise(env, &mut deferred, &mut raw_promise) },
    "Create promise failed in async_work::run"
  )?;
  let task_status = abort_status.unwrap_or_else(|| Rc::new(Cell::new(0)));
  let result = Box::leak(Box::new(AsyncWork {
    inner_task: task,
    deferred,
    value: mem::MaybeUninit::uninit(),
    napi_async_work: ptr::null_mut(),
    status: task_status.clone(),
  }));
  check_status!(
    unsafe {
      sys::napi_create_async_work(
        env,
        raw_promise,
        undefined,
        Some(execute::<T>),
        Some(complete::<T>),
        (result as *mut AsyncWork<T>).cast(),
        &mut result.napi_async_work,
      )
    },
    "Create async work failed in async_work::run"
  )?;
  check_status!(
    unsafe { sys::napi_queue_async_work(env, result.napi_async_work) },
    "Queue async work failed in async_work::run"
  )?;
  // Only a queue that succeeded holds a waiting-request reference for a teardown to balance.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  register_outstanding_async_work(env, result.napi_async_work);
  Ok(AsyncWorkPromise {
    napi_async_work: result.napi_async_work,
    raw_promise,
    env,
    status: task_status,
    _phantom: PhantomData,
  })
}

unsafe impl<'task, T: ScopedTask<'task> + Send> Send for AsyncWork<'task, T> {}
unsafe impl<'task, T: ScopedTask<'task> + Sync> Sync for AsyncWork<'task, T> {}

/// env here is the same with the one in `CallContext`.
/// So it actually could do nothing here, because `execute` function is called in the other thread mostly.
unsafe extern "C" fn execute<'task, T: ScopedTask<'task>>(_env: sys::napi_env, data: *mut c_void) {
  let work = Box::leak(unsafe { Box::from_raw(data as *mut AsyncWork<T>) });
  let value = work.inner_task.compute();
  work.value.write(value);
}

unsafe extern "C" fn complete<'task, T: ScopedTask<'task>>(
  env: sys::napi_env,
  status: sys::napi_status,
  data: *mut c_void,
) {
  if let Err(e) = complete_impl::<T>(env, status, data) {
    let js_err = JsError::from(e);
    unsafe { js_err.throw_into(env) };
  }
}

/// Checks the status of `napi_resolve_deferred`/`napi_reject_deferred`,
/// reporting whether the deferred was actually settled.
///
/// Both refuse to run JavaScript once the environment starts tearing down —
/// Worker exit can outlive a queued completion callback (#3535) — reporting
/// `napi_pending_exception` for module API < 10 or `napi_cannot_run_js` for
/// API >= 10. The deferred is already dead in that state, so those statuses
/// settle as a no-op instead of propagating: handing them to `throw_into` would
/// fail the same way, and its debug assertion would abort the process.
fn check_settle_status(status: sys::napi_status, message: &str) -> Result<bool> {
  match status {
    sys::Status::napi_ok => Ok(true),
    sys::Status::napi_pending_exception | sys::Status::napi_cannot_run_js => Ok(false),
    _ => Err(Error::new(Status::from(status), message.to_owned())),
  }
}

/// The JavaScript-facing half of [`complete_impl`]: settle the deferred and
/// hand the task's output or error back to it.
///
/// Returns whether settlement ran its course. `Ok(false)` means the
/// environment refused every attempt — teardown — so the deferred was left
/// alone; callers then skip `finally` just as they do after a settlement
/// error, because there is no JavaScript left for it to run against.
fn settle<'task, T: ScopedTask<'task>>(
  env: sys::napi_env,
  status: sys::napi_status,
  work: &mut AsyncWork<'task, T>,
  deferred: sys::napi_deferred,
) -> Result<bool> {
  if status == sys::Status::napi_cancelled {
    const ABORT_ERROR_NAME: &str = "AbortError";
    let wrapped_env = Env::from_raw(env);
    let mut error =
      wrapped_env.create_error(Error::new(Status::Cancelled, ABORT_ERROR_NAME.to_owned()))?;
    error.set_named_property("name", ABORT_ERROR_NAME)?;
    return check_settle_status(
      unsafe { sys::napi_reject_deferred(env, deferred, error.0.value) },
      "Reject AbortError failed",
    );
  }
  let value_ptr = unsafe { work.value.assume_init_read() };
  let value = match value_ptr {
    Ok(output) => work.inner_task.resolve(
      // SAFETY: `Env` is long lived
      unsafe { std::mem::transmute::<&Env, &'task Env>(&Env::from_raw(env)) },
      output,
    ),
    Err(e) => work.inner_task.reject(
      // SAFETY: `Env` is long lived
      unsafe { std::mem::transmute::<&Env, &'task Env>(&Env::from_raw(env)) },
      e,
    ),
  };
  if work.status.get() != 2 {
    return match check_status!(status)
      .and_then(move |_| value)
      .and_then(|v| unsafe { ToNapiValue::to_napi_value(env, v) })
    {
      Ok(v) => check_settle_status(
        unsafe { sys::napi_resolve_deferred(env, deferred, v) },
        "Resolve promise failed",
      ),
      Err(e) => {
        // `ToNapiValue for Error` hands the retained value back verbatim —
        // the completion callback runs on the owning env/thread, exactly
        // where the retained reference is restorable — and synthesizes a
        // fresh `Error` from `status`/`reason`/`cause` when there is nothing
        // to hand back (an error built on the libuv thread holds no
        // reference; one captured on a foreign env or thread fails the owner
        // gates in `referenced_value` and falls back to synthesis instead of
        // dereferencing a foreign reference). `JsError::into_value` cannot
        // be used here: it gates reuse on `napi_is_error`, so a task
        // rejecting with a retained primitive or plain object — same
        // contract as the deferred settlement path — would settle with a
        // synthesized `Error` instead of the captured value.
        let rejection = unsafe { ToNapiValue::to_napi_value(env, e) }?;
        check_settle_status(
          unsafe { sys::napi_reject_deferred(env, deferred, rejection) },
          "Reject promise failed",
        )
      }
    };
  }
  // The promise was cancelled through `AsyncWorkPromise`/`AbortSignal`: the
  // deferred is deliberately left alone, but settlement ran its course, so
  // `finally` still applies.
  Ok(true)
}

fn complete_impl<'task, T: ScopedTask<'task>>(
  env: sys::napi_env,
  status: sys::napi_status,
  data: *mut c_void,
) -> Result<()> {
  let mut work = unsafe { Box::from_raw(data as *mut AsyncWork<T>) };
  let napi_async_work = mem::replace(&mut work.napi_async_work, ptr::null_mut());
  // A work stops being outstanding when this callback *finishes*, not when it starts. Settling
  // the deferred and running the task's own `resolve`/`finally` can re-enter JavaScript — a
  // setter on the value being handed back, a threadsafe-function callback — and that JavaScript
  // can call `dispose()`. Unregistering up front would let such a disposal read zero and tear
  // the environment down from inside this frame, before the promise is settled and before
  // `finally` runs: the promise then hangs forever, which is the very thing the registry
  // exists to prevent.
  //
  // A guard rather than a call at the end, so the `?` paths below still unregister: an entry
  // left behind would make a drain wait for a work that already completed, and the drain has
  // no deadline. Dropped explicitly before `napi_delete_async_work` frees the handle, so a
  // cancel sweep can never be handed a dangling one.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  let outstanding_entry = OutstandingAsyncWorkGuard(napi_async_work);
  let deferred = mem::replace(&mut work.deferred, ptr::null_mut());
  let settle_result = settle::<T>(env, status, &mut work, deferred);
  // The handle is freed below no matter how settlement went, so the shared
  // status must read terminal on every path: `on_abort` and
  // `AsyncWorkPromise::cancel` only refrain from `napi_cancel_async_work` once
  // it reads 1, and a stale status would send them to freed memory.
  work.status.set(1);
  // `finally` runs only when settlement ran — an error or a dead env skips it,
  // same as before.
  let result = match settle_result {
    Ok(true) => work.inner_task.finally(Env::from_raw(env)),
    Ok(false) => Ok(()),
    Err(e) => Err(e),
  };
  // Everything that can re-enter JavaScript has run. Leave the registry before the handle is
  // freed below.
  #[cfg(all(target_family = "wasm", not(feature = "noop")))]
  drop(outstanding_entry);
  // `napi_delete_async_work` runs no JavaScript and stays legal on a torn-down
  // env, so the handle is freed on every path — an error above must not leak it.
  result.and(check_status!(
    unsafe { sys::napi_delete_async_work(env, napi_async_work) },
    "Delete async work failed"
  ))
}
