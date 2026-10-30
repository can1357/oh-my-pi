use std::{
  any::TypeId,
  ffi::c_void,
  ops::{Deref, DerefMut},
  ptr,
};

use crate::{
  bindgen_runtime::{
    sys, Env, FromNapiMutRef, FromNapiRef, FromNapiValue, Result, Status, ToNapiValue, TypeName,
    Unknown, ValidateNapiValue,
  },
  check_status, check_status_or_throw, finalize_external_payload, is_registered_native_payload,
  register_native_payload, Error, JsExternal,
};

#[repr(C)]
pub struct External<T: 'static> {
  type_id: TypeId,
  obj: T,
  size_hint: usize,
  pub adjusted_size: i64,
}

impl<T: 'static> TypeName for &External<T> {
  fn type_name() -> &'static str {
    "External"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::External
  }
}

impl<T: 'static> TypeName for &mut External<T> {
  fn type_name() -> &'static str {
    "External"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::External
  }
}

impl<T: 'static> From<T> for External<T> {
  fn from(t: T) -> Self {
    External::new(t)
  }
}

impl<T: 'static> ValidateNapiValue for &External<T> {}

impl<T: 'static> ValidateNapiValue for &mut External<T> {}

impl<T: 'static> External<T> {
  pub fn new(value: T) -> Self {
    Self {
      type_id: TypeId::of::<T>(),
      obj: value,
      size_hint: 0,
      adjusted_size: 0,
    }
  }

  /// Turn a raw pointer (from napi) pointing to an External into a reference to the inner object.
  ///
  /// # Safety
  /// The `unknown_tagged_object` raw pointer must point to an `External<T>` struct.
  pub(crate) unsafe fn from_raw_impl(
    unknown_tagged_object: *mut c_void,
  ) -> Option<&'static mut Self> {
    // `napi_get_value_external` hands back whatever `data` pointer the external
    // was created with, and externals produced by foreign native code can carry
    // arbitrary payloads. Registry membership proves the pointer is a live
    // `External<T>` created by `to_napi_value_impl` in this binary, so it may be
    // dereferenced without reading the payload first.
    if unknown_tagged_object.is_null()
      || !is_registered_native_payload::<External<T>>(unknown_tagged_object)
    {
      return None;
    }
    Some(unsafe { &mut *(unknown_tagged_object as *mut External<T>) })
  }

  /// Turn a raw pointer (from napi) pointing to an External into a mutable reference to the inner object.
  ///
  /// # Safety
  /// The `unknown_tagged_object` raw pointer must point to an `External<T>` struct.
  pub unsafe fn inner_from_raw_mut(unknown_tagged_object: *mut c_void) -> Option<&'static mut T> {
    Self::from_raw_impl(unknown_tagged_object).map(|external| &mut external.obj)
  }

  /// Turn a raw pointer (from napi) pointing to an External into a reference inner object.
  ///
  /// # Safety
  /// The `unknown_tagged_object` raw pointer must point to an `External<T>` struct.
  pub unsafe fn inner_from_raw(unknown_tagged_object: *mut c_void) -> Option<&'static T> {
    Self::from_raw_impl(unknown_tagged_object).map(|external| &external.obj)
  }

  /// `size_hint` is a value to tell Node.js GC how much memory is used by this `External` object.
  ///
  /// If getting the exact `size_hint` is difficult, you can provide an approximate value, it's only effect to the GC.
  ///
  /// If your `External` object is not effect to GC, you can use `External::new` instead.
  pub fn new_with_size_hint(value: T, size_hint: usize) -> Self {
    Self {
      type_id: TypeId::of::<T>(),
      obj: value,
      size_hint,
      adjusted_size: 0,
    }
  }

  /// convert `External<T>` to `Unknown`
  pub fn into_unknown(self, env: &Env) -> Result<Unknown<'_>> {
    let napi_value = unsafe { ToNapiValue::to_napi_value(env.0, self)? };
    Ok(unsafe { Unknown::from_raw_unchecked(env.0, napi_value) })
  }

  /// Convert `External<T>` to `JsExternal`
  pub fn into_js_external(self, env: &Env) -> Result<JsExternal<'_>> {
    let napi_value = unsafe { ToNapiValue::to_napi_value(env.0, self)? };
    unsafe { JsExternal::from_napi_value(env.0, napi_value) }
  }

  #[allow(clippy::wrong_self_convention)]
  unsafe fn to_napi_value_impl(
    self,
    env: sys::napi_env,
  ) -> Result<(sys::napi_value, *mut External<T>)> {
    let mut napi_value = ptr::null_mut();
    let size_hint = self.size_hint as i64;
    let size_hint_ptr = Box::into_raw(Box::new(size_hint));
    let obj_ptr = Box::into_raw(Box::new(self));
    if let Err(err) = check_status!(
      unsafe {
        sys::napi_create_external(
          env,
          obj_ptr.cast(),
          Some(finalize_external_payload::<External<T>>),
          size_hint_ptr.cast(),
          &mut napi_value,
        )
      },
      "Create external value failed"
    ) {
      drop(unsafe { Box::from_raw(obj_ptr) });
      drop(unsafe { Box::from_raw(size_hint_ptr) });
      return Err(err);
    }
    // Register the payload so `from_raw_impl` can confirm it is a live
    // `External<T>` produced by this binary before dereferencing it.
    register_native_payload::<External<T>>(obj_ptr.cast());

    #[cfg(not(target_family = "wasm"))]
    {
      let mut adjusted_external_memory_size = std::mem::MaybeUninit::new(0);

      if size_hint != 0 {
        check_status!(
          unsafe {
            sys::napi_adjust_external_memory(
              env,
              size_hint,
              adjusted_external_memory_size.as_mut_ptr(),
            )
          },
          "Adjust external memory failed"
        )?;
      };

      (Box::leak(unsafe { Box::from_raw(obj_ptr) })).adjusted_size =
        unsafe { adjusted_external_memory_size.assume_init() };
    }

    Ok((napi_value, obj_ptr))
  }
}

