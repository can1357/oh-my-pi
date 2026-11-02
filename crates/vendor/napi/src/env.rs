#![allow(deprecated)]

#[cfg(feature = "napi6")]
use std::any::type_name;
#[cfg(feature = "napi5")]
use std::any::Any;
use std::convert::TryInto;
use std::ffi::CString;
#[cfg(all(
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
use std::future::Future;
#[cfg(feature = "compat-mode")]
use std::mem;
use std::os::raw::{c_char, c_void};
use std::ptr;

#[cfg(feature = "serde-json")]
use serde::de::DeserializeOwned;
#[cfg(feature = "serde-json")]
use serde::Serialize;

#[cfg(feature = "napi8")]
use crate::async_cleanup_hook::AsyncCleanupHook;
#[cfg(all(feature = "napi6", feature = "compat-mode"))]
use crate::bindgen_runtime::u128_with_sign_to_napi_value;
#[cfg(feature = "napi6")]
use crate::bindgen_runtime::FinalizeContext;
#[cfg(feature = "napi5")]
use crate::bindgen_runtime::FunctionCallContext;
#[cfg(all(
  any(feature = "tokio_rt", feature = "async-runtime"),
  feature = "napi4"
))]
use crate::bindgen_runtime::PromiseRaw;
use crate::bindgen_runtime::{
  FromNapiValue, Function, JsValuesTupleIntoVec, Object, ToNapiValue, Unknown,
};
#[cfg(feature = "napi3")]
use crate::cleanup_env::{CleanupEnvHook, CleanupEnvHookData};
#[cfg(feature = "serde-json")]
use crate::js_values::{De, Ser};
#[cfg(all(feature = "napi4", feature = "compat-mode"))]
use crate::threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunction};
#[cfg(feature = "napi3")]
use crate::JsError;
use crate::{
  async_work::{self, AsyncWorkPromise},
  bindgen_runtime::JsObjectValue,
  check_status,
  js_values::*,
  sys, Error, ExtendedErrorInfo, NodeVersion, Result, ScopedTask, Status, ValueType,
};

pub type Callback = unsafe extern "C" fn(sys::napi_env, sys::napi_callback_info) -> sys::napi_value;

pub(crate) static EMPTY_VEC: Vec<u8> = vec![];

#[derive(Clone, Copy)]
/// `Env` is used to represent a context that the underlying N-API implementation can use to persist VM-specific state.
///
/// Specifically, the same `Env` that was passed in when the initial native function was called must be passed to any subsequent nested N-API calls.
///
/// Caching the `Env` for the purpose of general reuse, and passing the `Env` between instances of the same addon running on different Worker threads is not allowed.
///
/// The `Env` becomes invalid when an instance of a native addon is unloaded.
///
/// Notification of this event is delivered through the callbacks given to `Env::add_env_cleanup_hook` and `Env::set_instance_data`.
pub struct Env(pub(crate) sys::napi_env);

impl From<sys::napi_env> for Env {
  fn from(env: sys::napi_env) -> Self {
    Env(env)
  }
}

