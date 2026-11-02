use std::{
  ffi::c_void,
  marker::PhantomData,
  mem,
  pin::Pin,
  ptr,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
  },
  task::{Context, Poll, Waker},
};

use tokio::sync::Mutex;

use futures_core::Stream;
use tokio_stream::StreamExt;

use crate::{
  bindgen_prelude::{
    BufferSlice, CallbackContext, FromNapiValue, Function, JsObjectValue, Object, PromiseRaw,
    ToNapiValue, TypeName, Unknown, ValidateNapiValue, NAPI_AUTO_LENGTH,
  },
  check_status, sys,
  threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
  Env, Error, JsError, JsValue, Result, Status, Value, ValueType,
};

pub struct ReadableStream<'env, T> {
  pub(crate) value: sys::napi_value,
  pub(crate) env: sys::napi_env,
  _marker: PhantomData<&'env T>,
}

impl<'env, T> JsValue<'env> for ReadableStream<'env, T> {
  fn value(&self) -> Value {
    Value {
      env: self.env,
      value: self.value,
      value_type: ValueType::Object,
    }
  }
}

impl<'env, T> JsObjectValue<'env> for ReadableStream<'env, T> {}

impl<T> TypeName for ReadableStream<'_, T> {
  fn type_name() -> &'static str {
    "ReadableStream"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<T> ValidateNapiValue for ReadableStream<'_, T> {
  unsafe fn validate(
    env: napi_sys::napi_env,
    napi_val: napi_sys::napi_value,
  ) -> Result<napi_sys::napi_value> {
    let constructor = Env::from(env)
      .get_global()?
      .get_named_property_unchecked::<Function>("ReadableStream")?;
    let mut is_instance = false;
    check_status!(
      unsafe { sys::napi_instanceof(env, napi_val, constructor.value, &mut is_instance) },
      "Check ReadableStream instance failed"
    )?;
    if !is_instance {
      return Err(Error::new(
        Status::InvalidArg,
        "Value is not a ReadableStream",
      ));
    }
    Ok(ptr::null_mut())
  }
}

impl<T> FromNapiValue for ReadableStream<'_, T> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self {
      value: napi_val,
      env,
      _marker: PhantomData,
    })
  }
}

impl<T> ReadableStream<'_, T> {
  /// Returns a boolean indicating whether the readable stream is locked to a reader.
  pub fn locked(&self) -> Result<bool> {
    let mut locked = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(self.env, self.value, c"locked".as_ptr().cast(), &mut locked)
      },
      "Get locked property failed"
    )?;
    unsafe { FromNapiValue::from_napi_value(self.env, locked) }
  }

  /// The `cancel()` method of the `ReadableStream` interface returns a Promise that resolves when the stream is canceled.
  pub fn cancel(&mut self, reason: Option<String>) -> Result<PromiseRaw<'_, ()>> {
    let mut cancel_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          self.value,
          c"abort".as_ptr().cast(),
          &mut cancel_fn,
        )
      },
      "Get abort property failed"
    )?;
    let reason_value = unsafe { ToNapiValue::to_napi_value(self.env, reason)? };
    let mut promise = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_call_function(
          self.env,
          self.value,
          cancel_fn,
          1,
          [reason_value].as_ptr(),
          &mut promise,
        )
      },
      "Call abort function failed"
    )?;
    Ok(PromiseRaw::new(self.env, promise))
  }
}

