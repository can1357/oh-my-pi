use std::convert::{From, TryFrom};
use std::error;
use std::ffi::CStr;
use std::fmt;
#[cfg(feature = "serde-json")]
use std::fmt::Display;
use std::os::raw::c_void;
use std::ptr;

#[cfg(feature = "serde-json")]
use serde::{de, ser};
#[cfg(feature = "serde-json")]
use serde_json::Error as SerdeJSONError;

#[cfg(target_family = "wasm")]
use crate::bindgen_runtime::JsObjectValue;
use crate::ValueType;
use crate::{bindgen_runtime::ToNapiValue, sys, Env, JsValue, Status, Unknown};

pub type Result<T, S = Status> = std::result::Result<T, Error<S>>;

/// Property key of the private holder object used to retain a JS value that
/// `napi_create_reference` cannot reference directly. See
/// [`Error::from_unknown_without_coercion`].
const ERROR_VALUE_KEY: &CStr = c"[[ErrorValue]]";

/// Represent `JsError`.
/// Return this Error in `js_function`, **napi-rs** will throw it as `JsError` for you.
/// If you want throw it as `TypeError` or `RangeError`, you can use `JsTypeError/JsRangeError::from(Error).throw_into(env)`
pub struct Error<S: AsRef<str> = Status> {
  pub status: S,
  pub reason: String,
  pub cause: Option<Box<Error>>,
  // A JS-exception-derived `Error` (`From<Unknown>`, or a ThreadsafeFunction
  // JS-throw) owns a `napi_ref` to the original JS error object, kept behind a
  // shared, reference-counted [`ErrorRef`]. `try_clone` clones this `Arc` — an
  // atomic bump with no napi FFI — so siblings can be sent across threads while
  // the single underlying `napi_ref` is released exactly once, by the last
  // `Arc`, on (or routed to) the owning JS thread. `None` for errors that hold
  // no JS reference (Rust-constructed, or a WASM error built from a JS value).
  pub(crate) maybe_ref: Option<std::sync::Arc<ErrorRef>>,
}

/// Shared owner of a JS error object's thread-affine `napi_ref`.
///
/// One `ErrorRef` backs an `Error` derived from a JS exception and every
/// `try_clone` of it. The `napi_ref` is created once at refcount 1 and is never
/// ref/unref'd for cloning — the number of live `Error` clones is tracked by the
/// `Arc<ErrorRef>` strong count instead (a pure atomic, safe from any thread).
/// The reference itself is released exactly once, when the last `Arc` drops,
/// from `ErrorRef::drop` (directly on the owning JS thread, or routed there via
/// the env's custom-GC TSFN when the last drop happens elsewhere).
pub(crate) struct ErrorRef {
  raw: sys::napi_ref,
  // `true` when `raw` references a private holder object carrying the retained
  // value under [`ERROR_VALUE_KEY`] instead of the value itself. Reads unwrap
  // the holder, so the distinction never escapes `Error`.
  indirect: bool,
  env: sys::napi_env,
  // The thread `raw` was created on, i.e. the only thread whose napi
  // implementation can resolve `env`. Every access to `raw` is gated on it, so a
  // reference that reaches a foreign thread is read as absent and, when no
  // custom-GC handle is available to route the release, deliberately leaked
  // rather than freed off-thread. This is the last line of defence behind
  // `custom_gc`; it is what makes the reference safe on `wasm32-wasip1-threads`,
  // where each agent owns a private `napi_env` table and an off-thread call
  // resolves `env` to `undefined` instead of merely racing.
  owner_thread: std::thread::ThreadId,
  // The owning env's custom-GC handle, captured on the owning JS thread when
  // `raw` is created. Lets the release run safely from any thread: the
  // `napi_ref` is thread-affine, so `napi_reference_unref`/`napi_delete_reference`
  // must run on the owning JS thread (releasing elsewhere mutates V8's
  // `GlobalHandles` concurrently with the JS thread and corrupts it).
  #[cfg(all(feature = "napi4", not(feature = "noop")))]
  custom_gc: Option<std::sync::Arc<crate::bindgen_prelude::CustomGcHandle>>,
}

// SAFETY: the raw `napi_ref`/`napi_env` are only ever dereferenced via napi FFI
// on the owning JS thread — `Error::referenced_value` gates reads on `env`
// identity, `owner_thread` and `current_thread_owns_custom_gc`, and
// `ErrorRef::drop` releases on the owning thread directly, routes the release
// through the env's custom-GC TSFN, or leaks. Moving or sharing an `ErrorRef`
// (and cloning its `Arc`) only copies/reads the pointer values; it never touches
// V8 off-thread. The captured `Arc<CustomGcHandle>` is itself `Send + Sync`.
// Mirrors the `unsafe impl Send/Sync for Error`.
unsafe impl Send for ErrorRef {}
unsafe impl Sync for ErrorRef {}

impl ErrorRef {
  /// Wraps a freshly created (`refcount == 1`) JS error `napi_ref`, capturing
  /// the current thread's identity and custom-GC handle. Must be called on the
  /// owning JS thread with a non-null `raw`. Every construction site builds an
  /// `ErrorRef` only after `napi_create_reference` succeeds, so `ErrorRef::drop`
  /// can release without a null check.
  pub(crate) fn new(raw: sys::napi_ref, env: sys::napi_env) -> Self {
    debug_assert!(!raw.is_null(), "ErrorRef must wrap a non-null napi_ref");
    // An `Error` is `Send`, so the `Arc<ErrorRef>` inside it can make its last
    // drop on a detached thread after the environment that created it — and the
    // worker that hosted that environment — are gone. Node then unloads a
    // worker-only addon, and `ErrorRef::drop` is code in that image: it crashes
    // on entry, before it could ever observe the aborted custom-GC handle. Pin
    // the image here, at construction, on the environment's own thread — the
    // same reasoning as `ThreadsafeFunctionHandle::new`: environment teardown
    // marks the custom-GC handle aborted and the drop path then no-ops, so a
    // pin placed anywhere on the drop path is skipped in exactly the
    // worker-teardown case it exists for. The pin happens at most once per
    // process; repeats are a single atomic increment. wasm has no loader and no
    // image to unmap.
    #[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
    crate::bindgen_runtime::retain_current_module_for_unload_safety();
    Self {
      raw,
      indirect: false,
      env,
      owner_thread: std::thread::current().id(),
      #[cfg(all(feature = "napi4", not(feature = "noop")))]
      custom_gc: crate::bindgen_prelude::current_custom_gc_handle(),
    }
  }

  /// Same as [`ErrorRef::new`], but `raw` references a holder object whose
  /// [`ERROR_VALUE_KEY`] property is the retained value.
  fn new_indirect(raw: sys::napi_ref, env: sys::napi_env) -> Self {
    let mut value = Self::new(raw, env);
    value.indirect = true;
    value
  }
}

/// Releases a JS error's `napi_ref` on the owning JS thread: unref to 0, then
/// delete. Called exactly once, from `ErrorRef::drop`.
#[cfg(not(feature = "noop"))]
fn release_error_reference(env: sys::napi_env, reference: sys::napi_ref) {
  let mut ref_count = 0;
  let status = unsafe { sys::napi_reference_unref(env, reference, &mut ref_count) };
  if status != sys::Status::napi_ok {
    eprintln!("unref error reference failed: {}", Status::from(status));
    // `ref_count` is meaningless when the unref failed, so deleting on the
    // strength of it would be a guess. Leave the reference to env teardown.
    return;
  }
  if ref_count == 0 {
    let status = unsafe { sys::napi_delete_reference(env, reference) };
    if status != sys::Status::napi_ok {
      eprintln!("delete error reference failed: {}", Status::from(status));
    }
  }
}

#[cfg(not(feature = "noop"))]
impl Drop for ErrorRef {
  fn drop(&mut self) {
    #[cfg(all(feature = "napi4", not(feature = "noop")))]
    if let Some(handle) = self.custom_gc.take() {
      let env = self.env;
      let raw = self.raw;
      // Read-lock held across the call so the custom-GC TSFN can't be
      // finalized mid-call (same protocol as ArrayBuffer/TypedArray drops).
      handle.with_read_aborted(|aborted| {
        if aborted {
          // The owning env is gone and V8 has already invalidated the
          // reference — releasing it now would be a use-after-free. Leaking
          // it is safe: the env teardown reclaimed the handle's storage.
          return;
        }
        if crate::bindgen_prelude::current_thread_owns_custom_gc(&handle) {
          release_error_reference(env, raw);
        } else {
          // The last `Arc` dropped off the owning JS thread. Route the release
          // through the env's custom-GC TSFN, exactly like Buffer/TypedArray
          // drops.
          let status =
            unsafe { sys::napi_call_threadsafe_function(handle.get_raw(), raw.cast(), 1) };
          assert!(
            status == sys::Status::napi_ok || status == sys::Status::napi_closing,
            "Call custom GC in ErrorRef::drop failed {}",
            Status::from(status)
          );
        }
      });
      return;
    }
    // No custom-GC handle captured (pre-napi4 build, or the reference was
    // created before module registration), so there is nothing to route the
    // release through. Releasing is only correct on the owning JS thread; from
    // anywhere else, leak instead. The leak is bounded — env teardown reclaims
    // the reference — whereas an off-thread `napi_reference_unref` corrupts V8's
    // `GlobalHandles` on native and, on `wasm32-wasip1-threads`, faults inside
    // the emnapi shim because the calling agent has no entry for `env`.
    if self.owner_thread != std::thread::current().id() {
      return;
    }
    release_error_reference(self.env, self.raw);
  }
}