impl Env {
  #[allow(clippy::missing_safety_doc)]
  pub fn from_raw(env: sys::napi_env) -> Self {
    Env(env)
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `bool` instead")]
  pub fn get_boolean(&self, value: bool) -> Result<JsBoolean> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_boolean(self.0, value, &mut raw_value) })?;
    Ok(unsafe { JsBoolean::from_raw_unchecked(self.0, raw_value) })
  }

  /// Create a new JavaScript number from a Rust `i32`
  pub fn create_int32(&self, int: i32) -> Result<JsNumber<'_>> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_int32(self.0, int, (&mut raw_value) as *mut sys::napi_value)
    })?;
    unsafe { JsNumber::from_napi_value(self.0, raw_value) }
  }

  /// Create a new JavaScript number from a Rust `i64`
  pub fn create_int64(&self, int: i64) -> Result<JsNumber<'_>> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_int64(self.0, int, (&mut raw_value) as *mut sys::napi_value)
    })?;
    unsafe { JsNumber::from_napi_value(self.0, raw_value) }
  }

  /// Create a new JavaScript number from a Rust `u32`
  pub fn create_uint32(&self, number: u32) -> Result<JsNumber<'_>> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_uint32(self.0, number, &mut raw_value) })?;
    unsafe { JsNumber::from_napi_value(self.0, raw_value) }
  }

  /// Create a new JavaScript number from a Rust `f64`
  pub fn create_double(&self, double: f64) -> Result<JsNumber<'_>> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_double(self.0, double, (&mut raw_value) as *mut sys::napi_value)
    })?;
    unsafe { JsNumber::from_napi_value(self.0, raw_value) }
  }

  /// [n_api_napi_create_bigint_int64](https://nodejs.org/api/n-api.html#n_api_napi_create_bigint_int64)
  #[cfg(all(feature = "napi6", feature = "compat-mode"))]
  #[deprecated(since = "3.0.0", note = "Use `BigInt` instead")]
  pub fn create_bigint_from_i64(&self, value: i64) -> Result<JsBigInt> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_bigint_int64(self.0, value, &mut raw_value) })?;
    Ok(JsBigInt::from_raw_unchecked(self.0, raw_value, 1))
  }

  #[cfg(all(feature = "napi6", feature = "compat-mode"))]
  #[deprecated(since = "3.0.0", note = "Use `BigInt` instead")]
  pub fn create_bigint_from_u64(&self, value: u64) -> Result<JsBigInt> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_bigint_uint64(self.0, value, &mut raw_value) })?;
    Ok(JsBigInt::from_raw_unchecked(self.0, raw_value, 1))
  }

  #[cfg(all(feature = "napi6", feature = "compat-mode"))]
  #[deprecated(since = "3.0.0", note = "Use `BigInt` instead")]
  pub fn create_bigint_from_i128(&self, value: i128) -> Result<JsBigInt> {
    unsafe {
      let raw_value =
        u128_with_sign_to_napi_value(self.0, value.unsigned_abs(), i32::from(value <= 0))?;
      Ok(JsBigInt::from_raw_unchecked(self.0, raw_value, 2))
    }
  }

  #[cfg(all(feature = "napi6", feature = "compat-mode"))]
  #[deprecated(since = "3.0.0", note = "Use `BigInt` instead")]
  pub fn create_bigint_from_u128(&self, value: u128) -> Result<JsBigInt> {
    unsafe {
      let raw_value = u128_with_sign_to_napi_value(self.0, value, 0)?;
      Ok(JsBigInt::from_raw_unchecked(self.0, raw_value, 2))
    }
  }

  /// [n_api_napi_create_bigint_words](https://nodejs.org/api/n-api.html#n_api_napi_create_bigint_words)
  ///
  /// The resulting BigInt will be negative when sign_bit is true.
  #[cfg(all(feature = "napi6", feature = "compat-mode"))]
  #[deprecated(since = "3.0.0", note = "Use `BigInt` instead")]
  pub fn create_bigint_from_words(&self, sign_bit: bool, words: Vec<u64>) -> Result<JsBigInt> {
    let mut raw_value = ptr::null_mut();
    let len = words.len();
    check_status!(unsafe {
      sys::napi_create_bigint_words(
        self.0,
        match sign_bit {
          true => 1,
          false => 0,
        },
        len,
        words.as_ptr(),
        &mut raw_value,
      )
    })?;
    Ok(JsBigInt::from_raw_unchecked(self.0, raw_value, len))
  }

  /// This API creates a new JavaScript string from a Rust type that can be converted to a `&str`
  pub fn create_string<S: AsRef<str>>(&self, s: S) -> Result<JsString<'_>> {
    let s = s.as_ref();
    unsafe { self.create_string_from_c_char(s.as_ptr().cast(), s.len() as isize) }
  }

  /// This API creates a new JavaScript string from a Rust `String`
  pub fn create_string_from_std<'env>(&self, s: String) -> Result<JsString<'env>> {
    unsafe { self.create_string_from_c_char(s.as_ptr().cast(), s.len() as isize) }
  }

  /// This API is used for C ffi scenario.
  /// Convert raw *const c_char into JsString
  ///
  /// # Safety
  ///
  /// The caller must guarantee that the `data_ptr` is a valid pointer to either:
  /// - a valid utf-8 string with length of `len`
  /// - a valid utf-8 string terminated by a null character when [crate::bindgen_runtime::NAPI_AUTO_LENGTH] is passed to `len`
  pub unsafe fn create_string_from_c_char<'env>(
    &self,
    data_ptr: *const c_char,
    len: isize,
  ) -> Result<JsString<'env>> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_string_utf8(self.0, data_ptr, len, &mut raw_value) })?;
    unsafe { JsString::from_napi_value(self.0, raw_value) }
  }

  /// This API creates a new JavaScript string from a Rust type that can be converted to a `&[u16]`
  pub fn create_string_utf16<C: AsRef<[u16]>>(&self, chars: C) -> Result<JsString<'_>> {
    let mut raw_value = ptr::null_mut();
    let chars = chars.as_ref();
    check_status!(unsafe {
      sys::napi_create_string_utf16(self.0, chars.as_ptr(), chars.len() as isize, &mut raw_value)
    })?;
    unsafe { JsString::from_napi_value(self.0, raw_value) }
  }

  /// This API creates a new JavaScript string from a Rust type that can be converted to a `&[u8]`
  pub fn create_string_latin1<C: AsRef<[u8]>>(&self, chars: C) -> Result<JsString<'_>> {
    let mut raw_value = ptr::null_mut();
    let chars = chars.as_ref();
    check_status!(unsafe {
      sys::napi_create_string_latin1(
        self.0,
        chars.as_ptr().cast(),
        chars.len() as isize,
        &mut raw_value,
      )
    })?;
    unsafe { JsString::from_napi_value(self.0, raw_value) }
  }

  /// This API creates a new JavaScript symbol from a optional description
  pub fn create_symbol(&self, description: Option<&str>) -> Result<JsSymbol<'_>> {
    let mut result = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_symbol(
        self.0,
        description
          .and_then(|desc| self.create_string(desc).ok())
          .map(|string| string.0.value)
          .unwrap_or(ptr::null_mut()),
        &mut result,
      )
    })?;
    Ok(JsSymbol(
      Value {
        env: self.0,
        value: result,
        value_type: ValueType::Symbol,
      },
      std::marker::PhantomData,
    ))
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `Object::new` instead")]
  pub fn create_object(&self) -> Result<JsObject> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_object(self.0, &mut raw_value) })?;
    Ok(unsafe { JsObject::from_raw_unchecked(self.0, raw_value) })
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `Array` instead")]
  pub fn create_empty_array(&self) -> Result<JsObject> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_array(self.0, &mut raw_value) })?;
    Ok(unsafe { JsObject::from_raw_unchecked(self.0, raw_value) })
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `Array` instead")]
  pub fn create_array_with_length(&self, length: usize) -> Result<JsObject> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_array_with_length(self.0, length, &mut raw_value) })?;
    Ok(unsafe { JsObject::from_raw_unchecked(self.0, raw_value) })
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `Buffer` instead")]
  /// This API allocates a node::Buffer object. While this is still a fully-supported data structure, in most cases using a TypedArray will suffice.
  pub fn create_buffer(&self, length: usize) -> Result<JsBufferValue> {
    let mut raw_value = ptr::null_mut();
    let mut data_ptr = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_buffer(self.0, length, &mut data_ptr, &mut raw_value)
    })?;

    Ok(JsBufferValue::new(
      JsBuffer(Value {
        env: self.0,
        value: raw_value,
        value_type: ValueType::Object,
      }),
      mem::ManuallyDrop::new(if length == 0 {
        Vec::new()
      } else {
        unsafe { Vec::from_raw_parts(data_ptr as *mut _, length, length) }
      }),
    ))
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `BufferSlice::from_data` instead")]
  /// This API allocates a node::Buffer object and initializes it with data backed by the passed in buffer.
  ///
  /// While this is still a fully-supported data structure, in most cases using a TypedArray will suffice.
  pub fn create_buffer_with_data(&self, mut data: Vec<u8>) -> Result<JsBufferValue> {
    let length = data.len();
    let mut raw_value = ptr::null_mut();
    let data_ptr = data.as_mut_ptr();
    check_status!(unsafe {
      if length == 0 {
        // Rust uses 0x1 as the data pointer for empty buffers,
        // but NAPI/V8 only allows multiple buffers to have
        // the same data pointer if it's 0x0.
        sys::napi_create_buffer(self.0, length, ptr::null_mut(), &mut raw_value)
      } else {
        let hint_ptr = Box::into_raw(Box::new((length, data.capacity())));
        let status = sys::napi_create_external_buffer(
          self.0,
          length,
          data_ptr.cast(),
          Some(drop_buffer),
          hint_ptr.cast(),
          &mut raw_value,
        );
        // electron doesn't support external buffers
        if status == sys::Status::napi_no_external_buffers_allowed {
          drop(Box::from_raw(hint_ptr));
          let mut dest_data_ptr = ptr::null_mut();
          let status = sys::napi_create_buffer_copy(
            self.0,
            length,
            data.as_ptr().cast(),
            &mut dest_data_ptr,
            &mut raw_value,
          );
          data = Vec::from_raw_parts(dest_data_ptr.cast(), length, length);
          status
        } else {
          status
        }
      }
    })?;
    Ok(JsBufferValue::new(
      JsBuffer(Value {
        env: self.0,
        value: raw_value,
        value_type: ValueType::Object,
      }),
      mem::ManuallyDrop::new(data),
    ))
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `BufferSlice::from_external` instead")]
  /// # Safety
  /// Mostly the same with `create_buffer_with_data`
  ///
  /// Provided `finalize_callback` will be called when `Buffer` got dropped.
  ///
  /// You can pass in `noop_finalize` if you have nothing to do in finalize phase.
  ///
  /// # Notes
  ///
  /// JavaScript may mutate the data passed in to this buffer when writing the buffer.
  /// However, some JavaScript runtimes do not support external buffers (notably electron!)
  /// in which case modifications may be lost.
  ///
  /// If you need to support these runtimes, you should create a buffer by other means and then
  /// later copy the data back out.
  pub unsafe fn create_buffer_with_borrowed_data<Hint, Finalize>(
    &self,
    mut data: *mut u8,
    length: usize,
    hint: Hint,
    finalize_callback: Finalize,
  ) -> Result<JsBufferValue>
  where
    Finalize: FnOnce(Env, Hint),
  {
    let mut raw_value = ptr::null_mut();
    if data.is_null() || std::ptr::eq(data, EMPTY_VEC.as_ptr()) {
      return Err(Error::new(
        Status::InvalidArg,
        "Borrowed data should not be null".to_owned(),
      ));
    }
    let hint_ptr = Box::into_raw(Box::new((hint, finalize_callback)));
    unsafe {
      let status = sys::napi_create_external_buffer(
        self.0,
        length,
        data.cast(),
        Some(raw_finalize_with_custom_callback::<Hint, Finalize>),
        hint_ptr.cast(),
        &mut raw_value,
      );
      if status == sys::Status::napi_no_external_buffers_allowed {
        let (hint, finalize) = *Box::from_raw(hint_ptr);
        let mut result_data = ptr::null_mut();
        let status = sys::napi_create_buffer_copy(
          self.0,
          length,
          data.cast(),
          &mut result_data,
          &mut raw_value,
        );
        data = result_data.cast();
        finalize(*self, hint);
        check_status!(status)?;
      } else {
        check_status!(status)?;
      }
    };
    Ok(JsBufferValue::new(
      JsBuffer(Value {
        env: self.0,
        value: raw_value,
        value_type: ValueType::Object,
      }),
      mem::ManuallyDrop::new(unsafe { Vec::from_raw_parts(data, length, length) }),
    ))
  }

  #[cfg(not(target_family = "wasm"))]
  /// This function gives V8 an indication of the amount of externally allocated memory that is kept alive by JavaScript objects (i.e. a JavaScript object that points to its own memory allocated by a native module).
  ///
  /// Registering externally allocated memory will trigger global garbage collections more often than it would otherwise.
  ///
  /// ***ATTENTION ⚠️***, do not use this with `create_buffer_with_data/create_arraybuffer_with_data`, since these two functions already called the `adjust_external_memory` internal.
  pub fn adjust_external_memory(&self, size: i64) -> Result<i64> {
    let mut changed = 0i64;
    check_status!(unsafe { sys::napi_adjust_external_memory(self.0, size, &mut changed) })?;
    Ok(changed)
  }

  #[cfg(target_family = "wasm")]
  #[allow(unused_variables)]
  pub fn adjust_external_memory(&self, size: i64) -> Result<i64> {
    Ok(0)
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `BufferSlice::copy_from` instead")]
  /// This API allocates a node::Buffer object and initializes it with data copied from the passed-in buffer.
  ///
  /// While this is still a fully-supported data structure, in most cases using a TypedArray will suffice.
  pub fn create_buffer_copy<D>(&self, data_to_copy: D) -> Result<JsBufferValue>
  where
    D: AsRef<[u8]>,
  {
    let length = data_to_copy.as_ref().len();
    let data_ptr = data_to_copy.as_ref().as_ptr();
    let mut copy_data = ptr::null_mut();
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_buffer_copy(
        self.0,
        length,
        data_ptr as *mut c_void,
        &mut copy_data,
        &mut raw_value,
      )
    })?;
    Ok(JsBufferValue::new(
      JsBuffer(Value {
        env: self.0,
        value: raw_value,
        value_type: ValueType::Object,
      }),
      mem::ManuallyDrop::new(if length == 0 {
        Vec::new()
      } else {
        unsafe { Vec::from_raw_parts(copy_data as *mut u8, length, length) }
      }),
    ))
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `ArrayBuffer::from_data` instead")]
  pub fn create_arraybuffer(&self, length: usize) -> Result<JsArrayBufferValue> {
    let mut raw_value = ptr::null_mut();
    let mut data_ptr = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_arraybuffer(self.0, length, &mut data_ptr, &mut raw_value)
    })?;

    Ok(JsArrayBufferValue::new(
      unsafe { JsArrayBuffer::from_raw_unchecked(self.0, raw_value) },
      data_ptr as *mut c_void,
      length,
    ))
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `ArrayBuffer::from_data` instead")]
  pub fn create_arraybuffer_with_data(&self, mut data: Vec<u8>) -> Result<JsArrayBufferValue> {
    let length = data.len();
    let mut raw_value = ptr::null_mut();
    let data_ptr = data.as_mut_ptr();
    if length == 0 {
      // Rust uses 0x1 as the data pointer for empty buffers,
      // but NAPI/V8 only allows multiple buffers to have
      // the same data pointer if it's 0x0.
      check_status!(
        unsafe { sys::napi_create_arraybuffer(self.0, length, ptr::null_mut(), &mut raw_value) },
        "Failed to create arraybuffer"
      )?;
    } else {
      let hint_ptr = Box::into_raw(Box::new((length, data.capacity())));
      let mut status = unsafe {
        sys::napi_create_external_arraybuffer(
          self.0,
          data_ptr.cast(),
          length,
          Some(drop_buffer),
          hint_ptr.cast(),
          &mut raw_value,
        )
      };
      if status == sys::Status::napi_no_external_buffers_allowed {
        unsafe { drop(Box::from_raw(hint_ptr)) };
        let mut underlying_data = ptr::null_mut();
        status = unsafe {
          sys::napi_create_arraybuffer(self.0, length, &mut underlying_data, &mut raw_value)
        };
        check_status!(status, "Failed to create arraybuffer")?;
        if length > 0 {
          unsafe { ptr::copy_nonoverlapping(data_ptr, underlying_data.cast(), length) };
        }
      } else {
        check_status!(status, "Failed to create arraybuffer")?;
      }
    }

    mem::forget(data);
    Ok(JsArrayBufferValue::new(
      JsArrayBuffer(Value {
        env: self.0,
        value: raw_value,
        value_type: ValueType::Object,
      }),
      data_ptr.cast(),
      length,
    ))
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Use `ArrayBuffer::from_external` instead")]
  /// # Safety
  /// Mostly the same with `create_arraybuffer_with_data`
  ///
  /// Provided `finalize_callback` will be called when `Buffer` got dropped.
  ///
  /// You can pass in `noop_finalize` if you have nothing to do in finalize phase.
  ///
  /// # Notes
  ///
  /// JavaScript may mutate the data passed in to this buffer when writing the buffer.
  /// However, some JavaScript runtimes do not support external buffers (notably electron!)
  /// in which case modifications may be lost.
  ///
  /// If you need to support these runtimes, you should create a buffer by other means and then
  /// later copy the data back out.
  pub unsafe fn create_arraybuffer_with_borrowed_data<Hint, Finalize>(
    &self,
    data: *mut u8,
    length: usize,
    hint: Hint,
    finalize_callback: Finalize,
  ) -> Result<JsArrayBufferValue>
  where
    Finalize: FnOnce(Env, Hint),
  {
    let mut raw_value = ptr::null_mut();
    let hint_ptr = Box::into_raw(Box::new((hint, finalize_callback)));
    // `finalize` below reclaims `data`; on the copy fallback the value must
    // point at the engine-owned copy instead.
    let mut data_ptr: *mut c_void = data.cast();
    unsafe {
      let status = sys::napi_create_external_arraybuffer(
        self.0,
        if length == 0 {
          // Rust uses 0x1 as the data pointer for empty buffers,
          // but NAPI/V8 only allows multiple buffers to have
          // the same data pointer if it's 0x0.
          ptr::null_mut()
        } else {
          data as *mut c_void
        },
        length,
        Some(
          raw_finalize_with_custom_callback::<Hint, Finalize>
            as unsafe extern "C" fn(
              env: sys::napi_env,
              finalize_data: *mut c_void,
              finalize_hint: *mut c_void,
            ),
        ),
        hint_ptr.cast(),
        &mut raw_value,
      );
      if status == sys::Status::napi_no_external_buffers_allowed {
        let (hint, finalize) = *Box::from_raw(hint_ptr);
        let mut underlying_data = ptr::null_mut();
        let status =
          sys::napi_create_arraybuffer(self.0, length, &mut underlying_data, &mut raw_value);
        // Copy data before calling finalize, since finalize may free the source data
        if status == sys::Status::napi_ok && length > 0 {
          ptr::copy_nonoverlapping(data, underlying_data.cast(), length);
        }
        // Always call finalize to clean up caller's resources, even on error
        finalize(*self, hint);
        check_status!(status, "Failed to create arraybuffer")?;
        if length > 0 {
          data_ptr = underlying_data;
        }
      } else {
        check_status!(status)?;
      }
    };
    Ok(JsArrayBufferValue::new(
      JsArrayBuffer(Value {
        env: self.0,
        value: raw_value,
        value_type: ValueType::Object,
      }),
      data_ptr,
      length,
    ))
  }

  /// This API allows an add-on author to create a function object in native code.
  ///
  /// This is the primary mechanism to allow calling into the add-on's native code from JavaScript.
  ///
  /// The newly created function is not automatically visible from script after this call.
  ///
  /// Instead, a property must be explicitly set on any object that is visible to JavaScript, in order for the function to be accessible from script.
  pub fn create_function<Args: JsValuesTupleIntoVec, Return>(
    &self,
    name: &str,
    callback: Callback,
  ) -> Result<Function<'_, Args, Return>> {
    let mut raw_result = ptr::null_mut();
    let len = name.len();
    check_status!(unsafe {
      sys::napi_create_function(
        self.0,
        name.as_ptr().cast(),
        len as isize,
        Some(callback),
        ptr::null_mut(),
        &mut raw_result,
      )
    })?;

    unsafe { Function::<Args, Return>::from_napi_value(self.0, raw_result) }
  }

  #[cfg(feature = "napi5")]
  pub fn create_function_from_closure<Args: JsValuesTupleIntoVec, Return, F>(
    &self,
    name: &str,
    callback: F,
  ) -> Result<Function<'_, Args, Return>>
  where
    Return: ToNapiValue,
    F: 'static + Fn(FunctionCallContext) -> Result<Return>,
  {
    let closure_data_ptr = Box::into_raw(Box::new(callback));

    let mut raw_result = ptr::null_mut();
    let len = name.len();
    check_status!(unsafe {
      sys::napi_create_function(
        self.0,
        name.as_ptr().cast(),
        len as isize,
        Some(trampoline::<Return, F>),
        closure_data_ptr.cast(), // We let it borrow the data here
        &mut raw_result,
      )
    })?;

    // Note: based on N-API docs, at this point, we have created an effective
    // `&'static dyn Fn…` in Rust parlance, in that thanks to `Box::into_raw()`
    // we are sure the context won't be freed, and thus the callback may use
    // it to call the actual method thanks to the trampoline…
    // But we thus have a data leak: there is nothing yet responsible for
    // running the `drop(Box::from_raw(…))` cleanup code.
    //
    // To solve that, according to the docs, we need to attach a finalizer:
    check_status!(unsafe {
      sys::napi_add_finalizer(
        self.0,
        raw_result,
        closure_data_ptr.cast(),
        Some(finalize_box_trampoline::<F>),
        ptr::null_mut(),
        ptr::null_mut(),
      )
    })?;

    unsafe { Function::from_napi_value(self.0, raw_result) }
  }

  /// This API retrieves a napi_extended_error_info structure with information about the last error that occurred.
  ///
  /// The content of the napi_extended_error_info returned is only valid up until an n-api function is called on the same env.
  ///
  /// Do not rely on the content or format of any of the extended information as it is not subject to SemVer and may change at any time. It is intended only for logging purposes.
  ///
  /// This API can be called even if there is a pending JavaScript exception.
  pub fn get_last_error_info(&self) -> Result<ExtendedErrorInfo> {
    let mut raw_extended_error = ptr::null();
    check_status!(unsafe { sys::napi_get_last_error_info(self.0, &mut raw_extended_error) })?;
    unsafe { ptr::read(raw_extended_error) }.try_into()
  }

  /// Throw any JavaScript value
  pub fn throw<T: ToNapiValue>(&self, value: T) -> Result<()> {
    check_status!(unsafe { sys::napi_throw(self.0, ToNapiValue::to_napi_value(self.0, value)?,) })
  }

  /// This API throws a JavaScript Error with the text provided.
  pub fn throw_error(&self, msg: &str, code: Option<&str>) -> Result<()> {
    let code = code.and_then(|s| CString::new(s).ok());
    let msg = CString::new(msg)?;
    check_status!(unsafe {
      sys::napi_throw_error(
        self.0,
        code.as_ref().map(|s| s.as_ptr()).unwrap_or(ptr::null_mut()),
        msg.as_ptr(),
      )
    })
  }

  /// This API throws a JavaScript RangeError with the text provided.
  pub fn throw_range_error(&self, msg: &str, code: Option<&str>) -> Result<()> {
    let code = code.and_then(|s| CString::new(s).ok());
    let msg = CString::new(msg)?;
    check_status!(unsafe {
      sys::napi_throw_range_error(
        self.0,
        code.as_ref().map(|s| s.as_ptr()).unwrap_or(ptr::null_mut()),
        msg.as_ptr(),
      )
    })
  }

  /// This API throws a JavaScript TypeError with the text provided.
  pub fn throw_type_error(&self, msg: &str, code: Option<&str>) -> Result<()> {
    let code = code.and_then(|s| CString::new(s).ok());
    let msg = CString::new(msg)?;
    check_status!(unsafe {
      sys::napi_throw_type_error(
        self.0,
        code.as_ref().map(|s| s.as_ptr()).unwrap_or(ptr::null_mut()),
        msg.as_ptr(),
      )
    })
  }

  /// This API throws a JavaScript SyntaxError with the text provided.
  #[cfg(feature = "napi9")]
  pub fn throw_syntax_error<S: AsRef<str>, C: AsRef<str>>(&self, msg: S, code: Option<C>) {
    use crate::check_status_or_throw;

    let code = code.as_ref().map(|c| c.as_ref()).unwrap_or("");
    let c_code = CString::new(code).expect("code must be a valid utf-8 string");
    let code_ptr = c_code.as_ptr();
    let msg: CString = CString::new(msg.as_ref()).expect("msg must be a valid utf-8 string");
    let msg_ptr = msg.as_ptr();
    check_status_or_throw!(
      self.0,
      unsafe { sys::node_api_throw_syntax_error(self.0, code_ptr, msg_ptr,) },
      "Throw syntax error failed"
    );
  }

  #[allow(clippy::expect_fun_call)]
  /// In the event of an unrecoverable error in a native module
  ///
  /// A fatal error can be thrown to immediately terminate the process.
  pub fn fatal_error(self, location: &str, message: &str) {
    let location_len = location.len();
    let message_len = message.len();

    unsafe {
      sys::napi_fatal_error(
        location.as_ptr().cast(),
        location_len as isize,
        message.as_ptr().cast(),
        message_len as isize,
      )
    }
  }

  #[cfg(feature = "napi3")]
  /// Trigger an 'uncaughtException' in JavaScript.
  ///
  /// Useful if an async callback throws an exception with no way to recover.
  pub fn fatal_exception(&self, err: Error) {
    unsafe {
      let js_error = JsError::from(err).into_value(self.0);
      let status = sys::napi_fatal_exception(self.0, js_error);
      debug_assert!(
        status == sys::Status::napi_ok,
        "napi_fatal_exception failed"
      );
    };
  }

  /// Create JavaScript class
  pub fn define_class<Args: JsValuesTupleIntoVec>(
    &self,
    name: &str,
    constructor_cb: Callback,
    properties: &[Property],
  ) -> Result<Function<'_, Args, Unknown<'_>>> {
    let mut raw_result = ptr::null_mut();
    let raw_properties = properties
      .iter()
      .map(|prop| prop.raw())
      .collect::<Vec<sys::napi_property_descriptor>>();
    check_status!(unsafe {
      sys::napi_define_class(
        self.0,
        name.as_ptr().cast(),
        name.len() as isize,
        Some(constructor_cb),
        ptr::null_mut(),
        raw_properties.len(),
        raw_properties.as_ptr(),
        &mut raw_result,
      )
    })?;

    unsafe { Function::from_napi_value(self.0, raw_result) }
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `JsObjectValue::wrap` instead")]
  #[allow(clippy::needless_pass_by_ref_mut)]
  pub fn wrap<T: 'static>(
    &self,
    js_object: &mut JsObject,
    native_object: T,
    size_hint: Option<usize>,
  ) -> Result<()> {
    let tagged_object = Box::into_raw(Box::new(TaggedObject::new(native_object)));
    let size_hint_ptr = Box::into_raw(Box::new(size_hint.unwrap_or(0) as i64));
    if let Err(err) = check_status!(unsafe {
      sys::napi_wrap(
        self.0,
        js_object.0.value,
        tagged_object.cast(),
        Some(finalize_tagged_object::<T>),
        size_hint_ptr.cast(),
        ptr::null_mut(),
      )
    }) {
      drop(unsafe { Box::from_raw(tagged_object) });
      drop(unsafe { Box::from_raw(size_hint_ptr) });
      return Err(err);
    }
    // Same payload registry as `JsObjectValue::wrap`; see that method.
    register_payload(tagged_object.cast());
    Ok(())
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `JsObjectValue::unwrap` instead")]
  #[allow(clippy::mut_from_ref)]
  pub fn unwrap<T: 'static>(&self, js_object: &JsObject) -> Result<&mut T> {
    unsafe {
      let tagged_object = unwrap_tagged_object::<T>(self.0, js_object.0.value)?;
      (*tagged_object).object.as_mut().ok_or_else(|| {
        Error::new(
          Status::InvalidArg,
          "Invalid argument, nothing attach to js_object".to_owned(),
        )
      })
    }
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(
    since = "3.0.0",
    note = "Please use `JsObjectValue::drop_wrapped` instead"
  )]
  pub fn drop_wrapped<T: 'static>(&self, js_object: &JsObject) -> Result<()> {
    unsafe {
      // Validate before detaching: on mismatch the wrap and its finalizer must
      // stay intact.
      unwrap_tagged_object::<T>(self.0, js_object.0.value)?;
      let mut detached = ptr::null_mut();
      check_status!(sys::napi_remove_wrap(
        self.0,
        js_object.0.value,
        &mut detached,
      ))?;
      unregister_payload(detached);
      drop(Box::from_raw(detached as *mut TaggedObject<T>));
      Ok(())
    }
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `Ref::new` instead")]
  /// This API create a new reference with the initial 1 ref count to the Object passed in.
  pub fn create_reference<'env, T>(&self, value: &T) -> Result<Ref<T>>
  where
    T: JsValue<'env>,
  {
    Ref::new(self, value)
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `Ref::get_value` instead")]
  /// Get reference value from `Ref` with type check
  pub fn get_reference_value<T>(&self, reference: &Ref<T>) -> Result<T>
  where
    T: FromNapiValue,
  {
    let mut js_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_get_reference_value(self.0, reference.raw_ref, &mut js_value)
    })?;
    unsafe { T::from_napi_value(self.0, js_value) }
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `ObjectRef::get_value` instead")]
  /// Get reference value from `Ref` without type check
  ///
  /// Using this API if you are sure the type of `T` is matched with provided `Ref<()>`.
  ///
  /// If type mismatched, calling `T::method` would return `Err`.
  pub fn get_reference_value_unchecked<T>(&self, reference: &Ref<T>) -> Result<T>
  where
    T: FromNapiValue,
  {
    let mut js_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_get_reference_value(self.0, reference.raw_ref, &mut js_value)
    })?;
    unsafe { T::from_napi_value(self.0, js_value) }
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `External::new` instead")]
  /// If `size_hint` provided, `Env::adjust_external_memory` will be called under the hood.
  ///
  /// If no `size_hint` provided, global garbage collections will be triggered less times than expected.
  ///
  /// If getting the exact `native_object` size is difficult, you can provide an approximate value, it's only effect to the GC.
  pub fn create_external<'env, T: 'static>(
    &'env self,
    native_object: T,
    size_hint: Option<i64>,
  ) -> Result<JsExternal<'env>> {
    let mut object_value = ptr::null_mut();
    let tagged_object = Box::into_raw(Box::new(TaggedObject::new(native_object)));
    let size_hint_ptr = Box::into_raw(Box::new(size_hint.unwrap_or(0)));
    if let Err(err) = check_status!(unsafe {
      sys::napi_create_external(
        self.0,
        tagged_object.cast(),
        Some(finalize_external_payload::<TaggedObject<T>>),
        size_hint_ptr.cast(),
        &mut object_value,
      )
    }) {
      drop(unsafe { Box::from_raw(tagged_object) });
      drop(unsafe { Box::from_raw(size_hint_ptr) });
      return Err(err);
    }
    // Register the payload so `get_value_external` can confirm it is a live
    // `TaggedObject` produced by this API before dereferencing it.
    register_native_payload::<TaggedObject<T>>(tagged_object.cast());
    if let Some(changed) = size_hint {
      if changed != 0 {
        let mut adjusted_value = 0i64;
        check_status!(unsafe {
          sys::napi_adjust_external_memory(self.0, changed, &mut adjusted_value)
        })?;
      }
    };
    unsafe { JsExternal::from_napi_value(self.0, object_value) }
  }

  #[cfg(feature = "compat-mode")]
  #[deprecated(since = "3.0.0", note = "Please use `&External` instead")]
  #[allow(clippy::mut_from_ref)]
  pub fn get_value_external<T: 'static>(&self, js_external: &JsExternal) -> Result<&mut T> {
    unsafe {
      let mut unknown_tagged_object = ptr::null_mut();
      check_status!(sys::napi_get_value_external(
        self.0,
        js_external.0.value,
        &mut unknown_tagged_object,
      ))?;

      // The payload pointer is untyped; registry membership proves it is a
      // live `TaggedObject<T>` produced by `Env::create_external` in this
      // binary before any dereference.
      if unknown_tagged_object.is_null()
        || !is_registered_native_payload::<TaggedObject<T>>(unknown_tagged_object)
      {
        return Err(Error::new(
          Status::InvalidArg,
          "T on get_value_external is not the type of wrapped object".to_owned(),
        ));
      }
      let tagged_object = unknown_tagged_object as *mut TaggedObject<T>;
      (*tagged_object).object.as_mut().ok_or_else(|| {
        Error::new(
          Status::InvalidArg,
          "nothing attach to js_external".to_owned(),
        )
      })
    }
  }

  /// Create a JavaScript error object from `Error`
  ///
  /// The result is always an `Error`. An [`Error`] can retain an arbitrary
  /// JavaScript value (see [`Error::from_unknown_without_coercion`]) — a number,
  /// `null`, a string — and handing that back would break this function's own
  /// contract and silently no-op every object operation the caller then performs
  /// on the result. Reuse is therefore gated on `napi_is_error`, exactly like
  /// `JsError::into_value`.
  ///
  /// This gate is specific to the two APIs that *construct* an error object. The
  /// [`ToNapiValue`](crate::bindgen_prelude::ToNapiValue) impls — for `Error` and
  /// for `JsError`/`JsTypeError`/`JsRangeError` — are conversions and hand the
  /// retained value back verbatim, which is what the rejection and throw
  /// settlement paths need.
  pub fn create_error(&self, e: Error) -> Result<Object<'_>> {
    // Reuse the original JS error object when it is safe to read on this thread
    // *and* it really is an error; the shared `napi_ref` is released when `e`
    // drops at the end of this call.
    if let Some(result) = unsafe { e.referenced_value(self.0) } {
      if unsafe { crate::error::is_js_error(self.0, result) } {
        return Ok(Object::from_raw(self.0, result));
      }
    }
    let reason = &e.reason;
    let reason_string = self.create_string(reason.as_str())?;
    let status = self.create_string(e.status.as_ref())?;
    let mut result = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_error(self.0, status.0.value, reason_string.0.value, &mut result)
    })?;
    Ok(Object::from_raw(self.0, result))
  }

  /// Run [Task](./trait.Task.html) in libuv thread pool, return [AsyncWorkPromise](./struct.AsyncWorkPromise.html)
  pub fn spawn<'env, T: 'env + ScopedTask<'env>>(
    &self,
    task: T,
  ) -> Result<AsyncWorkPromise<T::JsValue>> {
    async_work::run(self.0, task, None)
  }

  pub fn run_in_scope<T, F>(&self, executor: F) -> Result<T>
  where
    F: FnOnce() -> Result<T>,
  {
    let mut handle_scope = ptr::null_mut();
    check_status!(unsafe { sys::napi_open_handle_scope(self.0, &mut handle_scope) })?;

    let result = executor();

    check_status!(unsafe { sys::napi_close_handle_scope(self.0, handle_scope) })?;
    result
  }

  /// Node-API provides an API for executing a string containing JavaScript using the underlying JavaScript engine.
  /// This function executes a string of JavaScript code and returns its result with the following caveats:
  /// - Unlike `eval`, this function does not allow the script to access the current lexical scope, and therefore also does not allow to access the [module scope](https://nodejs.org/api/modules.html#the-module-scope), meaning that pseudo-globals such as require will not be available.
  /// - The script can access the [global scope](https://nodejs.org/api/globals.html). Function and `var` declarations in the script will be added to the [global](https://nodejs.org/api/globals.html#global) object. Variable declarations made using `let` and `const` will be visible globally, but will not be added to the global object.
  /// - The value of this is [global](https://nodejs.org/api/globals.html) within the script.
  pub fn run_script<S: AsRef<str>, V: FromNapiValue>(&self, script: S) -> Result<V> {
    let s = self.create_string(script.as_ref())?;
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_run_script(self.0, s.raw(), &mut raw_value) })?;
    unsafe { V::from_napi_value(self.0, raw_value) }
  }

  /// `process.versions.napi`
  pub fn get_napi_version(&self) -> Result<u32> {
    let global = self.get_global()?;
    let process: Object = global.get_named_property("process")?;
    let versions: Object = process.get_named_property("versions")?;
    let napi_version: String = versions.get_named_property("napi")?;
    napi_version
      .parse()
      .map_err(|e| Error::new(Status::InvalidArg, format!("{e}")))
  }

  #[cfg(all(feature = "napi2", not(target_family = "wasm")))]
  pub fn get_uv_event_loop(&self) -> Result<*mut sys::uv_loop_s> {
    let mut uv_loop: *mut sys::uv_loop_s = ptr::null_mut();
    check_status!(unsafe { sys::napi_get_uv_event_loop(self.0, &mut uv_loop) })?;
    Ok(uv_loop)
  }

  #[cfg(feature = "napi3")]
  pub fn add_env_cleanup_hook<T, F>(
    &self,
    cleanup_data: T,
    cleanup_fn: F,
  ) -> Result<CleanupEnvHook<T>>
  where
    T: 'static,
    F: 'static + FnOnce(T),
  {
    let hook = CleanupEnvHookData {
      data: cleanup_data,
      hook: Box::new(cleanup_fn),
    };
    let hook_ref = Box::leak(Box::new(hook));
    #[cfg(not(target_family = "wasm"))]
    {
      check_status!(unsafe {
        sys::napi_add_env_cleanup_hook(
          self.0,
          Some(cleanup_env::<T>),
          (hook_ref as *mut CleanupEnvHookData<T>).cast(),
        )
      })?;
    }

    #[cfg(all(target_family = "wasm", not(feature = "noop")))]
    {
      check_status!(unsafe {
        crate::napi_add_env_cleanup_hook(
          self.0,
          Some(cleanup_env::<T>),
          (hook_ref as *mut CleanupEnvHookData<T>).cast(),
        )
      })?;
    }
    Ok(CleanupEnvHook(hook_ref))
  }

  #[cfg(feature = "napi3")]
  pub fn remove_env_cleanup_hook<T>(&self, hook: CleanupEnvHook<T>) -> Result<()>
  where
    T: 'static,
  {
    #[cfg(not(target_family = "wasm"))]
    {
      check_status!(unsafe {
        sys::napi_remove_env_cleanup_hook(self.0, Some(cleanup_env::<T>), hook.0 as *mut _)
      })
    }

    // Mirror `add_env_cleanup_hook`: on wasm the cleanup hooks resolve through
    // the `napi` wasm import module (`#[link(wasm_import_module = "napi")]` in
    // `lib.rs`), which is also where the emnapi archives bind their own
    // references. Going through `sys` here would emit an `env`-module import
    // for the same symbol instead, so removal would target a different
    // implementation than the one registration went through and the hook would
    // still fire at env teardown.
    #[cfg(all(target_family = "wasm", not(feature = "noop")))]
    {
      check_status!(unsafe {
        crate::napi_remove_env_cleanup_hook(self.0, Some(cleanup_env::<T>), hook.0 as *mut _)
      })
    }

    #[cfg(all(target_family = "wasm", feature = "noop"))]
    {
      // `noop` builds register nothing (`add_env_cleanup_hook` skips the call
      // too), so just drop the hook.
      let _ = (hook.0, cleanup_env::<T>);
      Ok(())
    }
  }

  #[cfg(all(feature = "napi4", feature = "compat-mode"))]
  #[deprecated(
    since = "2.17.0",
    note = "Please use `Function::build_threadsafe_function` instead"
  )]
  #[allow(deprecated)]
  pub fn create_threadsafe_function<
    T: 'static + Send,
    V: 'static + JsValuesTupleIntoVec,
    R: 'static + Send + FnMut(ThreadsafeCallContext<T>) -> Result<V>,
  >(
    &self,
    func: &JsFunction,
    _max_queue_size: usize,
    callback: R,
  ) -> Result<ThreadsafeFunction<T, Unknown<'_>, V>> {
    ThreadsafeFunction::<T, Unknown, V>::create(self.0, func.0.value, callback)
  }

  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4",
    feature = "compat-mode"
  ))]
  #[deprecated(since = "3.0.0", note = "Please use `Env::spawn_future` instead")]
  pub fn execute_tokio_future<
    T: 'static + Send,
    V: 'static + ToNapiValue,
    F: 'static + Send + Future<Output = Result<T>>,
    R: 'static + FnOnce(&mut Env, T) -> Result<V>,
  >(
    &self,
    fut: F,
    resolver: R,
  ) -> Result<JsObject> {
    use crate::tokio_runtime;

    let promise = tokio_runtime::execute_tokio_future(self.0, fut, |env, val| unsafe {
      resolver(&mut Env::from_raw(env), val).and_then(|v| ToNapiValue::to_napi_value(env, v))
    })?;

    Ok(unsafe { JsObject::from_raw_unchecked(self.0, promise) })
  }

  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  /// Spawn a future, return a JavaScript Promise which takes the result of the future
  pub fn spawn_future<
    T: 'static + Send + ToNapiValue,
    F: 'static + Send + Future<Output = Result<T>>,
  >(
    &self,
    fut: F,
  ) -> Result<PromiseRaw<'_, T>> {
    use crate::tokio_runtime;

    let promise = tokio_runtime::execute_tokio_future(self.0, fut, |env, val| unsafe {
      ToNapiValue::to_napi_value(env, val)
    })?;

    Ok(PromiseRaw::new(self.0, promise))
  }

  #[cfg(all(
    any(feature = "tokio_rt", feature = "async-runtime"),
    feature = "napi4"
  ))]
  /// Spawn a future with a callback
  /// So you can access the `Env` and resolved value after the future completed
  pub fn spawn_future_with_callback<
    'env,
    T: 'static + Send,
    V: ToNapiValue,
    F: 'static + Send + Future<Output = Result<T>>,
    R: 'static + FnOnce(&'env Env, T) -> Result<V>,
  >(
    &'env self,
    fut: F,
    callback: R,
  ) -> Result<PromiseRaw<'env, V>> {
    use crate::tokio_runtime;

    let promise = tokio_runtime::execute_tokio_future(self.0, fut, move |env, val| unsafe {
      let env = Env::from_raw(env);
      let static_env = core::mem::transmute::<&Env, &'env Env>(&env);
      let val = callback(static_env, val)?;
      ToNapiValue::to_napi_value(env.0, val)
    })?;

    Ok(PromiseRaw::new(self.0, promise))
  }

  /// Creates a deferred promise, which can be resolved or rejected from a background thread.
  #[cfg(feature = "napi4")]
  pub fn create_deferred<Data: ToNapiValue, Resolver: FnOnce(Env) -> Result<Data>>(
    &self,
  ) -> Result<(JsDeferred<Data, Resolver>, Object<'_>)> {
    JsDeferred::new(self)
  }

  /// This API does not observe leap seconds; they are ignored, as ECMAScript aligns with POSIX time specification.
  ///
  /// This API allocates a JavaScript Date object.
  ///
  /// JavaScript Date objects are described in [Section 20.3](https://tc39.github.io/ecma262/#sec-date-objects) of the ECMAScript Language Specification.
  #[cfg(feature = "napi5")]
  pub fn create_date(&self, time: f64) -> Result<JsDate<'_>> {
    let mut js_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_date(self.0, time, &mut js_value) })?;
    Ok(JsDate::from_raw(self.0, js_value))
  }

  #[cfg(feature = "napi6")]
  /// This API associates data with the currently running Agent. data can later be retrieved using `Env::get_instance_data()`.
  ///
  /// Any existing data associated with the currently running Agent which was set by means of a previous call to `Env::set_instance_data()` will be overwritten.
  ///
  /// If a `finalize_cb` was provided by the previous call, it will not be called.
  pub fn set_instance_data<T, Hint, F>(&self, native: T, hint: Hint, finalize_cb: F) -> Result<()>
  where
    T: 'static,
    Hint: 'static,
    F: FnOnce(FinalizeContext<T, Hint>),
  {
    let instance_data = Box::into_raw(Box::new(InstanceData {
      tagged_object: TaggedObject::new(native),
      finalize_cb,
    }));
    let hint_ptr = Box::into_raw(Box::new(hint));
    if let Err(err) = check_status!(unsafe {
      sys::napi_set_instance_data(
        self.0,
        instance_data.cast(),
        Some(
          set_instance_finalize_callback::<T, Hint, F>
            as unsafe extern "C" fn(
              env: sys::napi_env,
              finalize_data: *mut c_void,
              finalize_hint: *mut c_void,
            ),
        ),
        hint_ptr.cast(),
      )
    }) {
      drop(unsafe { Box::from_raw(instance_data) });
      drop(unsafe { Box::from_raw(hint_ptr) });
      return Err(err);
    }
    // Register the payload so `get_instance_data` can confirm it is live data
    // set by this API before dereferencing it.
    register_native_payload::<InstanceDataTag<T>>(instance_data.cast());
    Ok(())
  }

  /// This API retrieves data that was previously associated with the currently running Agent via `Env::set_instance_data()`.
  ///
  /// If no data is set, the call will succeed and data will be set to NULL.
  #[cfg(feature = "napi6")]
  pub fn get_instance_data<T>(&self) -> Result<Option<&'static mut T>>
  where
    T: 'static,
  {
    let mut unknown_tagged_object: *mut c_void = ptr::null_mut();
    unsafe {
      check_status!(sys::napi_get_instance_data(
        self.0,
        &mut unknown_tagged_object
      ))?;
      if unknown_tagged_object.is_null() {
        return Ok(None);
      }
      // The instance-data slot is per-env and can be overwritten by any code
      // in the process; registry membership proves the pointer is a live
      // `InstanceData<T>` payload set by `Env::set_instance_data` in this
      // binary before any dereference.
      if !is_registered_native_payload::<InstanceDataTag<T>>(unknown_tagged_object) {
        return Err(Error::new(
          Status::InvalidArg,
          format!(
            "Invalid argument, {} on unwrap is not the type of wrapped object",
            type_name::<T>()
          ),
        ));
      }
      let tagged_object = unknown_tagged_object as *mut TaggedObject<T>;
      (*tagged_object).object.as_mut().map(Some).ok_or_else(|| {
        Error::new(
          Status::InvalidArg,
          "Invalid argument, nothing attach to js_object".to_owned(),
        )
      })
    }
  }

  /// Registers hook, which is a function of type `FnOnce(Arg)`, as a function to be run with the `arg` parameter once the current Node.js environment exits.
  ///
  /// Unlike [`add_env_cleanup_hook`](https://docs.rs/napi/latest/napi/struct.Env.html#method.add_env_cleanup_hook), the hook is allowed to be asynchronous.
  ///
  /// Otherwise, behavior generally matches that of [`add_env_cleanup_hook`](https://docs.rs/napi/latest/napi/struct.Env.html#method.add_env_cleanup_hook).
  #[cfg(feature = "napi8")]
  pub fn add_removable_async_cleanup_hook<Arg, F>(
    &self,
    arg: Arg,
    cleanup_fn: F,
  ) -> Result<AsyncCleanupHook>
  where
    F: FnOnce(Arg),
    Arg: 'static,
  {
    let mut handle = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_add_async_cleanup_hook(
        self.0,
        Some(
          async_finalize::<Arg, F>
            as unsafe extern "C" fn(handle: sys::napi_async_cleanup_hook_handle, data: *mut c_void),
        ),
        Box::leak(Box::new((arg, cleanup_fn))) as *mut (Arg, F) as *mut c_void,
        &mut handle,
      )
    })?;
    Ok(AsyncCleanupHook(handle))
  }

  /// This API is very similar to [`add_removable_async_cleanup_hook`](https://docs.rs/napi/latest/napi/struct.Env.html#method.add_removable_async_cleanup_hook)
  ///
  /// Use this one if you don't want remove the cleanup hook anymore.
  #[cfg(feature = "napi8")]
  pub fn add_async_cleanup_hook<Arg, F>(&self, arg: Arg, cleanup_fn: F) -> Result<()>
  where
    F: FnOnce(Arg),
    Arg: 'static,
  {
    check_status!(unsafe {
      sys::napi_add_async_cleanup_hook(
        self.0,
        Some(
          async_finalize::<Arg, F>
            as unsafe extern "C" fn(handle: sys::napi_async_cleanup_hook_handle, data: *mut c_void),
        ),
        Box::leak(Box::new((arg, cleanup_fn))) as *mut (Arg, F) as *mut c_void,
        ptr::null_mut(),
      )
    })
  }

  #[cfg(feature = "napi9")]
  pub fn symbol_for(&self, description: &str) -> Result<JsSymbol<'_>> {
    let mut result = ptr::null_mut();
    check_status!(unsafe {
      sys::node_api_symbol_for(
        self.0,
        description.as_ptr().cast(),
        description.len() as isize,
        &mut result,
      )
    })?;

    Ok(JsSymbol(
      Value {
        env: self.0,
        value: result,
        value_type: ValueType::Symbol,
      },
      std::marker::PhantomData,
    ))
  }

  #[cfg(feature = "napi9")]
  /// This API retrieves the file path of the currently running JS module as a URL. For a file on
  /// the local file system it will start with `file://`.
  ///
  /// # Errors
  ///
  /// The retrieved string may be empty if the add-on loading process fails to establish the
  /// add-on's file name.
  pub fn get_module_file_name(&self) -> Result<String> {
    let mut char_ptr = ptr::null();
    check_status!(
      unsafe { sys::node_api_get_module_file_name(self.0, &mut char_ptr) },
      "call node_api_get_module_file_name failed"
    )?;
    // SAFETY: This is safe because `char_ptr` is guaranteed to not be `null`, and point to
    // null-terminated string data.
    let module_filename = unsafe { std::ffi::CStr::from_ptr(char_ptr) };

    Ok(module_filename.to_string_lossy().into_owned())
  }

  /// ### Serialize `Rust Struct` into `JavaScript Value`
  ///
  /// ```
  /// #[derive(Serialize, Debug, Deserialize)]
  /// struct AnObject {
  ///     a: u32,
  ///     b: Vec<f64>,
  ///     c: String,
  /// }
  ///
  /// #[js_function]
  /// fn serialize(ctx: CallContext) -> Result<JsUnknown> {
  ///     let value = AnyObject { a: 1, b: vec![0.1, 2.22], c: "hello" };
  ///     ctx.env.to_js_value(&value)
  /// }
  /// ```
  #[cfg(feature = "serde-json")]
  #[allow(clippy::wrong_self_convention)]
  pub fn to_js_value<'env, T>(&self, node: &T) -> Result<Unknown<'env>>
  where
    T: Serialize,
  {
    let s = Ser(self);
    node
      .serialize(s)
      .map(|v| Unknown(v, std::marker::PhantomData))
  }

  /// ### Deserialize data from `JsValue`
  /// ```
  /// #[derive(Serialize, Debug, Deserialize)]
  /// struct AnObject {
  ///     a: u32,
  ///     b: Vec<f64>,
  ///     c: String,
  /// }
  ///
  /// #[js_function(1)]
  /// fn deserialize_from_js(ctx: CallContext) -> Result<JsUndefined> {
  ///     let arg0 = ctx.get::<JsUnknown>(0)?;
  ///     let de_serialized: AnObject = ctx.env.from_js_value(arg0)?;
  ///     ...
  /// }
  ///
  #[cfg(feature = "serde-json")]
  pub fn from_js_value<'v, T, V>(&self, value: V) -> Result<T>
  where
    T: DeserializeOwned,
    V: JsValue<'v>,
  {
    let value = Value {
      env: self.0,
      value: value.raw(),
      value_type: ValueType::Unknown,
    };
    let mut de = De(&value);
    T::deserialize(&mut de)
  }

  /// This API represents the invocation of the Strict Equality algorithm as defined in [Section 7.2.14](https://tc39.es/ecma262/#sec-strict-equality-comparison) of the ECMAScript Language Specification.
  pub fn strict_equals<'env, A: JsValue<'env>, B: JsValue<'env>>(
    &self,
    a: A,
    b: B,
  ) -> Result<bool> {
    let mut result = false;
    check_status!(unsafe { sys::napi_strict_equals(self.0, a.raw(), b.raw(), &mut result) })?;
    Ok(result)
  }

  pub fn get_node_version(&self) -> Result<NodeVersion> {
    let mut result = ptr::null();
    check_status!(unsafe { sys::napi_get_node_version(self.0, &mut result) })?;
    let version = unsafe { *result };
    version.try_into()
  }

  /// get raw env ptr
  pub fn raw(&self) -> sys::napi_env {
    self.0
  }
}