impl<T: FromNapiValue> ReadableStream<'_, T> {
  pub fn read(&self) -> Result<Reader<T>> {
    let mut reader_function = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          self.value,
          c"getReader".as_ptr().cast(),
          &mut reader_function,
        )
      },
      "Get getReader on ReadableStream failed"
    )?;
    let mut reader = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_call_function(
          self.env,
          self.value,
          reader_function,
          0,
          ptr::null_mut(),
          &mut reader,
        )
      },
      "Call getReader on ReadableStreamReader failed"
    )?;
    let mut read_function = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          reader,
          c"read".as_ptr().cast(),
          &mut read_function,
        )
      },
      "Get read from ReadableStreamDefaultReader failed"
    )?;
    let mut bind_function = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          read_function,
          c"bind".as_ptr().cast(),
          &mut bind_function,
        )
      },
      "Get bind from ReadableStreamDefaultReader::read failed"
    )?;
    let mut bind_read = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_call_function(
          self.env,
          read_function,
          bind_function,
          1,
          [reader].as_ptr(),
          &mut bind_read,
        )
      },
      "Call bind from ReadableStreamDefaultReader::read failed"
    )?;
    let read_function = unsafe {
      Function::<(), PromiseRaw<IteratorValue<T>>>::from_napi_value(self.env, bind_read)?
    }
    .build_threadsafe_function()
    .callee_handled::<true>()
    .weak::<true>()
    .build()?;
    Ok(Reader {
      inner: read_function,
      state: Arc::new(ReaderState {
        inner: std::sync::Mutex::new(ReaderInner {
          chunk: Ok(None),
          done: false,
          reading: false,
          waker: None,
        }),
      }),
    })
  }
}

impl<T: ToNapiValue + Send + 'static> ReadableStream<'_, T> {
  pub fn new<S: Stream<Item = Result<T>> + Unpin + Send + 'static>(
    env: &Env,
    inner: S,
  ) -> Result<Self> {
    let global = env.get_global()?;
    let constructor = global.get_named_property_unchecked::<Unknown>("ReadableStream")?;
    if constructor.get_type()? == ValueType::Undefined {
      return Err(Error::new(
        Status::GenericFailure,
        "ReadableStream is not supported in this Node.js version",
      ));
    }

    // Create shared state for the stream
    let state = StreamState::new(inner);
    let state_ptr = Arc::into_raw(state) as *mut c_void;

    let mut underlying_source = Object::new(env)?;

    // Create pull callback
    let mut pull_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"pull".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(pull_callback::<T, S>),
          state_ptr,
          &mut pull_fn,
        )
      },
      "Failed to create pull function"
    )?;
    underlying_source.set_named_property("pull", pull_fn)?;

    // Create cancel callback for cleanup
    let mut cancel_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"cancel".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(cancel_callback::<S>),
          state_ptr,
          &mut cancel_fn,
        )
      },
      "Failed to create cancel function"
    )?;
    underlying_source.set_named_property("cancel", cancel_fn)?;

    // Register invoke to free the Arc when underlying_source is GC'd
    register_invoke::<S>(env.raw(), underlying_source.0.value, state_ptr)?;

    let mut stream = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_new_instance(
          env.0,
          constructor.0.value,
          1,
          [underlying_source.0.value].as_ptr(),
          &mut stream,
        )
      },
      "Create ReadableStream instance failed"
    )?;
    Ok(Self {
      value: stream,
      env: env.0,
      _marker: PhantomData,
    })
  }

  /// Creates a new `ReadableStream` with the given `stream` and `ReadableStream` class.
  ///
  /// This is useful if the runtime only supports Node-API 4 but doesn't support the WebStream API.
  ///
  /// Node-API 4 was initially introduced in `v10.16.0` and WebStream was introduced in `v16.5.0`.
  pub fn with_readable_stream_class<S: Stream<Item = Result<T>> + Unpin + Send + 'static>(
    env: &Env,
    readable_stream_class: &Unknown,
    inner: S,
  ) -> Result<Self> {
    if readable_stream_class.get_type()? == ValueType::Undefined {
      return Err(Error::new(
        Status::GenericFailure,
        "ReadableStream is not supported in this Node.js version",
      ));
    }

    // Create shared state for the stream
    let state = StreamState::new(inner);
    let state_ptr = Arc::into_raw(state) as *mut c_void;

    let mut underlying_source = Object::new(env)?;

    // Create pull callback
    let mut pull_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"pull".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(pull_callback::<T, S>),
          state_ptr,
          &mut pull_fn,
        )
      },
      "Failed to create pull function"
    )?;
    underlying_source.set_named_property("pull", pull_fn)?;

    // Create cancel callback for cleanup
    let mut cancel_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"cancel".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(cancel_callback::<S>),
          state_ptr,
          &mut cancel_fn,
        )
      },
      "Failed to create cancel function"
    )?;
    underlying_source.set_named_property("cancel", cancel_fn)?;

    // Register invoke to free the Arc when underlying_source is GC'd
    register_invoke::<S>(env.raw(), underlying_source.0.value, state_ptr)?;

    let mut stream = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_new_instance(
          env.0,
          readable_stream_class.0.value,
          1,
          [underlying_source.0.value].as_ptr(),
          &mut stream,
        )
      },
      "Create ReadableStream instance failed"
    )?;
    Ok(Self {
      value: stream,
      env: env.0,
      _marker: PhantomData,
    })
  }
}

