#![allow(clippy::single_component_path_imports)]

use std::marker::PhantomData;
use std::os::raw::c_void;
use std::ptr::{self, null_mut};
use std::sync::{
  self,
  atomic::{AtomicBool, AtomicPtr, Ordering},
  Arc, RwLock, RwLockWriteGuard,
};

use futures::channel::oneshot::channel;

use crate::{
  bindgen_runtime::{FromNapiValue, JsValuesTupleIntoVec, TypeName, Unknown, ValidateNapiValue},
  check_status, sys, Env, Error, JsError, Result, Status,
};

#[deprecated(since = "2.17.0", note = "Please use `ThreadsafeFunction` instead")]
pub type ThreadSafeCallContext<T> = ThreadsafeCallContext<T>;

/// ThreadSafeFunction Context object
/// the `value` is the value passed to `call` method
pub struct ThreadsafeCallContext<T: 'static> {
  pub env: Env,
  pub value: T,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThreadsafeFunctionCallMode {
  NonBlocking,
  Blocking,
}

impl From<ThreadsafeFunctionCallMode> for sys::napi_threadsafe_function_call_mode {
  fn from(value: ThreadsafeFunctionCallMode) -> Self {
    match value {
      ThreadsafeFunctionCallMode::Blocking => sys::ThreadsafeFunctionCallMode::blocking,
      ThreadsafeFunctionCallMode::NonBlocking => sys::ThreadsafeFunctionCallMode::nonblocking,
    }
  }
}

pub struct ThreadsafeFunctionHandle {
  raw: AtomicPtr<sys::napi_threadsafe_function__>,
  aborted: RwLock<bool>,
  referred: AtomicBool,
}

impl ThreadsafeFunctionHandle {
  /// create a Arc to hold the `ThreadsafeFunctionHandle`
  pub fn new(raw: sys::napi_threadsafe_function) -> Arc<Self> {
    // Every handle pins the addon image, at construction, on the env's thread,
    // while the environment unquestionably still owns the image. Construction
    // is the only point that covers every path: environment teardown finalizes
    // the threadsafe function first, which marks the handle aborted, and `Drop`
    // then takes its no-op branch — so a pin placed anywhere on the drop path
    // is skipped in exactly the worker-teardown case it exists for. This also
    // covers handles wrapped around a raw threadsafe function directly through
    // this public constructor, which never pass through `create_raw`. The pin
    // happens at most once per process; repeats are a single atomic load.
    #[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
    crate::bindgen_runtime::retain_current_module_for_unload_safety();

    Arc::new(Self {
      raw: AtomicPtr::new(raw),
      aborted: RwLock::new(false),
      referred: AtomicBool::new(true),
    })
  }

  /// Lock `aborted` with read access, call `f` with the value of `aborted`, then unlock it
  pub fn with_read_aborted<RT, F>(&self, f: F) -> RT
  where
    F: FnOnce(bool) -> RT,
  {
    let aborted_guard = self
      .aborted
      .read()
      .expect("Threadsafe Function aborted lock failed");
    f(*aborted_guard)
  }

  /// Lock `aborted` with write access, call `f` with the `RwLockWriteGuard`, then unlock it
  pub fn with_write_aborted<RT, F>(&self, f: F) -> RT
  where
    F: FnOnce(RwLockWriteGuard<bool>) -> RT,
  {
    let aborted_guard = self
      .aborted
      .write()
      .expect("Threadsafe Function aborted lock failed");
    f(aborted_guard)
  }

  #[allow(clippy::arc_with_non_send_sync)]
  pub fn null() -> Arc<Self> {
    Self::new(null_mut())
  }

  pub fn get_raw(&self) -> sys::napi_threadsafe_function {
    self.raw.load(Ordering::SeqCst)
  }

  pub fn set_raw(&self, raw: sys::napi_threadsafe_function) {
    self.raw.store(raw, Ordering::SeqCst)
  }
}

impl Drop for ThreadsafeFunctionHandle {
  fn drop(&mut self) {
    self.with_read_aborted(|aborted| {
      if !aborted {
        let raw = self.get_raw();
        // if ThreadsafeFunction::create failed, the raw will be null and we don't need to release it
        if !raw.is_null() {
          let release_status = unsafe {
            sys::napi_release_threadsafe_function(
              self.get_raw(),
              sys::ThreadsafeFunctionReleaseMode::release,
            )
          };
          if release_status != sys::Status::napi_ok {
            // This runs in a destructor, which can be reached from a Node
            // callback or from a thread being torn down, so panicking here
            // would unwind across an FFI boundary and abort the process. That
            // is exactly what a worker exit used to do: Node closes the
            // threadsafe function during environment teardown and reports
            // `napi_closing` to whichever handle drops afterwards.
            //
            // The release did not happen, so native code that can still reach
            // this threadsafe function may outlive the environment. The addon
            // image is already pinned — `ThreadsafeFunctionHandle::new` pins at
            // construction for every handle, including this one — so nothing
            // more is needed here; the failure is simply not asserted on.
          }
        }
      }
    })
  }
}

