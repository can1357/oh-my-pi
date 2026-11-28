use std::{
  cell::Cell,
  ffi::{c_void, CStr},
  future::Future,
  marker::PhantomData,
  mem,
  pin::Pin,
  ptr,
  rc::Rc,
  sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
  },
  task::{Context, Poll, Waker},
  thread::{self, ThreadId},
};

use tokio::sync::Mutex;

use futures::{channel::oneshot, task::AtomicWaker};
use futures_core::Stream;
use tokio_stream::StreamExt;

#[cfg(all(feature = "napi4", not(feature = "noop")))]
use crate::bindgen_prelude::{custom_gc_handle_for_env, CustomGcHandle};
use crate::{
  bindgen_prelude::{
    BufferSlice, CallbackContext, Either, FromNapiValue, Function, FunctionRef, JsObjectValue,
    Object, PromiseRaw, ToNapiValue, TypeName, Undefined, Unknown, ValidateNapiValue,
    NAPI_AUTO_LENGTH,
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

  /// Calls `stream.cancel(reason)` and returns its Promise, which resolves when the stream
  /// is canceled. `None` passes `undefined` as the reason.
  ///
  /// A locked stream cannot be canceled this way: the Promise rejects with a `TypeError`
  /// and the underlying source's `cancel` is not called. [`ReadableStream::read`] locks the
  /// stream to its reader, so after `read()` use [`Reader::cancel`],
  /// [`ReaderCancelHandle::cancel`] or [`ReaderCancelHandle::cancel_on_js_thread`] instead.
  ///
  /// The Promise also rejects when the source's `cancel` throws. Do not just drop it: a
  /// rejected Promise that nothing handles is an unhandled rejection, and by default
  /// Node.js then exits with code 1. Return it to JavaScript, attach a handler with
  /// [`PromiseRaw::catch`], or turn it into a [`Promise`](crate::bindgen_prelude::Promise)
  /// with [`PromiseRaw::into_sendable_promise`] and await it.
  pub fn cancel(&mut self, reason: Option<String>) -> Result<PromiseRaw<'_, ()>> {
    let mut cancel_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          self.value,
          c"cancel".as_ptr().cast(),
          &mut cancel_fn,
        )
      },
      "Get cancel property failed"
    )?;
    let reason_value = unsafe { ToNapiValue::to_napi_value(self.env, cancel_reason(reason))? };
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
      "Call cancel function failed"
    )?;
    Ok(PromiseRaw::new(self.env, promise))
  }
}

impl<T: FromNapiValue> ReadableStream<'_, T> {
  /// Locks the stream to a new reader (`stream.getReader()`) and returns a [`Reader`] that
  /// yields its chunks as a Rust [`Stream`].
  ///
  /// Dropping the `Reader` neither cancels the stream nor releases the lock. To stop
  /// reading and cancel the stream, use [`Reader::cancel`] or [`Reader::cancel_handle`].
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
    let signal = Arc::new(CancelSignal {
      cancelled: AtomicBool::new(false),
      waker: AtomicWaker::new(),
    });
    Ok(Reader {
      inner: read_function,
      state: Arc::new(ReaderState {
        inner: std::sync::Mutex::new(ReaderInner {
          chunk: Ok(None),
          done: false,
          reading: false,
          waker: None,
        }),
        signal: signal.clone(),
      }),
      cancel: ReaderCancelHandle {
        cancel_fn: bind_reader_cancel(self.env, reader).map(Arc::new),
        signal,
        env: ReaderEnv::current(self.env),
      },
    })
  }
}

/// `reader.cancel` bound to its reader, callable from any thread.
///
/// `CalleeHandled` is `false` so the first argument is the cancel reason itself (with
/// `true`, napi-rs would pass `null` first and that `null` would become the reason).
type ReaderCancelFn = ThreadsafeFunction<
  Option<String>,
  Unknown<'static>,
  Either<String, Undefined>,
  Status,
  false,
  true,
>;

/// `reader.cancel` bound to its reader, held two ways.
struct BoundCancel {
  /// For [`ReaderCancelHandle::cancel`]: callable from any thread, runs later.
  threadsafe: ReaderCancelFn,
  /// For [`ReaderCancelHandle::cancel_on_js_thread`]: called right away. The threadsafe
  /// function above already holds the same function, so this reference keeps nothing
  /// alive for longer, and `FunctionRef` can be dropped on any thread.
  js: FunctionRef<Either<String, Undefined>, Unknown<'static>>,
  /// The senders of calls through `threadsafe` that have not run yet.
  queued: Arc<QueuedCancels>,
}

