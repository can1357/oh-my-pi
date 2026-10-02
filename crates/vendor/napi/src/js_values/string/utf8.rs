use std::convert::TryFrom;
use std::str;

use crate::{bindgen_prelude::ToNapiValue, sys, Error, JsString, Result, Status};

pub struct JsStringUtf8<'env> {
  pub(crate) inner: JsString<'env>,
  pub(crate) buf: Vec<u8>,
}

impl<'env> JsStringUtf8<'env> {
  pub fn as_str(&self) -> Result<&str> {
    str::from_utf8(self.buf.as_slice())
      .map_err(|err| Error::new(Status::InvalidArg, err.to_string()))
  }

  pub fn as_slice(&self) -> &[u8] {
    self.buf.as_slice()
  }

  pub fn len(&self) -> usize {
    self.buf.len()
  }

  pub fn is_empty(&self) -> bool {
    self.buf.is_empty()
  }

  pub fn into_owned(self) -> Result<String> {
    Ok(unsafe { String::from_utf8_unchecked(self.buf.to_vec()) })
  }

  pub fn take(self) -> Vec<u8> {
    self.buf.to_vec()
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