#[repr(u8)]
pub enum ThreadsafeFunctionCallVariant {
  Direct,
  WithCallback,
}

pub struct ThreadsafeFunctionCallJsBackData<T, Return = Unknown<'static>> {
  pub data: T,
  pub call_variant: ThreadsafeFunctionCallVariant,
  pub callback: Box<dyn FnOnce(Result<Return>, Env) -> Result<()>>,
}

/// Communicate with the addon's main thread by invoking a JavaScript function from other threads.
///
/// ## Example
/// An example of using `ThreadsafeFunction`:
///
/// ```rust
/// use std::thread;
/// use std::sync::Arc;
///
/// use napi::{
///     threadsafe_function::{
///         ThreadSafeCallContext, ThreadsafeFunctionCallMode, ThreadsafeFunctionReleaseMode,
///     },
/// };
/// use napi_derive::napi;
///
/// #[napi]
/// pub fn call_threadsafe_function(callback: Arc<ThreadsafeFunction<(u32, bool, String), ()>>) {
///   let tsfn_cloned = tsfn.clone();
///
///   thread::spawn(move || {
///       let output: Vec<u32> = vec![0, 1, 2, 3];
///       // It's okay to call a threadsafe function multiple times.
///       tsfn.call(Ok((1, false, "NAPI-RS".into())), ThreadsafeFunctionCallMode::Blocking);
///       tsfn.call(Ok((2, true, "NAPI-RS".into())), ThreadsafeFunctionCallMode::NonBlocking);
///   });
///
///   thread::spawn(move || {
///       tsfn_cloned.call((3, false, "NAPI-RS".into())), ThreadsafeFunctionCallMode::NonBlocking);
///   });
/// }
/// ```
pub struct ThreadsafeFunction<
  T: 'static,
  Return: 'static + FromNapiValue = Unknown<'static>,
  CallJsBackArgs: 'static + JsValuesTupleIntoVec = T,
  ErrorStatus: AsRef<str> + From<Status> = Status,
  const CalleeHandled: bool = true,
  const Weak: bool = false,
  const MaxQueueSize: usize = 0,
> {
  pub handle: Arc<ThreadsafeFunctionHandle>,
  _phantom: PhantomData<(T, CallJsBackArgs, Return, ErrorStatus)>,
}

unsafe impl<
    T: 'static,
    Return: FromNapiValue,
    CallJsBackArgs: 'static + JsValuesTupleIntoVec,
    ErrorStatus: AsRef<str> + From<Status>,
    const CalleeHandled: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  > Send
  for ThreadsafeFunction<
    T,
    Return,
    CallJsBackArgs,
    ErrorStatus,
    { CalleeHandled },
    { Weak },
    { MaxQueueSize },
  >
{
}

unsafe impl<
    T: 'static,
    Return: FromNapiValue,
    CallJsBackArgs: 'static + JsValuesTupleIntoVec,
    ErrorStatus: AsRef<str> + From<Status>,
    const CalleeHandled: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  > Sync
  for ThreadsafeFunction<
    T,
    Return,
    CallJsBackArgs,
    ErrorStatus,
    { CalleeHandled },
    { Weak },
    { MaxQueueSize },
  >
{
}

impl<
    T: 'static + JsValuesTupleIntoVec,
    Return: FromNapiValue,
    ErrorStatus: AsRef<str> + From<Status>,
    const CalleeHandled: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  > FromNapiValue
  for ThreadsafeFunction<T, Return, T, ErrorStatus, { CalleeHandled }, { Weak }, { MaxQueueSize }>
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Self::create(env, napi_val, |ctx| Ok(ctx.value))
  }
}

impl<
    T: 'static + JsValuesTupleIntoVec,
    Return: FromNapiValue,
    ErrorStatus: AsRef<str> + From<Status>,
    const CalleeHandled: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  > TypeName
  for ThreadsafeFunction<T, Return, T, ErrorStatus, { CalleeHandled }, { Weak }, { MaxQueueSize }>
{
  fn type_name() -> &'static str {
    "ThreadsafeFunction"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::Function
  }
}