impl<S: AsRef<str>> Error<S> {
  pub fn set_cause(&mut self, cause: Error) {
    self.cause = Some(Box::new(cause));
  }
}

impl<S: AsRef<str>> std::fmt::Debug for Error<S> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    write!(
      f,
      "Error {{ status: {:?}, reason: {:?} }}",
      self.status.as_ref(),
      self.reason
    )
  }
}

impl<S: AsRef<str>> ToNapiValue for Error<S> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    if let Some(value) = unsafe { val.referenced_value(env) } {
      // Reuse the original JS error object (keeps its subclass, stack, and own
      // properties). The shared `napi_ref` is released when `val`'s `Arc` drops.
      Ok(value)
    } else {
      // No JS reference, or converting off the owning thread: rebuild a fresh
      // error from `status`/`reason`/`cause`.
      Ok(unsafe { JsError::from(val).into_value(env) })
    }
  }
}

unsafe impl<S> Send for Error<S> where S: Send + AsRef<str> {}
unsafe impl<S> Sync for Error<S> where S: Sync + AsRef<str> {}

impl<S: AsRef<str> + std::fmt::Debug> error::Error for Error<S> {}

impl<S: AsRef<str>> From<std::convert::Infallible> for Error<S> {
  fn from(_: std::convert::Infallible) -> Self {
    unreachable!()
  }
}

#[cfg(feature = "serde-json")]
impl ser::Error for Error {
  fn custom<T: Display>(msg: T) -> Self {
    Error::new(Status::InvalidArg, msg.to_string())
  }
}

#[cfg(feature = "serde-json")]
impl de::Error for Error {
  fn custom<T: Display>(msg: T) -> Self {
    Error::new(Status::InvalidArg, msg.to_string())
  }
}

#[cfg(feature = "serde-json")]
impl From<SerdeJSONError> for Error {
  fn from(value: SerdeJSONError) -> Self {
    Error::new(Status::InvalidArg, format!("{value}"))
  }
}

#[cfg(not(target_family = "wasm"))]
impl From<Unknown<'_>> for Error {
  fn from(value: Unknown) -> Self {
    let mut result = std::ptr::null_mut();
    let status = unsafe { sys::napi_create_reference(value.0.env, value.0.value, 1, &mut result) };
    if status != sys::Status::napi_ok {
      return Error::new(
        Status::from(status),
        "Create Error reference failed".to_owned(),
      );
    }
    let maybe_env = value.0.env;
    let maybe_error_message = value
      .coerce_to_string()
      .and_then(|a| a.into_utf8().and_then(|a| a.into_owned()));
    let maybe_cause = extract_error_cause(value).unwrap_or(None);

    if let Ok(error_message) = maybe_error_message {
      return Self {
        status: Status::GenericFailure,
        reason: error_message,
        cause: maybe_cause,
        maybe_ref: Some(std::sync::Arc::new(ErrorRef::new(result, maybe_env))),
      };
    }

    Self {
      status: Status::GenericFailure,
      reason: "".to_string(),
      cause: maybe_cause,
      maybe_ref: Some(std::sync::Arc::new(ErrorRef::new(result, maybe_env))),
    }
  }
}

#[cfg(target_family = "wasm")]
impl From<Unknown<'_>> for Error {
  fn from(value: Unknown) -> Self {
    let value_type = value.get_type();

    let maybe_error_message;

    if let Ok(vt) = value_type {
      if vt == ValueType::Object {
        maybe_error_message = value
          .coerce_to_object()
          .and_then(|obj| obj.get_named_property::<Unknown>("message"))
          .and_then(|message| {
            message
              .coerce_to_string()
              .and_then(|message| message.into_utf8().and_then(|message| message.into_owned()))
          });
      } else {
        maybe_error_message = value
          .coerce_to_string()
          .and_then(|a| a.into_utf8().and_then(|a| a.into_owned()));
      }
    } else {
      maybe_error_message = value
        .coerce_to_string()
        .and_then(|a| a.into_utf8().and_then(|a| a.into_owned()));
    };

    let maybe_cause = extract_error_cause(value).unwrap_or(None);

    if let Ok(error_message) = maybe_error_message {
      return Self {
        status: Status::GenericFailure,
        reason: error_message,
        cause: maybe_cause,
        maybe_ref: None,
      };
    }

    Self {
      status: Status::GenericFailure,
      reason: "".to_string(),
      cause: maybe_cause,
      maybe_ref: None,
    }
  }
}

impl Error {
  /// Captures an arbitrary JavaScript value as an `Error` without coercing it.
  ///
  /// JavaScript allows *any* value to be thrown or used to reject a promise, but
  /// [`From<Unknown>`] assumes an object: it calls `napi_create_reference` on the
  /// value and then `napi_coerce_to_string` on it. Both are wrong for a value
  /// that is not an object:
  ///
  /// * `napi_create_reference` rejects primitives with `napi_invalid_arg` on
  ///   Node-API < 10, so `Promise.reject('boom')` observed from Rust collapses to
  ///   `Error { InvalidArg, "Create Error reference failed" }` and the thrown
  ///   value is lost.
  /// * `napi_coerce_to_string` invokes `toString`/`Symbol.toPrimitive`, i.e.
  ///   arbitrary user code, while unwinding an error — which can throw again and
  ///   leave a second exception pending.
  ///
  /// This constructor does neither. The value is retained behind a private
  /// holder object, which `napi_create_reference` accepts for every value type,
  /// so converting the `Error` back with [`ToNapiValue`] reproduces the original
  /// value *identically* — same object identity, same primitive, no `Error`
  /// wrapper synthesized around it.
  ///
  /// [`Error::reason`] and [`Error::cause`] are filled in only from data that is
  /// readable **without running JavaScript**: a string primitive is copied
  /// verbatim, and a value `napi_is_error` accepts has its `message` and `cause`
  /// read as *data properties*. Every other value (a plain object, a number,
  /// `null`) yields an empty reason and relies on the retained value to carry the
  /// information back to JavaScript.
  ///
  /// `message` and `cause` are not read with `napi_get_named_property`, which is
  /// an ordinary `[[Get]]` and would run a `get message()` accessor. Node-API has
  /// no descriptor read — there is no `napi_get_own_property_descriptor` through
  /// Node-API 10 — so the lookup goes through `Reflect.getOwnPropertyDescriptor`,
  /// walking the prototype chain with `napi_get_prototype`. A **data** descriptor
  /// contributes its `value`; an **accessor** descriptor stops the walk and is
  /// never invoked, leaving the reason empty (or the cause absent). Reading
  /// `.value` off the returned descriptor is safe: it is a fresh ordinary object
  /// the specification just created.
  ///
  /// Two honest caveats:
  ///
  /// * A [`Proxy`] still runs its `getOwnPropertyDescriptor` and `getPrototypeOf`
  ///   traps. There is no way to interrogate a proxy without waking it up. (In
  ///   practice `napi_is_error` returns `false` for a proxy over an `Error`, so
  ///   this path is usually not even entered.)
  /// * `Reflect.getOwnPropertyDescriptor` is resolved **once per env, at module
  ///   registration**, and kept behind a `napi_ref` for that env's lifetime.
  ///   Reading `Reflect` off the global object is itself an ordinary `[[Get]]` —
  ///   `globalThis.Reflect` is configurable, so user code can redefine it as an
  ///   accessor — and a per-capture read would run that accessor *while an error
  ///   is unwinding*: arbitrary user code, possibly reentering the addon, with
  ///   side effects no cleared exception can undo. Resolving at registration
  ///   moves the one unavoidable `[[Get]]` to a defined moment (the `require()`
  ///   of the addon) and makes capture immune to later patching. The trade-off
  ///   is deliberate: a `Reflect` patched *after* load is ignored by capture
  ///   rather than observed on the next call. An env whose registration found
  ///   `Reflect` missing, not an object, or without a callable
  ///   `getOwnPropertyDescriptor` — like an env that never registered this
  ///   addon — degrades to an empty reason and absent cause; the retained value
  ///   is unaffected. Capture never falls back to a `[[Get]]`, on the global or
  ///   on `message`. The pair registration finds is trusted the way the addon's
  ///   own exports are trusted: code that ran *before* the addon loaded can have
  ///   replaced it, and Node-API offers no way to tell (no descriptor-read
  ///   primitive, no fresh realm, no pristine reference to compare against) —
  ///   nor any way to defend, since a pre-load adversary can just as well wrap
  ///   the addon's exports themselves. Registration does, however, put the
  ///   candidate through a behavioral sanity probe against an object of known,
  ///   non-interposable shape; a candidate that misreports it — a broken shim, a
  ///   crude interposer — is dropped at that defined moment and the env degrades
  ///   to an empty reason and absent cause permanently, instead of the impostor
  ///   running during every capture.
  ///
  /// Every failure along the way is swallowed with its pending exception cleared,
  /// so a hostile value cannot poison the environment or become the reported
  /// error.
  ///
  /// [`Proxy`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
  ///
  /// Identity is reproduced only when the `Error` is converted back on the env
  /// and thread that captured it, which is where JavaScript can observe it
  /// anyway. Converted anywhere else — the `Error` was moved to a worker, or the
  /// owning env is gone — a fresh error is built from [`Error::reason`] instead,
  /// because a `napi_ref` cannot be resolved outside its own env.
  ///
  /// Identity also depends on the conversion used. The [`ToNapiValue`] impls —
  /// for `Error` itself and for `JsError`/`JsTypeError`/`JsRangeError` — hand the
  /// retained value back untouched, which is what the settlement paths (promise
  /// rejection, `AsyncGenerator.throw()`, a throw out of a ThreadsafeFunction
  /// callback) rely on. Only the two APIs that *construct* an error object gate
  /// reuse on `napi_is_error` and otherwise synthesize one from
  /// [`Error::reason`]: `JsError::into_value` (the synchronous throw path) and
  /// [`Env::create_error`]. So a retained non-`Error` survives a rejection and a
  /// `JsTypeError` return value, but not a `create_error`.
  ///
  /// When there is nothing to reuse, the synthesized error keeps the constructor
  /// its wrapper names: a `JsTypeError` becomes a `TypeError`, a `JsRangeError` a
  /// `RangeError`.
  ///
  /// [`Env::create_error`]: crate::Env::create_error
  ///
  /// The `cause` chain is captured the same way, up to eight links.
  /// The retained value carries its own `cause` back to JavaScript, but the
  /// fallback path — off-thread, or a foreign env, exactly where the retained
  /// value is gone — has nothing but this chain to rebuild from, and
  /// `JsError::into_value` does set `cause` on the error it synthesizes. The
  /// depth limit is what keeps a cyclic chain (`a.cause = b; b.cause = a`) from
  /// recursing forever; [`From<Unknown>`] overflows the stack on exactly that
  /// input.
  ///
  /// Use it wherever JavaScript decides the value and its identity must survive
  /// the round trip: `Promise` rejection handlers, `AsyncGenerator.throw()` and
  /// a throw out of a ThreadsafeFunction callback all do. Prefer
  /// [`From<Unknown>`] when the value is known to be an `Error` and a
  /// human-readable rendering (including the stack trace) matters more than
  /// exact identity.
  pub fn from_unknown_without_coercion(value: Unknown<'_>) -> Self {
    error_without_coercion(value, MAX_CAUSE_DEPTH)
  }
}