impl<'env> ReadableStream<'env, BufferSlice<'env>> {
  /// Creates a new `ReadableStream` with the given `stream` that emits bytes.
  pub fn create_with_stream_bytes<
    B: Into<Vec<u8>>,
    S: Stream<Item = Result<B>> + Unpin + Send + 'static,
  >(
    env: &Env,
    inner: S,
  ) -> Result<Self> {
    let global = env.get_global()?;
    let constructor = global.get_named_property_unchecked::<Function>("ReadableStream")?;

    // Create shared state for the stream
    let state = StreamState::new(inner);
    let state_ptr = Arc::into_raw(state) as *mut c_void;

    let mut underlying_source = Object::new(env)?;

    // Create pull callback
    let mut pull_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"pull".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(pull_callback_bytes::<B, S>),
          state_ptr,
          &mut pull_fn,
        )
      },
      "Failed to create pull function"
    )?;
    underlying_source.set_named_property("pull", pull_fn)?;

    // Create cancel callback for cleanup
    let mut cancel_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"cancel".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(cancel_callback::<S>),
          state_ptr,
          &mut cancel_fn,
        )
      },
      "Failed to create cancel function"
    )?;
    underlying_source.set_named_property("cancel", cancel_fn)?;

    // Register invoke to free the Arc when underlying_source is GC'd
    register_invoke::<S>(env.raw(), underlying_source.0.value, state_ptr)?;

    underlying_source.set("type", "bytes")?;
    let mut stream = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_new_instance(
          env.0,
          constructor.value,
          1,
          [underlying_source.0.value].as_ptr(),
          &mut stream,
        )
      },
      "Create ReadableStream instance failed"
    )?;
    Ok(Self {
      value: stream,
      env: env.0,
      _marker: PhantomData,
    })
  }

  /// create a new `ReadableStream` with the given `stream` that emits bytes and `ReadableStream` class.
  pub fn with_stream_bytes_and_readable_stream_class<
    B: Into<Vec<u8>>,
    S: Stream<Item = Result<B>> + Unpin + Send + 'static,
  >(
    env: &Env,
    readable_stream_class: &Unknown,
    inner: S,
  ) -> Result<Self> {
    if readable_stream_class.get_type()? == ValueType::Undefined {
      return Err(Error::new(
        Status::GenericFailure,
        "ReadableStream is not supported in this Node.js version",
      ));
    }

    // Create shared state for the stream
    let state = StreamState::new(inner);
    let state_ptr = Arc::into_raw(state) as *mut c_void;

    let mut underlying_source = Object::new(env)?;

    // Create pull callback
    let mut pull_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"pull".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(pull_callback_bytes::<B, S>),
          state_ptr,
          &mut pull_fn,
        )
      },
      "Failed to create pull function"
    )?;
    underlying_source.set_named_property("pull", pull_fn)?;

    // Create cancel callback for cleanup
    let mut cancel_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_function(
          env.raw(),
          c"cancel".as_ptr().cast(),
          NAPI_AUTO_LENGTH,
          Some(cancel_callback::<S>),
          state_ptr,
          &mut cancel_fn,
        )
      },
      "Failed to create cancel function"
    )?;
    underlying_source.set_named_property("cancel", cancel_fn)?;

    // Register invoke to free the Arc when underlying_source is GC'd
    register_invoke::<S>(env.raw(), underlying_source.0.value, state_ptr)?;

    underlying_source.set("type", "bytes")?;
    let mut stream = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_new_instance(
          env.0,
          readable_stream_class.0.value,
          1,
          [underlying_source.0.value].as_ptr(),
          &mut stream,
        )
      },
      "Create ReadableStream instance failed"
    )?;
    Ok(Self {
      value: stream,
      env: env.0,
      _marker: PhantomData,
    })
  }
}