/// The senders of [`ReaderCancelHandle::cancel`] calls that are queued and have not run yet.
///
/// When the environment is torn down after a call was queued but before it ran, Node.js
/// hands the call to the threadsafe function with a null env, and napi-rs then drops
/// nothing: the call's closure leaks, and a sender inside it would never be dropped, so the
/// future would stay pending. So the closure holds only a key, and the sender waits here
/// until the call runs and takes it. The threadsafe function's callback owns a
/// [`CloseOnDrop`], and that callback is dropped when the threadsafe function is finalized
/// (released, or its environment torn down), after its last call that can still run. Then
/// the senders still here are dropped, and their futures resolve to `Err`.
#[derive(Default)]
struct QueuedCancels {
  state: std::sync::Mutex<QueuedCancelsState>,
}

#[derive(Default)]
struct QueuedCancelsState {
  /// The threadsafe function was finalized: no call can be queued or run any more.
  closed: bool,
  next_key: u64,
  senders: Vec<(u64, oneshot::Sender<Result<()>>)>,
}

impl QueuedCancels {
  fn lock(&self) -> std::sync::MutexGuard<'_, QueuedCancelsState> {
    // Nothing panics while the lock is held, so the data is consistent even if poisoned.
    self
      .state
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
  }

  /// Keeps `sender` for the call that gets the returned key. Returns `None`, and drops
  /// `sender`, once the threadsafe function was finalized.
  fn insert(&self, sender: oneshot::Sender<Result<()>>) -> Option<u64> {
    let mut state = self.lock();
    if state.closed {
      return None;
    }
    let key = state.next_key;
    state.next_key = key.wrapping_add(1);
    state.senders.push((key, sender));
    Some(key)
  }

  /// Takes the sender for the call with `key`, if it is still here.
  fn take(&self, key: u64) -> Option<oneshot::Sender<Result<()>>> {
    let mut state = self.lock();
    let index = state.senders.iter().position(|(k, _)| *k == key)?;
    Some(state.senders.swap_remove(index).1)
  }

  /// Drops every sender still here, so that their futures resolve to `Err`, and refuses
  /// new ones.
  fn close(&self) {
    let senders = {
      let mut state = self.lock();
      state.closed = true;
      mem::take(&mut state.senders)
    };
    // Dropped after the lock is released: dropping a sender wakes its receiver's task.
    drop(senders);
  }
}

/// Closes its [`QueuedCancels`] when dropped. Owned by the callback of the threadsafe
/// function that queues the cancel calls.
struct CloseOnDrop(Arc<QueuedCancels>);

impl Drop for CloseOnDrop {
  fn drop(&mut self) {
    self.0.close();
  }
}

/// A `None` reason is passed to JavaScript as `undefined` (what `cancel()` with no
/// argument gives the source), not as `null`.
fn cancel_reason(reason: Option<String>) -> Either<String, Undefined> {
  match reason {
    Some(reason) => Either::A(reason),
    None => Either::B(()),
  }
}

/// Binds `reader.cancel` to `reader`, wraps it in a weak threadsafe function like the bound
/// `read` above, and keeps a reference to it for calls on the JavaScript thread.
///
/// Returns `None` instead of an error when that is not possible (for example a custom
/// reader without a `cancel` method), so `ReadableStream::read` behaves exactly as it did
/// before cancel support; [`ReaderCancelHandle::cancel`] reports the missing method.
fn bind_reader_cancel(env: sys::napi_env, reader: sys::napi_value) -> Option<BoundCancel> {
  let bind = || -> Result<BoundCancel> {
    let mut cancel_function = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(env, reader, c"cancel".as_ptr().cast(), &mut cancel_function)
      },
      "Get cancel from ReadableStreamDefaultReader failed"
    )?;
    let mut value_type = 0;
    check_status!(
      unsafe { sys::napi_typeof(env, cancel_function, &mut value_type) },
      "Get type of ReadableStreamDefaultReader::cancel failed"
    )?;
    if value_type != sys::ValueType::napi_function {
      return Err(Error::new(
        Status::FunctionExpected,
        "ReadableStreamDefaultReader::cancel is not a function",
      ));
    }
    let reader = unsafe { Unknown::from_raw_unchecked(env, reader) };
    let unbound = unsafe {
      Function::<Either<String, Undefined>, Unknown<'static>>::from_napi_value(
        env,
        cancel_function,
      )?
    };
    let cancel_function = unbound.bind(reader)?;
    let js = cancel_function.create_ref()?;
    let queued = Arc::new(QueuedCancels::default());
    let close_on_drop = CloseOnDrop(queued.clone());
    let threadsafe = cancel_function
      .build_threadsafe_function::<Option<String>>()
      .callee_handled::<false>()
      .weak::<true>()
      .build_callback(move |ctx| {
        // Moved into this callback, which the threadsafe function's finalizer drops.
        let _ = &close_on_drop;
        Ok(cancel_reason(ctx.value))
      })?;
    Ok(BoundCancel {
      threadsafe,
      js,
      queued,
    })
  };
  match bind() {
    Ok(bound) => Some(bound),
    Err(_) => {
      // A throwing `cancel` getter leaves an exception pending; clear it so `read()` does
      // not return to JavaScript with it still set.
      let mut pending_exception = ptr::null_mut();
      unsafe {
        sys::napi_get_and_clear_last_exception(env, &mut pending_exception);
      }
      None
    }
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
  /// Shared with every cancel handle.
  signal: Arc<CancelSignal>,
}

