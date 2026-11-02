#[cfg(feature = "napi5")]
use std::ffi::c_void;
#[cfg(feature = "napi5")]
use std::ptr;

#[cfg(feature = "napi5")]
use super::check_status;
use crate::{
  bindgen_prelude::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
  sys, Result, Value, ValueType,
};
#[cfg(feature = "napi5")]
use crate::{bindgen_runtime::FinalizeContext, Env};

#[deprecated(since = "3.0.0", note = "Use `napi::bindgen_prelude::Object` instead")]
#[derive(Clone, Copy)]
pub struct JsObject(pub(crate) Value);

impl TypeName for JsObject {
  fn type_name() -> &'static str {
    "Object"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for JsObject {}

impl FromNapiValue for JsObject {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self(Value {
      env,
      value: napi_val,
      value_type: ValueType::Object,
    }))
  }
}

impl ToNapiValue for JsObject {
  unsafe fn to_napi_value(_: sys::napi_env, value: Self) -> Result<sys::napi_value> {
    Ok(value.0.value)
  }
}

impl From<Value> for JsObject {
  fn from(value: Value) -> Self {
    Self(value)
  }
}

#[cfg(feature = "napi5")]
impl JsObject {
  pub fn add_finalizer<T, Hint, F>(
    &mut self,
    native: T,
    finalize_hint: Hint,
    finalize_cb: F,
  ) -> Result<()>
  where
    T: 'static,
    Hint: 'static,
    F: FnOnce(FinalizeContext<T, Hint>) + 'static,
  {
    let mut maybe_ref = ptr::null_mut();
    let wrap_context = Box::leak(Box::new((native, finalize_cb, ptr::null_mut())));
    check_status!(unsafe {
      sys::napi_add_finalizer(
        self.0.env,
        self.0.value,
        wrap_context as *mut _ as *mut c_void,
        Some(
          finalize_callback::<T, Hint, F>
            as unsafe extern "C" fn(
              env: sys::napi_env,
              finalize_data: *mut c_void,
              finalize_hint: *mut c_void,
            ),
        ),
        Box::leak(Box::new(finalize_hint)) as *mut _ as *mut c_void,
        &mut maybe_ref, // Note: this does not point to the boxed one…
      )
    })?;
    wrap_context.2 = maybe_ref;
    Ok(())
  }
}

#[cfg(feature = "napi5")]
unsafe extern "C" fn finalize_callback<T, Hint, F>(
  raw_env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) where
  T: 'static,
  Hint: 'static,
  F: FnOnce(FinalizeContext<T, Hint>),
{
  let (value, callback, raw_ref) =
    unsafe { *Box::from_raw(finalize_data as *mut (T, F, sys::napi_ref)) };
  let hint = unsafe { *Box::from_raw(finalize_hint as *mut Hint) };
  let env = Env::from_raw(raw_env);
  callback(FinalizeContext { env, value, hint });
  if !raw_ref.is_null() {
    let status = unsafe { sys::napi_delete_reference(raw_env, raw_ref) };
    debug_assert!(
      status == sys::Status::napi_ok,
      "Delete reference in finalize callback failed"
    );
  }
}
