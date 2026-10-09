use std::ptr;

use crate::{
  bindgen_runtime::{Env, FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
  check_status, sys, type_of, JsValue, Result, Value, ValueType,
};

#[derive(Clone, Copy)]
/// Represents a raw JavaScript value
pub struct Unknown<'env>(
  pub(crate) Value,
  pub(crate) std::marker::PhantomData<&'env ()>,
);

impl<'env> JsValue<'env> for Unknown<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl TypeName for Unknown<'_> {
  fn type_name() -> &'static str {
    "unknown"
  }

  fn value_type() -> ValueType {
    ValueType::Unknown
  }
}

impl ValidateNapiValue for Unknown<'_> {
  unsafe fn validate(
    _env: napi_sys::napi_env,
    _napi_val: napi_sys::napi_value,
  ) -> Result<sys::napi_value> {
    Ok(ptr::null_mut())
  }
}

impl FromNapiValue for Unknown<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Unknown(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Unknown,
      },
      std::marker::PhantomData,
    ))
  }
}

impl Unknown<'_> {
  pub fn get_type(&self) -> Result<ValueType> {
    type_of!(self.0.env, self.0.value)
  }

  /// This function should be called after `JsUnknown::get_type`
  /// and the `V` must be match with the return value of `get_type`
  ///
  /// # Safety
  ///
  /// The caller must ensure that `Self` can be converted into `V`
  pub unsafe fn cast<V>(&self) -> Result<V>
  where
    V: FromNapiValue,
  {
    unsafe { V::from_napi_value(self.0.env, self.0.value) }
  }

  /// Unknown doesn't have a type
  ///
  /// # Safety
  ///
  /// The caller must ensure that:
  /// - The `env` is a valid napi env pointer
  /// - The `napi_val` is a valid js value pointer
  pub unsafe fn from_raw_unchecked(env: sys::napi_env, value: sys::napi_value) -> Self {
    Unknown(
      Value {
        env,
        value,
        value_type: ValueType::Unknown,
      },
      std::marker::PhantomData,
    )
  }

  /// Create a reference to the unknown value
  pub fn create_ref(&self) -> Result<UnknownRef> {
    let mut ref_ = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(self.0.env, self.0.value, 1, &mut ref_) },
      "Failed to create reference"
    )?;
    Ok(UnknownRef { inner: ref_ })
  }
}

/// A reference to a unknown JavaScript value.
///
/// You must call the `unref` method to release the reference, or the object under the hood will be leaked forever.
///
/// Set the `LEAK_CHECK` to `false` to disable the leak check during the `Drop`
pub struct UnknownRef<const LEAK_CHECK: bool = true> {
  pub(crate) inner: sys::napi_ref,
}

unsafe impl<const LEAK_CHECK: bool> Send for UnknownRef<LEAK_CHECK> {}

impl<const LEAK_CHECK: bool> Drop for UnknownRef<LEAK_CHECK> {
  fn drop(&mut self) {
    if LEAK_CHECK && !self.inner.is_null() {
      eprintln!("ObjectRef is not unref, it considered as a memory leak");
    }
  }
}

impl<const LEAK_CHECK: bool> UnknownRef<LEAK_CHECK> {
  /// Get the object from the reference
  pub fn get_value<'env>(&self, env: &'env Env) -> Result<Unknown<'env>> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env.0, self.inner, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(unsafe { Unknown::from_raw_unchecked(env.0, result) })
  }

  /// Unref the reference
  pub fn unref(mut self, env: &Env) -> Result<()> {
    check_status!(
      unsafe { sys::napi_reference_unref(env.0, self.inner, &mut 0) },
      "unref Ref failed"
    )?;
    check_status!(
      unsafe { sys::napi_delete_reference(env.0, self.inner) },
      "delete Ref failed"
    )?;
    self.inner = ptr::null_mut();
    Ok(())
  }
}

impl<const LEAK_CHECK: bool> FromNapiValue for UnknownRef<LEAK_CHECK> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut ref_ = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(env, napi_val, 1, &mut ref_) },
      "Failed to create reference"
    )?;
    Ok(Self { inner: ref_ })
  }
}

impl<const LEAK_CHECK: bool> ToNapiValue for &UnknownRef<LEAK_CHECK> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.inner, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}

impl<const LEAK_CHECK: bool> ToNapiValue for UnknownRef<LEAK_CHECK> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.inner, &mut result) },
      "Failed to get reference value"
    )?;
    check_status!(
      unsafe { sys::napi_delete_reference(env, val.inner) },
      "Failed to delete reference"
    )?;
    Ok(result)
  }
}
