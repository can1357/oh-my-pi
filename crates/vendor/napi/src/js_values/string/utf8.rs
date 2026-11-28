use std::convert::TryFrom;

use crate::{bindgen_prelude::ToNapiValue, sys, Error, JsString, Result};

pub struct JsStringUtf8<'env> {
  pub(crate) inner: JsString<'env>,
  pub(crate) buf: String,
}

impl<'env> JsStringUtf8<'env> {
  /// Returns the string as a `&str`.
  ///
  /// This never fails. It returns `Result` only to keep the signature backwards compatible.
  pub fn as_str(&self) -> Result<&str> {
    Ok(self.buf.as_str())
  }

  /// Returns the string's UTF-8 bytes, without a NUL terminator.
  pub fn as_slice(&self) -> &[u8] {
    self.buf.as_bytes()
  }

  /// Returns the length of the string in UTF-8 bytes (not chars or UTF-16 code units).
  pub fn len(&self) -> usize {
    self.buf.len()
  }

  pub fn is_empty(&self) -> bool {
    self.buf.is_empty()
  }

  pub fn into_owned(self) -> Result<String> {
    Ok(self.buf)
  }

  pub fn take(self) -> Vec<u8> {
    self.buf.into_bytes()
  }

  pub fn into_value(self) -> JsString<'env> {
    self.inner
  }
}

impl TryFrom<JsStringUtf8<'_>> for String {
  type Error = Error;

  fn try_from(value: JsStringUtf8) -> Result<String> {
    value.into_owned()
  }
}

impl From<JsStringUtf8<'_>> for Vec<u8> {
  fn from(value: JsStringUtf8) -> Self {
    value.take()
  }
}

impl ToNapiValue for JsStringUtf8<'_> {
  unsafe fn to_napi_value(_: sys::napi_env, val: JsStringUtf8) -> Result<sys::napi_value> {
    Ok(val.inner.0.value)
  }
}
