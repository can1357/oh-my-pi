use std::convert::TryFrom;
#[cfg(all(feature = "napi10", not(target_family = "wasm")))]
use std::ffi::c_void;
use std::ops::Deref;

use crate::{bindgen_runtime::ToNapiValue, sys, Error, JsString, Result, Status};

#[cfg(feature = "napi10")]
use crate::Env;

pub struct JsStringUtf16<'env> {
  pub(crate) inner: JsString<'env>,
  /// Backing code-unit view.
  ///
  /// For wrappers produced by [`Self::from_data`] / [`Self::from_external`]:
  /// - On `wasm32-*` (WASI / emnapi) the external-string APIs always copy
  ///   into the JS heap, so the wrapper retains its own owning copy of the
  ///   units in `_inner_buf` and `buf` slices that copy — always valid.
  /// - On native, when V8 keeps the external buffer (`copied = false`),
  ///   `buf` slices the original units for free; when V8 chooses to copy
  ///   (`copied = true` — short strings or sandbox mode), the finalizer
  ///   already freed the source buffer before this function returned, so
  ///   `buf` is `&[]`. Recover the units via [`JsString::into_utf16`] on
  ///   [`Self::into_value`] in that rare native case.
  pub(crate) buf: &'env [u16],
  pub(crate) _inner_buf: Vec<u16>,
}

impl<'env> JsStringUtf16<'env> {
  #[cfg(feature = "napi10")]
  /// Try to create a new JavaScript utf16 string from a Rust `Vec<u16>` without copying the data.
  ///
  /// ## Behavior
  ///
  /// The `copied` parameter in the underlying `node_api_create_external_string_utf16` call
  /// indicates whether the string data was copied into V8's heap rather than being used
  /// as an external reference.
  ///
  /// ### When `copied` is `true`:
  /// - String data is copied to V8's heap
  /// - Finalizer is called synchronously to release the source buffer
  /// - Performance benefit of external strings is not achieved
  ///
  /// ### When `copied` is `false`:
  /// - V8 creates an external string that references the original buffer without copying
  /// - Original buffer must remain valid for the lifetime of the JS string
  /// - Finalizer called when string is garbage collected
  /// - Memory usage and copying overhead is reduced
  ///
  /// ## Common scenarios where `copied` is `true`:
  /// - String is too short (typically < 10-15 characters)
  /// - V8 heap is under memory pressure
  /// - V8 is running with pointer compression or sandbox features
  /// - Invalid UTF-16 encoding that requires sanitization
  /// - Platform doesn't support external strings (e.g. `wasm32-*` / emnapi)
  /// - Memory alignment issues with the provided buffer
  ///
  /// ## Platform notes
  ///
  /// On `wasm32-*` (WASI / emnapi) the external-string API always falls back
  /// to `napi_create_string_utf16`, which copies into the JS heap. To avoid
  /// the double work and the use-after-free that would otherwise come with
  /// the synchronous finalizer, this function uses `napi_create_string_utf16`
  /// directly on WASM and keeps the source `Vec` alive in the wrapper so
  /// `as_slice()` / `len()` / `is_empty()` keep returning the original units.
  ///
  /// On native, when V8 chooses to copy (`copied = true`), the source buffer
  /// has been freed by the finalizer before this returns. `as_slice()` then
  /// returns `&[]`; recover the units via [`JsString::into_utf16`] on
  /// [`Self::into_value`] if needed.
  pub fn from_data(env: &'env Env, data: Vec<u16>) -> Result<JsStringUtf16<'env>> {
    use std::ptr;

    use crate::{check_status, Value, ValueType};

    if data.is_empty() {
      return Err(Error::new(
        Status::InvalidArg,
        "Cannot create external string from empty data".to_owned(),
      ));
    }

    #[cfg(target_family = "wasm")]
    {
      // emnapi always copies into the JS heap, so skip the external-string
      // API entirely and just call the regular one. Then keep the source Vec
      // alive in `_inner_buf` so `buf` stays valid for the wrapper's
      // accessors.
      let mut raw_value = ptr::null_mut();
      let data_ptr = data.as_ptr();
      let len = data.len();
      check_status!(
        unsafe { sys::napi_create_string_utf16(env.0, data_ptr, len as isize, &mut raw_value) },
        "Failed to create utf16 string"
      )?;
      Ok(Self {
        inner: JsString(
          Value {
            env: env.0,
            value: raw_value,
            value_type: ValueType::String,
          },
          std::marker::PhantomData,
        ),
        buf: unsafe { std::slice::from_raw_parts(data_ptr, len) },
        _inner_buf: data,
      })
    }

    #[cfg(not(target_family = "wasm"))]
    {
      use std::mem::ManuallyDrop;

      // Transfer ownership of the Vec to V8 via the finalizer; Rust must not
      // drop it. The finalizer reconstructs the Vec from (ptr, len, cap) and
      // drops it — synchronously when V8 copies, or on GC when V8 keeps the
      // external reference.
      let mut data = ManuallyDrop::new(data);
      let data_ptr = data.as_ptr();
      let len = data.len();
      let cap = data.capacity();
      let finalize_hint = Box::into_raw(Box::new((len, cap)));
      let mut raw_value = ptr::null_mut();
      let mut copied = false;

      let status = unsafe {
        sys::node_api_create_external_string_utf16(
          env.0,
          data_ptr,
          len as isize,
          Some(drop_utf16_string),
          finalize_hint.cast(),
          &mut raw_value,
          &mut copied,
        )
      };

      // On error V8 never invokes the finalizer; release both the hint Box
      // and the Vec ourselves. On success the finalizer owns them.
      if status != sys::Status::napi_ok {
        unsafe {
          drop(Box::from_raw(finalize_hint));
          ManuallyDrop::drop(&mut data);
        }
      }
      check_status!(status, "Failed to create external string utf16")?;

      // If V8 copied the units, the finalizer already freed our buffer
      // synchronously and exposing a slice into it would be use-after-free.
      // Report an empty view in that case.
      let buf: &'env [u16] = if copied {
        &[]
      } else {
        unsafe { std::slice::from_raw_parts(data_ptr, len) }
      };

      Ok(Self {
        inner: JsString(
          Value {
            env: env.0,
            value: raw_value,
            value_type: ValueType::String,
          },
          std::marker::PhantomData,
        ),
        buf,
        _inner_buf: vec![],
      })
    }
  }

