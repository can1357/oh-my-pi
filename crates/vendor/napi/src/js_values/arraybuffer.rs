use std::ops::{Deref, DerefMut};
use std::os::raw::c_void;
use std::ptr;
use std::slice;

use crate::{
  bindgen_runtime::{FromNapiValue, TypeName, TypedArrayType, ValidateNapiValue},
  check_status, sys, Env, Error, NapiValue, Ref, Result, Status, Unknown, Value, ValueType,
};

use super::JsValue;

#[deprecated(
  since = "3.0.0",
  note = "Use `napi::bindgen_prelude::ArrayBuffer` instead"
)]
pub struct JsArrayBuffer(pub(crate) Value);

impl TypeName for JsArrayBuffer {
  fn type_name() -> &'static str {
    "ArrayBuffer"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for JsArrayBuffer {
  unsafe fn validate(env: sys::napi_env, napi_val: sys::napi_value) -> Result<sys::napi_value> {
    let mut is_array_buffer = false;
    check_status!(unsafe { sys::napi_is_arraybuffer(env, napi_val, &mut is_array_buffer) })?;
    if !is_array_buffer {
      return Err(Error::new(
        Status::InvalidArg,
        "Value is not an array buffer".to_owned(),
      ));
    }
    Ok(ptr::null_mut())
  }
}

impl FromNapiValue for JsArrayBuffer {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self(Value {
      env,
      value: napi_val,
      value_type: ValueType::Object,
    }))
  }
}

impl JsValue<'_> for JsArrayBuffer {
  fn value(&self) -> Value {
    self.0
  }
}

#[deprecated(
  since = "3.0.0",
  note = "Use `napi::bindgen_prelude::ArrayBuffer` instead"
)]
pub struct JsArrayBufferValue {
  pub value: JsArrayBuffer,
  pub(crate) len: usize,
  pub(crate) data: *mut c_void,
}

#[deprecated(
  since = "3.0.0",
  note = "Use `napi::bindgen_prelude::Uint8Array/Int8Array...` instead"
)]
pub struct JsTypedArray(pub(crate) Value);

impl TypeName for JsTypedArray {
  fn type_name() -> &'static str {
    "TypedArray"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl FromNapiValue for JsTypedArray {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self(Value {
      env,
      value: napi_val,
      value_type: ValueType::Object,
    }))
  }
}

impl JsValue<'_> for JsTypedArray {
  fn value(&self) -> Value {
    self.0
  }
}

#[deprecated(
  since = "3.0.0",
  note = "Use `napi::bindgen_prelude::Uint8Array/Int8Array...` instead"
)]
pub struct JsTypedArrayValue {
  pub arraybuffer: JsArrayBuffer,
  data: *mut c_void,
  pub byte_offset: usize,
  pub length: usize,
  pub typedarray_type: TypedArrayType,
}

pub struct JsDataView(pub(crate) Value);

impl TypeName for JsDataView {
  fn type_name() -> &'static str {
    "DataView"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

pub struct JsDataViewValue {
  pub arraybuffer: JsArrayBuffer,
  _data: *mut c_void,
  pub byte_offset: u64,
  pub length: u64,
}

impl JsArrayBuffer {
  #[cfg(feature = "napi7")]
  pub fn detach(self) -> Result<()> {
    check_status!(unsafe { sys::napi_detach_arraybuffer(self.0.env, self.0.value) })
  }

  #[cfg(feature = "napi7")]
  pub fn is_detached(&self) -> Result<bool> {
    let mut is_detached = false;
    check_status!(unsafe {
      sys::napi_is_detached_arraybuffer(self.0.env, self.0.value, &mut is_detached)
    })?;
    Ok(is_detached)
  }

  pub fn into_value(self) -> Result<JsArrayBufferValue> {
    let mut data = ptr::null_mut();
    let mut len: usize = 0;
    check_status!(unsafe {
      sys::napi_get_arraybuffer_info(self.0.env, self.0.value, &mut data, &mut len)
    })?;
    Ok(JsArrayBufferValue {
      data,
      value: self,
      len,
    })
  }

  pub fn into_typedarray(
    self,
    typedarray_type: TypedArrayType,
    length: usize,
    byte_offset: usize,
  ) -> Result<JsTypedArray> {
    let mut typedarray_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_typedarray(
        self.0.env,
        typedarray_type.into(),
        length,
        self.0.value,
        byte_offset,
        &mut typedarray_value,
      )
    })?;
    Ok(JsTypedArray(Value {
      env: self.0.env,
      value: typedarray_value,
      value_type: ValueType::Object,
    }))
  }

  pub fn into_dataview(self, length: usize, byte_offset: usize) -> Result<JsDataView> {
    let mut dataview_value = ptr::null_mut();
    check_status!(unsafe {
      sys::napi_create_dataview(
        self.0.env,
        length,
        self.0.value,
        byte_offset,
        &mut dataview_value,
      )
    })?;
    Ok(JsDataView(Value {
      env: self.0.env,
      value: dataview_value,
      value_type: ValueType::Object,
    }))
  }

  pub fn into_ref(self) -> Result<Ref<JsArrayBuffer>> {
    Ref::new(&Env::from(self.0.env), &self)
  }
}

