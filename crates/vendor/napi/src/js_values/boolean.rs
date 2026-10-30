use std::convert::TryFrom;

use super::Value;
use crate::bindgen_runtime::{ToNapiValue, TypeName, ValidateNapiValue};
use crate::{check_status, ValueType};
use crate::{sys, Error, Result};

#[deprecated(since = "3.0.0", note = "use `bool` instead")]
#[derive(Clone, Copy)]
pub struct JsBoolean(pub(crate) Value);

impl TypeName for JsBoolean {
  fn type_name() -> &'static str {
    "bool"
  }

  fn value_type() -> crate::ValueType {
    ValueType::Boolean
  }
}

impl ValidateNapiValue for JsBoolean {}

impl ToNapiValue for JsBoolean {
  unsafe fn to_napi_value(_: sys::napi_env, value: Self) -> Result<sys::napi_value> {
    Ok(value.0.value)
  }
}

impl JsBoolean {
  pub fn get_value(&self) -> Result<bool> {
    let mut result = false;
    check_status!(unsafe { sys::napi_get_value_bool(self.0.env, self.0.value, &mut result) })?;
    Ok(result)
  }
}

impl TryFrom<JsBoolean> for bool {
  type Error = Error;

  fn try_from(value: JsBoolean) -> Result<bool> {
    value.get_value()
  }
}