/// How many `cause` links [`Error::from_unknown_without_coercion`] follows.
///
/// `cause` chains are user data and may be cyclic, so the walk has to be
/// bounded. Eight links is far past anything a human writes and keeps the
/// captured error small.
const MAX_CAUSE_DEPTH: usize = 8;

/// How many prototypes a property lookup walks before giving up.
///
/// Ordinary prototype chains are short and acyclic, but a `Proxy` can return a
/// fresh object from its `getPrototypeOf` trap every time, so the walk needs a
/// bound of its own.
const MAX_PROTOTYPE_DEPTH: usize = 32;

/// Body of [`Error::from_unknown_without_coercion`], carrying the remaining
/// `cause` budget so the chain can be captured without unbounded recursion.
fn error_without_coercion(value: Unknown<'_>, cause_budget: usize) -> Error {
  Error {
    status: Status::GenericFailure,
    reason: owned_reason_without_coercion(value),
    cause: cause_without_coercion(value, cause_budget),
    maybe_ref: retain_value_without_coercion(value),
  }
}

/// Retains `value` so it can be handed back to JavaScript unchanged.
///
/// `napi_create_reference` only accepts objects, functions, and symbols before
/// Node-API 10, so the value is stashed as a plain data property on a private
/// holder object and the holder is what gets referenced. [`ErrorRef::indirect`]
/// records that reads have to unwrap it.
fn retain_value_without_coercion(value: Unknown<'_>) -> Option<std::sync::Arc<ErrorRef>> {
  let env = value.0.env;
  let mut holder = ptr::null_mut();
  if unsafe { sys::napi_create_object(env, &mut holder) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return None;
  }
  let properties = [sys::napi_property_descriptor {
    utf8name: ERROR_VALUE_KEY.as_ptr().cast(),
    name: ptr::null_mut(),
    method: None,
    getter: None,
    setter: None,
    value: value.0.value,
    attributes: sys::PropertyAttributes::default,
    data: ptr::null_mut(),
  }];
  let status =
    unsafe { sys::napi_define_properties(env, holder, properties.len(), properties.as_ptr()) };
  if status != sys::Status::napi_ok {
    clear_pending_exception(env);
    return None;
  }
  let mut reference = ptr::null_mut();
  if unsafe { sys::napi_create_reference(env, holder, 1, &mut reference) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return None;
  }
  Some(std::sync::Arc::new(ErrorRef::new_indirect(reference, env)))
}

/// Best-effort [`Error::reason`] for [`Error::from_unknown_without_coercion`],
/// derived without coercing anything and without running any JavaScript: the
/// `message` read below goes through a descriptor lookup and refuses to invoke a
/// `get message()` accessor. See [`Error::from_unknown_without_coercion`].
fn owned_reason_without_coercion(value: Unknown<'_>) -> String {
  let env = value.0.env;
  if is_error_without_coercion(value) {
    return data_property_without_get(env, value.0.value, c"message")
      .and_then(|message| owned_string_without_coercion(env, message))
      .unwrap_or_else(|| "JavaScript Error".to_owned());
  }
  // A string primitive is its own message; reading it is a plain copy, not a
  // coercion, so `throw 'boom'` still surfaces as `"boom"` on the Rust side.
  owned_string_without_coercion(env, value.0.value).unwrap_or_default()
}

/// Best-effort [`Error::cause`] for [`Error::from_unknown_without_coercion`],
/// read with the same descriptor discipline as the reason: a `get cause()`
/// accessor is detected and left alone rather than invoked.
///
/// The chain is followed for at most `budget` more links, so a cyclic `cause`
/// chain terminates instead of recursing until the stack runs out.
fn cause_without_coercion(value: Unknown<'_>, budget: usize) -> Option<Box<Error>> {
  if budget == 0 {
    return None;
  }
  let env = value.0.env;
  // Only objects and functions can carry an own `cause`; asking for a
  // descriptor on anything else throws a `TypeError`.
  if !matches!(
    type_without_coercion(env, value.0.value)?,
    sys::ValueType::napi_object | sys::ValueType::napi_function
  ) {
    return None;
  }
  let raw_cause = data_property_without_get(env, value.0.value, c"cause")?;
  // An absent `cause`, and an explicit `cause: undefined` or `cause: null`, all
  // mean "no cause" — the same rule `extract_error_cause` applies.
  if matches!(
    type_without_coercion(env, raw_cause)?,
    sys::ValueType::napi_undefined | sys::ValueType::napi_null
  ) {
    return None;
  }
  let cause = unsafe { Unknown::from_raw_unchecked(env, raw_cause) };
  Some(Box::new(error_without_coercion(cause, budget - 1)))
}

/// `napi_is_error` without the `check_status!` machinery: a failure here means
/// the value simply is not treated as an `Error`.
fn is_error_without_coercion(value: Unknown<'_>) -> bool {
  let env = value.0.env;
  let mut is_error = false;
  if unsafe { sys::napi_is_error(env, value.0.value, &mut is_error) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return false;
  }
  is_error
}

/// `napi_typeof`, reporting a failure as `None` instead of a status.
fn type_without_coercion(
  env: sys::napi_env,
  value: sys::napi_value,
) -> Option<sys::napi_valuetype> {
  let mut value_type = -1;
  if unsafe { sys::napi_typeof(env, value, &mut value_type) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return None;
  }
  Some(value_type)
}

/// The load-time `Reflect` / `Reflect.getOwnPropertyDescriptor` pair of the env
/// this thread registered, kept as own data properties of a private holder
/// object behind a single `napi_ref`.
struct ReflectIntrinsics {
  env: sys::napi_env,
  holder: sys::napi_ref,
  // Whether `napi_add_env_cleanup_hook` SUCCEEDED for this env. Only then does
  // a later pointer-equal entry prove the env is alive: the hook clears the
  // slot at teardown, so a stale entry cannot survive to be matched. Without
  // it (pre-napi3, or a hook call that failed) an embedder can tear the env
  // down and receive the same `napi_env` address for a new one — and deleting
  // the superseded reference through that recycled pointer would hand a dead
  // ref to a live env. Only `cache_reflect_intrinsics_for_env` reads it, so it
  // goes dead when `noop` compiles that registration out.
  #[cfg_attr(feature = "noop", allow(dead_code))]
  cleanup_hook_installed: bool,
}

thread_local! {
  // One slot per OS thread, keyed by env — the same one-env-per-OS-thread
  // invariant `CURRENT_CUSTOM_GC_HANDLE` documents and relies on. Installed by
  // `cache_reflect_intrinsics_for_env` on the registering (env's own) thread;
  // read by `reflect_get_own_property_descriptor` on that same thread, which is
  // the only thread whose napi implementation can resolve the env at all.
  static REFLECT_INTRINSICS: std::cell::RefCell<Option<ReflectIntrinsics>> =
    const { std::cell::RefCell::new(None) };
}

