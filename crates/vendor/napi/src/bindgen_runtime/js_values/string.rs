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

/// Strings up to this many bytes go to `napi_create_string_utf8` unless they are pure ASCII: the
/// engine decodes them faster than a separate transcoding pass plus a heap allocation.
#[cfg(not(target_family = "wasm"))]
const SMALL_STRING_LEN: usize = 64;

/// Length of the ASCII prefix of `bytes`.
#[cfg(not(target_family = "wasm"))]
#[inline]
fn ascii_len(bytes: &[u8]) -> usize {
  const HIGH_BITS: u128 = u128::from_ne_bytes([0x80; 16]);
  let mut len = 0;
  // Runs between non-ASCII chars are usually short, so check 16 bytes at a time first. The
  // per-byte loop inside the chunk is cheaper than computing the exact position, because its
  // branches are predicted.
  for chunk in bytes.as_chunks::<16>().0.iter().take(4) {
    if u128::from_ne_bytes(*chunk) & HIGH_BITS != 0 {
      return len + chunk.iter().take_while(|byte| byte.is_ascii()).count();
    }
    len += 16;
  }
  // A long run: OR-folding 64 bytes at a time vectorizes and skips ASCII about twice as fast
  if len == 64 {
    for block in bytes[len..].as_chunks::<64>().0 {
      if block.iter().fold(0, |acc, &byte| acc | byte) >= 0x80 {
        break;
      }
      len += 64;
    }
  }
  for chunk in bytes[len..].as_chunks::<16>().0 {
    if u128::from_ne_bytes(*chunk) & HIGH_BITS != 0 {
      break;
    }
    len += 16;
  }
  len
    + bytes[len..]
      .iter()
      .take_while(|byte| byte.is_ascii())
      .count()
}

#[cfg(not(target_family = "wasm"))]
#[inline]
fn fits_latin1(bytes: &[u8]) -> bool {
  let (chunks, rest) = bytes.as_chunks::<32>();
  chunks
    .iter()
    .all(|chunk| chunk.iter().fold(0, |max, &byte| max.max(byte)) < 0xC4)
    && rest.iter().all(|&byte| byte < 0xC4)
}

/// Create a JavaScript string from `val`, picking the cheapest Node-API constructor for its
/// content.
#[cfg(not(target_family = "wasm"))]
pub(crate) unsafe fn create_js_string(
  env: sys::napi_env,
  val: &str,
  result: *mut sys::napi_value,
) -> sys::napi_status {
  let bytes = val.as_bytes();
  let mut pos = ascii_len(bytes);
  if pos == bytes.len() {
    return unsafe {
      sys::napi_create_string_latin1(env, bytes.as_ptr().cast(), bytes.len() as isize, result)
    };
  }
  if bytes.len() <= SMALL_STRING_LEN {
    return unsafe {
      sys::napi_create_string_utf8(env, bytes.as_ptr().cast(), bytes.len() as isize, result)
    };
  }
  if fits_latin1(&bytes[pos..]) {
    let mut latin1 = Vec::with_capacity(bytes.len());
    latin1.extend_from_slice(&bytes[..pos]);
    while pos < bytes.len() {
      latin1.push(((bytes[pos] & 0x1F) << 6) | (bytes[pos + 1] & 0x3F));
      pos += 2;
      let run = ascii_len(&bytes[pos..]);
      latin1.extend_from_slice(&bytes[pos..pos + run]);
      pos += run;
    }
    return unsafe {
      sys::napi_create_string_latin1(env, latin1.as_ptr().cast(), latin1.len() as isize, result)
    };
  }
  // The engine's UTF-8 decoder copies an ASCII prefix fast and decodes only the rest slowly.
  // Widening the prefix to UTF-16 here, and having the engine copy it again, costs more once it
  // is over 4/5 of the string (measured break-even: 80-90% from 1 KiB up; below that both ways
  // are within a few ns). Latin-1 needs no such cut-off: the engine copies it as is.
  if pos > bytes.len() / 5 * 4 {
    return unsafe {
      sys::napi_create_string_utf8(env, bytes.as_ptr().cast(), bytes.len() as isize, result)
    };
  }
  let mut utf16 = Vec::with_capacity(bytes.len());
  utf16.extend(bytes[..pos].iter().map(|&byte| u16::from(byte)));
  while pos < bytes.len() {
    let ch = unsafe { val.get_unchecked(pos..) }.chars().next().unwrap();
    let mut units = [0; 2];
    utf16.extend_from_slice(ch.encode_utf16(&mut units));
    pos += ch.len_utf8();
    let run = ascii_len(&bytes[pos..]);
    utf16.extend(bytes[pos..pos + run].iter().map(|&byte| u16::from(byte)));
    pos += run;
  }
  unsafe { sys::napi_create_string_utf16(env, utf16.as_ptr(), utf16.len() as isize, result) }
}

