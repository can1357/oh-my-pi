use std::marker::PhantomData;
use std::ptr;

use crate::{
  bindgen_runtime::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
  check_status, sys, Result, Value, ValueType,
};

pub use latin1::JsStringLatin1;
pub use utf16::JsStringUtf16;
pub use utf8::JsStringUtf8;

use super::JsValue;

mod latin1;
mod utf16;
mod utf8;

#[derive(Clone, Copy)]
pub struct JsString<'env>(pub(crate) Value, pub(crate) PhantomData<&'env ()>);

impl TypeName for JsString<'_> {
  fn type_name() -> &'static str {
    "String"
  }

  fn value_type() -> crate::ValueType {
    ValueType::String
  }
}

impl ValidateNapiValue for JsString<'_> {}

impl<'env> JsValue<'env> for JsString<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl FromNapiValue for JsString<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JsString(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::String,
      },
      PhantomData,
    ))
  }
}

impl ToNapiValue for &JsString<'_> {
  unsafe fn to_napi_value(_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    Ok(val.raw())
  }
}

impl<'env> JsString<'env> {
  #[cfg(feature = "serde-json")]
  pub(crate) fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Self {
    JsString(
      Value {
        env,
        value,
        value_type: ValueType::String,
      },
      PhantomData,
    )
  }

  pub fn utf8_len(&self) -> Result<usize> {
    let mut length = 0;
    check_status!(unsafe {
      sys::napi_get_value_string_utf8(self.0.env, self.0.value, ptr::null_mut(), 0, &mut length)
    })?;
    Ok(length)
  }

  pub fn utf16_len(&self) -> Result<usize> {
    let mut length = 0;
    check_status!(unsafe {
      sys::napi_get_value_string_utf16(self.0.env, self.0.value, ptr::null_mut(), 0, &mut length)
    })?;
    Ok(length)
  }

  pub fn latin1_len(&self) -> Result<usize> {
    let mut length = 0;
    check_status!(unsafe {
      sys::napi_get_value_string_latin1(self.0.env, self.0.value, ptr::null_mut(), 0, &mut length)
    })?;
    Ok(length)
  }

  pub fn into_utf8(self) -> Result<JsStringUtf8<'env>> {
    // `+ 1` for the NUL terminator `napi_get_value_string_utf8` writes after the string bytes
    let len = self.utf8_len()? + 1;
    let mut bytes: Vec<u8> = Vec::with_capacity(len);

    let mut written_byte_count = 0;
    check_status!(unsafe {
      sys::napi_get_value_string_utf8(
        self.0.env,
        self.0.value,
        bytes.as_mut_ptr().cast(),
        len,
        &mut written_byte_count,
      )
    })?;

    debug_assert!(written_byte_count < len);
    // SAFETY: `napi_get_value_string_utf8` initialized the first `written_byte_count` bytes,
    // followed by a NUL terminator, so `written_byte_count < len`
    unsafe { bytes.set_len(written_byte_count) };

    // SAFETY: `napi_get_value_string_utf8` only writes valid UTF-8, and `bytes` holds the whole
    // string, so it does not end partway through a multi-byte character
    let buf = unsafe { String::from_utf8_unchecked(bytes) };

    Ok(JsStringUtf8 { inner: self, buf })
  }

  pub fn into_utf16(self) -> Result<JsStringUtf16<'env>> {
    // `+ 1` for the NUL terminator `napi_get_value_string_utf16` writes after the string data
    let len = self.utf16_len()? + 1;
    let mut code_units: Vec<u16> = Vec::with_capacity(len);

    let mut written_code_unit_count = 0usize;
    check_status!(unsafe {
      sys::napi_get_value_string_utf16(
        self.0.env,
        self.0.value,
        code_units.as_mut_ptr(),
        len,
        &mut written_code_unit_count,
      )
    })?;

    // Keep the NUL terminator in `code_units`: `JsStringUtf16::len` and `as_slice` include it,
    // `as_str` strips it
    debug_assert!(written_code_unit_count < len);
    // SAFETY: `napi_get_value_string_utf16` initialized the first `written_code_unit_count`
    // code units, followed by a NUL terminator, so `written_code_unit_count + 1 <= len`
    unsafe { code_units.set_len(written_code_unit_count + 1) };

    Ok(JsStringUtf16 {
      inner: self,
      buf: unsafe { std::slice::from_raw_parts(code_units.as_ptr(), code_units.len()) },
      _inner_buf: code_units,
    })
  }

  pub fn into_latin1(self) -> Result<JsStringLatin1<'env>> {
    // `+ 1` for the NUL terminator `napi_get_value_string_latin1` writes after the string bytes
    let len = self.latin1_len()? + 1;
    let mut bytes: Vec<u8> = Vec::with_capacity(len);

    let mut written_byte_count = 0usize;
    check_status!(unsafe {
      sys::napi_get_value_string_latin1(
        self.0.env,
        self.0.value,
        bytes.as_mut_ptr().cast(),
        len,
        &mut written_byte_count,
      )
    })?;

    debug_assert!(written_byte_count < len);
    // SAFETY: `napi_get_value_string_latin1` initialized the first `written_byte_count` bytes,
    // followed by a NUL terminator, so `written_byte_count < len`
    unsafe { bytes.set_len(written_byte_count) };

    Ok(JsStringLatin1 {
      inner: self,
      buf: unsafe { std::slice::from_raw_parts(bytes.as_ptr(), bytes.len()) },
      _inner_buf: bytes,
    })
  }
}