/// Shared by a [`Reader`] and its cancel handles. It has no type parameter, so the handle
/// needs none either, and a cancel never takes the reader's lock.
struct CancelSignal {
  /// Set once a cancel was requested: the reader yields nothing more, and reads that
  /// settle later are dropped.
  cancelled: AtomicBool,
  /// The task polling the reader, so that a cancel can wake it without waiting for
  /// JavaScript to settle the read in flight. `poll_next` registers the waker before it
  /// checks `cancelled`, and `cancel` sets `cancelled` before it wakes, so a cancel that
  /// races with a poll is never missed.
  waker: AtomicWaker,
}

impl CancelSignal {
  fn cancel(&self) {
    self.cancelled.store(true, Ordering::SeqCst);
    self.waker.wake();
  }

  fn is_cancelled(&self) -> bool {
    self.cancelled.load(Ordering::SeqCst)
  }

  /// Drops the waker of the task that polled last, once the reader has ended or is
  /// dropped. No poll waits for a cancel then, and a later poll registers again before it
  /// checks `cancelled`. Without this, a cancel handle kept after the reader ended would
  /// keep that task's allocation alive.
  fn release_waker(&self) {
    drop(self.waker.take());
  }
}

// `AtomicWaker` holds an `UnsafeCell`, so without this `CancelSignal` is not
// `RefUnwindSafe`, and `Reader<T>` (through its `Arc`s) would lose `RefUnwindSafe` and
// `UnwindSafe`, which it had before cancel support. A panic cannot leave a broken
// `CancelSignal` behind for a later user: `cancelled` is an atomic, and `AtomicWaker`
// guards its cell with its own atomic state. At worst a panicking `Waker::clone` inside
// `register` makes later wakes do nothing, and `poll_next` still checks `cancelled`.
// napi-rs does the same for `AbortSignal`.
impl std::panic::RefUnwindSafe for CancelSignal {}

/// The environment a [`Reader`] was made in, for the check in
/// [`ReaderCancelHandle::cancel_on_js_thread`].
#[derive(Clone)]
struct ReaderEnv {
  /// The `napi_env`, as an address. It is only compared, never used to call Node-API.
  address: usize,
  /// The environment's JavaScript thread. A `ThreadId` is never reused in a process, so an
  /// environment on another thread does not pass, even when it got the address of a dead
  /// one (a new worker, for example).
  thread: ThreadId,
  /// The custom-GC handle of this env when the `Reader` was made, which tells whether the
  /// env is torn down.
  #[cfg(all(feature = "napi4", not(feature = "noop")))]
  custom_gc: Option<Arc<CustomGcHandle>>,
}

impl ReaderEnv {
  /// Runs on the JavaScript thread of `env`.
  fn current(env: sys::napi_env) -> Self {
    Self {
      address: env as usize,
      thread: thread::current().id(),
      #[cfg(all(feature = "napi4", not(feature = "noop")))]
      custom_gc: custom_gc_handle_for_env(env),
    }
  }

  /// Whether `env` is this environment, the current thread is its JavaScript thread, and
  /// the environment is not torn down.
  fn is_current(&self, env: &Env) -> bool {
    if self.address != env.raw() as usize || self.thread != thread::current().id() {
      return false;
    }
    #[cfg(all(feature = "napi4", not(feature = "noop")))]
    if let Some(custom_gc) = &self.custom_gc {
      return custom_gc.is_open();
    }
    // No custom-GC handle (a `noop` build, or none for this env): the address
    // and the thread are all that is checked.
    true
  }
}

/// Reads a JavaScript `ReadableStream` as a Rust [`Stream`]; returned by
/// [`ReadableStream::read`].
pub struct Reader<T: FromNapiValue + 'static> {
  inner:
    ThreadsafeFunction<(), PromiseRaw<'static, IteratorValue<'static, T>>, (), Status, true, true>,
  state: Arc<ReaderState<T>>,
  cancel: ReaderCancelHandle,
}