/// This function could be used for `BufferSlice::from_external` and want do noting when Buffer finalized.
pub fn noop_finalize<Hint>(_env: Env, _hint: Hint) {}

#[cfg(feature = "compat-mode")]
unsafe extern "C" fn drop_buffer(
  _env: sys::napi_env,
  finalize_data: *mut c_void,
  hint: *mut c_void,
) {
  let length_ptr = hint as *mut (usize, usize);
  let (length, cap) = unsafe { *Box::from_raw(length_ptr) };
  if length == 0 || finalize_data.is_null() {
    return;
  }
  mem::drop(unsafe { Vec::from_raw_parts(finalize_data as *mut u8, length, cap) });
}

#[cfg_attr(target_family = "wasm", allow(unused_variables))]
pub(crate) unsafe extern "C" fn raw_finalize<T>(
  env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  let tagged_object = finalize_data as *mut T;
  drop(unsafe { Box::from_raw(tagged_object) });
  #[cfg(not(target_family = "wasm"))]
  if !finalize_hint.is_null() {
    let size_hint = unsafe { *Box::from_raw(finalize_hint as *mut i64) };
    if size_hint != 0 {
      let mut adjusted = 0i64;
      let status = unsafe { sys::napi_adjust_external_memory(env, -size_hint, &mut adjusted) };
      debug_assert!(
        status == sys::Status::napi_ok,
        "Calling napi_adjust_external_memory failed"
      );
    }
  };
}