impl<
    T: 'static + JsValuesTupleIntoVec,
    Return: FromNapiValue,
    ErrorStatus: AsRef<str> + From<Status>,
    const CalleeHandled: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  > ValidateNapiValue
  for ThreadsafeFunction<T, Return, T, ErrorStatus, { CalleeHandled }, { Weak }, { MaxQueueSize }>
{
}

/// Non-generic core of [`ThreadsafeFunction::create`].
///
/// All of the heavy FFI setup (async resource name creation, the
/// `napi_create_threadsafe_function` call, the weak-ref handling) is
/// type-independent, so it is extracted here to be emitted once instead of
/// being monomorphized for every `<T, Return, CallJsBackArgs, ...>`
/// combination. The only per-type parts — the boxed user callback and the two
/// `extern "C"` trampolines — are passed in as raw pointers / function
/// pointers by the generic `create` shell.
fn create_raw(
  env: sys::napi_env,
  func: sys::napi_value,
  max_queue_size: usize,
  weak: bool,
  callback_ptr: *mut c_void,
  thread_finalize_cb: sys::napi_finalize,
  call_js_cb: sys::napi_threadsafe_function_call_js,
) -> Result<Arc<ThreadsafeFunctionHandle>> {
  // A threadsafe function exists to be handed to a thread that is not the one
  // owning this environment, so from here on native code in this image is
  // reachable from a thread that can outlive the environment. The addon image
  // is pinned by `ThreadsafeFunctionHandle::new` (via `null()` below), so no
  // separate retention call is needed here.

  let mut async_resource_name = ptr::null_mut();
  static THREAD_SAFE_FUNCTION_ASYNC_RESOURCE_NAME: &str = "napi_rs_threadsafe_function";

  #[cfg(feature = "napi10")]
  {
    let mut copied = false;
    check_status!(
      unsafe {
        sys::node_api_create_external_string_latin1(
          env,
          THREAD_SAFE_FUNCTION_ASYNC_RESOURCE_NAME.as_ptr().cast(),
          27,
          None,
          ptr::null_mut(),
          &mut async_resource_name,
          &mut copied,
        )
      },
      "Create external string latin1 in ThreadsafeFunction::create failed"
    )?;
  }

  #[cfg(not(feature = "napi10"))]
  {
    check_status!(
      unsafe {
        sys::napi_create_string_utf8(
          env,
          THREAD_SAFE_FUNCTION_ASYNC_RESOURCE_NAME.as_ptr().cast(),
          27,
          &mut async_resource_name,
        )
      },
      "Create string utf8 in ThreadsafeFunction::create failed"
    )?;
  }

  let mut raw_tsfn = ptr::null_mut();
  let handle = ThreadsafeFunctionHandle::null();
  check_status!(
    unsafe {
      sys::napi_create_threadsafe_function(
        env,
        func,
        ptr::null_mut(),
        async_resource_name,
        max_queue_size,
        1,
        Arc::downgrade(&handle).into_raw().cast_mut().cast(), // pass handler to thread_finalize_cb
        thread_finalize_cb,
        callback_ptr,
        call_js_cb,
        &mut raw_tsfn,
      )
    },
    "Create threadsafe function in ThreadsafeFunction::create failed"
  )?;
  handle.set_raw(raw_tsfn);

  // Weak ThreadsafeFunction will not prevent the event loop from exiting
  if weak {
    check_status!(
      unsafe { sys::napi_unref_threadsafe_function(env, raw_tsfn) },
      "Unref threadsafe function failed in Weak mode"
    )?;
    // The tsfn is now unreferenced at the N-API level, so keep `referred` in
    // sync. Otherwise the deprecated `refer`/`unref` would read a stale `true`
    // and `refer` would skip its `napi_ref_threadsafe_function` call.
    handle.referred.store(false, Ordering::Relaxed);
  }

  Ok(handle)
}