  #[cfg(feature = "napi10")]
  /// Creates an external UTF-16 string from raw data with a custom finalize callback.
  ///
  /// ## Safety
  ///
  /// The caller must ensure that:
  /// - The data pointer is valid for the lifetime of the string and points to at least `len` UTF-16 code units of storage
  /// - The finalize callback properly cleans up the data
  ///
  /// ## `finalize_callback` invocation contract
  ///
  /// `finalize_callback` is invoked **exactly once** for any call that
  /// reaches the N-API layer:
  /// - On success, V8 invokes it (synchronously when `copied = true`, on GC
  ///   when `copied = false`) on native; on WASM this function invokes it
  ///   inline after the N-API call.
  /// - On N-API failure (e.g. OOM, status != `napi_ok`), this function
  ///   invokes it inline before returning the error so the caller's buffer
  ///   is released.
  ///
  /// It is **not** invoked when this function returns `InvalidArg` from its
  /// own pre-validation (null `data` or `len > isize::MAX / size_of::<u16>()`).
  /// Those are caller bugs: we cannot safely reach the buffer at `data + len`,
  /// and many real callbacks (e.g. `Vec::from_raw_parts(ptr, len, len)`)
  /// would trigger UB if invoked with the bogus arguments. Validate inputs
  /// and retain ownership of the source buffer until this returns `Ok` if
  /// you rely on the callback as your only cleanup path.
  ///
  /// ## Behavior
  ///
  /// The `copied` parameter in the underlying `node_api_create_external_string_utf16` call
  /// indicates whether the string data was copied into V8's heap rather than being used
  /// as an external reference.
  ///
  /// ### When `copied` is `true`:
  /// - String data is copied to V8's heap
  /// - Finalizer is invoked during string creation if provided
  /// - Original buffer can be freed after the call
  /// - Performance benefit of external strings is not achieved
  ///
  /// ### When `copied` is `false`:
  /// - V8 creates an external string that references the original buffer without copying
  /// - Original buffer must remain valid for the lifetime of the JS string
  /// - Finalizer called when string is garbage collected
  /// - Memory usage and copying overhead is reduced
  ///
  /// ## Platform notes
  ///
  /// On `wasm32-*` (WASI / emnapi) the external-string API always copies and
  /// runs the finalizer synchronously, so this function makes its own copy
  /// of the units into the wrapper before invoking the caller's finalize
  /// callback. The caller's buffer ownership semantics are unchanged
  /// (finalize_callback is called exactly once); on WASM, `as_slice()` etc.
  /// observe the copy stored inside the wrapper.
  ///
  /// On native, when V8 chooses to copy (`copied = true`), the caller's
  /// finalize callback has already run synchronously by the time this
  /// returns, so the source units may be freed; `as_slice()` returns `&[]`
  /// in that case. When V8 keeps the buffer external (`copied = false`),
  /// `as_slice()` borrows the caller-provided units for free.
  pub unsafe fn from_external<T: 'env, F: FnOnce(Env, T) + 'env>(
    env: &'env Env,
    data: *const u16,
    len: usize,
    finalize_hint: T,
    finalize_callback: F,
  ) -> Result<JsStringUtf16<'env>> {
    use std::mem::size_of;
    use std::ptr;