/// `set_instance_data` payload layout: `#[repr(C)]` keeps `tagged_object` at
/// offset zero so `get_instance_data` can borrow it through a
/// `*mut TaggedObject<T>` regardless of how `F` would reorder a plain tuple.
#[cfg(feature = "napi6")]
#[repr(C)]
struct InstanceData<T: 'static, F> {
  tagged_object: TaggedObject<T>,
  finalize_cb: F,
}

/// Registration marker for instance-data payloads in `NATIVE_PAYLOADS` — never
/// instantiated. `set_instance_data` cannot tag entries with the payload's own
/// `T`: the registry shares its key space with external payloads registered as
/// `External<U>`/`TaggedObject<U>`, so a `T = External<U>` entry would let a
/// foreign-installed external payload pointer satisfy `get_instance_data` and
/// be read through the wrong layout. A dedicated tag keeps instance-data
/// entries disjoint from every other registration kind.
#[cfg(feature = "napi6")]
struct InstanceDataTag<T>(std::marker::PhantomData<T>);

#[cfg(feature = "napi6")]
unsafe extern "C" fn set_instance_finalize_callback<T, Hint, F>(
  raw_env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) where
  T: 'static,
  Hint: 'static,
  F: FnOnce(FinalizeContext<T, Hint>),
{
  unregister_native_payload(finalize_data);
  let InstanceData {
    tagged_object,
    finalize_cb,
  } = unsafe { *Box::from_raw(finalize_data as *mut InstanceData<T, F>) };
  let hint = unsafe { *Box::from_raw(finalize_hint as *mut Hint) };
  let env = Env::from_raw(raw_env);
  finalize_cb(FinalizeContext {
    value: tagged_object.object.unwrap(),
    hint,
    env,
  });
}

