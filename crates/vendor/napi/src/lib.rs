#![deny(clippy::all)]
#![allow(non_upper_case_globals)]

//! High level Node.js [N-API](https://nodejs.org/api/n-api.html) binding
//!
//! **napi-rs** provides minimal overhead to write N-API modules in `Rust`.
//!
//! ## Feature flags
//!
//! ### napi1 ~ napi10
//!
//! Because `Node.js` N-API has versions. So there are feature flags to choose what version of `N-API` you want to build for.
//! For example, if you want build a library which can be used by `node@10.17.0`, you should choose the `napi5` or lower.
//!
//! The details of N-API versions and support matrix: [Node-API version matrix](https://nodejs.org/api/n-api.html#node-api-version-matrix)
//!
//! ### tokio_rt
//! With `tokio_rt` feature, `napi-rs` provides a ***tokio runtime*** in an additional thread.
//! And you can easily run tokio `future` in it and return `promise`.
//!
//! ```
//! use futures::prelude::*;
//! use napi::bindgen_prelude::*;
//! use tokio;
//!
//! #[napi]
//! pub fn tokio_readfile(js_filepath: String) -> Result<Buffer> {
//!     ctx.env.spawn_future_with_callback(
//!         tokio::fs::read(js_filepath)
//!           .map(|v| v.map_err(|e| Error::new(Status::Unknown, format!("failed to read file, {}", e)))),
//!         |_, data| data.into(),
//!     )
//! }
//! ```
//!
//! ### async-runtime
//!
//! The `async-runtime` feature exposes a service-provider interface for plugging a **custom
//! async runtime** into napi instead of (or alongside) the built-in Tokio runtime: implement
//! the `bindgen_prelude::AsyncRuntime` trait and register exactly one instance with
//! `bindgen_prelude::register_async_runtime` from `#[module_init]`, before the first Node-API
//! environment starts.
//!
//! The relevant build shapes:
//!
//! - **`async-runtime` only** (no `tokio_rt`): napi links no Tokio at all. Every generated
//!   `#[napi] async fn` runs on the registered backend; when nothing is registered the promise
//!   rejects with a missing-backend error.
//! - **`async-runtime` + `tokio_rt`** (combined, e.g. through Cargo feature unification): the
//!   established helpers `spawn`, `spawn_blocking`, `block_on`,
//!   `within_runtime_if_available`, and `create_custom_tokio_runtime` stay Tokio-backed with
//!   unchanged signatures. Generated async functions follow the *selection*: the custom
//!   backend if one was registered before the registration window closed, otherwise Tokio.
//!   Selecting a custom backend never constructs Tokio.
//! - **`noop` + `async-runtime`**: the SPI types exist so code compiles, but no backend can be
//!   installed; registration retires the supplied backend and reports `InvalidArg`.
//!
//! Panic containment around backend hooks and task polls requires `panic = "unwind"`; on
//! `panic = "abort"` targets (including Rust's shipped `wasm32-wasip1(-threads)`) a panicking
//! async function traps or aborts before its promise settles.
//!
//! ### latin1
//!
//! Decode latin1 string from JavaScript using [encoding_rs](https://docs.rs/encoding_rs).
//!
//! With this feature, you can use `JsString.as_latin1_string` function
//!
//! ### serde-json
//!
//! Enable Serialize/Deserialize data cross `JavaScript Object` and `Rust struct`.
//!
//! ```
//! #[derive(Serialize, Debug, Deserialize)]
//! struct AnObject {
//!     a: u32,
//!     b: Vec<f64>,
//!     c: String,
//! }
//!
//! #[napi]
//! fn deserialize_from_js(arg0: JsUnknown) -> Result<JsUndefined> {
//!     let de_serialized: AnObject = ctx.env.from_js_value(arg0)?;
//!     ...
//! }
//!
//! #[napi]
//! fn serialize(env: Env) -> Result<JsUnknown> {
//!     let value = AnyObject { a: 1, b: vec![0.1, 2.22], c: "hello" };
//!     env.to_js_value(&value)
//! }
//! ```
//!

#[cfg(all(target_family = "wasm", not(feature = "noop"), feature = "napi3"))]
#[link(wasm_import_module = "napi")]
extern "C" {
  fn napi_add_env_cleanup_hook(
    env: sys::napi_env,
    fun: Option<unsafe extern "C" fn(arg: *mut core::ffi::c_void)>,
    arg: *mut core::ffi::c_void,
  ) -> sys::napi_status;
  fn napi_remove_env_cleanup_hook(
    env: sys::napi_env,
    fun: Option<unsafe extern "C" fn(arg: *mut core::ffi::c_void)>,
    arg: *mut core::ffi::c_void,
  ) -> sys::napi_status;
}