#[cfg(not(feature = "noop"))]
thread_local! {
  // Counts invocations of the probe object's accessor getter, so
  // `probe_get_own_property_descriptor` can prove the candidate descriptor
  // reader did not fall back to a `[[Get]]`. Thread-local for the same
  // one-env-per-OS-thread reason as `REFLECT_INTRINSICS`; registration and the
  // probe calls all run on the env's own thread.
  static PROBE_ACCESSOR_HITS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Native getter installed on the probe object's `accessor` property. A
/// specification-conforming `Reflect.getOwnPropertyDescriptor` reports the
/// accessor without invoking it; anything that lands here reads properties
/// with a `[[Get]]` instead, which is exactly the behavior the capture path
/// must never trigger.
#[cfg(not(feature = "noop"))]
unsafe extern "C" fn probe_accessor_getter(
  env: sys::napi_env,
  _info: sys::napi_callback_info,
) -> sys::napi_value {
  PROBE_ACCESSOR_HITS.with(|hits| hits.set(hits.get().saturating_add(1)));
  let mut undefined = ptr::null_mut();
  if unsafe { sys::napi_get_undefined(env, &mut undefined) } != sys::Status::napi_ok {
    return ptr::null_mut();
  }
  undefined
}

/// Behavioral sanity probe for the `getOwnPropertyDescriptor` candidate
/// resolved at registration: exercises it against a freshly created object of
/// known shape and accepts it only if it behaves like the intrinsic.
///
/// **Why a behavioral check and not provenance:** provenance cannot be
/// established through Node-API at all. There is no descriptor-read primitive
/// (`napi_get_own_property_descriptor` does not exist through Node-API 10), no
/// non-`[[Get]]` read of the global, no fresh-realm primitive
/// (`napi_run_script` evaluates in the same, already-patched realm), no proxy
/// detection, and no pristine reference to `napi_strict_equals` against —
/// obtaining one is the very problem. Any "is this native code" check via
/// `Function.prototype.toString` is itself a call through a patchable callable.
/// So the candidate is *trusted the way the module's own exports are trusted*:
/// code that runs before the addon loads sits inside the addon's trust boundary
/// — it can wrap `require`, replace the loader, or interpose every export — and
/// no addon can defend against it. What this probe adds is a *defined moment of
/// failure* for a candidate that is broken (a buggy shim, a crude interposer):
/// it is caught here, at registration, and the env degrades to an empty
/// reason/cause permanently instead of invoking the impostor during every
/// capture. A sophisticated adversary that passes the probe and misbehaves
/// later is inside the pre-load trust boundary, exactly like one that patched
/// the module exports themselves.
///
/// The probe object is created with `napi_create_object` +
/// `napi_define_properties`, which construct the object directly — its shape
/// cannot be interposed from JavaScript. Three calls are made:
///
/// * `gopd(probe, "data")` must yield a descriptor whose own `value` is
///   strict-equal to the sentinel;
/// * `gopd(probe, "accessor")` must yield a descriptor with an own `get` and
///   **no** own `value`, and the native getter must not have run;
/// * `gopd(probe, "missing")` must yield `undefined`.
///
/// Reading `value` off a returned descriptor object may run user code when the
/// candidate is hostile enough to return a proxy — acceptable here: the probe
/// runs at registration, the same defined moment as the `[[Get]]` of `Reflect`
/// itself, never mid-capture, and any misbehavior (a throw, a wrong shape)
/// fails the probe.
#[cfg(not(feature = "noop"))]
fn probe_get_own_property_descriptor(
  env: sys::napi_env,
  reflect: sys::napi_value,
  get_own_property_descriptor: sys::napi_value,
) -> bool {
  let create_string = |key: &CStr| -> Option<sys::napi_value> {
    let bytes = key.to_bytes();
    let mut value = ptr::null_mut();
    if unsafe {
      sys::napi_create_string_utf8(env, bytes.as_ptr().cast(), bytes.len() as isize, &mut value)
    } != sys::Status::napi_ok
    {
      clear_pending_exception(env);
      return None;
    }
    Some(value)
  };
  let Some(sentinel) = create_string(c"napi-rs reflect probe") else {
    return false;
  };
  let mut probe = ptr::null_mut();
  if unsafe { sys::napi_create_object(env, &mut probe) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return false;
  }
  let properties = [
    sys::napi_property_descriptor {
      utf8name: c"data".as_ptr().cast(),
      name: ptr::null_mut(),
      method: None,
      getter: None,
      setter: None,
      value: sentinel,
      attributes: sys::PropertyAttributes::default,
      data: ptr::null_mut(),
    },
    sys::napi_property_descriptor {
      utf8name: c"accessor".as_ptr().cast(),
      name: ptr::null_mut(),
      method: None,
      getter: Some(probe_accessor_getter),
      setter: None,
      value: ptr::null_mut(),
      attributes: sys::PropertyAttributes::default,
      data: ptr::null_mut(),
    },
  ];
  if unsafe { sys::napi_define_properties(env, probe, properties.len(), properties.as_ptr()) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return false;
  }
  let call_candidate = |key: &CStr| -> Option<sys::napi_value> {
    let key_value = create_string(key)?;
    let args = [probe, key_value];
    let mut descriptor = ptr::null_mut();
    if unsafe {
      sys::napi_call_function(
        env,
        reflect,
        get_own_property_descriptor,
        args.len(),
        args.as_ptr(),
        &mut descriptor,
      )
    } != sys::Status::napi_ok
    {
      clear_pending_exception(env);
      return None;
    }
    Some(descriptor)
  };
  let has_own = |object: sys::napi_value, key: &CStr| -> Option<bool> {
    let key_value = create_string(key)?;
    let mut result = false;
    if unsafe { sys::napi_has_own_property(env, object, key_value, &mut result) }
      != sys::Status::napi_ok
    {
      clear_pending_exception(env);
      return None;
    }
    Some(result)
  };
  let hits_before = PROBE_ACCESSOR_HITS.with(|hits| hits.get());

  // A data property must come back as a descriptor whose own `value` is the
  // sentinel, verbatim.
  let Some(descriptor) = call_candidate(c"data") else {
    return false;
  };
  if type_without_coercion(env, descriptor) != Some(sys::ValueType::napi_object) {
    return false;
  }
  if has_own(descriptor, c"value") != Some(true) {
    return false;
  }
  let mut reported = ptr::null_mut();
  if unsafe { sys::napi_get_named_property(env, descriptor, c"value".as_ptr(), &mut reported) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return false;
  }
  let mut is_sentinel = false;
  if unsafe { sys::napi_strict_equals(env, reported, sentinel, &mut is_sentinel) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return false;
  }
  if !is_sentinel {
    return false;
  }

  // An accessor property must be *described*, never *read*: an own `get`, no
  // own `value`, and the native getter untouched.
  let Some(descriptor) = call_candidate(c"accessor") else {
    return false;
  };
  if type_without_coercion(env, descriptor) != Some(sys::ValueType::napi_object) {
    return false;
  }
  if has_own(descriptor, c"value") != Some(false) {
    return false;
  }
  if has_own(descriptor, c"get") != Some(true) {
    return false;
  }

  // A missing property must yield `undefined`, not a fabricated descriptor.
  let Some(descriptor) = call_candidate(c"missing") else {
    return false;
  };
  if type_without_coercion(env, descriptor) != Some(sys::ValueType::napi_undefined) {
    return false;
  }

  PROBE_ACCESSOR_HITS.with(|hits| hits.get()) == hits_before
}

/// Resolves and caches the env's `Reflect` / `Reflect.getOwnPropertyDescriptor`
/// pair. Called from `napi_register_module_v1`, once per env registration, on
/// the env's own thread.
///
/// This performs the one deliberate `[[Get]]` of `Reflect` off the global
/// object — at module load, a defined moment — so that
/// [`Error::from_unknown_without_coercion`] never has to touch the patchable
/// global mid-capture. A `Reflect` that is missing, not an object, or without a
/// callable `getOwnPropertyDescriptor` leaves the cache empty and every capture
/// on this env degrades to an empty reason/cause.
///
/// **Trust boundary.** What this cache holds is whatever
/// `globalThis.Reflect.getOwnPropertyDescriptor` resolved to when the addon
/// loaded. Code that ran *before* the addon loaded can have replaced it, and
/// that replacement is then invoked during capture. This is accepted
/// deliberately, because it is not a defensible line: a pre-load adversary
/// already owns the addon's entire surface (it can wrap `require`, interpose
/// every export, or patch the module loader), and Node-API offers no
/// alternative — no descriptor-read primitive, no non-`[[Get]]` global access,
/// no fresh-realm escape hatch, and no pristine reference to compare against
/// (see [`probe_get_own_property_descriptor`]). Omitting `reason`/`cause`
/// entirely would not close that boundary; it would only take fidelity away
/// from every non-adversarial user. What *is* enforced is behavior: the
/// resolved candidate must pass a registration-time sanity probe against an
/// object whose shape JavaScript cannot interpose, so a broken or crudely
/// hostile replacement is dropped at a defined moment — the env then degrades
/// to an empty reason/cause permanently, and the impostor is never invoked
/// during capture. The retained value itself never depends on any of this.
///
/// Best effort: any failure clears the pending exception and leaves the slot
/// unchanged. `napi_get_global`, `napi_get_named_property` and
/// `napi_create_reference` (on an object) are all implemented by emnapi, so
/// the cache works on `wasm32-wasip1` and `wasm32-wasip1-threads` too — only
/// the env-cleanup hook is skipped there (see below).
#[cfg(not(feature = "noop"))]
pub(crate) fn cache_reflect_intrinsics_for_env(env: sys::napi_env) {
  let mut global = ptr::null_mut();
  if unsafe { sys::napi_get_global(env, &mut global) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return;
  }
  let mut reflect = ptr::null_mut();
  if unsafe { sys::napi_get_named_property(env, global, c"Reflect".as_ptr(), &mut reflect) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return;
  }
  if type_without_coercion(env, reflect) != Some(sys::ValueType::napi_object) {
    return;
  }
  let mut get_own_property_descriptor = ptr::null_mut();
  if unsafe {
    sys::napi_get_named_property(
      env,
      reflect,
      c"getOwnPropertyDescriptor".as_ptr(),
      &mut get_own_property_descriptor,
    )
  } != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return;
  }
  if type_without_coercion(env, get_own_property_descriptor) != Some(sys::ValueType::napi_function)
  {
    return;
  }
  // Registration-time sanity probe: only a candidate that behaves like the
  // intrinsic on an object of known, non-interposable shape is cached. A
  // failing candidate is dropped here — leaving the slot as it was, so this
  // env's captures degrade to an empty reason/cause (or, on a re-registration,
  // keep the pair the first load vetted) — rather than being invoked during
  // every capture.
  if !probe_get_own_property_descriptor(env, reflect, get_own_property_descriptor) {
    return;
  }
  // Pin both behind one reference: a holder object whose own data properties
  // are the pair, exactly the `ERROR_VALUE_KEY` retention pattern.
  let mut holder = ptr::null_mut();
  if unsafe { sys::napi_create_object(env, &mut holder) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return;
  }
  let properties = [
    sys::napi_property_descriptor {
      utf8name: c"Reflect".as_ptr().cast(),
      name: ptr::null_mut(),
      method: None,
      getter: None,
      setter: None,
      value: reflect,
      attributes: sys::PropertyAttributes::default,
      data: ptr::null_mut(),
    },
    sys::napi_property_descriptor {
      utf8name: c"getOwnPropertyDescriptor".as_ptr().cast(),
      name: ptr::null_mut(),
      method: None,
      getter: None,
      setter: None,
      value: get_own_property_descriptor,
      attributes: sys::PropertyAttributes::default,
      data: ptr::null_mut(),
    },
  ];
  if unsafe { sys::napi_define_properties(env, holder, properties.len(), properties.as_ptr()) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return;
  }
  let mut reference = ptr::null_mut();
  if unsafe { sys::napi_create_reference(env, holder, 1, &mut reference) } != sys::Status::napi_ok {
    clear_pending_exception(env);
    return;
  }
  REFLECT_INTRINSICS.with(|slot| {
    let mut slot = slot.borrow_mut();
    let previous = slot.take();
    let cleanup_hook_installed = match previous {
      Some(superseded) if superseded.env == env => {
        // A pointer-equal entry. Whether it belongs to a LIVE env depends on
        // the cleanup hook: with it installed, teardown clears the slot, so a
        // surviving entry proves this is the same live env re-registering
        // (`delete require.cache` and re-`require`, see unload.spec.js) and
        // the superseded holder can be released immediately. The hook from the
        // first registration stays in place — Node aborts on a duplicate
        // `(fn, arg)` cleanup-hook pair, so it must not be registered again.
        //
        // Without the hook (pre-napi3, or an installation that failed),
        // pointer equality proves nothing: an embedder can destroy the env and
        // recreate one at the same address on this thread, and the entry would
        // be the DEAD env's. Deleting its already-reclaimed reference through
        // the new env risks corrupting the live runtime, so the superseded
        // reference is deliberately leaked instead — one reference per env
        // recreation, bounded, and only on configurations that cannot observe
        // teardown. On wasm the delete stays unconditional: the slot lives in
        // the instance's own linear memory and dies with it, so a pointer
        // match there is the same live instance by construction.
        if superseded.cleanup_hook_installed || cfg!(target_family = "wasm") {
          let _ = unsafe { sys::napi_delete_reference(env, superseded.holder) };
          clear_pending_exception(env);
        }
        superseded.cleanup_hook_installed
      }
      _ => {
        // Empty slot, or a different env owned this thread before. In the latter
        // case that env is gone (one env per OS thread) and its teardown already
        // reclaimed the superseded reference — reachable only on builds without
        // napi3's cleanup hook, which would have cleared the slot — so there is
        // nothing to release and deleting through a dead env would be the real
        // bug. Either way this is the first hook registration for `env`.
        //
        // Registration is best effort, like the cache itself: without the hook
        // the slot is cleared by thread death instead (a worker's thread dies
        // with its env), and the reference is reclaimed by env teardown.
        //
        // Not on wasm: referencing `napi_add_env_cleanup_hook` from Rust imports
        // it under the `env` wasm module, while emnapi's static archive declares
        // it under `napi` — wasm-ld refuses the mismatch. The hook exists for a
        // native embedder tearing an env down and reusing its thread (and
        // possibly the env pointer); on wasm this thread-local lives inside the
        // instance's own linear memory and dies with the instance, whose
        // context is never reused after `Context.destroy()`, so there is no
        // stale slot for a later env to match.
        #[cfg(all(feature = "napi3", not(target_family = "wasm")))]
        {
          let hook_status = unsafe {
            sys::napi_add_env_cleanup_hook(env, Some(reflect_intrinsics_env_cleanup), env.cast())
          };
          hook_status == sys::Status::napi_ok
        }
        #[cfg(not(all(feature = "napi3", not(target_family = "wasm"))))]
        {
          false
        }
      }
    };
    *slot = Some(ReflectIntrinsics {
      env,
      holder: reference,
      cleanup_hook_installed,
    });
  });
}

