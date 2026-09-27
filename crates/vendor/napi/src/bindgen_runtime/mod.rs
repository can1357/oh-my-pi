use std::ffi::c_void;
use std::sync::Arc;

pub use callback_info::*;
pub use class_accessor::*;
pub use env::*;
pub use iterator::Generator;
pub use js_values::*;
pub use module_register::*;
pub use native_borrow::*;
pub use type_tag::*;

use super::sys;
use crate::{Error, JsError, Result, Status};

#[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
pub mod async_iterator;
#[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
pub use async_iterator::AsyncGenerator;
mod callback_info;
mod class_accessor;
mod env;
mod error;
pub mod iterator;
mod js_values;
mod module_register;
mod native_borrow;
mod type_tag;

pub trait ObjectFinalize: Sized {
  #[allow(unused)]
  fn finalize(self, env: Env) -> Result<()> {
    Ok(())
  }
}

#[doc(hidden)]
pub fn panic_to_error(e: Box<dyn std::any::Any + Send>) -> Error {
  let message = {
    if let Some(string) = e.downcast_ref::<String>() {
      string.clone()
    } else if let Some(string) = e.downcast_ref::<&str>() {
      string.to_string()
    } else {
      format!("panic from Rust code: {:?}", e)
    }
  };
  Error::new(Status::GenericFailure, message)
}

pub(crate) fn catch_unwind_safely(f: impl FnOnce()) {
  if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
    // A malicious panic payload may panic again from Drop. Leaking only that exceptional
    // payload is preferable to a double panic crossing an FFI or teardown boundary.
    std::mem::forget(payload);
  }
}

/// # Safety
///
/// called when node wrapper objects destroyed
#[doc(hidden)]
pub(crate) unsafe extern "C" fn raw_finalize_unchecked<T: ObjectFinalize>(
  env: sys::napi_env,
  finalize_data: *mut c_void,
  _finalize_hint: *mut c_void,
) {
  let data: Box<T> = unsafe { Box::from_raw(finalize_data.cast()) };
  // Remove the `REFERENCE_MAP` entry and run the reference bookkeeping
  // *regardless* of whether the user `finalize()` returns `Err`, so an errored
  // finalize can never leave a stale entry keyed on the just-freed pointer. The
  // finalize error (if any) is thrown last, after cleanup. The success path is
  // unchanged.
  let ref_entry = REFERENCE_MAP
    .with(|cell| cell.borrow_mut(|reference_map| reference_map.remove(&finalize_data)));
  let finalize_result = data.finalize(Env::from_raw(env));

  if let Some((_, ref_val, finalize_callbacks_ptr)) = ref_entry {
    let finalize_callbacks_rc = unsafe { Arc::from_raw(finalize_callbacks_ptr) };

    #[cfg(all(debug_assertions, not(target_family = "wasm")))]
    {
      let rc_strong_count = Arc::strong_count(&finalize_callbacks_rc);
      // If `Arc` strong count is 2, it means the finalize of referenced `Object` is called before the `fn drop` of the `Reference`
      // It always happened on exiting process
      // In general, the `fn drop` would happen first
      if rc_strong_count != 1 && rc_strong_count != 2 {
        eprintln!("Arc strong count is: {rc_strong_count}, it should be 1 or 2");
      }
    }
    let finalize = unsafe { Box::from_raw(finalize_callbacks_rc.get()) };
    finalize();
    let delete_reference_status = unsafe { sys::napi_delete_reference(env, ref_val) };
    debug_assert!(
      delete_reference_status == sys::Status::napi_ok,
      "Delete reference in finalize callback failed {}",
      Status::from(delete_reference_status)
    );
  }

  if let Err(err) = finalize_result {
    let e: JsError = err.into();
    unsafe { e.throw_into(env) };
  }
}