#[cfg(feature = "napi3")]
unsafe extern "C" fn cleanup_env<T: 'static>(hook_data: *mut c_void) {
  let cleanup_env_hook = unsafe { Box::from_raw(hook_data as *mut CleanupEnvHookData<T>) };
  (cleanup_env_hook.hook)(cleanup_env_hook.data);
}

pub(crate) unsafe extern "C" fn raw_finalize_with_custom_callback<Hint, Finalize>(
  env: sys::napi_env,
  _finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) where
  Finalize: FnOnce(Env, Hint),
{
  let (hint, callback) = unsafe { *Box::from_raw(finalize_hint as *mut (Hint, Finalize)) };
  callback(Env::from_raw(env), hint);
}

#[cfg(feature = "napi8")]
unsafe extern "C" fn async_finalize<Arg, F>(
  handle: sys::napi_async_cleanup_hook_handle,
  data: *mut c_void,
) where
  Arg: 'static,
  F: FnOnce(Arg),
{
  let (arg, callback) = unsafe { *Box::from_raw(data as *mut (Arg, F)) };
  callback(arg);
  if !handle.is_null() {
    let status = unsafe { sys::napi_remove_async_cleanup_hook(handle) };
    assert!(
      status == sys::Status::napi_ok,
      "Remove async cleanup hook failed after async cleanup callback"
    );
  }
}