impl<
    T: 'static,
    Return: FromNapiValue,
    CallJsBackArgs: 'static + JsValuesTupleIntoVec,
    ErrorStatus: AsRef<str> + From<Status>,
    const CalleeHandled: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  >
  ThreadsafeFunction<
    T,
    Return,
    CallJsBackArgs,
    ErrorStatus,
    { CalleeHandled },
    { Weak },
    { MaxQueueSize },
  >
{
  // See [napi_create_threadsafe_function](https://nodejs.org/api/n-api.html#n_api_napi_create_threadsafe_function)
  // for more information.
  pub(crate) fn create<
    NewArgs: 'static + JsValuesTupleIntoVec,
    R: 'static + FnMut(ThreadsafeCallContext<T>) -> Result<NewArgs>,
  >(
    env: sys::napi_env,
    func: sys::napi_value,
    callback: R,
  ) -> Result<
    ThreadsafeFunction<
      T,
      Return,
      NewArgs,
      ErrorStatus,
      { CalleeHandled },
      { Weak },
      { MaxQueueSize },
    >,
  > {
    let callback_ptr = Box::into_raw(Box::new(callback));
    // `napi_create_threadsafe_function` only takes ownership of `callback_ptr`
    // (registering `thread_finalize_cb` to reclaim it) once it succeeds. If
    // `create_raw` returns early on any FFI error, neither N-API nor Rust owns
    // the box, so reclaim it here to avoid leaking the callback.
    let handle = create_raw(
      env,
      func,
      MaxQueueSize,
      Weak,
      callback_ptr.cast(),
      Some(thread_finalize_cb::<T, NewArgs, R>),
      Some(call_js_cb::<T, Return, NewArgs, ErrorStatus, R, CalleeHandled>),
    )
    .inspect_err(|_| {
      drop(unsafe { Box::from_raw(callback_ptr) });
    })?;

    Ok(ThreadsafeFunction {
      handle,
      _phantom: PhantomData,
    })
  }

  #[deprecated(
    since = "2.17.0",
    note = "Please use `ThreadsafeFunction::clone` instead of manually increasing the reference count"
  )]
  /// See [napi_ref_threadsafe_function](https://nodejs.org/api/n-api.html#n_api_napi_ref_threadsafe_function)
  /// for more information.
  ///
  /// "ref" is a keyword so that we use "refer" here.
  pub fn refer(&mut self, env: &Env) -> Result<()> {
    self.handle.with_read_aborted(|aborted| {
      if !aborted && !self.handle.referred.load(Ordering::Relaxed) {
        check_status!(unsafe { sys::napi_ref_threadsafe_function(env.0, self.handle.get_raw()) })?;
        self.handle.referred.store(true, Ordering::Relaxed);
      }
      Ok(())
    })
  }

  #[deprecated(
    since = "2.17.0",
    note = "Please use `ThreadsafeFunction::clone` instead of manually decreasing the reference count"
  )]
  /// See [napi_unref_threadsafe_function](https://nodejs.org/api/n-api.html#n_api_napi_unref_threadsafe_function)
  /// for more information.
  pub fn unref(&mut self, env: &Env) -> Result<()> {
    self.handle.with_read_aborted(|aborted| {
      if !aborted && self.handle.referred.load(Ordering::Relaxed) {
        check_status!(unsafe {
          sys::napi_unref_threadsafe_function(env.0, self.handle.get_raw())
        })?;
        self.handle.referred.store(false, Ordering::Relaxed);
      }
      Ok(())
    })
  }

  pub fn aborted(&self) -> bool {
    self.handle.with_read_aborted(|aborted| aborted)
  }

  #[deprecated(
    since = "2.17.0",
    note = "Drop all references to the ThreadsafeFunction will automatically release it"
  )]
  pub fn abort(self) -> Result<()> {
    self.handle.with_write_aborted(|mut aborted_guard| {
      if !*aborted_guard {
        check_status!(unsafe {
          sys::napi_release_threadsafe_function(
            self.handle.get_raw(),
            sys::ThreadsafeFunctionReleaseMode::abort,
          )
        })?;
        *aborted_guard = true;
      }
      Ok(())
    })
  }

  /// Get the raw `ThreadSafeFunction` pointer
  pub fn raw(&self) -> sys::napi_threadsafe_function {
    self.handle.get_raw()
  }
}

