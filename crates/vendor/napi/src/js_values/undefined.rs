use crate::{
  bindgen_runtime::{FromNapiValue, TypeName, ValidateNapiValue},
  sys, JsValue, Result, ValueType,
};

use super::Value;

#[deprecated(since = "3.0.0", note = "use `()` instead")]
#[derive(Clone, Copy)]
pub struct JsUndefined(pub(crate) Value);

impl TypeName for JsUndefined {
  fn type_name() -> &'static str {
    "undefined"
  }

  fn value_type() -> crate::ValueType {
    ValueType::Undefined
  }
}

impl ValidateNapiValue for JsUndefined {}

impl JsValue<'_> for JsUndefined {
  fn value(&self) -> Value {
    self.0
  }
}

impl FromNapiValue for JsUndefined {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self(Value {
      env,
      value: napi_val,
      value_type: ValueType::Undefined,
    }))
  }
}