/// Drops the cached `Reflect` pair if it belongs to `env`, a superseded env that was never
/// torn down (see `release_superseded_env` in `module_register.rs`); napi calls through it
/// are still legal.
#[cfg(all(not(feature = "noop"), feature = "napi3", not(target_family = "wasm")))]
pub(crate) fn release_reflect_intrinsics(env: sys::napi_env) {
  unsafe { reflect_intrinsics_env_cleanup(env.cast()) };
}

/// Env-teardown counterpart of [`cache_reflect_intrinsics_for_env`]: drops the
/// cached holder reference while the env can still delete it, and clears the
/// slot so a later env reusing this thread (an embedder reload) can never match
/// a stale entry through a recycled env pointer.
///
/// Runs on the env's own thread, before the env is destroyed — napi calls are
/// still legal here.
#[cfg(all(not(feature = "noop"), feature = "napi3", not(target_family = "wasm")))]
unsafe extern "C" fn reflect_intrinsics_env_cleanup(arg: *mut c_void) {
  REFLECT_INTRINSICS.with(|slot| {
    let mut slot = slot.borrow_mut();
    if slot
      .as_ref()
      .is_some_and(|cache| cache.env.cast::<c_void>() == arg)
    {
      if let Some(cache) = slot.take() {
        let _ = unsafe { sys::napi_delete_reference(cache.env, cache.holder) };
        clear_pending_exception(cache.env);
      }
    }
  });
}

/// Resolves the env's **cached** `Reflect.getOwnPropertyDescriptor`, returning
/// it together with the `Reflect` object to call it on.
///
/// Node-API exposes no descriptor read of its own, so the only way to inspect a
/// property without triggering its getter is to go through the language. The
/// pair is resolved once per env, at module registration
/// ([`cache_reflect_intrinsics_for_env`]), because reading `Reflect` off the
/// global object is itself a `[[Get]]`: `globalThis.Reflect` is configurable,
/// user code can redefine it as an accessor, and a per-capture read would run
/// that accessor — arbitrary user code, free to reenter the addon or hang —
/// mid-unwind, which is precisely what this path exists to avoid.
///
/// This inverts an earlier per-call design. That design's concern was
/// *staleness* — "caching only changes when a patch is observed" — but the
/// threat model that matters here is *reentrancy during capture*, and the
/// load-time cache ends it: after registration, capture never touches the
/// global again, so a later patch cannot inject code into the capture path at
/// all (a strictly stronger property than observing the patch late).
///
/// `None` — an env with no usable cache, because `Reflect` was missing or
/// unusable at registration or the env never registered this addon — makes the
/// capture degrade to an empty reason/cause. It never falls back to a `[[Get]]`.
///
/// Reading the pair back off the private holder is safe: both are its own
/// **data** properties on an ordinary object that never escaped to JavaScript,
/// so `napi_get_named_property` finds them without walking the prototype chain
/// or running user code.
fn reflect_get_own_property_descriptor(
  env: sys::napi_env,
) -> Option<(sys::napi_value, sys::napi_value)> {
  let holder = REFLECT_INTRINSICS.with(|slot| {
    slot
      .borrow()
      .as_ref()
      .and_then(|cache| (cache.env == env).then_some(cache.holder))
  })?;
  let mut holder_value = ptr::null_mut();
  if unsafe { sys::napi_get_reference_value(env, holder, &mut holder_value) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return None;
  }
  if holder_value.is_null() {
    return None;
  }
  let mut reflect = ptr::null_mut();
  if unsafe { sys::napi_get_named_property(env, holder_value, c"Reflect".as_ptr(), &mut reflect) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return None;
  }
  let mut get_own_property_descriptor = ptr::null_mut();
  if unsafe {
    sys::napi_get_named_property(
      env,
      holder_value,
      c"getOwnPropertyDescriptor".as_ptr(),
      &mut get_own_property_descriptor,
    )
  } != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return None;
  }
  if type_without_coercion(env, get_own_property_descriptor) != Some(sys::ValueType::napi_function)
  {
    return None;
  }
  Some((reflect, get_own_property_descriptor))
}