pub struct IteratorValue<'env, T: FromNapiValue> {
  _marker: PhantomData<&'env ()>,
  value: Option<T>,
  done: bool,
}

impl<T: FromNapiValue> FromNapiValue for IteratorValue<'_, T> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut done = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_named_property(env, napi_val, c"done".as_ptr().cast(), &mut done) },
      "Get done property failed"
    )?;
    let done = unsafe { FromNapiValue::from_napi_value(env, done)? };
    let mut value = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_named_property(env, napi_val, c"value".as_ptr().cast(), &mut value) },
      "Get value property failed"
    )?;
    let value = unsafe { FromNapiValue::from_napi_value(env, value)? };
    Ok(Self {
      value,
      done,
      _marker: PhantomData,
    })
  }
}

struct ReaderInner<T: FromNapiValue + 'static> {
  /// Buffered read result: `Ok(None)` = empty, `Ok(Some(_))` = a chunk waiting to be
  /// yielded, `Err(_)` = a read error waiting to be surfaced.
  chunk: Result<Option<T>>,
  /// The JS reader signalled `done` (or errored); no more reads should be issued.
  done: bool,
  /// A JS `read()` is currently in flight. Guards against issuing a second concurrent
  /// read, which would race two results into the single `chunk` slot and drop one.
  reading: bool,
  /// Waker of the task currently awaiting a chunk; woken when a read completes.
  waker: Option<Waker>,
}

/// Shared state between the polling task (tokio thread) and the JS `read()` resolution
/// callbacks (JS thread). A single mutex serializes them so a chunk can never be lost:
/// a poll either observes a buffered chunk and drains it, or observes `reading == true`
/// and waits — it can never miss a chunk yet still issue a fresh overlapping read.
struct ReaderState<T: FromNapiValue + 'static> {
  inner: std::sync::Mutex<ReaderInner<T>>,
}

pub struct Reader<T: FromNapiValue + 'static> {
  inner:
    ThreadsafeFunction<(), PromiseRaw<'static, IteratorValue<'static, T>>, (), Status, true, true>,
  state: Arc<ReaderState<T>>,
}

/// Build an owned error message from a rejected JS value **without** retaining a napi
/// reference. Runs on the JS thread (inside the promise `catch` callback), so the
/// coercions below are valid here; the returned `String` becomes part of an owned
/// `Error` that is then safe to move to — and drop on — any thread.
fn rejection_message(value: Unknown) -> String {
  fn from_message_property(value: Unknown) -> Result<String> {
    let object = value.coerce_to_object()?;
    let message = object.get_named_property::<Unknown>("message")?;
    message.coerce_to_string()?.into_utf8()?.into_owned()
  }

  let message = if matches!(value.get_type(), Ok(ValueType::Object)) {
    from_message_property(value).ok()
  } else {
    None
  }
  .unwrap_or_else(|| {
    value
      .coerce_to_string()
      .and_then(|s| s.into_utf8())
      .and_then(|s| s.into_owned())
      .unwrap_or_else(|_| "ReadableStream read error".to_owned())
  });

  // A throwing `message` getter or `toString` above leaves a pending JS exception on
  // the env even though the failed probe was swallowed. Clear it here (on the JS
  // thread) so the caller does not return to JS with an exception still pending — that
  // would let the promise chain throw/reject independently of the error we report.
  let mut pending_exception = ptr::null_mut();
  unsafe {
    sys::napi_get_and_clear_last_exception(value.0.env, &mut pending_exception);
  }
  message
}

