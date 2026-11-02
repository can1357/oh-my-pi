use std::mem;
use std::ops::{Deref, DerefMut};
use std::ptr;

use crate::{
  bindgen_runtime::{FromNapiValue, TypeName, ValidateNapiValue},
  check_status, sys, Env, Error, JsValue, Ref, Result, Status, Unknown, Value, ValueType,
};

#[deprecated(since = "3.0.0", note = "Please use Buffer or &[u8] instead")]
pub struct JsBuffer(pub(crate) Value);

impl TypeName for JsBuffer {
  fn type_name() -> &'static str {
    "Buffer"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for JsBuffer {
  unsafe fn validate(env: sys::napi_env, napi_val: sys::napi_value) -> Result<sys::napi_value> {
    let mut is_buffer = false;
    check_status!(unsafe { sys::napi_is_buffer(env, napi_val, &mut is_buffer) })?;
    if !is_buffer {
      return Err(Error::new(
        Status::InvalidArg,
        "Value is not a buffer".to_owned(),
      ));
    }
    Ok(ptr::null_mut())
  }
}

impl FromNapiValue for JsBuffer {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JsBuffer(Value {
      env,
      value: napi_val,
      value_type: ValueType::Object,
    }))
  }
}

impl JsValue<'_> for JsBuffer {
  fn value(&self) -> Value {
    self.0
  }
}

#[deprecated(since = "3.0.0", note = "Please use Buffer or &[u8] instead")]
pub struct JsBufferValue {
  pub(crate) value: JsBuffer,
  len: usize,
  data_ptr: *mut u8,
  owned: Option<mem::ManuallyDrop<Vec<u8>>>,
}

impl JsBuffer {
  pub fn into_value(self) -> Result<JsBufferValue> {
    let mut data = ptr::null_mut();
    let mut len: usize = 0;
    check_status!(unsafe {
      sys::napi_get_buffer_info(self.0.env, self.0.value, &mut data, &mut len)
    })?;
    Ok(JsBufferValue {
      value: self,
      len,
      data_ptr: data as *mut u8,
      owned: None,
    })
  }

  pub fn into_ref(self) -> Result<Ref<JsBuffer>> {
    Ref::new(&Env::from(self.0.env), &self)
  }
}

impl JsBufferValue {
  pub fn new(value: JsBuffer, data: mem::ManuallyDrop<Vec<u8>>) -> Self {
    let len = data.len();
    let data_ptr = if len == 0 {
      std::ptr::null_mut()
    } else {
      data.as_ptr() as *mut u8
    };
    JsBufferValue {
      value,
      len,
      data_ptr,
      owned: Some(data),
    }
  }

  pub fn into_raw(self) -> JsBuffer {
    self.value
  }

  pub fn into_unknown<'env>(self) -> Unknown<'env> {
    unsafe { Unknown::from_raw_unchecked(self.value.0.env, self.value.0.value) }
  }
}

impl AsRef<[u8]> for JsBufferValue {
  fn as_ref(&self) -> &[u8] {
    if let Some(ref data) = self.owned {
      data.as_slice()
    } else if self.len == 0 {
      &[]
    } else {
      unsafe { std::slice::from_raw_parts(self.data_ptr as *const u8, self.len) }
    }
  }
}

impl AsMut<[u8]> for JsBufferValue {
  fn as_mut(&mut self) -> &mut [u8] {
    if let Some(ref mut data) = self.owned {
      data.as_mut_slice()
    } else if self.len == 0 {
      &mut []
    } else {
      unsafe { std::slice::from_raw_parts_mut(self.data_ptr, self.len) }
    }
  }
}

impl Deref for JsBufferValue {
  type Target = [u8];

  fn deref(&self) -> &Self::Target {
    self.as_ref()
  }
}

impl DerefMut for JsBufferValue {
  fn deref_mut(&mut self) -> &mut Self::Target {
    self.as_mut()
  }
}