impl<
    T: 'static,
    Return: FromNapiValue,
    CallJsBackArgs: 'static + JsValuesTupleIntoVec,
    ErrorStatus: AsRef<str> + From<Status>,
    const Weak: bool,
    const MaxQueueSize: usize,
  > ThreadsafeFunction<T, Return, CallJsBackArgs, ErrorStatus, true, { Weak }, { MaxQueueSize }>
{
  /// See [napi_call_threadsafe_function](https://nodejs.org/api/n-api.html#n_api_napi_call_threadsafe_function)
  /// for more information.
  pub fn call(&self, value: Result<T, ErrorStatus>, mode: ThreadsafeFunctionCallMode) -> Status {
    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Status::Closing;
      }

      unsafe {
        sys::napi_call_threadsafe_function(
          self.handle.get_raw(),
          Box::into_raw(Box::new(value.map(|data| {
            ThreadsafeFunctionCallJsBackData {
              data,
              call_variant: ThreadsafeFunctionCallVariant::Direct,
              callback: Box::new(|_d: Result<Return>, _| Ok(())),
            }
          })))
          .cast(),
          mode.into(),
        )
      }
      .into()
    })
  }

  /// Call the ThreadsafeFunction, and handle the return value with a callback
  pub fn call_with_return_value<F: 'static + FnOnce(Result<Return>, Env) -> Result<()>>(
    &self,
    value: Result<T, ErrorStatus>,
    mode: ThreadsafeFunctionCallMode,
    cb: F,
  ) -> Status {
    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Status::Closing;
      }

      unsafe {
        sys::napi_call_threadsafe_function(
          self.handle.get_raw(),
          Box::into_raw(Box::new(value.map(|data| {
            ThreadsafeFunctionCallJsBackData {
              data,
              call_variant: ThreadsafeFunctionCallVariant::WithCallback,
              callback: Box::new(move |d: Result<Return>, env: Env| cb(d, env)),
            }
          })))
          .cast(),
          mode.into(),
        )
      }
      .into()
    })
  }

  /// Call the ThreadsafeFunction, and handle the return value with in `async` way
  pub async fn call_async(&self, value: Result<T, ErrorStatus>) -> Result<Return> {
    let (sender, receiver) = channel::<Result<Return>>();

    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Err(crate::Error::from_status(Status::Closing));
      }

      check_status!(
        unsafe {
          sys::napi_call_threadsafe_function(
            self.handle.get_raw(),
            Box::into_raw(Box::new(value.map(|data| {
              ThreadsafeFunctionCallJsBackData {
                data,
                call_variant: ThreadsafeFunctionCallVariant::WithCallback,
                callback: Box::new(move |d: Result<Return>, _| {
                  sender
                    .send(d)
                    // The only reason for send to return Err is if the receiver isn't listening
                    // Not hiding the error would result in a napi_fatal_error call, it's safe to ignore it instead.
                    .or(Ok(()))
                }),
              }
            })))
            .cast(),
            ThreadsafeFunctionCallMode::NonBlocking.into(),
          )
        },
        "Threadsafe function call_async failed"
      )
    })?;
    receiver.await.map_err(|_| {
      crate::Error::new(
        Status::GenericFailure,
        "Receive value from threadsafe function sender failed",
      )
    })?
  }

  /// Call the ThreadsafeFunction the same way `call_async` does, with explicit
  /// "catch the JavaScript throw" semantics.
  ///
  /// Provided so callers can use the same method name regardless of the `CalleeHandled` value.
  pub async fn call_async_catch(&self, value: Result<T, ErrorStatus>) -> Result<Return> {
    self.call_async(value).await
  }
}