// `Reader<T>` was `RefUnwindSafe` and `UnwindSafe` (for a `T` that is) before cancel
// support. Losing an auto trait is a breaking change, so this fails to compile if it
// happens again.
const _: fn() = || {
  fn unwind_safe<T: std::panic::RefUnwindSafe + std::panic::UnwindSafe>() {}
  unwind_safe::<Reader<u32>>();
};

impl<T: FromNapiValue + 'static> Reader<T> {
  /// Returns a handle that cancels this reader's stream. It can be cloned, sent to other
  /// threads, and used while another task is awaiting this reader's next chunk.
  pub fn cancel_handle(&self) -> ReaderCancelHandle {
    self.cancel.clone()
  }

  /// Cancels the stream through the reader, like `reader.cancel(reason)` in JavaScript.
  ///
  /// Same as `self.cancel_handle().cancel(reason)`; see [`ReaderCancelHandle::cancel`].
  pub fn cancel(
    &self,
    reason: Option<String>,
  ) -> impl Future<Output = Result<()>> + Send + 'static {
    self.cancel.cancel(reason)
  }

  /// Cancels the stream through the reader right away, on the JavaScript thread.
  ///
  /// Same as `self.cancel_handle().cancel_on_js_thread(env, reason)`; see
  /// [`ReaderCancelHandle::cancel_on_js_thread`].
  pub fn cancel_on_js_thread(
    &self,
    env: &Env,
    reason: Option<String>,
  ) -> Result<impl Future<Output = Result<()>> + Send + 'static> {
    self.cancel.cancel_on_js_thread(env, reason)
  }
}

/// Cancels the stream behind a [`Reader`]. Get one with [`Reader::cancel_handle`]; it can be
/// cloned and sent to other threads.
#[derive(Clone)]
pub struct ReaderCancelHandle {
  /// `None` when the reader had no usable `cancel` method.
  cancel_fn: Option<Arc<BoundCancel>>,
  signal: Arc<CancelSignal>,
  env: ReaderEnv,
}