/// # Safety
///
/// called when node buffer is ready for gc
#[doc(hidden)]
pub unsafe extern "C" fn drop_buffer(
  _env: sys::napi_env,
  #[allow(unused)] finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  #[cfg(all(debug_assertions, not(windows), not(target_family = "wasm")))]
  {
    js_values::BUFFER_DATA.with(|buffer_data| {
      let mut buffer = buffer_data.lock().expect("Unlock Buffer data failed");
      buffer.remove(&(finalize_data as *mut u8));
    });
  }
  unsafe {
    drop(Box::from_raw(finalize_hint as *mut Buffer));
  }
}

/// # Safety
///
/// called when node buffer slice is ready for gc
#[doc(hidden)]
pub unsafe extern "C" fn drop_buffer_slice(
  _env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  let (len, cap): (usize, usize) = *unsafe { Box::from_raw(finalize_hint.cast()) };
  #[cfg(all(debug_assertions, not(windows), not(target_family = "wasm")))]
  {
    js_values::BUFFER_DATA.with(|buffer_data| {
      let mut buffer = buffer_data.lock().expect("Unlock Buffer data failed");
      buffer.remove(&(finalize_data as *mut u8));
    });
  }
  if finalize_data.is_null() {
    return;
  }
  unsafe {
    drop(Vec::from_raw_parts(finalize_data, len, cap));
  }
}

/// Create an object with properties
///
/// When the `experimental` feature is enabled, uses `node_api_create_object_with_properties`
/// which creates the object with all properties in a single optimized call.
/// Otherwise falls back to `napi_create_object` + `napi_define_properties`.
#[doc(hidden)]
#[cfg(not(feature = "noop"))]
#[inline]
pub unsafe fn create_object_with_properties(
  env: sys::napi_env,
  properties: &[sys::napi_property_descriptor],
) -> Result<sys::napi_value> {
  use crate::check_status;

  let mut obj_ptr = std::ptr::null_mut();

  #[cfg(all(
    feature = "experimental",
    feature = "node_version_detect",
    not(target_family = "wasm")
  ))]
  {
    let node_version = NODE_VERSION.get().unwrap();
    if !properties.is_empty()
      && ((node_version.major == 25 && node_version.minor >= 2) || node_version.major > 25)
    {
      // Convert property names from C strings to napi_value
      let mut names: Vec<sys::napi_value> = Vec::with_capacity(properties.len());
      let mut values: Vec<sys::napi_value> = Vec::with_capacity(properties.len());

      for prop in properties {
        let mut name_value = std::ptr::null_mut();
        // utf8name is a null-terminated C string, use -1 to auto-detect length
        check_status!(
          sys::napi_create_string_utf8(env, prop.utf8name, -1, &mut name_value),
          "Failed to create property name string",
        )?;
        names.push(name_value);
        values.push(prop.value);
      }

      let mut result_obj = std::ptr::null_mut();
      check_status!(
        sys::node_api_create_object_with_properties(
          env,
          std::ptr::null_mut(), // prototype_or_null
          names.as_ptr(),
          values.as_ptr(),
          properties.len(),
          &mut result_obj,
        ),
        "Failed to create object with properties",
      )?;
      return Ok(result_obj);
    }
  }

  // Fallback: create object then define properties
  check_status!(
    sys::napi_create_object(env, &mut obj_ptr),
    "Failed to create object",
  )?;

  if !properties.is_empty() {
    check_status!(
      sys::napi_define_properties(env, obj_ptr, properties.len(), properties.as_ptr()),
      "Failed to define properties",
    )?;
  }

  Ok(obj_ptr)
}

#[doc(hidden)]
#[cfg(feature = "noop")]
pub unsafe fn create_object_with_properties(
  _env: sys::napi_env,
  _properties: &[sys::napi_property_descriptor],
) -> Result<sys::napi_value> {
  Ok(std::ptr::null_mut())
}

#[cfg(test)]
mod tests {
  use std::panic::panic_any;

  use super::catch_unwind_safely;

  struct PanickingPanicPayload;

  impl Drop for PanickingPanicPayload {
    fn drop(&mut self) {
      panic!("nested panic payload destructor");
    }
  }

  #[test]
  fn catch_unwind_safely_forgets_panicking_panic_payloads() {
    catch_unwind_safely(|| panic_any(PanickingPanicPayload));
  }
}