#[cfg(feature = "napi8")]
mod async_cleanup_hook;
#[cfg(feature = "napi8")]
pub use async_cleanup_hook::AsyncCleanupHook;
mod async_work;
mod bindgen_runtime;
#[cfg(feature = "compat-mode")]
mod call_context;
#[cfg(feature = "napi3")]
mod cleanup_env;
mod env;
mod error;
mod js_values;
mod status;
mod task;
#[cfg(all(
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
mod tokio_runtime;
mod value_type;
#[cfg(feature = "napi3")]
pub use cleanup_env::CleanupEnvHook;
#[cfg(not(feature = "noop"))]
mod sendable_resolver;
#[cfg(feature = "napi4")]
pub mod threadsafe_function;
#[cfg(not(feature = "noop"))]
pub use sendable_resolver::SendableResolver;

mod version;

pub use napi_sys as sys;

pub use async_work::AsyncWorkPromise;
#[cfg(feature = "compat-mode")]
pub use call_context::CallContext;

pub use bindgen_runtime::iterator;
pub use env::*;
pub use error::*;
pub use js_values::*;
pub use status::Status;
pub use task::{ScopedTask, Task};
pub use value_type::*;
pub use version::NodeVersion;
#[cfg(feature = "serde-json")]
#[macro_use]
extern crate serde;

pub type ContextlessResult<T> = Result<Option<T>>;

#[doc(hidden)]
#[macro_export(local_inner_macros)]
macro_rules! type_of {
  ($env:expr, $value:expr) => {{
    let mut value_type = 0;
    #[allow(unused_unsafe)]
    check_status!(unsafe { $crate::sys::napi_typeof($env, $value, &mut value_type) })
      .and_then(|_| Ok($crate::ValueType::from(value_type)))
  }};
}

#[doc(hidden)]
#[macro_export]
macro_rules! assert_type_of {
  ($env: expr, $value:expr, $value_ty: expr) => {
    $crate::type_of!($env, $value).and_then(|received_type| {
      if received_type == $value_ty {
        Ok(())
      } else {
        Err($crate::Error::new(
          $crate::Status::InvalidArg,
          format!(
            "Expect value to be {}, but received {}",
            $value_ty, received_type
          ),
        ))
      }
    })
  };
}

pub mod bindgen_prelude {
  #[cfg(all(feature = "compat-mode", not(feature = "noop")))]
  pub use crate::bindgen_runtime::register_module_exports;
  #[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
  pub use crate::tokio_runtime::*;
  pub use crate::{
    assert_type_of, bindgen_runtime::*, check_pending_exception, check_status,
    check_status_or_throw, error, error::*, sys, type_of, JsError, JsValue, Property,
    PropertyAttributes, Result, Status, Task, ValueType,
  };
  #[cfg(feature = "tracing")]
  pub use ::tracing;

  /// Emit NAPI call tracing through one shared callsite.
  ///
  /// Keep this out of line: every generated NAPI wrapper calls this function, and inlining the
  /// tracing macro would duplicate its static callsite metadata in every wrapper.
  #[cfg(feature = "tracing")]
  #[doc(hidden)]
  #[inline(never)]
  pub fn trace_napi_call(name: &'static str) {
    ::tracing::debug!(target: "napi", "{}", name);
  }

  // This function's signature must be kept in sync with the one in tokio_runtime.rs, otherwise napi
  // will fail to compile without the `tokio_rt` feature.

  /// If the feature `tokio_rt` has been enabled this will enter the runtime context and
  /// then call the provided closure. Otherwise it will just call the provided closure.
  #[cfg(not(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  )))]
  pub fn within_runtime_if_available<F: FnOnce() -> T, T>(f: F) -> T {
    f()
  }
}

#[doc(hidden)]
pub mod __private {
  pub use crate::bindgen_runtime::{
    get_class_constructor, iterator::create_iterator, register_class, ___CALL_FROM_FACTORY,
  };

  #[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
  pub use crate::bindgen_runtime::async_iterator::create_async_iterator;

  use crate::sys;

  pub unsafe fn log_js_value<V: AsRef<[sys::napi_value]>>(
    // `info`, `log`, `warning` or `error`
    method: &str,
    env: sys::napi_env,
    values: V,
  ) {
    use std::ffi::CString;
    use std::ptr;

    let mut g = ptr::null_mut();
    unsafe { sys::napi_get_global(env, &mut g) };
    let mut console = ptr::null_mut();
    let console_c_string = CString::new("console").unwrap();
    let method_c_string = CString::new(method).unwrap();
    unsafe { sys::napi_get_named_property(env, g, console_c_string.as_ptr(), &mut console) };
    let mut method_js_fn = ptr::null_mut();
    unsafe {
      sys::napi_get_named_property(env, console, method_c_string.as_ptr(), &mut method_js_fn)
    };
    unsafe {
      sys::napi_call_function(
        env,
        console,
        method_js_fn,
        values.as_ref().len(),
        values.as_ref().as_ptr(),
        ptr::null_mut(),
      )
    };
  }
}

pub extern crate ctor;

#[cfg(feature = "tokio_rt")]
pub extern crate tokio;

#[cfg(feature = "error_anyhow")]
pub extern crate anyhow;

#[cfg(feature = "web_stream")]
pub extern crate futures_core;
#[cfg(feature = "web_stream")]
pub extern crate tokio_stream;