impl ReaderCancelHandle {
  /// Calls `reader.cancel(reason)` on the JavaScript reader, from any thread. `None` passes
  /// `undefined`, as `reader.cancel()` does.
  ///
  /// What happens:
  ///
  /// - The call is queued to the JavaScript thread through a threadsafe function when this
  ///   method is called (not when the future is first polled), and it runs on a later turn
  ///   of the event loop. That is also true when this method is called on the JavaScript
  ///   thread: the underlying source's `cancel` then runs after the current JavaScript call
  ///   has returned. To run it inside the current call, use
  ///   [`ReaderCancelHandle::cancel_on_js_thread`].
  /// - The threadsafe function does not keep Node.js running. If nothing else does (a
  ///   timer, a socket, other pending work), the process can exit before the queued call
  ///   runs, and then the source's `cancel` never runs.
  /// - The future does not have to be awaited: the cancel is already sent, and dropping the
  ///   future only drops the result. The compiler's warning that futures do nothing unless
  ///   polled is wrong here; drop it with `drop(handle.cancel(None));` (Clippy warns on
  ///   `let _ =` with a future). Do not block the JavaScript thread on the future: it can
  ///   only settle once that thread runs.
  /// - The [`Reader`] ends right away, without waiting for JavaScript: a task waiting for
  ///   its next chunk is woken, its next poll returns `None`, and any chunk that was read
  ///   but not yet yielded is dropped. This also holds when the JavaScript read never
  ///   settles, for example with a custom reader whose `cancel` is missing or throws. With
  ///   a standard `ReadableStream`, a read in flight is settled by the stream as done; that
  ///   result, like any read result that arrives later, is dropped.
  /// - The stream stays locked to the reader (the lock is not released), as in
  ///   JavaScript.
  /// - Calling it again is fine: a standard `ReadableStream` is already canceled then, so
  ///   the JavaScript call resolves and the underlying source's `cancel` is not called a
  ///   second time.
  ///
  /// What `reader.cancel` returned is followed exactly as `await` follows a value, by an
  /// `await` that runs on the JavaScript thread:
  ///
  /// - A native Promise (its `constructor` is the built-in `Promise`) is observed directly.
  ///   No `then` is looked up, so its own `then`, or a replaced `Promise.prototype.then` or
  ///   `Promise.prototype.catch`, makes no difference.
  /// - Any other value with a callable `then` (a custom thenable, or a Promise whose
  ///   `constructor` was changed) is adopted by calling that `then` in a microtask. A
  ///   `then`, or a `then` getter, that throws counts as a rejection.
  /// - Any other value (a custom reader's `cancel` may return `undefined`) counts as
  ///   fulfilled, because the cancel did run.
  ///
  /// The future resolves to `Ok(())` when the value fulfills, and to `Err` with the
  /// rejection's message when it rejects (for example the stream had errored, or the
  /// source's `cancel` threw); the rejection is handled, as with `await`. The future also
  /// resolves to `Err` if `cancel` throws, if the reader has no `cancel` method, or if the
  /// call cannot be queued because the environment is shutting down. Under WebAssembly
  /// (emnapi), the `await` is compiled through the global `eval`; where `eval` is blocked
  /// (a Content Security Policy without `'unsafe-eval'`), the future resolves to `Err` and
  /// the value is not followed.
  ///
  /// If the value never settles, the future stays pending. If in addition nothing can
  /// settle it any more (nobody holds its `resolve` or `reject`) and it is
  /// garbage-collected, the future resolves to `Err("ReadableStream cancel was dropped
  /// before it settled")`. If the environment shuts down (a worker exits, for example)
  /// after the call was queued but before it ran, or while the value is pending, the future
  /// resolves to `Err` as well.
  pub fn cancel(
    &self,
    reason: Option<String>,
  ) -> impl Future<Output = Result<()>> + Send + 'static {
    self.signal.cancel();
    let receiver = match &self.cancel_fn {
      None => Err(no_cancel_method()),
      Some(bound) => {
        let (sender, receiver) = oneshot::channel::<Result<()>>();
        // The sender waits in `queued` until the call runs (see `QueuedCancels`).
        match bound.queued.insert(sender) {
          None => Err(Error::new(
            Status::Closing,
            "Failed to schedule ReadableStream cancel",
          )),
          Some(key) => {
            let queued = bound.queued.clone();
            let status = bound.threadsafe.call_with_return_value(
              reason,
              ThreadsafeFunctionCallMode::NonBlocking,
              move |returned, env| {
                // Always there: the senders are only dropped once no call can run.
                if let Some(sender) = queued.take(key) {
                  settle_cancel(returned, env, sender);
                }
                // Never return an error from here: it would go to `napi_fatal_exception`.
                Ok(())
              },
            );
            if status == Status::Ok {
              Ok(receiver)
            } else {
              // Not queued, so no call will take the sender.
              drop(bound.queued.take(key));
              Err(Error::new(
                status,
                "Failed to schedule ReadableStream cancel",
              ))
            }
          }
        }
      }
    };
    cancel_outcome(receiver)
  }

  /// Calls `reader.cancel(reason)` on the JavaScript reader right away. Call it on the
  /// JavaScript thread, with the `Env` of the current call, for example in a `close()`
  /// method. `None` passes `undefined`.
  ///
  /// Unlike [`ReaderCancelHandle::cancel`], nothing is queued: with a standard
  /// `ReadableStream`, the underlying source's `cancel(reason)` has run when this method
  /// returns, as when `ImageDecoder.close()` cancels its stream in a browser. No lock is
  /// held while JavaScript runs, so the source's `cancel` may call back into the addon,
  /// even into this handle. Do not call it from a finalizer, where JavaScript cannot run.
  ///
  /// It first checks that it runs on the stream's JavaScript thread, with the stream's
  /// `env`. If not, it returns `Err` and does nothing else: the [`Reader`] keeps going and
  /// no JavaScript runs. This catches a worker that got this handle, and a handle whose
  /// environment is gone, also when a new environment got the same address. The check
  /// comes before everything else, also for a reader without a `cancel` method.
  ///
  /// After the check, the [`Reader`] ends first, as with [`ReaderCancelHandle::cancel`],
  /// and stays ended even when this returns `Err`. The stream stays locked, and calling it
  /// again is fine. A read already queued to the JavaScript thread can still call
  /// `reader.read()` after this returns; a standard `ReadableStream` answers it with done,
  /// without calling the source, and the `Reader` drops the result.
  ///
  /// It returns `Err` right away if `cancel` throws, or if the reader has no `cancel`
  /// method. Otherwise it returns a future that resolves the way the future of
  /// [`ReaderCancelHandle::cancel`] does: what `reader.cancel` returned is followed exactly
  /// as `await` follows it, including what happens when it never settles. The future is
  /// `Send + 'static` (await it on any runtime, or turn it into a JavaScript Promise). It
  /// does not have to be awaited: the cancel has already run, so
  /// `let _ = handle.cancel_on_js_thread(env, None);` is fine when the outcome does not
  /// matter.
  pub fn cancel_on_js_thread(
    &self,
    env: &Env,
    reason: Option<String>,
  ) -> Result<impl Future<Output = Result<()>> + Send + 'static> {
    // First, so that with a wrong or dead env nothing else happens.
    if !self.env.is_current(env) {
      return Err(Error::new(
        Status::InvalidArg,
        "ReaderCancelHandle::cancel_on_js_thread must be called on the stream's JavaScript thread, with its env",
      ));
    }
    self.signal.cancel();
    let Some(bound) = &self.cancel_fn else {
      return Err(no_cancel_method());
    };
    let raw_env = env.raw();
    let cancel_function = bound.js.borrow_back(env)?;
    let reason = unsafe { ToNapiValue::to_napi_value(raw_env, cancel_reason(reason))? };
    // The function is bound to the reader, so `this` does not matter.
    let mut this = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_undefined(raw_env, &mut this) },
      "Get undefined failed"
    )?;
    let mut returned = ptr::null_mut();
    let status = unsafe {
      sys::napi_call_function(
        raw_env,
        this,
        cancel_function.value,
        1,
        [reason].as_ptr(),
        &mut returned,
      )
    };
    if status == sys::Status::napi_pending_exception {
      let reason = take_exception_message(raw_env)
        .unwrap_or_else(|| "ReadableStream reader cancel threw".to_owned());
      return Err(Error::new(Status::GenericFailure, reason));
    }
    check_status!(status, "Call ReadableStream reader cancel failed")?;
    let (sender, receiver) = oneshot::channel::<Result<()>>();
    settle_cancel(
      Ok(unsafe { Unknown::from_raw_unchecked(raw_env, returned) }),
      *env,
      sender,
    );
    Ok(cancel_outcome(Ok(receiver)))
  }
}