impl<T: FromNapiValue + 'static> futures_core::Stream for Reader<T> {
  type Item = Result<T>;

  fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    let issue_read = {
      let mut inner = self
        .state
        .inner
        .lock()
        .map_err(|_| Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next"))?;
      // 1. Surface any buffered chunk or error first.
      match mem::replace(&mut inner.chunk, Ok(None)) {
        Ok(Some(chunk)) => return Poll::Ready(Some(Ok(chunk))),
        Err(err) => return Poll::Ready(Some(Err(err))),
        Ok(None) => {}
      }
      // 2. If the stream finished (or errored) and nothing is buffered, end iteration.
      if inner.done {
        return Poll::Ready(None);
      }
      // 3. Remember the latest waker so the in-flight read can wake this task.
      inner.waker = Some(cx.waker().clone());
      // 4. Issue a read only if none is already in flight (at most one outstanding).
      if inner.reading {
        false
      } else {
        inner.reading = true;
        true
      }
    };

    if issue_read {
      let state = self.state.clone();
      let state_in_catch = self.state.clone();
      let state_in_finally = self.state.clone();
      let state_on_setup_err = self.state.clone();
      let status = self.inner.call_with_return_value(
        Ok(()),
        ThreadsafeFunctionCallMode::NonBlocking,
        move |iterator, env| {
          // Attach the promise handlers. `finally` is what clears `reading` and wakes
          // the polling task; if any step below bails out early via `?` (the read()
          // result failed to convert, or a handler could not be attached) that
          // `finally` is never registered, so we MUST run the same cleanup ourselves —
          // otherwise `reading` stays set and the task is parked forever.
          let setup = (move || -> Result<()> {
            let iterator = iterator?;
            iterator
              .then(move |cx| {
                let mut inner = state.inner.lock().map_err(|_| {
                  Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next")
                })?;
                // The stream may already be terminated by the setup-error path (a later
                // handler-attach step failed *after* this `then` was registered). Drop
                // the late settlement rather than resurrect a chunk after the end.
                if inner.done {
                  return Ok(());
                }
                if cx.value.done {
                  inner.done = true;
                }
                if let Some(val) = cx.value.value {
                  inner.chunk = Ok(Some(val));
                }
                Ok(())
              })?
              .catch(move |cx: CallbackContext<Unknown>| {
                // Convert the JS rejection into an OWNED Rust error *on the JS thread*
                // (where this callback runs), carrying no `napi_ref`. `Reader<T>` is a
                // `Send` stream, so a consumer may drop the yielded `Err` on a runtime
                // thread; an `Error` holding a `napi_ref` would then release that
                // reference off the JS thread, which aborts the process / is UB.
                // Always call this (it also clears any pending exception) before
                // checking `done`, so a late rejection never leaves one set.
                let reason = rejection_message(cx.value);
                let mut inner = state_in_catch.inner.lock().map_err(|_| {
                  Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next")
                })?;
                // If the stream already terminated (setup-error path), drop this late
                // rejection rather than surface a second terminal error after the end.
                if inner.done {
                  return Ok(());
                }
                inner.chunk = Err(Error::new(Status::GenericFailure, reason));
                // An errored read terminates the stream.
                inner.done = true;
                Ok(())
              })?
              .finally(move |_| {
                let waker = {
                  let mut inner = state_in_finally.inner.lock().map_err(|_| {
                    Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next")
                  })?;
                  inner.reading = false;
                  inner.waker.take()
                };
                if let Some(waker) = waker {
                  waker.wake();
                }
                Ok(())
              })?;
            Ok(())
          })();
          if let Err(err) = setup {
            // Handlers may not have been attached, so `finally` may never fire.
            // Terminate the stream with the error and release the parked task.
            //
            // A handler attachment that throws (e.g. a malicious thenable whose
            // `then`/`catch`/`finally` throws) leaves a JS exception *pending* on the
            // env. Left pending it wedges every subsequent napi call on this thread —
            // including the runtime's own promise resolution — which hangs the
            // consumer. Clear it here, on the JS thread (a no-op when nothing is
            // pending, e.g. the synchronous `read()` throw path).
            let mut pending_exception = ptr::null_mut();
            unsafe {
              sys::napi_get_and_clear_last_exception(env.raw(), &mut pending_exception);
            }
            // `err` can also own a JS exception reference (`maybe_raw`) — e.g. when the
            // bound `read()` threw synchronously, the threadsafe call wraps the
            // exception. `Reader<T>` is `Send`, so the stored error may be surfaced or
            // dropped on the Tokio thread; dropping a `napi_ref` off the JS thread
            // aborts the process / is UB (the same hazard the `catch` path avoids).
            // Rebuild a reference-free OWNED error here on the JS thread — the message
            // is already mirrored into `reason` — and drop the original now so any
            // reference is released on this (JS) thread.
            let reason = if err.reason.is_empty() {
              format!("ReadableStream read failed: {}", err.status)
            } else {
              err.reason.clone()
            };
            let owned = Error::new(Status::GenericFailure, reason);
            drop(err);
            let waker = {
              let mut inner = state_on_setup_err.inner.lock().map_err(|_| {
                Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next")
              })?;
              inner.reading = false;
              inner.done = true;
              inner.chunk = Err(owned);
              inner.waker.take()
            };
            if let Some(waker) = waker {
              waker.wake();
            }
          }
          Ok(())
        },
      );
      // The threadsafe call itself can fail to schedule (runtime shutting down /
      // `Status::Closing`, or a full queue). When it does, the callback above never
      // runs, so `reading`/`waker` would be stuck. Recover synchronously: clear the
      // flag, end the stream, and surface the error now.
      if status != Status::Ok {
        let mut inner = self
          .state
          .inner
          .lock()
          .map_err(|_| Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next"))?;
        inner.reading = false;
        inner.done = true;
        inner.waker = None;
        return Poll::Ready(Some(Err(Error::new(
          status,
          "Failed to schedule ReadableStream read",
        ))));
      }
    }

    Poll::Pending
  }
}