/// Reads `object[key]` as a **data** property, without performing a `[[Get]]`.
///
/// `napi_get_named_property` would run a `get key()` accessor — arbitrary user
/// code, executed while an error is unwinding, which is precisely what
/// [`Error::from_unknown_without_coercion`] exists to avoid. Instead the
/// prototype chain is walked with `napi_get_prototype` and each link is asked
/// for an own descriptor via `Reflect.getOwnPropertyDescriptor`:
///
/// * a **data** descriptor contributes its `value` and ends the walk;
/// * an **accessor** descriptor ends the walk with `None` — it shadows anything
///   further up the chain, and it is *not* invoked;
/// * no descriptor means "not an own property here", so the walk continues.
///
/// Reading `value` back off the descriptor is safe: `getOwnPropertyDescriptor`
/// returns a freshly created ordinary object, so `napi_has_own_property` and
/// `napi_get_named_property` on it cannot reach user code — `has_own` in
/// particular is immune to `Object.prototype` pollution.
///
/// A `Proxy` does run its `getOwnPropertyDescriptor` and `getPrototypeOf` traps.
/// Nothing can interrogate a proxy without waking it up.
fn data_property_without_get(
  env: sys::napi_env,
  object: sys::napi_value,
  key: &CStr,
) -> Option<sys::napi_value> {
  let (reflect, get_own_property_descriptor) = reflect_get_own_property_descriptor(env)?;

  let key_bytes = key.to_bytes();
  let mut key_value = ptr::null_mut();
  if unsafe {
    sys::napi_create_string_utf8(
      env,
      key_bytes.as_ptr().cast(),
      key_bytes.len() as isize,
      &mut key_value,
    )
  } != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return None;
  }
  let mut value_key = ptr::null_mut();
  if unsafe { sys::napi_create_string_utf8(env, c"value".as_ptr(), 5, &mut value_key) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return None;
  }

  let mut current = object;
  for _ in 0..MAX_PROTOTYPE_DEPTH {
    let args = [current, key_value];
    let mut descriptor = ptr::null_mut();
    if unsafe {
      sys::napi_call_function(
        env,
        reflect,
        get_own_property_descriptor,
        args.len(),
        args.as_ptr(),
        &mut descriptor,
      )
    } != sys::Status::napi_ok
    {
      clear_pending_exception(env);
      return None;
    }

    if type_without_coercion(env, descriptor)? == sys::ValueType::napi_object {
      let mut is_data_descriptor = false;
      if unsafe { sys::napi_has_own_property(env, descriptor, value_key, &mut is_data_descriptor) }
        != sys::Status::napi_ok
      {
        clear_pending_exception(env);
        return None;
      }
      if !is_data_descriptor {
        // An accessor descriptor. Stop here without calling the getter.
        return None;
      }
      let mut property = ptr::null_mut();
      if unsafe { sys::napi_get_named_property(env, descriptor, c"value".as_ptr(), &mut property) }
        != sys::Status::napi_ok
      {
        clear_pending_exception(env);
        return None;
      }
      return Some(property);
    }

    // Not an own property of `current`; continue up the prototype chain.
    let mut prototype = ptr::null_mut();
    if unsafe { sys::napi_get_prototype(env, current, &mut prototype) } != sys::Status::napi_ok {
      clear_pending_exception(env);
      return None;
    }
    if !matches!(
      type_without_coercion(env, prototype)?,
      sys::ValueType::napi_object | sys::ValueType::napi_function
    ) {
      // End of the chain (`null`).
      return None;
    }
    current = prototype;
  }
  None
}

/// Copies `value` into an owned `String` when — and only when — it is already a
/// JavaScript string. Returns `None` for every other value type instead of
/// coercing it.
fn owned_string_without_coercion(env: sys::napi_env, value: sys::napi_value) -> Option<String> {
  if type_without_coercion(env, value)? != sys::ValueType::napi_string {
    return None;
  }

  let mut length = 0;
  if unsafe { sys::napi_get_value_string_utf8(env, value, ptr::null_mut(), 0, &mut length) }
    != sys::Status::napi_ok
  {
    clear_pending_exception(env);
    return None;
  }
  let mut bytes = vec![0; length + 1];
  let mut written = 0;
  let status = unsafe {
    sys::napi_get_value_string_utf8(
      env,
      value,
      bytes.as_mut_ptr().cast(),
      bytes.len(),
      &mut written,
    )
  };
  if status != sys::Status::napi_ok {
    clear_pending_exception(env);
    return None;
  }
  bytes.truncate(written);
  String::from_utf8(bytes).ok()
}

/// Drops any exception a failed N-API call left pending.
///
/// The non-coercing capture path deliberately ignores failures — a hostile
/// `get message()` must not become the reported error — but it must not hand a
/// poisoned environment back to the caller either.
fn clear_pending_exception(env: sys::napi_env) {
  let mut is_pending = false;
  if unsafe { sys::napi_is_exception_pending(env, &mut is_pending) } != sys::Status::napi_ok
    || !is_pending
  {
    return;
  }
  let mut exception = ptr::null_mut();
  let _ = unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) };
}

#[cfg(feature = "anyhow")]
impl From<anyhow::Error> for Error {
  fn from(value: anyhow::Error) -> Self {
    let mut chain = value.chain();

    let mut error = Error::new(Status::GenericFailure, chain.next().unwrap().to_string());

    let mut current = &mut error;

    for cause in chain {
      current.cause = Some(Box::new(Error::new(
        Status::GenericFailure,
        cause.to_string(),
      )));
      current = current.cause.as_deref_mut().unwrap();
    }

    error
  }
}

impl<S: AsRef<str> + std::fmt::Debug> fmt::Display for Error<S> {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    if !self.reason.is_empty() {
      write!(f, "{:?}, {}", self.status, self.reason)
    } else {
      write!(f, "{:?}", self.status)
    }
  }
}

impl<S: AsRef<str>> Error<S> {
  pub fn new<R: ToString>(status: S, reason: R) -> Self {
    Error {
      status,
      reason: reason.to_string(),
      cause: None,
      maybe_ref: None,
    }
  }

  pub fn from_status(status: S) -> Self {
    Error {
      status,
      reason: "".to_owned(),
      cause: None,
      maybe_ref: None,
    }
  }
}

impl<S: AsRef<str> + Clone> Error<S> {
  /// Builds a copy carrying only the thread-safe data: `status`, `reason`, and a
  /// recursively reference-less `cause` chain. It owns no [`ErrorRef`] (`maybe_ref`
  /// is `None`), so it is safe to create and drop on any thread because it reads
  /// only owned Rust data and never touches a thread-affine reference.
  /// `try_clone` uses it whenever it cannot share the original's `napi_ref`: with
  /// no custom-GC handle to route an off-thread release, or when the error holds
  /// no reference at all (a Rust-constructed error, or a WASM error built from a
  /// JS value). Cloning it preserves the cause chain so a later reference-less
  /// conversion (`into_value` with `maybe_ref == None`) can re-attach `.cause`.
  fn reference_less_clone(&self) -> Self {
    Self {
      status: self.status.clone(),
      reason: self.reason.clone(),
      cause: self
        .cause
        .as_ref()
        .map(|cause| Box::new(cause.reference_less_clone())),
      maybe_ref: None,
    }
  }

  /// Clones this `Error`.
  ///
  /// An `Error` derived from a JS exception (e.g. a `Promise` rejection) owns a
  /// `napi_ref` to the original JS value, kept behind a shared [`ErrorRef`]. The
  /// clone shares that reference by cloning the `Arc` — a thread-safe atomic
  /// bump with no napi FFI — so both map back to the same JS object and the
  /// clone can be sent to another thread; the single `napi_ref` is released
  /// exactly once, when the last clone drops. When the clone is later converted
  /// back to a JS value *on the owning JS thread*, it reuses the original object
  /// (preserving its subclass, stack, and own properties); converted on any
  /// other thread it degrades to a fresh `Error` rebuilt from `status`/`reason`/
  /// `cause`. Sharing needs the owning env's custom-GC handle (the only safe
  /// off-thread release path); without one — a pre-`napi4` build, or a reference
  /// created before module registration — and for errors that hold no reference,
  /// `try_clone` returns a reference-less copy that still carries the `status`,
  /// `reason`, and `cause` chain.
  pub fn try_clone(&self) -> Result<Self> {
    match &self.maybe_ref {
      // Share the JS reference with the clone. Cloning the `Arc` is an atomic
      // refcount bump with no napi FFI, so it is safe from any thread; the
      // single `napi_ref` stays at count 1 and is released once, by the last
      // `Arc`. The shared object carries its own `.cause`, so `into_value`
      // ignores the Rust `cause` field when it reuses the object on the owning
      // thread — but we still keep a reference-less cause backup so a clone
      // converted off the owning thread (rebuilt from `reason`) keeps the chain.
      #[cfg(all(feature = "napi4", not(feature = "noop")))]
      Some(error_ref) if error_ref.custom_gc.is_some() => Ok(Self {
        status: self.status.clone(),
        reason: self.reason.clone(),
        cause: self
          .cause
          .as_ref()
          .map(|cause| Box::new(cause.reference_less_clone())),
        maybe_ref: Some(error_ref.clone()),
      }),
      // No custom-GC handle (pre-`napi4` build, or a reference created before
      // module registration, which has no safe off-thread release path), or no
      // JS reference at all (a Rust-constructed error, or a WASM error built
      // from a JS value): rebuild from the owned fields, preserving the cause
      // chain instead of dropping it.
      _ => Ok(self.reference_less_clone()),
    }
  }
}