impl<T: 'static> FromNapiMutRef for External<T> {
  unsafe fn from_napi_mut_ref(
    env: sys::napi_env,
    napi_val: sys::napi_value,
  ) -> crate::Result<&'static mut Self> {
    let mut unknown_tagged_object = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_value_external(env, napi_val, &mut unknown_tagged_object) },
      "Failed to get external value"
    )?;

    match Self::from_raw_impl(unknown_tagged_object) {
      Some(external) => Ok(external),
      None => Err(Error::new(
        Status::InvalidArg,
        format!(
          "<{}> on `External` is not the type of wrapped object",
          std::any::type_name::<T>()
        ),
      )),
    }
  }
}

impl<T: 'static> FromNapiRef for External<T> {
  unsafe fn from_napi_ref(
    env: sys::napi_env,
    napi_val: sys::napi_value,
  ) -> crate::Result<&'static Self> {
    unsafe { Self::from_napi_mut_ref(env, napi_val) }.map(|v| v as &Self)
  }
}

impl<T: 'static> AsRef<T> for External<T> {
  fn as_ref(&self) -> &T {
    &self.obj
  }
}

impl<T: 'static> AsMut<T> for External<T> {
  fn as_mut(&mut self) -> &mut T {
    &mut self.obj
  }
}

impl<T: 'static> Deref for External<T> {
  type Target = T;

  fn deref(&self) -> &Self::Target {
    self.as_ref()
  }
}

impl<T: 'static> DerefMut for External<T> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    self.as_mut()
  }
}

impl<T: 'static> ToNapiValue for External<T> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let (napi_value, _) = unsafe { val.to_napi_value_impl(env)? };
    Ok(napi_value)
  }
}

/// `ExternalRef` is a reference to an `External` object
pub struct ExternalRef<T: 'static> {
  pub(crate) obj: &'static mut External<T>,
  pub(crate) raw: sys::napi_ref,
  pub(crate) env: sys::napi_env,
}

unsafe impl<T: Sync + 'static> Sync for ExternalRef<T> {}

impl<T: 'static> TypeName for ExternalRef<T> {
  fn type_name() -> &'static str {
    "External"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::External
  }
}

impl<T: 'static> ValidateNapiValue for ExternalRef<T> {}

impl<T: 'static> Drop for ExternalRef<T> {
  fn drop(&mut self) {
    check_status_or_throw!(
      self.env,
      unsafe { sys::napi_delete_reference(self.env, self.raw) },
      "Failed to delete reference on external value"
    );
  }
}

impl<T: 'static> ExternalRef<T> {
  pub fn new(env: &Env, value: T) -> Result<Self> {
    let external = External::new(value);
    let mut ref_ptr = ptr::null_mut();
    let (napi_val, external) = unsafe { external.to_napi_value_impl(env.0)? };
    check_status!(
      unsafe { sys::napi_create_reference(env.0, napi_val, 1, &mut ref_ptr) },
      "Failed to create reference on external value"
    )?;
    Ok(ExternalRef {
      obj: Box::leak(unsafe { Box::from_raw(external) }),
      raw: ref_ptr,
      env: env.0,
    })
  }

  /// Get the raw JsExternal value from the reference
  pub fn get_value(&self) -> Result<JsExternal<'_>> {
    let mut napi_val = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(self.env, self.raw, &mut napi_val) },
      "Failed to get reference value on external value"
    )?;
    unsafe { JsExternal::from_napi_value(self.env, napi_val) }
  }
}

impl<T: 'static> FromNapiValue for ExternalRef<T> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> crate::Result<Self> {
    let mut unknown_tagged_object = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_value_external(env, napi_val, &mut unknown_tagged_object) },
      "Failed to get external value"
    )?;

    let external = match unsafe { External::from_raw_impl(unknown_tagged_object) } {
      Some(external) => external,
      None => {
        return Err(Error::new(
          Status::InvalidArg,
          format!(
            "<{}> on `External` is not the type of wrapped object",
            std::any::type_name::<T>()
          ),
        ));
      }
    };

    let mut ref_ptr = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(env, napi_val, 1, &mut ref_ptr) },
      "Failed to create reference on external value"
    )?;

    Ok(ExternalRef {
      obj: external,
      raw: ref_ptr,
      env,
    })
  }
}

impl<T: 'static> ToNapiValue for ExternalRef<T> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.raw, &mut value) },
      "Failed to get reference value on external value"
    )?;
    Ok(value)
  }
}

impl<T: 'static> ToNapiValue for &ExternalRef<T> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut value = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.raw, &mut value) },
      "Failed to get reference value on external value"
    )?;
    Ok(value)
  }
}

impl<T: 'static> Deref for ExternalRef<T> {
  type Target = T;

  fn deref(&self) -> &Self::Target {
    self.obj
  }
}

impl<T: 'static> DerefMut for ExternalRef<T> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    self.obj
  }
}