    use crate::{check_status, Value, ValueType};

    // Validation failures below are caller bugs: we cannot safely interact
    // with the buffer at `data + len`, and we have no contractually safe way
    // to invoke the caller's `finalize_callback`. The callback is dropped
    // without being invoked in these cases; the caller is responsible for
    // their own cleanup before passing invalid arguments.
    if data.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "Data pointer should not be null".to_owned(),
      ));
    }
    if len > isize::MAX as usize / size_of::<u16>() {
      return Err(Error::new(
        Status::InvalidArg,
        "Data length exceeds isize::MAX / sizeof(u16)".to_owned(),
      ));
    }

    #[cfg(target_family = "wasm")]
    {
      // emnapi always copies, so use the plain create_string entry point and
      // copy the caller's units into our own buffer (so `buf` stays valid
      // after the caller's finalize_callback releases the source). The
      // caller's callback runs exactly once, here, regardless of whether
      // create succeeds — on WASM the engine never delegates finalization.
      let buffer = if len == 0 {
        Vec::new()
      } else {
        unsafe { std::slice::from_raw_parts(data, len) }.to_vec()
      };
      let buf_ptr = buffer.as_ptr();
      let buf_len = buffer.len();
      let mut raw_value = ptr::null_mut();
      let status =
        unsafe { sys::napi_create_string_utf16(env.0, buf_ptr, buf_len as isize, &mut raw_value) };

      finalize_callback(*env, finalize_hint);

      check_status!(status, "Failed to create utf16 string")?;

      Ok(Self {
        inner: JsString(
          Value {
            env: env.0,
            value: raw_value,
            value_type: ValueType::String,
          },
          std::marker::PhantomData,
        ),
        buf: unsafe { std::slice::from_raw_parts(buf_ptr, buf_len) },
        _inner_buf: buffer,
      })
    }

    #[cfg(not(target_family = "wasm"))]
    {
      let hint_ptr = Box::into_raw(Box::new((finalize_hint, finalize_callback)));
      let mut raw_value = ptr::null_mut();
      let mut copied = false;

      let status = unsafe {
        sys::node_api_create_external_string_utf16(
          env.0,
          data,
          len as isize,
          Some(finalize_with_custom_callback::<T, F>),
          hint_ptr.cast(),
          &mut raw_value,
          &mut copied,
        )
      };

      // V8 only invokes `finalize_with_custom_callback` on success. On
      // failure we still own the hint Box; reconstruct and invoke the
      // caller's callback to release their buffer, otherwise it leaks.
      // On success (copied = true or false), V8 owns the hint and will
      // invoke the callback itself — we must not call it again here.
      if status != sys::Status::napi_ok {
        let (hint, callback) = *unsafe { Box::from_raw(hint_ptr) };
        callback(*env, hint);
      }
      check_status!(status, "Failed to create external string utf16")?;

      // If V8 copied the units, the caller's `finalize_callback` already
      // ran synchronously and the buffer at `data` may be freed. Exposing
      // a slice into it would be use-after-free, so report an empty view
      // in that case.
      let buf: &'env [u16] = if copied {
        &[]
      } else {
        unsafe { std::slice::from_raw_parts(data, len) }
      };

      Ok(Self {
        inner: JsString(
          Value {
            env: env.0,
            value: raw_value,
            value_type: ValueType::String,
          },
          std::marker::PhantomData,
        ),
        buf,
        _inner_buf: vec![],
      })
    }
  }

  #[cfg(feature = "napi10")]
  pub fn from_static(env: &'env Env, data: &'static [u16]) -> Result<JsStringUtf16<'env>> {
    use std::ptr;

    use crate::{check_status, Value, ValueType};

    if data.is_empty() {
      return Err(Error::new(
        Status::InvalidArg,
        "Data should not be empty".to_owned(),
      ));
    }

    let mut raw_value = ptr::null_mut();
    let mut copied = false;

    check_status!(
      unsafe {
        sys::node_api_create_external_string_utf16(
          env.0,
          data.as_ptr(),
          data.len() as isize,
          None,
          ptr::null_mut(),
          &mut raw_value,
          &mut copied,
        )
      },
      "Failed to create external string utf16"
    )?;

    Ok(Self {
      inner: JsString(
        Value {
          env: env.0,
          value: raw_value,
          value_type: ValueType::String,
        },
        std::marker::PhantomData,
      ),
      buf: data,
      _inner_buf: vec![],
    })
  }

  pub fn as_str(&self) -> Result<String> {
    if let Some((_, prefix)) = self.as_slice().split_last() {
      String::from_utf16(prefix).map_err(|e| Error::new(Status::InvalidArg, format!("{e}")))
    } else {
      Ok(String::new())
    }
  }

  pub fn as_slice(&self) -> &[u16] {
    self.buf
  }

  pub fn len(&self) -> usize {
    self.buf.len()
  }

  pub fn is_empty(&self) -> bool {
    self.buf.is_empty()
  }

  pub fn into_value(self) -> JsString<'env> {
    self.inner
  }
}