impl<S: AsRef<str>> Error<S> {
  /// Reads the referenced JS error object, but only when it is safe to touch on
  /// the current thread. The `napi_ref` is thread-affine, so with a napi4
  /// custom-GC handle we read it only with proof we are on the owning JS thread;
  /// off the owning thread (a shared clone being converted on a foreign env) it
  /// returns `None`, so the caller rebuilds a fresh error from `reason` instead
  /// of dereferencing a foreign env's reference. The captured `env` and owner
  /// thread gate the read the same way when the build carries no custom-GC
  /// machinery (non-`napi4`, or a reference created before module registration),
  /// where there is no handle to compare.
  ///
  /// # Safety
  ///
  /// `env` must be a valid `napi_env` for the current thread.
  pub(crate) unsafe fn referenced_value(&self, env: sys::napi_env) -> Option<sys::napi_value> {
    let error_ref = self.maybe_ref.as_ref()?;
    // A reference belongs to the env it was created in and may only be resolved
    // from that env's thread. Both checks are pure Rust — no napi call is made
    // until the reference is known to be readable here.
    if error_ref.env != env || error_ref.owner_thread != std::thread::current().id() {
      return None;
    }
    #[cfg(all(feature = "napi4", not(feature = "noop")))]
    if let Some(handle) = &error_ref.custom_gc {
      if !crate::bindgen_prelude::current_thread_owns_custom_gc(handle) {
        return None;
      }
    }
    let mut result = ptr::null_mut();
    let status = unsafe { sys::napi_get_reference_value(env, error_ref.raw, &mut result) };
    if status != sys::Status::napi_ok {
      return None;
    }
    if error_ref.indirect {
      // `result` is the private holder object; the retained value is its
      // `ERROR_VALUE_KEY` property. It is a plain data property on an object we
      // created ourselves, so reading it runs no user code.
      let status = unsafe {
        sys::napi_get_named_property(env, result, ERROR_VALUE_KEY.as_ptr().cast(), &mut result)
      };
      if status != sys::Status::napi_ok {
        return None;
      }
    }
    Some(result)
  }
}

/// Outlined helper for `#[napi(object)]` deserialization: decorate a field-getter
/// error with its `Struct.field` location.
///
/// The `#[napi]` derive used to inline this `format!` into every generated
/// `FromNapiValue` impl, once per field — hundreds of identical copies in a large
/// addon. Keeping it non-generic and out-of-line collapses all of them to a single
/// shared function on the (cold) error path. The produced message is byte-for-byte
/// identical to the previous inline version.
#[cold]
#[inline(never)]
#[doc(hidden)]
pub fn decorate_field_error(mut err: Error, struct_name: &str, field: &str) -> Error {
  err.reason = format!("{} on {}.{}", err.reason, struct_name, field);
  err
}

/// Outlined helper for `#[napi(object)]` deserialization: build the error returned
/// when a required field is missing. Non-generic and out-of-line for the same
/// code-size reason as [`decorate_field_error`]; the message is unchanged.
#[cold]
#[inline(never)]
#[doc(hidden)]
pub fn missing_field_error(field: &str) -> Error {
  Error::new(Status::InvalidArg, format!("Missing field `{}`", field))
}

impl Error {
  pub fn from_reason<T: Into<String>>(reason: T) -> Self {
    Error {
      status: Status::GenericFailure,
      reason: reason.into(),
      cause: None,
      maybe_ref: None,
    }
  }
}

impl From<std::ffi::NulError> for Error {
  fn from(error: std::ffi::NulError) -> Self {
    Error {
      status: Status::GenericFailure,
      reason: format!("{error}"),
      cause: None,
      maybe_ref: None,
    }
  }
}

impl From<std::io::Error> for Error {
  fn from(error: std::io::Error) -> Self {
    Error {
      status: Status::GenericFailure,
      reason: format!("{error}"),
      cause: None,
      maybe_ref: None,
    }
  }
}

#[derive(Clone, Debug)]
pub struct ExtendedErrorInfo {
  pub message: String,
  pub engine_reserved: *mut c_void,
  pub engine_error_code: u32,
  pub error_code: Status,
}

impl TryFrom<sys::napi_extended_error_info> for ExtendedErrorInfo {
  type Error = Error;

  fn try_from(value: sys::napi_extended_error_info) -> Result<Self> {
    Ok(Self {
      message: if value.error_message.is_null() {
        String::new()
      } else {
        unsafe {
          CStr::from_ptr(value.error_message.cast())
            .to_str()
            .map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))?
            .to_owned()
        }
      },
      engine_error_code: value.engine_error_code,
      engine_reserved: value.engine_reserved,
      error_code: Status::from(value.error_code),
    })
  }
}

/// Whether `value` is a JavaScript `Error`.
///
/// An [`Error`] may retain an *arbitrary* JavaScript value — see
/// [`Error::from_unknown_without_coercion`], which retains whatever a promise
/// rejected with or a callback threw, primitives included. Handing that value
/// back is what every *conversion* has to do, so the value JavaScript supplied
/// comes back as itself. The two APIs that instead **construct** an error object
/// — `JsError::into_value`, which feeds `napi_throw`, and [`Env::create_error`] —
/// cannot: a primitive there would break their own contract and silently no-op
/// every object operation the caller then performs. They gate reuse on this.
///
/// A failed check reads as "not an error": the caller then synthesizes one,
/// which is always a valid answer.
///
/// [`Env::create_error`]: crate::Env::create_error
///
/// # Safety
///
/// `env` must be valid for the current thread and `value` must belong to it.
pub(crate) unsafe fn is_js_error(env: sys::napi_env, value: sys::napi_value) -> bool {
  let mut is_error = false;
  let status = unsafe { sys::napi_is_error(env, value, &mut is_error) };
  debug_assert!(status == sys::Status::napi_ok, "Check Error failed");
  status == sys::Status::napi_ok && is_error
}

pub struct JsError<S: AsRef<str> = Status>(Error<S>);

#[cfg(feature = "anyhow")]
impl From<anyhow::Error> for JsError {
  fn from(value: anyhow::Error) -> Self {
    JsError(Error::from(value))
  }
}

pub struct JsTypeError<S: AsRef<str> = Status>(Error<S>);

pub struct JsRangeError<S: AsRef<str> = Status>(Error<S>);

#[cfg(feature = "napi9")]
pub struct JsSyntaxError<S: AsRef<str> = Status>(Error<S>);