/// Shared state for ReadableStream that coordinates between pull and cancel callbacks.
/// Uses Arc to share ownership between callbacks, Mutex to protect the stream,
/// and AtomicBool for lock-free cancellation checks.
///
/// Memory management: The Arc is freed by a invoke when the underlying_source
/// object is garbage collected. Callbacks only "borrow" the Arc using the
/// increment+from_raw pattern, never freeing it directly. This prevents
/// use-after-free if cancel_callback is invoked after pull_callback has
/// already closed the stream.
struct StreamState<S> {
  stream: Mutex<Option<Pin<Box<S>>>>,
  cancelled: AtomicBool,
}

impl<S> StreamState<S> {
  fn new(stream: S) -> Arc<Self> {
    Arc::new(Self {
      stream: Mutex::new(Some(Box::pin(stream))),
      cancelled: AtomicBool::new(false),
    })
  }
}

/// invoke callback that frees the Arc<StreamState> when the underlying_source
/// object is garbage collected. This is the only place where the Arc is freed,
/// ensuring that callbacks can safely borrow without risk of use-after-free.
extern "C" fn invoke<S>(
  _env: sys::napi_env,
  finalize_data: *mut c_void,
  _finalize_hint: *mut c_void,
) {
  if !finalize_data.is_null() {
    // Consume the Arc, dropping it and freeing memory
    drop(unsafe { Arc::from_raw(finalize_data.cast::<StreamState<S>>()) });
  }
}

/// Registers a invoke on the underlying_source object that will free the Arc<StreamState>
/// when the object is garbage collected.
fn register_invoke<S>(
  env: sys::napi_env,
  underlying_source: sys::napi_value,
  state_ptr: *mut c_void,
) -> Result<()> {
  check_status!(
    unsafe {
      sys::napi_add_finalizer(
        env,
        underlying_source,
        state_ptr,
        Some(invoke::<S>),
        ptr::null_mut(),
        ptr::null_mut(),
      )
    },
    "Failed to add invoke to underlying source"
  )
}

