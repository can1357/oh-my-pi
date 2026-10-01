use std::{ffi::c_void, ptr};

use super::{MaybeTypeTag, TypeName};
use crate::{check_status, sys, Error, JsError, Result, Status};

#[doc(hidden)]
pub type ClassAccessorGetter = unsafe fn(sys::napi_env, sys::napi_value) -> Result<sys::napi_value>;

#[doc(hidden)]
pub type ClassAccessorSetter =
  unsafe fn(sys::napi_env, sys::napi_value, sys::napi_value) -> Result<sys::napi_value>;

#[doc(hidden)]
pub struct ClassAccessorDescriptor {
  pub getter: Option<ClassAccessorGetter>,
  pub setter: Option<ClassAccessorSetter>,
}

#[doc(hidden)]
pub struct ClassAccessorCallbackInfo<const N: usize> {
  env: sys::napi_env,
  this: sys::napi_value,
  args: [sys::napi_value; N],
}

impl<const N: usize> ClassAccessorCallbackInfo<N> {
  #[doc(hidden)]
  #[inline]
  pub fn new(env: sys::napi_env, this: sys::napi_value, args: [sys::napi_value; N]) -> Self {
    Self { env, this, args }
  }

  #[doc(hidden)]
  #[inline]
  pub fn get_arg(&self, index: usize) -> sys::napi_value {
    self.args[index]
  }

  #[doc(hidden)]
  #[inline]
  pub fn this(&self) -> sys::napi_value {
    self.this
  }

  #[doc(hidden)]
  #[inline]
  pub unsafe fn unwrap_raw<T>(&mut self) -> Result<*mut T>
  where
    T: TypeName + MaybeTypeTag,
  {
    unsafe { class_accessor_unwrap_this::<T>(self.env, self.this) }
  }
}

#[doc(hidden)]
#[inline]
pub unsafe fn class_accessor_unwrap_this<T>(
  env: sys::napi_env,
  this: sys::napi_value,
) -> Result<*mut T>
where
  T: TypeName + MaybeTypeTag,
{
  let mut wrapped_val: *mut c_void = ptr::null_mut();

  check_status!(
    unsafe { sys::napi_unwrap(env, this, &mut wrapped_val) },
    "Failed to unwrap exclusive reference of `{}` type from napi value",
    T::type_name(),
  )?;

  // Reject a spoofed field-accessor receiver before the blind cast. Compiled
  // only on napi8 NATIVE targets (the `T: MaybeTypeTag` bound provides
  // `T::type_tag()` only there; elsewhere this is the pre-tag unchecked cast).
  #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
  unsafe {
    super::validate_type_tag(env, this, &T::type_tag(), T::type_name())?
  };

  Ok(wrapped_val.cast())
}

#[doc(hidden)]
pub unsafe extern "C" fn class_getter_trampoline(
  env: sys::napi_env,
  cb_info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut this = ptr::null_mut();
  let mut data = ptr::null_mut();

  check_status!(
    unsafe { sys::napi_get_cb_info(env, cb_info, &mut 0, ptr::null_mut(), &mut this, &mut data,) },
    "napi_get_cb_info failed"
  )
  .and_then(|_| {
    let descriptor = unsafe { (data as *const ClassAccessorDescriptor).as_ref() }
      .ok_or_else(|| Error::new(Status::InvalidArg, "Missing class accessor descriptor"))?;
    let getter = descriptor.getter.ok_or_else(|| {
      Error::new(
        Status::InvalidArg,
        "Missing class accessor getter descriptor",
      )
    })?;
    unsafe { getter(env, this) }
  })
  .unwrap_or_else(|e| {
    unsafe { JsError::from(e).throw_into(env) };
    ptr::null_mut()
  })
}

#[doc(hidden)]
pub unsafe extern "C" fn class_setter_trampoline(
  env: sys::napi_env,
  cb_info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut argc = 1;
  let mut args = [ptr::null_mut()];
  let mut this = ptr::null_mut();
  let mut data = ptr::null_mut();

  check_status!(
    unsafe {
      sys::napi_get_cb_info(
        env,
        cb_info,
        &mut argc,
        args.as_mut_ptr(),
        &mut this,
        &mut data,
      )
    },
    "napi_get_cb_info failed"
  )
  .and_then(|_| {
    if argc == 0 {
      return Err(Error::new(
        Status::InvalidArg,
        "Missing argument in property setter",
      ));
    }
    let descriptor = unsafe { (data as *const ClassAccessorDescriptor).as_ref() }
      .ok_or_else(|| Error::new(Status::InvalidArg, "Missing class accessor descriptor"))?;
    let setter = descriptor.setter.ok_or_else(|| {
      Error::new(
        Status::InvalidArg,
        "Missing class accessor setter descriptor",
      )
    })?;
    unsafe { setter(env, this, args[0]) }
  })
  .unwrap_or_else(|e| {
    unsafe { JsError::from(e).throw_into(env) };
    ptr::null_mut()
  })
}
