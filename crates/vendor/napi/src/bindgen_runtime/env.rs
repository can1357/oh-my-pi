use crate::{sys, JsGlobal, Result};

use super::Array;

pub use crate::Env;

impl Env {
  pub fn create_array(&self, len: u32) -> Result<Array<'_>> {
    Array::new(self.0, len)
  }

  pub fn get_global(&self) -> Result<JsGlobal<'static>> {
    let mut global = std::ptr::null_mut();
    crate::check_status!(
      unsafe { sys::napi_get_global(self.0, &mut global) },
      "Get global object from Env failed"
    )?;
    Ok(JsGlobal(
      crate::Value {
        value: global,
        env: self.0,
        value_type: crate::ValueType::Object,
      },
      std::marker::PhantomData,
    ))
  }
}