#[cfg(feature = "napi5")]
fn panic_payload_to_error(payload: Box<dyn Any + Send>) -> Error {
  let message = {
    if let Some(string) = payload.downcast_ref::<String>() {
      string.clone()
    } else if let Some(string) = payload.downcast_ref::<&str>() {
      string.to_string()
    } else {
      format!("panic from Rust code: {payload:?}")
    }
  };
  crate::bindgen_runtime::catch_unwind_safely(|| drop(payload));
  Error::new(Status::GenericFailure, message)
}

#[cfg(feature = "napi5")]
pub(crate) unsafe extern "C" fn trampoline<
  Return: ToNapiValue,
  F: Fn(FunctionCallContext) -> Result<Return>,
>(
  raw_env: sys::napi_env,
  cb_info: sys::napi_callback_info,
) -> sys::napi_value {
  // Fast path for 4 arguments or less.
  let mut argc = 4;
  let mut raw_args = Vec::with_capacity(4);
  let mut raw_this = ptr::null_mut();
  let mut closure_data_ptr = ptr::null_mut();

  check_status!(
    unsafe {
      sys::napi_get_cb_info(
        raw_env,
        cb_info,
        &mut argc,
        raw_args.as_mut_ptr(),
        &mut raw_this,
        &mut closure_data_ptr,
      )
    },
    "napi_get_cb_info failed"
  )
  .and_then(|_| {
    // Arguments length greater than 4, resize the vector.
    if argc > 4 {
      raw_args = vec![ptr::null_mut(); argc];
      check_status!(
        unsafe {
          sys::napi_get_cb_info(
            raw_env,
            cb_info,
            &mut argc,
            raw_args.as_mut_ptr(),
            &mut raw_this,
            &mut closure_data_ptr,
          )
        },
        "napi_get_cb_info failed"
      )?;
    } else {
      unsafe { raw_args.set_len(argc) };
    }
    Ok((raw_this, raw_args, closure_data_ptr, argc))
  })
  .and_then(|(raw_this, raw_args, closure_data_ptr, _argc)| {
    let closure: &F = Box::leak(unsafe { Box::from_raw(closure_data_ptr.cast()) });
    let mut env = Env::from_raw(raw_env);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
      closure(FunctionCallContext {
        env: &mut env,
        this: raw_this,
        args: raw_args.as_slice(),
      })
      .and_then(|ret| unsafe { <Return as ToNapiValue>::to_napi_value(raw_env, ret) })
    }))
    .map_err(panic_payload_to_error)
    .and_then(|r| r)
  })
  .unwrap_or_else(|e| {
    unsafe { JsError::from(e).throw_into(raw_env) };
    ptr::null_mut()
  })
}