impl JsArrayBufferValue {
  pub fn new(value: JsArrayBuffer, data: *mut c_void, len: usize) -> Self {
    JsArrayBufferValue { value, len, data }
  }

  pub fn into_raw(self) -> JsArrayBuffer {
    self.value
  }

  pub fn into_unknown<'env>(self) -> Unknown<'env> {
    unsafe { Unknown::from_raw_unchecked(self.value.0.env, self.value.0.value) }
  }
}

impl AsRef<[u8]> for JsArrayBufferValue {
  fn as_ref(&self) -> &[u8] {
    if self.data.is_null() {
      return &[];
    }
    unsafe { slice::from_raw_parts(self.data as *const u8, self.len) }
  }
}

impl AsMut<[u8]> for JsArrayBufferValue {
  fn as_mut(&mut self) -> &mut [u8] {
    if self.data.is_null() {
      return &mut [];
    }
    unsafe { slice::from_raw_parts_mut(self.data as *mut u8, self.len) }
  }
}

impl Deref for JsArrayBufferValue {
  type Target = [u8];

  fn deref(&self) -> &Self::Target {
    self.as_ref()
  }
}

impl DerefMut for JsArrayBufferValue {
  fn deref_mut(&mut self) -> &mut Self::Target {
    self.as_mut()
  }
}

impl JsTypedArray {
  /// get TypeArray info
  /// <https://nodejs.org/api/n-api.html#n_api_napi_get_typedarray_info>
  ///
  /// ***Warning***: Use caution while using this API since the underlying data buffer is managed by the VM.
  pub fn into_value(self) -> Result<JsTypedArrayValue> {
    let mut typedarray_type = 0;
    let mut len = 0;
    let mut data = ptr::null_mut();
    let mut arraybuffer_value = ptr::null_mut();
    let mut byte_offset = 0;
    check_status!(unsafe {
      sys::napi_get_typedarray_info(
        self.0.env,
        self.0.value,
        &mut typedarray_type,
        &mut len,
        &mut data,
        &mut arraybuffer_value,
        &mut byte_offset,
      )
    })?;

    Ok(JsTypedArrayValue {
      data,
      length: len,
      byte_offset,
      typedarray_type: typedarray_type.into(),
      arraybuffer: unsafe { JsArrayBuffer::from_raw_unchecked(self.0.env, arraybuffer_value) },
    })
  }
}

impl JsTypedArrayValue {
  #[inline]
  fn is_valid_as_ref(&self, dest_type: TypedArrayType) {
    // deref `Uint8ClampedArray` as `&[u8]` is valid
    if self.typedarray_type == TypedArrayType::Uint8Clamped && dest_type == TypedArrayType::Uint8 {
      return;
    }
    if self.typedarray_type != dest_type {
      panic!(
        "invalid typedarray type: expected {:?}, got {:?}",
        dest_type, self.typedarray_type
      );
    }
  }
}

macro_rules! impl_as_ref {
  ($ref_type:ident, $expect_type:expr) => {
    impl AsRef<[$ref_type]> for JsTypedArrayValue {
      fn as_ref(&self) -> &[$ref_type] {
        self.is_valid_as_ref($expect_type);
        if self.data.is_null() {
          return &[];
        }
        unsafe { slice::from_raw_parts(self.data as *const $ref_type, self.length) }
      }
    }

    impl AsMut<[$ref_type]> for JsTypedArrayValue {
      fn as_mut(&mut self) -> &mut [$ref_type] {
        self.is_valid_as_ref($expect_type);
        if self.data.is_null() {
          return &mut [];
        }
        unsafe { slice::from_raw_parts_mut(self.data as *mut $ref_type, self.length) }
      }
    }
  };
}

impl_as_ref!(u8, TypedArrayType::Uint8);
impl_as_ref!(i8, TypedArrayType::Int8);
impl_as_ref!(u16, TypedArrayType::Uint16);
impl_as_ref!(i16, TypedArrayType::Int16);
impl_as_ref!(u32, TypedArrayType::Uint32);
impl_as_ref!(i32, TypedArrayType::Int32);
impl_as_ref!(f32, TypedArrayType::Float32);
impl_as_ref!(f64, TypedArrayType::Float64);
#[cfg(feature = "napi6")]
impl_as_ref!(i64, TypedArrayType::BigInt64);
#[cfg(feature = "napi6")]
impl_as_ref!(u64, TypedArrayType::BigUint64);

impl JsDataView {
  pub fn into_value(self) -> Result<JsDataViewValue> {
    let mut length = 0u64;
    let mut byte_offset = 0u64;
    let mut arraybuffer_value = ptr::null_mut();
    let mut data = ptr::null_mut();

    check_status!(unsafe {
      sys::napi_get_dataview_info(
        self.0.env,
        self.0.value,
        &mut length as *mut u64 as *mut _,
        &mut data,
        &mut arraybuffer_value,
        &mut byte_offset as *mut u64 as *mut _,
      )
    })?;
    Ok(JsDataViewValue {
      arraybuffer: unsafe { JsArrayBuffer::from_raw_unchecked(self.0.env, arraybuffer_value) },
      byte_offset,
      length,
      _data: data,
    })
  }
}