impl<
    T: 'static,
    Return: FromNapiValue,
    CallJsBackArgs: 'static + JsValuesTupleIntoVec,
    ErrorStatus: AsRef<str> + From<Status>,
    const Weak: bool,
    const MaxQueueSize: usize,
  > ThreadsafeFunction<T, Return, CallJsBackArgs, ErrorStatus, false, { Weak }, { MaxQueueSize }>
{
  /// See [napi_call_threadsafe_function](https://nodejs.org/api/n-api.html#n_api_napi_call_threadsafe_function)
  /// for more information.
  pub fn call(&self, value: T, mode: ThreadsafeFunctionCallMode) -> Status {
    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Status::Closing;
      }

      unsafe {
        sys::napi_call_threadsafe_function(
          self.handle.get_raw(),
          Box::into_raw(Box::new(ThreadsafeFunctionCallJsBackData {
            data: value,
            call_variant: ThreadsafeFunctionCallVariant::Direct,
            callback: Box::new(|_d: Result<Return>, _: Env| Ok(())),
          }))
          .cast(),
          mode.into(),
        )
      }
      .into()
    })
  }

  /// Call the ThreadsafeFunction, and handle the return value with a callback
  pub fn call_with_return_value<F: 'static + FnOnce(Result<Return>, Env) -> Result<()>>(
    &self,
    value: T,
    mode: ThreadsafeFunctionCallMode,
    cb: F,
  ) -> Status {
    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Status::Closing;
      }

      unsafe {
        sys::napi_call_threadsafe_function(
          self.handle.get_raw(),
          Box::into_raw(Box::new(ThreadsafeFunctionCallJsBackData {
            data: value,
            call_variant: ThreadsafeFunctionCallVariant::WithCallback,
            callback: Box::new(cb),
          }))
          .cast(),
          mode.into(),
        )
      }
      .into()
    })
  }

  /// Call the ThreadsafeFunction in an `async` way and return the JavaScript
  /// callback's resolved value.
  ///
  /// **Warning:** if the JavaScript callback throws, this method will route
  /// the captured exception through `napi_fatal_exception`, which terminates
  /// the host process. Use [`call_async_catch`](Self::call_async_catch)
  /// if you need to handle JavaScript-thrown errors as `Err(napi::Error)`.
  pub async fn call_async(&self, value: T) -> Result<Return> {
    let (sender, receiver) = channel::<Return>();

    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Err(crate::Error::from_status(Status::Closing));
      }

      check_status!(unsafe {
        sys::napi_call_threadsafe_function(
          self.handle.get_raw(),
          Box::into_raw(Box::new(ThreadsafeFunctionCallJsBackData {
            data: value,
            call_variant: ThreadsafeFunctionCallVariant::WithCallback,
            callback: Box::new(move |d, _| {
              d.and_then(|d| {
                sender
                  .send(d)
                  // The only reason for send to return Err is if the receiver isn't listening
                  // Not hiding the error would result in a napi_fatal_error call, it's safe to ignore it instead.
                  .or(Ok(()))
              })
            }),
          }))
          .cast(),
          ThreadsafeFunctionCallMode::NonBlocking.into(),
        )
      })
    })?;

    receiver
      .await
      .map_err(|err| crate::Error::new(Status::GenericFailure, format!("{err}")))
  }

  /// Call the ThreadsafeFunction in an `async` way and catch JavaScript-thrown
  /// errors as `Err(napi::Error)` instead of crashing the host process.
  ///
  /// The returned `Err` carries `status == Status::PendingException` when it
  /// originated from a JS throw. The original JS exception object is preserved
  /// via `error.maybe_raw` (a `napi_ref`); callers that need to inspect the
  /// typed JS value can recover it via:
  ///
  /// ```ignore
  /// let js_value: Unknown = JsError::from(err).into_unknown(env);
  /// ```
  pub async fn call_async_catch(&self, value: T) -> Result<Return> {
    let (sender, receiver) = channel::<Result<Return>>();

    self.handle.with_read_aborted(|aborted| {
      if aborted {
        return Err(crate::Error::from_status(Status::Closing));
      }

      check_status!(
        unsafe {
          sys::napi_call_threadsafe_function(
            self.handle.get_raw(),
            Box::into_raw(Box::new(ThreadsafeFunctionCallJsBackData {
              data: value,
              call_variant: ThreadsafeFunctionCallVariant::WithCallback,
              callback: Box::new(move |d: Result<Return>, _| {
                sender
                  .send(d)
                  // The only reason for send to return Err is if the receiver isn't listening
                  // Not hiding the error would result in a napi_fatal_error call, it's safe to ignore it instead.
                  .or(Ok(()))
              }),
            }))
            .cast(),
            ThreadsafeFunctionCallMode::NonBlocking.into(),
          )
        },
        "Threadsafe function call_async_catch failed"
      )
    })?;
    receiver.await.map_err(|_| {
      crate::Error::new(
        Status::GenericFailure,
        "Receive value from threadsafe function sender failed",
      )
    })?
  }
}

