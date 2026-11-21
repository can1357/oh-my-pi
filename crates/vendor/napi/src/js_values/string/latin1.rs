#[cfg(all(feature = "napi10", not(target_family = "wasm")))]
use std::ffi::c_void;

use crate::{bindgen_prelude::ToNapiValue, sys, JsString, Result};

#[cfg(feature = "napi10")]
use crate::Env;

pub struct JsStringLatin1<'env> {
  pub(crate) inner: JsString<'env>,
  /// Backing bytes view.
  ///
  /// For wrappers produced by [`Self::from_data`] / [`Self::from_external`]:
  /// - On `wasm32-*` (WASI / emnapi) the external-string APIs always copy
  ///   into the JS heap, so the wrapper retains its own owning copy of the
  ///   bytes in `_inner_buf` and `buf` slices that copy — always valid.
  /// - On native, when V8 keeps the external buffer (`copied = false`),
  ///   `buf` slices the original bytes for free; when V8 chooses to copy
  ///   (`copied = true` — short strings or sandbox mode), the finalizer
  ///   already freed the source buffer before this function returned, so
  ///   `buf` is `&[]`. Recover the bytes via [`JsString::into_latin1`] on
  ///   [`Self::into_value`] in that rare native case.
  pub(crate) buf: &'env [u8],
  pub(crate) _inner_buf: Vec<u8>,
}

