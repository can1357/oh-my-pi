use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use crate::{bindgen_prelude::*, sys};

impl TypeName for OsString {
  fn type_name() -> &'static str {
    "OsString"
  }

  fn value_type() -> ValueType {
    ValueType::String
  }
}

impl ValidateNapiValue for OsString {}

impl ToNapiValue for &OsString {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_os_str()) }
  }
}

impl ToNapiValue for &mut OsString {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_os_str()) }
  }
}

impl ToNapiValue for OsString {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_os_str()) }
  }
}

impl FromNapiValue for OsString {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    // On Windows an `OsString` is WTF-8 encoded and can hold unpaired surrogates,
    // so we read the value as UTF-16 and build the `OsString` losslessly via
    // `OsStringExt::from_wide`. Routing through `String` would force N-API's
    // UTF-8 conversion and replace unpaired surrogates with U+FFFD before Rust
    // ever sees them.
    #[cfg(windows)]
    {
      use std::os::windows::ffi::OsStringExt;

      let utf16 = unsafe { Utf16String::from_napi_value(env, napi_val)? };
      Ok(OsString::from_wide(&utf16))
    }
    // On Unix an `OsString` is an arbitrary byte sequence (not required to be
    // valid UTF-8). We still read the value via the UTF-8 getter because a JS
    // string has no faithful byte representation otherwise: well-formed input is
    // converted losslessly, and the only lossy case (unpaired surrogates) has no
    // standard representation as a Unix path anyway (replaced with U+FFFD).
    #[cfg(not(windows))]
    {
      let s = unsafe { String::from_napi_value(env, napi_val)? };
      Ok(OsString::from(s))
    }
  }
}

impl ToNapiValue for &OsStr {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    // On Windows encode the value as UTF-16 and reuse `Utf16String` so unpaired
    // surrogates stored in the `OsStr` survive the conversion to a JavaScript
    // string.
    #[cfg(windows)]
    {
      use std::os::windows::ffi::OsStrExt;

      let utf16 = Utf16String::from(val.encode_wide().collect::<Vec<u16>>());
      unsafe { ToNapiValue::to_napi_value(env, utf16) }
    }
    // On other platforms an `OsStr` is an arbitrary byte sequence. If it is not
    // valid UTF-8 it cannot be represented as a JavaScript string, so we fail
    // losslessly instead of silently replacing bytes.
    #[cfg(not(windows))]
    {
      match val.to_str() {
        Some(s) => unsafe { ToNapiValue::to_napi_value(env, s) },
        None => Err(Error::from_reason(
          "Non-Unicode OsStr/Path cannot be represented as JavaScript string",
        )),
      }
    }
  }
}

impl TypeName for PathBuf {
  fn type_name() -> &'static str {
    "PathBuf"
  }

  fn value_type() -> ValueType {
    ValueType::String
  }
}

impl ValidateNapiValue for PathBuf {}

impl ToNapiValue for &PathBuf {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_path()) }
  }
}

impl ToNapiValue for &mut PathBuf {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_path()) }
  }
}

impl ToNapiValue for PathBuf {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_path()) }
  }
}

impl FromNapiValue for PathBuf {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let os_string = unsafe { OsString::from_napi_value(env, napi_val)? };
    Ok(PathBuf::from(os_string))
  }
}

impl ToNapiValue for &Path {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    unsafe { ToNapiValue::to_napi_value(env, val.as_os_str()) }
  }
}