macro_rules! impl_object_methods {
  ($js_value:ident, $kind:expr) => {
    impl<S: AsRef<str>> $js_value<S> {
      /// # Safety
      ///
      /// This function is safety if env is not null ptr.
      pub unsafe fn into_value(mut self, env: sys::napi_env) -> sys::napi_value {
        // Reuse the original JS error object when it is safe to read on this
        // thread (owning JS thread). The shared `napi_ref` is released when
        // `self`'s `Arc` drops at the end of this function — never here.
        if let Some(err) = unsafe { self.0.referenced_value(env) } {
          // make sure ref_value is a valid error at first and avoid throw error failed.
          if unsafe { is_js_error(env, err) } {
            return err;
          }
        }

        let error_status = self.0.status.as_ref();
        let status_len = error_status.len();
        let reason_len = self.0.reason.len();
        let mut error_code = ptr::null_mut();
        let mut reason_string = ptr::null_mut();
        let mut js_error = ptr::null_mut();
        // Every step below can fail while the environment is tearing down —
        // e.g. the async-work `complete` callback runs during Worker exit, when
        // the isolate can no longer serve these calls. Bail out with null
        // instead of asserting: `throw_into` reads null as "the env could not
        // build an error object" and skips the throw, because there is nothing
        // left that could receive one.
        if unsafe {
          sys::napi_create_string_utf8(
            env,
            error_status.as_ptr().cast(),
            status_len as isize,
            &mut error_code,
          )
        } != sys::Status::napi_ok
        {
          return ptr::null_mut();
        }
        if unsafe {
          sys::napi_create_string_utf8(
            env,
            self.0.reason.as_ptr().cast(),
            reason_len as isize,
            &mut reason_string,
          )
        } != sys::Status::napi_ok
        {
          return ptr::null_mut();
        }
        if unsafe { $kind(env, error_code, reason_string, &mut js_error) } != sys::Status::napi_ok {
          return ptr::null_mut();
        }
        if let Some(cause_error) = self.0.cause.take() {
          // Best-effort for the same reason: a failing conversion or property
          // write leaves the error standing without its `cause`.
          if let Ok(cause) = unsafe { ToNapiValue::to_napi_value(env, *cause_error) } {
            if !cause.is_null() {
              unsafe {
                sys::napi_set_named_property(env, js_error, c"cause".as_ptr().cast(), cause)
              };
            }
          }
        }
        js_error
      }

      pub fn into_unknown<'env>(self, env: Env) -> Unknown<'env> {
        let value = unsafe { self.into_value(env.raw()) };
        unsafe { Unknown::from_raw_unchecked(env.raw(), value) }
      }

      /// # Safety
      ///
      /// This function is safety if env is not null ptr.
      pub unsafe fn throw_into(self, env: sys::napi_env) {
        #[cfg(debug_assertions)]
        let reason = self.0.reason.clone();
        let status = self.0.status.as_ref().to_string();
        // Detect whether the env actually has a pending exception before
        // deciding how to surface this error.
        let mut is_pending_exception = false;
        if unsafe { $crate::sys::napi_is_exception_pending(env, &mut is_pending_exception) }
          != $crate::sys::Status::napi_ok
        {
          // The env cannot even report its exception state — it is tearing
          // down — so there is nothing that could receive this error.
          return;
        }
        // Skip re-throwing only when the exception is genuinely pending. An
        // error tagged `PendingException` can be a detached (reference-less)
        // clone — e.g. one produced by `try_clone` off the owning JS thread —
        // whose original JS exception was already cleared, so nothing is
        // pending. Such an error must still be surfaced from `reason` instead of
        // being silently dropped.
        if is_pending_exception && status == Status::PendingException.as_ref() {
          return;
        }
        let js_error = match is_pending_exception {
          true => {
            let mut error_result = std::ptr::null_mut();
            if unsafe { $crate::sys::napi_get_and_clear_last_exception(env, &mut error_result) }
              != $crate::sys::Status::napi_ok
            {
              return;
            }
            error_result
          }
          false => unsafe { self.into_value(env) },
        };
        // `into_value` returns null when the tearing-down env could not build
        // an error object; throwing null would fail the same way.
        if js_error.is_null() {
          return;
        }
        // `napi_throw` refuses to run while the environment is tearing down
        // (Worker exit): `napi_pending_exception` for module API < 10,
        // `napi_cannot_run_js` for API >= 10. Neither is deliverable — the
        // statuses are tolerated here and asserted against only in debug, where
        // this used to throw twice and panic on the first call's status.
        #[cfg(debug_assertions)]
        let throw_status = unsafe { sys::napi_throw(env, js_error) };
        #[cfg(not(debug_assertions))]
        unsafe {
          sys::napi_throw(env, js_error)
        };
        #[cfg(debug_assertions)]
        assert!(
          throw_status == sys::Status::napi_ok
            || throw_status == sys::Status::napi_pending_exception
            || throw_status == sys::Status::napi_cannot_run_js,
          "Throw error failed, status: [{}], raw message: \"{}\", raw status: [{}]",
          Status::from(throw_status),
          reason,
          status
        );
      }
    }

    impl<S: AsRef<str>> From<Error<S>> for $js_value<S> {
      fn from(err: Error<S>) -> Self {
        Self(err)
      }
    }

    impl crate::bindgen_prelude::ToNapiValue for $js_value {
      unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        // A retained value comes back *verbatim*, with no `napi_is_error` gate.
        // This is a conversion, not a constructor: it is what the promise and
        // async-generator settlement paths run through, and JavaScript may
        // reject with anything — a string, a number, `null` — and must get the
        // same value back. `into_value` cannot be used for this half: it gates
        // reuse on `napi_is_error`, which would replace every non-`Error`
        // rejection with a synthesized one.
        if let Some(retained) = unsafe { val.0.referenced_value(env) } {
          return Ok(retained);
        }
        // Nothing to reuse — the error was built in Rust, or is being converted
        // off the thread that captured it. Synthesize through `into_value`,
        // which uses `$kind`, deliberately NOT `ToNapiValue for Error`: that
        // delegation lost the subclass, so a `JsTypeError` with no retained
        // value came back as a plain `Error` (its fallback is
        // `JsError::into_value`).
        Ok(unsafe { val.into_value(env) })
      }
    }
  };
}

impl_object_methods!(JsError, sys::napi_create_error);
impl_object_methods!(JsTypeError, sys::napi_create_type_error);
impl_object_methods!(JsRangeError, sys::napi_create_range_error);
#[cfg(feature = "napi9")]
impl_object_methods!(JsSyntaxError, sys::node_api_create_syntax_error);

#[doc(hidden)]
#[macro_export]
macro_rules! error {
  ($status:expr, $($msg:tt)*) => {
    $crate::Error::new($status, format!($($msg)*))
  };
}

#[doc(hidden)]
#[macro_export]
macro_rules! check_status {
  ($code:expr) => {{
    let c = $code;
    match c {
      $crate::sys::Status::napi_ok => Ok(()),
      _ => Err($crate::Error::new($crate::Status::from(c), "".to_owned())),
    }
  }};

  ($code:expr, $($msg:tt)*) => {{
    let c = $code;
    match c {
      $crate::sys::Status::napi_ok => Ok(()),
      _ => Err($crate::Error::new($crate::Status::from(c), format!($($msg)*))),
    }
  }};

  ($code:expr, $msg:expr, $env:expr, $val:expr) => {{
    let c = $code;
    match c {
      $crate::sys::Status::napi_ok => Ok(()),
      _ => Err($crate::Error::new($crate::Status::from(c), format!($msg, $crate::type_of!($env, $val)?))),
    }
  }};
}

#[doc(hidden)]
#[macro_export]
macro_rules! check_status_and_type {
  ($code:expr, $env:ident, $val:ident, $msg:expr) => {{
    let c = $code;
    match c {
      $crate::sys::Status::napi_ok => Ok(()),
      _ => {
        use $crate::js_values::JsValue;
        let value_type = $crate::type_of!($env, $val)?;
        let error_msg = match value_type {
          ValueType::Function => {
            let function_name = unsafe {
              $crate::bindgen_prelude::Function::<
                $crate::bindgen_prelude::Unknown,
                $crate::bindgen_prelude::Unknown,
              >::from_napi_value($env, $val)?
              .name()?
            };
            format!(
              $msg,
              format!(
                "function {}(..) ",
                if function_name.len() == 0 {
                  "anonymous".to_owned()
                } else {
                  function_name
                }
              )
            )
          }
          ValueType::Object => {
            let env_ = $crate::Env::from($env);
            let json: $crate::JSON = env_.get_global()?.get_named_property_unchecked("JSON")?;
            let object = json.stringify($crate::bindgen_prelude::Object::from_raw($env, $val))?;
            format!($msg, format!("Object {}", object))
          }
          ValueType::Boolean | ValueType::Number => {
            let val = $crate::Unknown::from_raw_unchecked($env, $val);
            let value = val.coerce_to_string()?.into_utf8()?;
            format!($msg, format!("{} {} ", value_type, value.as_str()?))
          }
          #[cfg(feature = "napi6")]
          ValueType::BigInt => {
            let val = $crate::Unknown::from_raw_unchecked($env, $val);
            let value = val.coerce_to_string()?.into_utf8()?;
            format!($msg, format!("{} {} ", value_type, value.as_str()?))
          }
          _ => format!($msg, value_type),
        };
        Err($crate::Error::new($crate::Status::from(c), error_msg))
      }
    }
  }};
}

#[doc(hidden)]
#[macro_export]
macro_rules! check_pending_exception {
  ($env:expr, $code:expr) => {{
    let c = $code;
    match c {
      $crate::sys::Status::napi_ok => Ok(()),
      $crate::sys::Status::napi_pending_exception => {
        let mut error_result = std::ptr::null_mut();
        assert_eq!(
          unsafe { $crate::sys::napi_get_and_clear_last_exception($env, &mut error_result) },
          $crate::sys::Status::napi_ok
        );
        return Err($crate::Error::from(unsafe {
          $crate::bindgen_prelude::Unknown::from_raw_unchecked($env, error_result)
        }));
      }
      _ => Err($crate::Error::new($crate::Status::from(c), "".to_owned())),
    }
  }};

  ($env:expr, $code:expr, $($msg:tt)*) => {{
    let c = $code;
    match c {
      $crate::sys::Status::napi_ok => Ok(()),
      $crate::sys::Status::napi_pending_exception => {
        let mut error_result = std::ptr::null_mut();
        assert_eq!(
          unsafe { $crate::sys::napi_get_and_clear_last_exception($env, &mut error_result) },
          $crate::sys::Status::napi_ok
        );
        return Err($crate::Error::from(unsafe {
          $crate::bindgen_prelude::Unknown::from_raw_unchecked($env, error_result)
        }));
      }
      _ => Err($crate::Error::new($crate::Status::from(c), format!($($msg)*))),
    }
  }};
}

pub(crate) fn extract_error_cause(value: Unknown<'_>) -> Result<Option<Box<Error>>> {
  if value.get_type()? != ValueType::Object {
    return Ok(None);
  }

  let env = value.0.env;
  let key = c"cause";
  let mut raw_cause = ptr::null_mut();
  check_pending_exception!(
    env,
    unsafe { sys::napi_get_named_property(env, value.0.value, key.as_ptr(), &mut raw_cause) },
    "get_named_property error"
  )?;

  let cause = unsafe { Unknown::from_raw_unchecked(env, raw_cause) };
  match cause.get_type()? {
    ValueType::Undefined | ValueType::Null => Ok(None),
    _ => Ok(Some(Box::new(cause.into()))),
  }
}
