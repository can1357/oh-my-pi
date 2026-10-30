use std::marker::PhantomData;
use std::ptr;

use crate::{
  bindgen_runtime::{FromNapiValue, JsObjectValue, TypeName, ValidateNapiValue},
  check_status, sys, Error, JsValue, Result, Status, Value, ValueType,
};

#[derive(Clone, Copy)]
pub struct JsDate<'env>(pub(crate) Value, pub(crate) PhantomData<&'env ()>);

impl TypeName for JsDate<'_> {
  fn type_name() -> &'static str {
    "Date"
  }

  fn value_type() -> crate::ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for JsDate<'_> {
  unsafe fn validate(env: sys::napi_env, napi_val: sys::napi_value) -> Result<sys::napi_value> {
    let mut is_date = false;
    check_status!(unsafe { sys::napi_is_date(env, napi_val, &mut is_date) })?;
    if !is_date {
      return Err(Error::new(
        Status::InvalidArg,
        "Expected a Date object".to_owned(),
      ));
    }

    Ok(ptr::null_mut())
  }
}

impl FromNapiValue for JsDate<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Object,
      },
      PhantomData,
    ))
  }
}

impl<'env> JsValue<'env> for JsDate<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl<'env> JsObjectValue<'env> for JsDate<'env> {}

impl JsDate<'_> {
  pub(crate) fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Self {
    Self(
      Value {
        env,
        value,
        value_type: ValueType::Object,
      },
      PhantomData,
    )
  }

  pub fn value_of(&self) -> Result<f64> {
    let mut timestamp: f64 = 0.0;
    check_status!(unsafe { sys::napi_get_date_value(self.0.env, self.0.value, &mut timestamp) })?;
    Ok(timestamp)
  }
}