impl TryFrom<JsStringUtf16<'_>> for String {
  type Error = Error;

  fn try_from(value: JsStringUtf16) -> Result<String> {
    value.as_str()
  }
}

impl Deref for JsStringUtf16<'_> {
  type Target = [u16];

  fn deref(&self) -> &[u16] {
    self.buf
  }
}

impl AsRef<[u16]> for JsStringUtf16<'_> {
  fn as_ref(&self) -> &[u16] {
    self.buf
  }
}

impl From<JsStringUtf16<'_>> for Vec<u16> {
  fn from(value: JsStringUtf16) -> Self {
    value.as_slice().to_vec()
  }
}

impl ToNapiValue for JsStringUtf16<'_> {
  unsafe fn to_napi_value(_: sys::napi_env, val: JsStringUtf16) -> Result<sys::napi_value> {
    Ok(val.inner.0.value)
  }
}

#[cfg(all(feature = "napi10", not(target_family = "wasm")))]
extern "C" fn drop_utf16_string(
  _: sys::node_api_basic_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  let (size, capacity): (usize, usize) = unsafe { *Box::from_raw(finalize_hint.cast()) };
  if size == 0 || finalize_data.is_null() {
    return;
  }
  let data: Vec<u16> = unsafe { Vec::from_raw_parts(finalize_data.cast(), size, capacity) };
  drop(data);
}

#[cfg(all(feature = "napi10", not(target_family = "wasm")))]
extern "C" fn finalize_with_custom_callback<T, F: FnOnce(Env, T)>(
  env: sys::node_api_basic_env,
  _finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  let (hint, callback) = unsafe { *Box::from_raw(finalize_hint as *mut (T, F)) };
  callback(Env(env.cast()), hint);
}
