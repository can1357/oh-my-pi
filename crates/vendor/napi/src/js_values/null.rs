use crate::{
  bindgen_runtime::{TypeName, ValidateNapiValue},
  Value, ValueType,
};

#[cfg(feature = "compat-mode")]
#[deprecated(
  since = "3.0.0",
  note = "Please use `napi::bindgen_prelude::Null` instead"
)]
#[derive(Clone, Copy)]
pub struct JsNull(pub(crate) Value);

#[cfg(feature = "compat-mode")]
impl TypeName for JsNull {
  fn type_name() -> &'static str {
    "null"
  }

  fn value_type() -> ValueType {
    ValueType::Null
  }
}

#[cfg(feature = "compat-mode")]
impl ValidateNapiValue for JsNull {}