#[cfg(feature = "napi5")]
pub(crate) unsafe extern "C" fn trampoline_setter<
  V: FromNapiValue,
  F: Fn(Env, crate::bindgen_runtime::This, V) -> Result<()>,
>(
  raw_env: sys::napi_env,
  cb_info: sys::napi_callback_info,
) -> sys::napi_value {
  use crate::bindgen_runtime::This;

  let (raw_args, raw_this, closure_data_ptr) = {
    let mut argc = 1;
    let mut raw_args = vec![ptr::null_mut(); 1];
    let mut raw_this = ptr::null_mut();
    let mut data_ptr = ptr::null_mut();

    let status = unsafe {
      sys::napi_get_cb_info(
        raw_env,
        cb_info,
        &mut argc,
        raw_args.as_mut_ptr(),
        &mut raw_this,
        &mut data_ptr,
      )
    };
    unsafe { raw_args.set_len(argc) };
    debug_assert!(
      Status::from(status) == Status::Ok,
      "napi_get_cb_info failed"
    );

    let closure_data_ptr = unsafe { *(data_ptr as *mut PropertyClosures) }.setter_closure;
    (raw_args, raw_this, closure_data_ptr)
  };

  let closure: &F = Box::leak(unsafe { Box::from_raw(closure_data_ptr.cast()) });
  let env = Env::from_raw(raw_env);
  raw_args
    .first()
    .ok_or_else(|| Error::new(Status::InvalidArg, "Missing argument in property setter"))
    .and_then(|value| {
      std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let value = unsafe { V::from_napi_value(raw_env, *value)? };
        closure(
          env,
          unsafe { This::from_napi_value(raw_env, raw_this)? },
          value,
        )
      }))
      .map_err(panic_payload_to_error)
      .and_then(|r| r)
    })
    .map(|_| std::ptr::null_mut())
    .unwrap_or_else(|e| {
      unsafe { JsError::from(e).throw_into(raw_env) };
      ptr::null_mut()
    })
}