impl<'env> JsStringLatin1<'env> {
  #[cfg(feature = "napi10")]
  /// Try to create a new JavaScript latin1 string from a Rust `Vec<u8>` without copying the data.
  ///
  /// ## Behavior
  ///
  /// The `copied` parameter in the underlying `node_api_create_external_string_latin1` call
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
  /// - Invalid Latin-1 encoding that requires sanitization
  /// - Platform doesn't support external strings (e.g. `wasm32-*` / emnapi)
  /// - Memory alignment issues with the provided buffer
  ///
  /// ## Platform notes
  ///
  /// On `wasm32-*` (WASI / emnapi) the external-string API always falls back
  /// to `napi_create_string_latin1`, which copies into the JS heap. To avoid
  /// the double work and the use-after-free that would otherwise come with
  /// the synchronous finalizer, this function uses `napi_create_string_latin1`
  /// directly on WASM and keeps the source `Vec` alive in the wrapper so
  /// `as_slice()` / `len()` / `is_empty()` keep returning the original bytes.
  ///
  /// On native, when V8 chooses to copy (`copied = true`), the source buffer
  /// has been freed by the finalizer before this returns. `as_slice()` then
  /// returns `&[]`; recover the bytes via [`JsString::into_latin1`] on
  /// [`Self::into_value`] if needed.
  pub fn from_data(env: &'env Env, data: Vec<u8>) -> Result<JsStringLatin1<'env>> {
    use std::ptr;

    use crate::{check_status, Error, Status, Value, ValueType};

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
        unsafe {
          sys::napi_create_string_latin1(env.0, data_ptr.cast(), len as isize, &mut raw_value)
        },
        "Failed to create latin1 string"
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
        sys::node_api_create_external_string_latin1(
          env.0,
          data_ptr.cast(),
          len as isize,
          Some(drop_latin1_string),
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
      check_status!(status, "Failed to create external string latin1")?;

      // If V8 copied the bytes, the finalizer already freed our buffer
      // synchronously and exposing a slice into it would be use-after-free.
      // Report an empty view in that case.
      let buf: &'env [u8] = if copied {
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
  /// Creates an external Latin-1 string from raw data with a custom finalize callback.
  ///
  /// ## Safety
  ///
  /// The caller must ensure that:
  /// - The data pointer is valid for the lifetime of the string and points to a memory region of at least `len` bytes
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
  /// own pre-validation (null `data` or `len > isize::MAX`). Those are
  /// caller bugs: we cannot safely reach the buffer at `data + len`, and
  /// many real callbacks (e.g. `Vec::from_raw_parts(ptr, len, len)`) would
  /// trigger UB if invoked with the bogus arguments. Validate inputs and
  /// retain ownership of the source buffer until this returns `Ok` if you
  /// rely on the callback as your only cleanup path.
  ///
  /// ## Behavior
  ///
  /// The `copied` parameter in the underlying `node_api_create_external_string_latin1` call
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
  /// of the bytes into the wrapper before invoking the caller's finalize
  /// callback. The caller's buffer ownership semantics are unchanged
  /// (finalize_callback is called exactly once); on WASM, `as_slice()` etc.
  /// observe the copy stored inside the wrapper.
  ///
  /// On native, when V8 chooses to copy (`copied = true`), the caller's
  /// finalize callback has already run synchronously by the time this
  /// returns, so the source bytes may be freed; `as_slice()` returns `&[]`
  /// in that case. When V8 keeps the buffer external (`copied = false`),
  /// `as_slice()` borrows the caller-provided bytes for free.
  pub unsafe fn from_external<T: 'env, F: FnOnce(Env, T) + 'env>(
    env: &'env Env,
    data: *const u8,
    len: usize,
    finalize_hint: T,
    finalize_callback: F,
  ) -> Result<JsStringLatin1<'env>> {
    use std::ptr;

    use crate::{check_status, Error, Status, Value, ValueType};

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
    if len > isize::MAX as usize {
      return Err(Error::new(
        Status::InvalidArg,
        "Data length exceeds isize::MAX".to_owned(),
      ));
    }

    #[cfg(target_family = "wasm")]
    {
      // emnapi always copies, so use the plain create_string entry point and
      // copy the caller's bytes into our own buffer (so `buf` stays valid
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
      let status = unsafe {
        sys::napi_create_string_latin1(env.0, buf_ptr.cast(), buf_len as isize, &mut raw_value)
      };

      finalize_callback(*env, finalize_hint);

      check_status!(status, "Failed to create latin1 string")?;

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
        sys::node_api_create_external_string_latin1(
          env.0,
          data.cast(),
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
      check_status!(status, "Failed to create external string latin1")?;

      // If V8 copied the bytes, the caller's `finalize_callback` already
      // ran synchronously and the buffer at `data` may be freed. Exposing
      // a slice into it would be use-after-free, so report an empty view
      // in that case.
      let buf: &'env [u8] = if copied {
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
  pub fn from_static(env: &'env Env, string: &'static str) -> Result<JsStringLatin1<'env>> {
    use std::ptr;

    use crate::{check_status, Error, Status, Value, ValueType};

    if string.is_empty() {
      return Err(Error::new(
        Status::InvalidArg,
        "Data pointer should not be null".to_owned(),
      ));
    }

    let mut raw_value = ptr::null_mut();
    let mut copied = false;

    check_status!(
      unsafe {
        sys::node_api_create_external_string_latin1(
          env.0,
          string.as_ptr().cast(),
          string.len() as isize,
          None,
          ptr::null_mut(),
          &mut raw_value,
          &mut copied,
        )
      },
      "Failed to create external string latin1"
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
      buf: string.as_bytes(),
      _inner_buf: vec![],
    })
  }

  pub fn as_slice(&self) -> &[u8] {
    self.buf
  }

  pub fn len(&self) -> usize {
    self.buf.len()
  }

  pub fn is_empty(&self) -> bool {
    self.buf.is_empty()
  }

  pub fn take(self) -> Vec<u8> {
    self.as_slice().to_vec()
  }

  pub fn into_value(self) -> JsString<'env> {
    self.inner
  }

  #[cfg(feature = "latin1")]
  pub fn into_latin1_string(self) -> Result<String> {
    let mut dst_str = unsafe { String::from_utf8_unchecked(vec![0; self.len() * 2 + 1]) };
    encoding_rs::mem::convert_latin1_to_str(self.buf, dst_str.as_mut_str());
    Ok(dst_str)
  }
}

impl From<JsStringLatin1<'_>> for Vec<u8> {
  fn from(value: JsStringLatin1) -> Self {
    value.take()
  }
}

impl ToNapiValue for JsStringLatin1<'_> {
  unsafe fn to_napi_value(_: sys::napi_env, val: JsStringLatin1) -> Result<sys::napi_value> {
    Ok(val.inner.0.value)
  }
}

#[cfg(all(feature = "napi10", not(target_family = "wasm")))]
extern "C" fn drop_latin1_string(
  _: sys::node_api_basic_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  // Pair with `Box::into_raw` in `from_data`. Reconstructs both the hint Box
  // and the original Vec from its (ptr, len, cap) to release them. Called
  // synchronously by V8 when the string was copied, or on GC when the
  // string was kept external.
  let (size, capacity): (usize, usize) = unsafe { *Box::from_raw(finalize_hint.cast()) };
  if size == 0 || finalize_data.is_null() {
    return;
  }
  drop(unsafe { Vec::from_raw_parts(finalize_data.cast::<u8>(), size, capacity) });
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