/// Helper struct to extract and bind controller methods from callback info.
struct PullController<T: ToNapiValue> {
  enqueue: crate::bindgen_prelude::FunctionRef<T, ()>,
  close: crate::bindgen_prelude::FunctionRef<(), ()>,
}

impl<T: ToNapiValue> PullController<T> {
  fn from_callback_info(
    env: sys::napi_env,
    info: sys::napi_callback_info,
  ) -> Result<(Self, *mut c_void)> {
    let mut data = ptr::null_mut();
    let mut argc = 1;
    let mut args = [ptr::null_mut(); 1];
    check_status!(
      unsafe {
        sys::napi_get_cb_info(
          env,
          info,
          &mut argc,
          args.as_mut_ptr(),
          ptr::null_mut(),
          &mut data,
        )
      },
      "Get ReadableStream.pull callback info failed"
    )?;

    let controller = unsafe { Object::from_napi_value(env, args[0])? };
    let enqueue = controller
      .get_named_property_unchecked::<Function<T, ()>>("enqueue")?
      .bind(controller)?
      .create_ref()?;
    let close = controller
      .get_named_property_unchecked::<Function<(), ()>>("close")?
      .bind(controller)?
      .create_ref()?;

    Ok((Self { enqueue, close }, data))
  }
}

extern "C" fn cancel_callback<S>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut data = ptr::null_mut();
  unsafe {
    sys::napi_get_cb_info(
      env,
      info,
      ptr::null_mut(),
      ptr::null_mut(),
      ptr::null_mut(),
      &mut data,
    );
  }
  if !data.is_null() {
    // Borrow the Arc using increment+from_raw pattern.
    // The invoke registered on underlying_source will free the Arc when GC'd.
    // This prevents use-after-free if cancel is called after stream has closed.
    let state = unsafe {
      Arc::increment_strong_count(data.cast::<StreamState<S>>());
      Arc::from_raw(data.cast::<StreamState<S>>())
    };

    // Mark as cancelled so pull callback knows to stop
    state.cancelled.store(true, Ordering::SeqCst);

    // Try to take the stream - use try_lock to avoid blocking the event loop.
    // If we can't get the lock (pull is in progress), that's fine - pull will
    // see the cancelled flag and handle cleanup.
    if let Ok(mut guard) = state.stream.try_lock() {
      let _ = guard.take();
    };
    // Borrowed Arc drops here, decrementing ref count (but not freeing - invoke handles that)
  }
  ptr::null_mut()
}

extern "C" fn pull_callback<
  T: ToNapiValue + Send + 'static,
  S: Stream<Item = Result<T>> + Unpin + Send + 'static,
>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  match pull_callback_impl::<T, S>(env, info) {
    Ok(val) => val,
    Err(err) => unsafe {
      let js_error: JsError = err.into();
      js_error.throw_into(env);
      ptr::null_mut()
    },
  }
}

fn pull_callback_impl<
  T: ToNapiValue + Send + 'static,
  S: Stream<Item = Result<T>> + Unpin + Send + 'static,
