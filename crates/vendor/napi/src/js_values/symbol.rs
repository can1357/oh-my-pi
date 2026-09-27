use std::ptr;

use crate::{
  bindgen_runtime::{Env, FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
  check_status, sys, JsValue, Result, Value, ValueType,
};

#[derive(Clone, Copy)]
/// represent `Symbol` value in JavaScript
pub struct JsSymbol<'env>(
  pub(crate) Value,
  pub(crate) std::marker::PhantomData<&'env ()>,
);

impl TypeName for JsSymbol<'_> {
  fn type_name() -> &'static str {
    "symbol"
  }

  fn value_type() -> ValueType {
    ValueType::Symbol
  }
}

impl<'env> JsValue<'env> for JsSymbol<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl FromNapiValue for JsSymbol<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JsSymbol(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Symbol,
      },
      std::marker::PhantomData,
    ))
  }
}

impl ValidateNapiValue for JsSymbol<'_> {}

impl JsSymbol<'_> {
  /// Create a reference to the symbol
  pub fn create_ref<const LEAK_CHECK: bool>(&self) -> Result<SymbolRef<LEAK_CHECK>> {
    let mut ref_ = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(self.0.env, self.0.value, 1, &mut ref_) },
      "Failed to create reference"
    )?;
    Ok(SymbolRef { inner: ref_ })
  }
}

/// A reference to a JavaScript Symbol.
///
/// You must call the `unref` method to release the reference, or the symbol under the hood will be leaked forever.
///
/// Set the `LEAK_CHECK` to `false` to disable the leak check during the `Drop`
pub struct SymbolRef<const LEAK_CHECK: bool = true> {
  pub(crate) inner: sys::napi_ref,
}

unsafe impl<const LEAK_CHECK: bool> Send for SymbolRef<LEAK_CHECK> {}

impl<const LEAK_CHECK: bool> Drop for SymbolRef<LEAK_CHECK> {
  fn drop(&mut self) {
    if LEAK_CHECK && !self.inner.is_null() {
      eprintln!("ObjectRef is not unref, it considered as a memory leak");
    }
  }
}

impl<const LEAK_CHECK: bool> SymbolRef<LEAK_CHECK> {
  /// Get the object from the reference
  pub fn get_value<'env>(&self, env: &'env Env) -> Result<JsSymbol<'env>> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env.0, self.inner, &mut result) },
      "Failed to get reference value"
    )?;
    unsafe { JsSymbol::from_napi_value(env.0, result) }
  }

  /// Unref the reference
  pub fn unref(mut self, env: &Env) -> Result<()> {
    check_status!(
      unsafe { sys::napi_delete_reference(env.0, self.inner) },
      "delete Ref failed"
    )?;
    self.inner = ptr::null_mut();
    Ok(())
  }
}

impl<const LEAK_CHECK: bool> FromNapiValue for SymbolRef<LEAK_CHECK> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut ref_ = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(env, napi_val, 1, &mut ref_) },
      "Failed to create reference"
    )?;
    Ok(Self { inner: ref_ })
  }
}

impl<const LEAK_CHECK: bool> ToNapiValue for &SymbolRef<LEAK_CHECK> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.inner, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}

impl<const LEAK_CHECK: bool> ToNapiValue for SymbolRef<LEAK_CHECK> {
  unsafe fn to_napi_value(env: sys::napi_env, mut val: Self) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.inner, &mut result) },
      "Failed to get reference value"
    )?;
    check_status!(
      unsafe { sys::napi_delete_reference(env, val.inner) },
      "delete Ref failed"
    )?;
    val.inner = ptr::null_mut();
    drop(val);
    Ok(result)
  }
}
