use std::convert::TryFrom;

use crate::{
  bindgen_runtime::{FromNapiValue, TypeName, ValidateNapiValue},
  check_status, sys, Error, JsValue, Result, Value, ValueType,
};

#[derive(Clone, Copy)]
pub struct JsNumber<'env>(
  pub(crate) Value,
  pub(crate) std::marker::PhantomData<&'env ()>,
);

impl TypeName for JsNumber<'_> {
  fn type_name() -> &'static str {
    "number"
  }

  fn value_type() -> crate::ValueType {
    ValueType::Number
  }
}

impl ValidateNapiValue for JsNumber<'_> {}

impl<'env> JsValue<'env> for JsNumber<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl FromNapiValue for JsNumber<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JsNumber(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Number,
      },
      std::marker::PhantomData,
    ))
  }
}

impl JsNumber<'_> {
  pub fn get_uint32(&self) -> Result<u32> {
    let mut result = 0;
    check_status!(unsafe { sys::napi_get_value_uint32(self.0.env, self.0.value, &mut result) })?;
    Ok(result)
  }

  pub fn get_int32(&self) -> Result<i32> {
    let mut result = 0;
    check_status!(unsafe { sys::napi_get_value_int32(self.0.env, self.0.value, &mut result) })?;
    Ok(result)
  }

  pub fn get_int64(&self) -> Result<i64> {
    let mut result = 0;
    check_status!(unsafe { sys::napi_get_value_int64(self.0.env, self.0.value, &mut result) })?;
    Ok(result)
  }

  pub fn get_double(&self) -> Result<f64> {
    let mut result = 0_f64;
    check_status!(unsafe { sys::napi_get_value_double(self.0.env, self.0.value, &mut result) })?;
    Ok(result)
  }
}

impl TryFrom<JsNumber<'_>> for u32 {
  type Error = Error;

  fn try_from(value: JsNumber) -> Result<u32> {
    let mut result = 0;
    check_status!(unsafe { sys::napi_get_value_uint32(value.0.env, value.0.value, &mut result) })?;
    Ok(result)
  }
}

impl TryFrom<JsNumber<'_>> for i32 {
  type Error = Error;

  fn try_from(value: JsNumber) -> Result<i32> {
    let mut result = 0;
    check_status!(unsafe { sys::napi_get_value_int32(value.0.env, value.0.value, &mut result) })?;
    Ok(result)
  }
}

impl TryFrom<JsNumber<'_>> for i64 {
  type Error = Error;

  fn try_from(value: JsNumber) -> Result<i64> {
    let mut result = 0;
    check_status!(unsafe { sys::napi_get_value_int64(value.0.env, value.0.value, &mut result) })?;
    Ok(result)
  }
}

impl TryFrom<JsNumber<'_>> for f64 {
  type Error = Error;

  fn try_from(value: JsNumber) -> Result<f64> {
    let mut result = 0_f64;
    check_status!(unsafe { sys::napi_get_value_double(value.0.env, value.0.value, &mut result) })?;
    Ok(result)
  }
}