>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> Result<sys::napi_value> {
  let (controller, data) = PullController::<T>::from_callback_info(env, info)?;

  // Borrow the Arc<StreamState> using the increment+from_raw pattern.
  // The invoke registered on underlying_source will free the Arc when GC'd.
  // This prevents use-after-free if cancel is called after stream has closed.
  let state = unsafe {
    Arc::increment_strong_count(data.cast::<StreamState<S>>());
    Arc::from_raw(data.cast::<StreamState<S>>())
  };

  // Check if stream was cancelled
  if state.cancelled.load(Ordering::SeqCst) {
    return Ok(ptr::null_mut());
  }

  let env_wrapper = Env::from_raw(env);
  let state_for_async = state.clone();

  let promise = env_wrapper.spawn_future_with_callback(
    async move {
      let mut guard = state_for_async.stream.lock().await;
      if let Some(ref mut stream) = *guard {
        stream.next().await.transpose()
      } else {
        Ok(None)
      }
    },
    move |env, val| {
      // Use inner closure to ensure FunctionRef cleanup on all paths (including errors)
      let result = {
        // Re-check cancelled flag after async work completes to prevent
        // enqueueing if cancel was called while waiting for the next item
        if state.cancelled.load(Ordering::SeqCst) {
          // Stream was cancelled while waiting - skip enqueue and close
        } else if let Some(val) = val {
          let enqueue_fn = controller.enqueue.borrow_back(env)?;
          enqueue_fn.call(val)?;
        } else {
          let close_fn = controller.close.borrow_back(env)?;
          close_fn.call(())?;
          // Stream ended - take the inner stream to free resources early
          // (the Arc itself is freed by the invoke when underlying_source is GC'd)
          if let Ok(mut guard) = state.stream.try_lock() {
            let _ = guard.take();
          }
        }
        Ok::<(), Error>(())
      };
      // Always clean up FunctionRefs regardless of success/failure
      drop(controller.enqueue);
      drop(controller.close);
      result
    },
  )?;
  Ok(promise.inner)
}

extern "C" fn pull_callback_bytes<
  B: Into<Vec<u8>>,
  S: Stream<Item = Result<B>> + Unpin + Send + 'static,
>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  match pull_callback_impl_bytes::<B, S>(env, info) {
    Ok(val) => val,
    Err(err) => unsafe {
      let js_error: JsError = err.into();
      js_error.throw_into(env);
      ptr::null_mut()
    },
  }
}

fn pull_callback_impl_bytes<
  B: Into<Vec<u8>>,
  S: Stream<Item = Result<B>> + Unpin + Send + 'static,
>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> Result<sys::napi_value> {
  let (controller, data) = PullController::<BufferSlice>::from_callback_info(env, info)?;

  // Borrow the Arc<StreamState> using the increment+from_raw pattern.
  // The invoke registered on underlying_source will free the Arc when GC'd.
  // This prevents use-after-free if cancel is called after stream has closed.
  let state = unsafe {
    Arc::increment_strong_count(data.cast::<StreamState<S>>());
    Arc::from_raw(data.cast::<StreamState<S>>())
  };

  // Check if stream was cancelled
  if state.cancelled.load(Ordering::SeqCst) {
    return Ok(ptr::null_mut());
  }

  let env_wrapper = Env::from_raw(env);
  let state_for_async = state.clone();

  let promise = env_wrapper.spawn_future_with_callback(
    async move {
      let mut guard = state_for_async.stream.lock().await;
      if let Some(ref mut stream) = *guard {
        stream
          .next()
          .await
          .transpose()
          .map(|v| v.map(|v| Into::<Vec<u8>>::into(v)))
      } else {
        Ok(None)
      }
    },
    move |env, val| {
      // Use inner closure to ensure FunctionRef cleanup on all paths (including errors)
      let result = {
        // Re-check cancelled flag after async work completes to prevent
        // enqueueing if cancel was called while waiting for the next item
        if state.cancelled.load(Ordering::SeqCst) {
          // Stream was cancelled while waiting - skip enqueue and close
        } else if let Some(val) = val {
          let enqueue_fn = controller.enqueue.borrow_back(env)?;
          enqueue_fn.call(BufferSlice::from_data(env, val)?)?;
        } else {
          let close_fn = controller.close.borrow_back(env)?;
          close_fn.call(())?;
          // Stream ended - take the inner stream to free resources early
          // (the Arc itself is freed by the invoke when underlying_source is GC'd)
          if let Ok(mut guard) = state.stream.try_lock() {
            let _ = guard.take();
          }
        }
        Ok::<(), Error>(())
      };
      // Always clean up FunctionRefs regardless of success/failure
      drop(controller.enqueue);
      drop(controller.close);
      result
    },
  )?;
  Ok(promise.inner)
}
