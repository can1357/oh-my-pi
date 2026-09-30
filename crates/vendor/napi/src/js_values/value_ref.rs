use std::{marker::PhantomData, ptr};

use crate::{
  bindgen_runtime::{FromNapiMutRef, FromNapiValue, ToNapiValue},
  check_status, sys, Env, JsValue, Result,
};

pub struct Ref<T> {
  pub(crate) raw_ref: sys::napi_ref,
  pub(crate) _phantom: PhantomData<T>,
  pub(crate) taken: bool,
}

#[allow(clippy::non_send_fields_in_send_ty)]
unsafe impl<T> Send for Ref<T> {}
unsafe impl<T> Sync for Ref<T> {}

impl<'env, T: JsValue<'env>> Ref<T> {
  pub fn new(env: &Env, value: &T) -> Result<Ref<T>> {
    let mut raw_ref = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(env.0, value.raw(), 1, &mut raw_ref) },
      "Create napi_ref from {} failed",
      std::any::type_name::<T>()
    )?;
    Ok(Ref {
      raw_ref,
      taken: false,
      _phantom: PhantomData,
    })
  }

  pub fn unref(&mut self, env: &Env) -> Result<()> {
    check_status!(
      unsafe { sys::napi_reference_unref(env.0, self.raw_ref, &mut 0) },
      "unref Ref failed"
    )?;

    check_status!(
      unsafe { sys::napi_delete_reference(env.0, self.raw_ref) },
      "delete Ref failed"
    )?;
    self.taken = true;
    Ok(())
  }
}

impl<T: FromNapiValue> Ref<T> {
  /// Get the value from the reference
  pub fn get_value(&self, env: &Env) -> Result<T> {
    if self.taken {
      return Err(crate::Error::new(
        crate::Status::InvalidArg,
        "Ref value has been deleted",
      ));
    }
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env.0, self.raw_ref, &mut result) },
      "Failed to get reference value"
    )?;
    unsafe { T::from_napi_value(env.0, result) }
  }
}

impl<T: 'static + FromNapiMutRef> Ref<T> {
  /// Get the value reference from the reference
  #[allow(clippy::mut_from_ref)]
  pub fn get_value_mut(&self, env: &Env) -> Result<&mut T> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env.0, self.raw_ref, &mut result) },
      "Failed to get reference value"
    )?;
    unsafe { T::from_napi_mut_ref(env.0, result) }
  }
}

impl<'env, T: FromNapiValue + JsValue<'env>> FromNapiValue for Ref<T> {
  unsafe fn from_napi_value(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let val = T::from_napi_value(env, value)?;
    Ref::new(&Env::from_raw(env), &val)
  }
}

impl<T: 'static> ToNapiValue for Ref<T> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.raw_ref, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}
