use std::ffi::c_char;
use std::fmt::Display;
use std::ops::Deref;
use std::ptr;

use crate::{bindgen_prelude::*, check_status, check_status_and_type, sys};

impl TypeName for String {
  fn type_name() -> &'static str {
    "String"
  }

  fn value_type() -> ValueType {
    ValueType::String
  }
}

impl ValidateNapiValue for String {}

impl ToNapiValue for &String {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      unsafe {
        sys::napi_create_string_utf8(env, val.as_ptr().cast(), val.len() as isize, &mut ptr)
      },
      "Failed to convert rust `String` into napi `string`"
    )?;

    Ok(ptr)
  }
}

impl ToNapiValue for &mut String {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, &*val)
  }
}

impl ToNapiValue for String {
  #[inline]
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    #[allow(clippy::needless_borrows_for_generic_args)]
    unsafe {
      ToNapiValue::to_napi_value(env, &val)
    }
  }
}

impl FromNapiValue for String {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut len = 0;

    check_status_and_type!(
      unsafe { sys::napi_get_value_string_utf8(env, napi_val, ptr::null_mut(), 0, &mut len) },
      env,
      napi_val,
      "Failed to convert JavaScript value `{}` into rust type `String`"
    )?;

    // end char len in C
    len += 1;
    let mut ret: Vec<u8> = vec![0; len];

    let mut written_char_count = 0;

    check_status_and_type!(
      unsafe {
        sys::napi_get_value_string_utf8(
          env,
          napi_val,
          ret.as_mut_ptr().cast(),
          len,
          &mut written_char_count,
        )
      },
      env,
      napi_val,
      "Failed to convert napi `{}` into rust type `String`"
    )?;

    ret.truncate(written_char_count);

    Ok(unsafe { String::from_utf8_unchecked(ret) })
  }
}

impl ToNapiValue for &str {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      unsafe {
        sys::napi_create_string_utf8(env, val.as_ptr().cast(), val.len() as isize, &mut ptr)
      },
      "Failed to convert rust `&str` into napi `string`"
    )?;

    Ok(ptr)
  }
}

#[derive(Debug)]
pub struct Utf16String(Vec<u16>);

impl ValidateNapiValue for Utf16String {}

impl From<String> for Utf16String {
  fn from(s: String) -> Self {
    Utf16String(s.encode_utf16().collect())
  }
}

impl From<Vec<u16>> for Utf16String {
  fn from(data: Vec<u16>) -> Self {
    Utf16String(data)
  }
}

impl Display for Utf16String {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    write!(f, "{}", String::from_utf16_lossy(self))
  }
}

impl Deref for Utf16String {
  type Target = [u16];

  fn deref(&self) -> &Self::Target {
    self.0.as_ref()
  }
}

impl TypeName for Utf16String {
  fn type_name() -> &'static str {
    "String(utf16)"
  }

  fn value_type() -> ValueType {
    ValueType::String
  }
}

impl FromNapiValue for Utf16String {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut len = 0;

    check_status!(
      unsafe { sys::napi_get_value_string_utf16(env, napi_val, ptr::null_mut(), 0, &mut len) },
      "Failed to convert napi `utf16 string` into rust type `String`",
    )?;

    // end char len in C
    len += 1;
    let mut ret = vec![0; len];
    let mut written_char_count = 0;

    check_status!(
      unsafe {
        sys::napi_get_value_string_utf16(
          env,
          napi_val,
          ret.as_mut_ptr(),
          len,
          &mut written_char_count,
        )
      },
      "Failed to convert napi `utf16 string` into rust type `String`",
    )?;

    ret.truncate(written_char_count);

    Ok(Utf16String(ret))
  }
}

impl ToNapiValue for Utf16String {
  unsafe fn to_napi_value(env: sys::napi_env, val: Utf16String) -> Result<sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      unsafe {
        sys::napi_create_string_utf16(env, val.0.as_ptr().cast(), val.len() as isize, &mut ptr)
      },
      "Failed to convert napi `string` into rust type `String`"
    )?;

    Ok(ptr)
  }
}

#[derive(Debug)]
pub struct Latin1String(Vec<u8>);

impl ValidateNapiValue for Latin1String {}

impl From<String> for Latin1String {
  fn from(s: String) -> Self {
    Latin1String(s.into_bytes())
  }
}

#[cfg(feature = "latin1")]
impl Display for Latin1String {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let mut dst_slice = vec![0; self.0.len() * 2];
    let written =
      encoding_rs::mem::convert_latin1_to_utf8(self.0.as_slice(), dst_slice.as_mut_slice());
    dst_slice.truncate(written);
    write!(f, "{}", unsafe { String::from_utf8_unchecked(dst_slice) })
  }
}

impl Deref for Latin1String {
  type Target = [u8];

  fn deref(&self) -> &Self::Target {
    self.0.as_slice()
  }
}

impl TypeName for Latin1String {
  fn type_name() -> &'static str {
    "String(latin1)"
  }

  fn value_type() -> ValueType {
    ValueType::String
  }
}

impl FromNapiValue for Latin1String {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut len = 0;

    check_status!(
      unsafe { sys::napi_get_value_string_latin1(env, napi_val, ptr::null_mut(), 0, &mut len) },
      "Failed to convert napi `latin1 string` into rust type `String`",
    )?;

    // end char len in C
    len += 1;
    let mut buf: Vec<u8> = vec![0; len];

    let mut written_char_count = 0;

    check_status!(
      unsafe {
        sys::napi_get_value_string_latin1(
          env,
          napi_val,
          buf.as_mut_ptr().cast(),
          len,
          &mut written_char_count,
        )
      },
      "Failed to convert napi `latin1 string` into rust type `String`"
    )?;
    buf.truncate(written_char_count);
    Ok(Latin1String(buf))
  }
}

impl ToNapiValue for Latin1String {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      unsafe {
        sys::napi_create_string_latin1(env, val.0.as_ptr().cast(), val.len() as isize, &mut ptr)
      },
      "Failed to convert rust type `String` into napi `latin1 string`"
    )?;

    Ok(ptr)
  }
}

pub const NAPI_AUTO_LENGTH: isize = -1;

#[derive(Debug)]
/// A wrapper around the raw c_char pointer to a C string.
///
/// This is useful when you want to return a C string to JavaScript directly via NAPI-RS function without converting it to Rust string or performing any memory allocation.
///
/// The `RawCString` doesn't implement `FromNapiValue`, so you can't convert a JavaScript String to it.
pub struct RawCString {
  length: isize,
  inner: *const c_char,
}

impl RawCString {
  /// Create a new `RawCString` from a raw pointer and length.
  ///
  /// If the inner string is null-terminated, you can pass `` as the length.
  pub fn new(inner: *const c_char, length: isize) -> Self {
    Self { inner, length }
  }
}

impl ToNapiValue for RawCString {
  unsafe fn to_napi_value(env: napi_sys::napi_env, val: Self) -> Result<napi_sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      napi_sys::napi_create_string_utf8(env, val.inner, val.length, &mut ptr),
      "Failed to convert rust `&str` into napi `string`"
    )?;

    Ok(ptr)
  }
}