fn no_cancel_method() -> Error {
  Error::new(
    Status::FunctionExpected,
    "ReadableStream reader has no cancel method",
  )
}

/// What the future of both cancel methods resolves to: the outcome `settle_cancel` sends,
/// or the error that kept the call from being made.
async fn cancel_outcome(receiver: Result<oneshot::Receiver<Result<()>>>) -> Result<()> {
  receiver?.await.unwrap_or_else(|_| {
    Err(Error::new(
      Status::GenericFailure,
      "ReadableStream cancel was dropped before it settled",
    ))
  })
}

/// Runs on the JavaScript thread with what the bound `reader.cancel(reason)` returned.
/// Sends the outcome through `sender` exactly once, always as an owned error that holds
/// no `napi_ref` (the receiver may drop it on any thread).
///
/// The value is followed by a real `await` in a small async function
/// ([`FOLLOW_LIKE_AWAIT`]), so it settles exactly as `await value` would: a native Promise
/// is observed through the engine's own reaction, without looking up `then`, and any other
/// thenable is adopted through its `then`. The function is compiled on each call; the
/// engine caches the compiled code, and nothing is kept per env, so there is nothing to
/// look after when the addon is loaded again or a worker ends. If the value never settles
/// and becomes garbage, or the env is torn down, the finalizers of the two callbacks drop
/// the sender.
fn settle_cancel(returned: Result<Unknown<'_>>, env: Env, sender: oneshot::Sender<Result<()>>) {
  let raw_env = env.raw();
  // Both callbacks share the sender; only the first call sends. They run on this thread.
  let slot: CancelSlot = Rc::new(Cell::new(Some(sender)));
  let setup = (|| -> Result<()> {
    // `Err` here: `cancel` threw synchronously (or its result could not be read).
    let returned = returned?;
    let follow = compile_follow_like_await(raw_env)?;
    let fulfilled = settle_function(raw_env, c"fulfilled", settle_fulfilled, slot.clone())?;
    let rejected = settle_function(raw_env, c"rejected", settle_rejected, slot.clone())?;
    let mut this = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_undefined(raw_env, &mut this) },
      "Get undefined failed"
    )?;
    // The async function returns a Promise that always fulfills (its callbacks never
    // throw), so it is dropped here.
    let mut settled = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_call_function(
          raw_env,
          this,
          follow,
          3,
          [returned.raw(), fulfilled, rejected].as_ptr(),
          &mut settled,
        )
      },
      "Follow what ReadableStream reader cancel returned failed"
    )?;
    Ok(())
  })();
  if let Err(err) = setup {
    // If an exception was left pending (for example when compiling the async function
    // failed), its message is the one to report.
    let err = match take_exception_message(raw_env) {
      Some(reason) => {
        drop(err);
        Error::new(Status::GenericFailure, reason)
      }
      None => into_owned_error(raw_env, err, "ReadableStream cancel failed"),
    };
    send_outcome(&slot, Err(err));
  }
}