/// Create a JavaScript string from `val`.
///
/// emnapi's `napi_create_string_latin1` stops at the first NUL byte even when a length is given,
/// and it builds the string one byte at a time, so on wasm every string goes through
/// `napi_create_string_utf8`, which decodes with a single `TextDecoder` call.
#[cfg(target_family = "wasm")]
#[inline]
pub(crate) unsafe fn create_js_string(
  env: sys::napi_env,
  val: &str,
  result: *mut sys::napi_value,
) -> sys::napi_status {
  unsafe { sys::napi_create_string_utf8(env, val.as_ptr().cast(), val.len() as isize, result) }
}

impl ToNapiValue for &String {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      unsafe { create_js_string(env, val, &mut ptr) },
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

    // `+= 1` for the NUL terminator `napi_get_value_string_utf8` writes after the string bytes
    len += 1;
    let mut bytes: Vec<u8> = Vec::with_capacity(len);

    let mut written_byte_count = 0;
    check_status_and_type!(
      unsafe {
        sys::napi_get_value_string_utf8(
          env,
          napi_val,
          bytes.as_mut_ptr().cast(),
          len,
          &mut written_byte_count,
        )
      },
      env,
      napi_val,
      "Failed to convert napi `{}` into rust type `String`"
    )?;

    debug_assert!(written_byte_count < len);
    // SAFETY: `napi_get_value_string_utf8` initialized the first `written_byte_count` bytes,
    // followed by a NUL terminator, so `written_byte_count < len`
    unsafe { bytes.set_len(written_byte_count) };

    // SAFETY: `napi_get_value_string_utf8` only writes valid UTF-8, and `bytes` holds the whole
    // string, so it does not end partway through a multi-byte character
    Ok(unsafe { String::from_utf8_unchecked(bytes) })
  }
}

impl ToNapiValue for &str {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut ptr = ptr::null_mut();

    check_status!(
      unsafe { create_js_string(env, val, &mut ptr) },
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

    // `+= 1` for the NUL terminator `napi_get_value_string_utf16` writes after the string data
    len += 1;
    let mut code_units: Vec<u16> = Vec::with_capacity(len);

    let mut written_code_unit_count = 0;
    check_status!(
      unsafe {
        sys::napi_get_value_string_utf16(
          env,
          napi_val,
          code_units.as_mut_ptr(),
          len,
          &mut written_code_unit_count,
        )
      },
      "Failed to convert napi `utf16 string` into rust type `String`",
    )?;

    debug_assert!(written_code_unit_count < len);
    // SAFETY: `napi_get_value_string_utf16` initialized the first `written_code_unit_count`
    // code units, followed by a NUL terminator, so `written_code_unit_count < len`
    unsafe { code_units.set_len(written_code_unit_count) };

    Ok(Utf16String(code_units))
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

    // `+= 1` for the NUL terminator `napi_get_value_string_latin1` writes after the string bytes
    len += 1;
    let mut bytes: Vec<u8> = Vec::with_capacity(len);

    let mut written_byte_count = 0;
    check_status!(
      unsafe {
        sys::napi_get_value_string_latin1(
          env,
          napi_val,
          bytes.as_mut_ptr().cast(),
          len,
          &mut written_byte_count,
        )
      },
      "Failed to convert napi `latin1 string` into rust type `String`"
    )?;

    debug_assert!(written_byte_count < len);
    // SAFETY: `napi_get_value_string_latin1` initialized the first `written_byte_count` bytes,
    // followed by a NUL terminator, so `written_byte_count < len`
    unsafe { bytes.set_len(written_byte_count) };

    Ok(Latin1String(bytes))
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