unsafe extern "C" fn thread_finalize_cb<T: 'static, V: 'static + JsValuesTupleIntoVec, R>(
  #[allow(unused_variables)] env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) where
  R: 'static + FnMut(ThreadsafeCallContext<T>) -> Result<V>,
{
  let handle_option: Option<Arc<ThreadsafeFunctionHandle>> =
    unsafe { sync::Weak::from_raw(finalize_data.cast()).upgrade() };

  if let Some(handle) = handle_option {
    handle.with_write_aborted(|mut aborted_guard| {
      if !*aborted_guard {
        *aborted_guard = true;
      }
    });
  }

  // cleanup
  drop(unsafe { Box::<R>::from_raw(finalize_hint.cast()) });
}

/// Non-generic core of [`call_js_cb`].
///
/// Calling the JavaScript function, following Node's error-first callback
/// convention and capturing a pending exception do not depend on the concrete
/// threadsafe-function argument or return types. Keep that work out of the
/// generic trampoline so addons with many callback signatures only emit it
/// once.
#[inline(never)]
fn call_js_cb_raw(
  raw_env: sys::napi_env,
  js_callback: sys::napi_value,
  recv: sys::napi_value,
  call: std::result::Result<(Vec<sys::napi_value>, bool), sys::napi_value>,
  callee_handled: bool,
) -> (sys::napi_status, Option<Result<sys::napi_value>>) {
  // Follow async callback conventions: https://nodejs.org/en/knowledge/errors/what-are-the-error-conventions/
  // Check if the Result is okay, if so, pass a null as the first (error) argument automatically.
  // If the Result is an error, pass that as the first argument.
  match call {
    Ok((values, with_callback)) => {
      let args: Vec<sys::napi_value> = if callee_handled {
        let mut js_null = ptr::null_mut();
        unsafe { sys::napi_get_null(raw_env, &mut js_null) };
        core::iter::once(js_null).chain(values).collect()
      } else {
        values
      };
      let mut return_value = ptr::null_mut();
      let mut status = unsafe {
        sys::napi_call_function(
          raw_env,
          recv,
          js_callback,
          args.len(),
          args.as_ptr(),
          &mut return_value,
        )
      };
      let callback_arg = with_callback.then(|| {
        if status == sys::Status::napi_pending_exception {
          let mut exception = ptr::null_mut();
          unsafe { sys::napi_get_and_clear_last_exception(raw_env, &mut exception) };
          let raw_status = status;
          // The exception has been taken out of the env and is about to be handed
          // to the Rust callback, so it is handled from Node's point of view.
          status = sys::Status::napi_ok;

          // JavaScript can throw *anything*, so capture the exception the same
          // way a promise rejection is captured. The previous code did two things
          // that broke on a non-`Error`:
          //
          // * `napi_create_reference` rejects every non-object below Node-API 10
          //   — and a module without `node_api_module_get_api_version_v1` is
          //   version 8 — so `throw 'oops'` lost the thrown value outright.
          // * building `reason` from `napi_coerce_to_string` plus a `[[Get]]` of
          //   `stack` runs `toString`/`Symbol.toPrimitive` and V8's lazy stack
          //   formatter while the error is unwinding, and *throws* on a symbol,
          //   leaving that second exception pending in an env Node has already
          //   been told is clean.
          //
          // `from_unknown_without_coercion` does neither: the value is retained
          // behind a private holder object every type can be referenced through,
          // and `reason`/`cause` are read as data properties only.
          //
          // The cost is that `reason` no longer carries the stack trace: `stack`
          // is an own *accessor* on every V8 error, so there is no way to read it
          // without running a getter. JavaScript is unaffected — it now receives
          // the original exception object, stack and all.
          //
          // `call_js_cb_raw` runs on the env's JS thread, so the `ErrorRef` inside
          // captures the owning env, its thread and its custom-GC handle; the
          // returned `Error` is then free to travel to the caller's thread, where
          // the reference reads as absent and the release is routed back here
          // (#2975, #3369).
          //
          // SAFETY: `raw_env` and `exception` are valid pointers obtained from
          // `napi_get_and_clear_last_exception` above, which guarantees they are
          // non-null and live for the duration of this callback.
          let mut error = Error::from_unknown_without_coercion(unsafe {
            Unknown::from_raw_unchecked(raw_env, exception)
          });
          // Keep reporting *why* the callback failed. `call_async_catch` callers
          // branch on `PendingException` to tell a JS throw apart from a Rust
          // error, so the status has to survive the capture.
          error.status = Status::from(raw_status);
          Err(error)
        } else {
          Ok(return_value)
        }
      });
      (status, callback_arg)
    }
    Err(error_value) if !callee_handled => (
      unsafe { sys::napi_fatal_exception(raw_env, error_value) },
      None,
    ),
    Err(error_value) => (
      unsafe {
        sys::napi_call_function(
          raw_env,
          recv,
          js_callback,
          1,
          [error_value].as_mut_ptr(),
          ptr::null_mut(),
        )
      },
      None,
    ),
  }
}

unsafe extern "C" fn call_js_cb<
  T: 'static,
  Return: FromNapiValue,
  V: 'static + JsValuesTupleIntoVec,
  ErrorStatus: AsRef<str> + From<Status>,
  R,
  const CalleeHandled: bool,
>(
  raw_env: sys::napi_env,
  js_callback: sys::napi_value,
  context: *mut c_void,
  data: *mut c_void,
) where
  R: 'static + FnMut(ThreadsafeCallContext<T>) -> Result<V>,
{
  // env and/or callback can be null when shutting down
  if raw_env.is_null() || js_callback.is_null() {
    return;
  }

  let callback: &mut R = unsafe { Box::leak(Box::from_raw(context.cast())) };
  let val = unsafe {
    if CalleeHandled {
      *Box::<Result<ThreadsafeFunctionCallJsBackData<T, Return>, ErrorStatus>>::from_raw(
        data.cast(),
      )
    } else {
      Ok(*Box::<ThreadsafeFunctionCallJsBackData<T, Return>>::from_raw(data.cast()))
    }
  };

  let mut recv = ptr::null_mut();
  unsafe { sys::napi_get_undefined(raw_env, &mut recv) };

  let ret = val.and_then(|v| {
    (callback)(ThreadsafeCallContext {
      env: Env::from_raw(raw_env),
      value: v.data,
    })
    .and_then(|ret| {
      Ok((
        ret.into_vec(raw_env)?,
        matches!(v.call_variant, ThreadsafeFunctionCallVariant::WithCallback),
        v.callback,
      ))
    })
    .map_err(|err| Error::new(err.status.into(), err.reason.clone()))
  });

  let (call, callback) = match ret {
    Ok((values, with_callback, callback)) => (Ok((values, with_callback)), Some(callback)),
    Err(error) => (
      Err(unsafe { JsError::from(error).into_value(raw_env) }),
      None,
    ),
  };
  let (status, callback_arg) = call_js_cb_raw(raw_env, js_callback, recv, call, CalleeHandled);
  if let (Some(callback_arg), Some(callback)) = (callback_arg, callback) {
    let callback_arg = callback_arg
      .and_then(|return_value| unsafe { Return::from_napi_value(raw_env, return_value) });
    if let Err(err) = callback(callback_arg, Env::from_raw(raw_env)) {
      unsafe { sys::napi_fatal_exception(raw_env, JsError::from(err).into_value(raw_env)) };
    }
  }
  handle_call_js_cb_status(status, raw_env)
}

fn handle_call_js_cb_status(status: sys::napi_status, raw_env: sys::napi_env) {
  if status == sys::Status::napi_ok {
    return;
  }
  if status == sys::Status::napi_pending_exception {
    let mut error_result = ptr::null_mut();
    assert_eq!(
      unsafe { sys::napi_get_and_clear_last_exception(raw_env, &mut error_result) },
      sys::Status::napi_ok
    );

    // When shutting down, napi_fatal_exception sometimes returns another exception
    let stat = unsafe { sys::napi_fatal_exception(raw_env, error_result) };
    assert!(
      stat == sys::Status::napi_ok
        || stat == sys::Status::napi_pending_exception
        || stat == sys::Status::napi_cannot_run_js
    );
  } else {
    // During environment shutdown (e.g. Ctrl+C in a worker thread), any NAPI call
    // can fail. Bail out gracefully instead of panicking if we can't construct the
    // error object — there's nothing useful we can do in a half-torn-down env.
    let error_code: Status = status.into();
    let mut error_code_value = ptr::null_mut();
    if unsafe {
      sys::napi_create_string_utf8(
        raw_env,
        error_code.as_ref().as_ptr().cast(),
        error_code.as_ref().len() as isize,
        &mut error_code_value,
      )
    } != sys::Status::napi_ok
    {
      return;
    }
    const ERROR_MSG: &str = "Call JavaScript callback failed in threadsafe function";
    let mut error_msg_value = ptr::null_mut();
    if unsafe {
      sys::napi_create_string_utf8(
        raw_env,
        ERROR_MSG.as_ptr().cast(),
        ERROR_MSG.len() as isize,
        &mut error_msg_value,
      )
    } != sys::Status::napi_ok
    {
      return;
    }
    let mut error_value = ptr::null_mut();
    if unsafe {
      sys::napi_create_error(raw_env, error_code_value, error_msg_value, &mut error_value)
    } != sys::Status::napi_ok
    {
      return;
    }
    // When shutting down, napi_fatal_exception sometimes returns another exception
    let stat = unsafe { sys::napi_fatal_exception(raw_env, error_value) };
    assert!(
      stat == sys::Status::napi_ok
        || stat == sys::Status::napi_pending_exception
        || stat == sys::Status::napi_cannot_run_js
    );
  }
}

/// This is a placeholder type that is used to indicate that the return value of a threadsafe function is unknown.
/// Use this type when you don't care about the return value of a threadsafe function.
///
/// And you can't get the value of it as well because it's just a placeholder.
pub struct UnknownReturnValue;

impl TypeName for UnknownReturnValue {
  fn type_name() -> &'static str {
    "UnknownReturnValue"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::Unknown
  }
}

impl ValidateNapiValue for UnknownReturnValue {}

impl FromNapiValue for UnknownReturnValue {
  unsafe fn from_napi_value(_env: sys::napi_env, _napi_val: sys::napi_value) -> Result<Self> {
    Ok(UnknownReturnValue)
  }
}