/// Follows `value` exactly as `await` does, because it is `await`: for a native Promise
/// whose `constructor` is the built-in `Promise`, `await` uses the engine's own reaction
/// and looks up no `then`; any other value with a callable `then` is adopted through that
/// `then` (one that throws rejects); any other value fulfills. Both callbacks are native
/// functions that never throw, so the Promise this function returns never rejects.
const FOLLOW_LIKE_AWAIT: &CStr = c"(async (value, fulfilled, rejected) => {\
  try { await value } catch (error) { rejected(error); return }\
  fulfilled();\
})";

/// The sender of one cancel's outcome, shared by the two callbacks of `settle_cancel`.
type CancelSlot = Rc<Cell<Option<oneshot::Sender<Result<()>>>>>;

fn send_outcome(slot: &CancelSlot, result: Result<()>) {
  if let Some(sender) = slot.take() {
    // The receiver is gone only when the caller dropped the future.
    let _ = sender.send(result);
  }
}

/// Compiles and runs [`FOLLOW_LIKE_AWAIT`], which evaluates to the async function. In
/// Node.js, `napi_run_script` compiles directly (it works even with
/// `--disallow-code-generation-from-strings`); emnapi (WebAssembly) runs it through the
/// global `eval`.
fn compile_follow_like_await(env: sys::napi_env) -> Result<sys::napi_value> {
  let mut source = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_create_string_utf8(
        env,
        FOLLOW_LIKE_AWAIT.as_ptr(),
        NAPI_AUTO_LENGTH,
        &mut source,
      )
    },
    "Create the source of the ReadableStream cancel follower failed"
  )?;
  let mut follow = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_run_script(env, source, &mut follow) },
    "Compile the ReadableStream cancel follower failed"
  )?;
  Ok(follow)
}

/// A JavaScript function that runs `callback` with `slot`. The box holding `slot` belongs
/// to a `napi_wrap` finalizer on the function, so it lives as long as the function can be
/// called, and is dropped when the function is garbage-collected or the env is torn down.
fn settle_function(
  env: sys::napi_env,
  name: &CStr,
  callback: unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value,
  slot: CancelSlot,
) -> Result<sys::napi_value> {
  let data = Box::into_raw(Box::new(slot));
  let mut function = ptr::null_mut();
  let mut status = unsafe {
    sys::napi_create_function(
      env,
      name.as_ptr(),
      NAPI_AUTO_LENGTH,
      Some(callback),
      data.cast(),
      &mut function,
    )
  };
  if status == sys::Status::napi_ok {
    status = unsafe {
      sys::napi_wrap(
        env,
        function,
        data.cast(),
        Some(drop_cancel_slot),
        ptr::null_mut(),
        ptr::null_mut(),
      )
    };
  }
  if status != sys::Status::napi_ok {
    // The finalizer does not own the box. The function, if it was made, is never handed
    // out, so nothing can call it with `data`.
    drop(unsafe { Box::from_raw(data) });
  }
  check_status!(status, "Create a ReadableStream cancel callback failed")?;
  Ok(function)
}

/// `fulfilled()`: sends `Ok`. Never throws.
unsafe extern "C" fn settle_fulfilled(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut data = ptr::null_mut();
  let status = unsafe {
    sys::napi_get_cb_info(
      env,
      info,
      ptr::null_mut(),
      ptr::null_mut(),
      ptr::null_mut(),
      &mut data,
    )
  };
  if status == sys::Status::napi_ok && !data.is_null() {
    // The box is owned by the finalizer, which cannot run while the function runs.
    send_outcome(unsafe { &*data.cast::<CancelSlot>() }, Ok(()));
  }
  ptr::null_mut()
}

/// `rejected(error)`: sends `Err` with the error's message. Never throws:
/// `rejection_message` clears what a throwing `message` getter or `toString` leaves pending.
unsafe extern "C" fn settle_rejected(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut argc = 1;
  let mut argv = [ptr::null_mut(); 1];
  let mut data = ptr::null_mut();
  let status = unsafe {
    sys::napi_get_cb_info(
      env,
      info,
      &mut argc,
      argv.as_mut_ptr(),
      ptr::null_mut(),
      &mut data,
    )
  };
  if status == sys::Status::napi_ok && !data.is_null() {
    let reason = rejection_message(unsafe { Unknown::from_raw_unchecked(env, argv[0]) });
    // The box is owned by the finalizer, which cannot run while the function runs.
    send_outcome(
      unsafe { &*data.cast::<CancelSlot>() },
      Err(Error::new(Status::GenericFailure, reason)),
    );
  }
  ptr::null_mut()
}

extern "C" fn drop_cancel_slot(
  _env: sys::napi_env,
  finalize_data: *mut c_void,
  _finalize_hint: *mut c_void,
) {
  drop(unsafe { Box::from_raw(finalize_data.cast::<CancelSlot>()) });
}