#[cfg(feature = "napi5")]
pub(crate) unsafe extern "C" fn trampoline_getter<
  R: ToNapiValue,
  F: Fn(Env, crate::bindgen_runtime::This) -> Result<R>,
>(
  raw_env: sys::napi_env,
  cb_info: sys::napi_callback_info,
) -> sys::napi_value {
  let (raw_this, closure_data_ptr) = {
    let mut raw_this = ptr::null_mut();
    let mut data_ptr = ptr::null_mut();

    let status = unsafe {
      sys::napi_get_cb_info(
        raw_env,
        cb_info,
        &mut 0,
        ptr::null_mut(),
        &mut raw_this,
        &mut data_ptr,
      )
    };
    debug_assert!(
      Status::from(status) == Status::Ok,
      "napi_get_cb_info failed"
    );

    let closure_data_ptr = unsafe { *(data_ptr as *mut PropertyClosures) }.getter_closure;
    (raw_this, closure_data_ptr)
  };

  let closure: &F = Box::leak(unsafe { Box::from_raw(closure_data_ptr.cast()) });
  let env = Env::from_raw(raw_env);
  std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    let this = unsafe { crate::bindgen_runtime::This::from_napi_value(raw_env, raw_this)? };
    closure(env, this).and_then(|ret: R| unsafe { <R as ToNapiValue>::to_napi_value(env.0, ret) })
  }))
  .map_err(panic_payload_to_error)
  .and_then(|r| r)
  .unwrap_or_else(|e| {
    unsafe { JsError::from(e).throw_into(raw_env) };
    ptr::null_mut()
  })
}

#[cfg(feature = "napi5")]
pub(crate) unsafe extern "C" fn finalize_box_trampoline<F>(
  _raw_env: sys::napi_env,
  closure_data_ptr: *mut c_void,
  _finalize_hint: *mut c_void,
) {
  crate::bindgen_runtime::catch_unwind_safely(|| {
    drop(unsafe { Box::<F>::from_raw(closure_data_ptr.cast()) })
  })
}