/// Takes the exception pending on `env`, if there is one, and returns its message. Runs on
/// the JavaScript thread and keeps no reference to the exception.
fn take_exception_message(env: sys::napi_env) -> Option<String> {
  let mut pending = false;
  if unsafe { sys::napi_is_exception_pending(env, &mut pending) } != sys::Status::napi_ok
    || !pending
  {
    return None;
  }
  let mut exception = ptr::null_mut();
  if unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) } != sys::Status::napi_ok
    || exception.is_null()
  {
    return None;
  }
  Some(rejection_message(unsafe {
    Unknown::from_raw_unchecked(env, exception)
  }))
}

/// Turns an error caught on the JavaScript thread into one that holds no `napi_ref`.
///
/// It clears any exception left pending (a throwing `then`/`catch` getter, for example),
/// which would otherwise wedge later napi calls on this thread. `err` may own a reference
/// to a JavaScript exception; it is dropped here, on the JavaScript thread, because
/// releasing that reference on another thread aborts the process.
fn into_owned_error(env: sys::napi_env, err: Error, context: &str) -> Error {
  let mut pending_exception = ptr::null_mut();
  unsafe {
    sys::napi_get_and_clear_last_exception(env, &mut pending_exception);
  }
  let reason = if err.reason.is_empty() {
    format!("{context}: {}", err.status)
  } else {
    err.reason.clone()
  };
  drop(err);
  Error::new(Status::GenericFailure, reason)
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

impl<T: FromNapiValue + 'static> Drop for Reader<T> {
  fn drop(&mut self) {
    // Cancel handles and read callbacks can keep the signal alive after the reader.
    self.state.signal.release_waker();
    // The callbacks of a read in flight keep `state` alive until the read settles, which
    // may be never. They must not keep the task's waker too; their `finally` then finds
    // no waker to wake. Dropped after the lock is released.
    let waker = self
      .state
      .inner
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner)
      .waker
      .take();
    drop(waker);
  }
}

impl<T: FromNapiValue + 'static> futures_core::Stream for Reader<T> {
  type Item = Result<T>;

  fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
    // Let a cancel wake this task. Registered before the flag is checked below, so a
    // cancel that comes after the check still wakes it (see `CancelSignal`).
    self.state.signal.waker.register(cx.waker());
    let issue_read = {
      let mut inner = self
        .state
        .inner
        .lock()
        .map_err(|_| Error::new(Status::InvalidArg, "Poisoned lock in Reader::poll_next"))?;
      // 0. A canceled reader ends at once; drop whatever was buffered.
      if self.state.signal.is_cancelled() {
        inner.chunk = Ok(None);
        inner.done = true;
        inner.waker = None;
        self.state.signal.release_waker();
        return Poll::Ready(None);
      }
      // 1. Surface any buffered chunk or error first.
      match mem::replace(&mut inner.chunk, Ok(None)) {
        Ok(Some(chunk)) => return Poll::Ready(Some(Ok(chunk))),
        Err(err) => {
          // An error always ends the stream (`done` is set with it).
          self.state.signal.release_waker();
          return Poll::Ready(Some(Err(err)));
        }
        Ok(None) => {}
      }
      // 2. If the stream finished (or errored) and nothing is buffered, end iteration.
      if inner.done {
        self.state.signal.release_waker();
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
                // handler-attach step failed *after* this `then` was registered), or the
                // reader was canceled. Drop the late settlement rather than resurrect a
                // chunk after the end.
                if inner.done || state.signal.is_cancelled() {
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
                // If the stream already terminated (setup-error path) or the reader was
                // canceled, drop this late rejection rather than surface a second
                // terminal error after the end.
                if inner.done || state_in_catch.signal.is_cancelled() {
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
            // consumer. `into_owned_error` clears it here, on the JS thread (a no-op
            // when nothing is pending, e.g. the synchronous `read()` throw path).
            //
            // `err` can also own a JS exception reference (`maybe_raw`) — e.g. when the
            // bound `read()` threw synchronously, the threadsafe call wraps the
            // exception. `Reader<T>` is `Send`, so the stored error may be surfaced or
            // dropped on the Tokio thread; dropping a `napi_ref` off the JS thread
            // aborts the process / is UB (the same hazard the `catch` path avoids).
            // `into_owned_error` rebuilds a reference-free OWNED error here on the JS
            // thread and drops the original now, so any reference is released on this
            // (JS) thread.
            let owned = into_owned_error(env.raw(), err, "ReadableStream read failed");
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
        self.state.signal.release_waker();
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
