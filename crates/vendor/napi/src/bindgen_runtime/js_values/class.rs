use std::any::type_name;
use std::ffi::CString;
use std::marker::PhantomData;
use std::ops::{Deref, DerefMut};
use std::ptr;

use crate::{
  bindgen_runtime::{
    check_class_identity, class_id_of, raw_finalize_unchecked, ClassId, FromNapiValue,
    JsObjectValue, MaybeTypeTag, Object, ObjectFinalize, Reference, Result, TypeName,
    ValidateNapiValue,
  },
  check_status, sys, Env, JsValue, PropertyAttributes, Value, ValueType,
};

#[derive(Clone, Copy)]
pub struct This<'env, T = Object<'env>> {
  pub object: T,
  _phantom: &'env PhantomData<()>,
}

impl<T> From<T> for This<'_, T> {
  fn from(value: T) -> Self {
    Self {
      object: value,
      _phantom: &PhantomData,
    }
  }
}

impl<T> Deref for This<'_, T> {
  type Target = T;

  fn deref(&self) -> &Self::Target {
    &self.object
  }
}

impl<T> DerefMut for This<'_, T> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    &mut self.object
  }
}

impl<'env, T: JsValue<'env>> JsValue<'env> for This<'_, T> {
  fn value(&self) -> Value {
    self.object.value()
  }
}

impl<T: FromNapiValue> FromNapiValue for This<'_, T> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self {
      object: T::from_napi_value(env, napi_val)?,
      _phantom: &PhantomData,
    })
  }
}

#[derive(Clone, Copy)]
pub struct ClassInstance<'env, T: 'env> {
  pub value: sys::napi_value,
  env: sys::napi_env,
  inner: *mut T,
  _phantom: &'env PhantomData<()>,
}

// NOTE: the `MaybeTypeTag` bound here is transitively required, not collateral:
// `JsValue: FromNapiValue` (see `js_values/value.rs`), and
// `FromNapiValue for ClassInstance<T>` (below) needs `T: MaybeTypeTag` to name
// `T::type_tag()` under napi8-native. Without `napi8` and on all wasm targets
// `MaybeTypeTag` is vacuous, so the default and wasm public API are unchanged.
impl<'env, T: 'env + MaybeTypeTag> JsValue<'env> for ClassInstance<'env, T> {
  fn value(&self) -> Value {
    Value {
      env: self.env,
      value: self.value,
      value_type: ValueType::Object,
    }
  }
}

impl<'env, T: 'env + MaybeTypeTag> JsObjectValue<'env> for ClassInstance<'env, T> {}

impl<'env, T: 'env> ClassInstance<'env, T> {
  #[doc(hidden)]
  pub unsafe fn new(value: sys::napi_value, env: sys::napi_env, inner: *mut T) -> Self {
    Self {
      value,
      env,
      inner: unsafe { &mut *inner },
      _phantom: &PhantomData,
    }
  }

  pub fn as_object<'a>(&self, env: &'a Env) -> Object<'a> {
    Object(
      Value {
        env: env.raw(),
        value: self.value,
        value_type: ValueType::Object,
      },
      PhantomData,
    )
  }

  /// Assign this `ClassInstance` to another `This` object
  ///
  /// Extends the lifetime of `ClassInstance` to `This`.
  pub fn assign_to_this<'a, 'this, U>(
    &'a self,
    name: &'a str,
    this: &'a mut This<U>,
  ) -> Result<ClassInstance<'this, T>>
  where
    'this: 'env,
    U: FromNapiValue + JsValue<'this>,
  {
    let name = CString::new(name)?;
    check_status!(
      unsafe {
        sys::napi_set_named_property(self.env, this.object.raw(), name.as_ptr(), self.value)
      },
      "Failed to assign ClassInstance<{}> to this",
      std::any::type_name::<T>()
    )?;
    let val: ClassInstance<'this, T> = ClassInstance {
      value: self.value,
      env: self.env,
      inner: self.inner,
      _phantom: &PhantomData,
    };
    Ok(val)
  }

  /// Assign this `ClassInstance` to another `This` object with `PropertyAttributes`.
  ///
  /// Extends the lifetime of `ClassInsatnce` to `This`.
  pub fn assign_to_this_with_attributes<'a, 'this, U>(
    &'a self,
    name: &'a str,
    attributes: PropertyAttributes,
    this: &'a mut This<U>,
  ) -> Result<ClassInstance<'this, T>>
  where
    'this: 'env,
    // Kept for backwards compatibility (previously required by `Property::with_value(self)`).
    // Vacuous without `napi8` and on all wasm targets, so the default and wasm API are unchanged.
    T: MaybeTypeTag,
    U: FromNapiValue + JsValue<'this>,
  {
    let name = CString::new(name)?;
    let descriptor = sys::napi_property_descriptor {
      utf8name: name.as_ptr(),
      name: ptr::null_mut(),
      method: None,
      getter: None,
      setter: None,
      value: self.value,
      attributes: attributes.into(),
      data: ptr::null_mut(),
    };

    check_status!(
      unsafe { sys::napi_define_properties(self.env, this.object.value().value, 1, &descriptor) },
      "Failed to define properties on This in `assign_to_this_with_attributes`"
    )?;

    let val: ClassInstance<'this, T> = ClassInstance {
      value: self.value,
      env: self.env,
      inner: self.inner,
      _phantom: &PhantomData,
    };
    Ok(val)
  }
}

impl<'env, T: 'env> TypeName for ClassInstance<'env, T>
where
  &'env T: TypeName,
{
  fn type_name() -> &'static str {
    type_name::<&T>()
  }

  fn value_type() -> ValueType {
    <&T>::value_type()
  }
}

impl<'env, T: 'env> ValidateNapiValue for ClassInstance<'env, T>
where
  &'env T: ValidateNapiValue,
{
  unsafe fn validate(
    env: sys::napi_env,
    napi_val: sys::napi_value,
  ) -> crate::Result<sys::napi_value> {
    unsafe { <&'env T>::validate(env, napi_val) }
  }
}

impl<'env, T: 'env + MaybeTypeTag> FromNapiValue for ClassInstance<'env, T> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> crate::Result<Self> {
    let mut value = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_unwrap(env, napi_val, &mut value) },
      "Unwrap value [{}] from class failed",
      type_name::<T>(),
    )?;

    // Reject a wrong-class / prototype-spoofed object before the blind cast.
    // The tag check is compiled only on napi8 NATIVE targets (the
    // `T: MaybeTypeTag` bound provides `T::type_tag()` only there); elsewhere
    // `check_class_identity` checks the class recorded at wrap time.
    #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
    unsafe {
      crate::bindgen_runtime::validate_type_tag(env, napi_val, &T::type_tag(), type_name::<T>())?;
    }
    check_class_identity::<T>(value, type_name::<T>)?;

    let value = unsafe { Box::from_raw(value as *mut T) };
    Ok(Self {
      value: napi_val,
      inner: Box::leak(value),
      env,
      _phantom: &PhantomData,
    })
  }
}

impl<'env, T: 'env> Deref for ClassInstance<'env, T> {
  type Target = T;

  fn deref(&self) -> &Self::Target {
    unsafe { &*self.inner }
  }
}

impl<'env, T: 'env> DerefMut for ClassInstance<'env, T> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    unsafe { &mut *self.inner }
  }
}

impl<'env, T: 'env> AsRef<T> for ClassInstance<'env, T> {
  fn as_ref(&self) -> &T {
    unsafe { &*self.inner }
  }
}

pub trait JavaScriptClassExt: Sized {
  fn into_instance(self, env: &Env) -> Result<ClassInstance<'_, Self>>;
  fn into_reference(self, env: Env) -> Result<Reference<Self>>;
  fn instance_of<'env, V: JsValue<'env>>(env: &Env, value: &V) -> Result<bool>;
}

/// Drop a class value whose raw pointer was produced by `Box::into_raw` but was
/// never adopted by `napi_wrap` (so no finalizer will ever reclaim it).
///
/// Zero-sized classes are special: `Box::into_raw` of a ZST yields the dangling
/// pointer, which callers may have replaced with a 1-byte heap placeholder so
/// distinct instances get distinct `REFERENCE_MAP` keys. Both forms are handled.
///
/// # Safety
///
/// `wrapped_value` must come from `Box::<T>::into_raw` (or be the 1-byte
/// placeholder substituted for a ZST `T`) and must not have been adopted by a
/// finalizer.
pub(crate) unsafe fn drop_unadopted_class_value<T>(wrapped_value: *mut std::ffi::c_void) {
  if std::mem::size_of::<T>() == 0 {
    unsafe { ptr::drop_in_place(ptr::NonNull::<T>::dangling().as_ptr()) };
    unsafe { free_empty_class_placeholder::<T>(wrapped_value) };
  } else {
    drop(unsafe { Box::from_raw(wrapped_value.cast::<T>()) });
  }
}

/// Free the 1-byte heap placeholder that stands in for a zero-sized class
/// value. Reconstructing a `Box<T>` for a ZST never deallocates, so the
/// placeholder must be released separately. No-op for non-ZST `T` and for the
/// unsubstituted dangling pointer.
///
/// # Safety
///
/// For a ZST `T`, `wrapped_value` must be either `NonNull::<T>::dangling()` or
/// a live placeholder allocated as a `Box<u8>`-layout value.
pub(crate) unsafe fn free_empty_class_placeholder<T>(wrapped_value: *mut std::ffi::c_void) {
  if std::mem::size_of::<T>() == 0 && wrapped_value != ptr::NonNull::<T>::dangling().as_ptr().cast()
  {
    drop(unsafe { Box::from_raw(wrapped_value.cast::<u8>()) });
  }
}

/// Non-generic core of [`new_instance`].
///
/// Constructing and wrapping the JavaScript object does not depend on the
/// concrete Rust class. Accept the type-dependent finalizer and class name as
/// values so addons with many classes only emit the N-API and reference-map
/// setup once.
#[inline(never)]
unsafe fn new_instance_raw(
  env: sys::napi_env,
  wrapped_value: *mut std::ffi::c_void,
  ctor_ref: sys::napi_ref,
  finalize_cb: sys::napi_finalize,
  class_name: &str,
  class_id: ClassId,
) -> Result<sys::napi_value> {
  let mut ctor = std::ptr::null_mut();
  check_status!(
    sys::napi_get_reference_value(env, ctor_ref, &mut ctor),
    "Failed to get constructor reference of class `{}`",
    class_name,
  )?;

  let mut result = std::ptr::null_mut();
  crate::__private::___CALL_FROM_FACTORY.with(|inner| inner.set(true));
  let status = sys::napi_new_instance(env, ctor, 0, std::ptr::null_mut(), &mut result);
  // Reset before checking `status`: a stale `true` would make every later JS
  // `new` of a `#[napi]` class on this thread skip its Rust constructor.
  crate::__private::___CALL_FROM_FACTORY.with(|inner| inner.set(false));
  check_status!(status, "Failed to construct class `{}`", class_name)?;
  let mut object_ref = std::ptr::null_mut();
  check_status!(
    sys::napi_wrap(
      env,
      result,
      wrapped_value,
      finalize_cb,
      std::ptr::null_mut(),
      &mut object_ref,
    ),
    "Failed to wrap native object of class `{}`",
    class_name,
  )?;

  // Allocated only after `napi_wrap` succeeds so a wrap failure cannot leak it.
  let initial_finalize: Box<dyn FnOnce()> = Box::new(|| {});
  // `Arc` (not `Rc`) is required so it matches `Reference`'s `Arc<Cell<..>>` field and its
  // `Sync` impl; the `Cell` is only accessed on the JS thread.
  #[allow(clippy::arc_with_non_send_sync)]
  let finalize_callbacks_ptr = std::sync::Arc::into_raw(std::sync::Arc::new(std::cell::Cell::new(
    Box::into_raw(initial_finalize),
  )));

  // Record the wrapped class for builds without type tags (#3608).
  super::value_ref::add_ref(
    env,
    wrapped_value,
    (wrapped_value, object_ref, finalize_callbacks_ptr),
    class_id,
  );

  Ok(result)
}

/// # Safety
///
/// create instance of class
#[doc(hidden)]
pub unsafe fn new_instance<T: 'static + ObjectFinalize + MaybeTypeTag>(
  env: sys::napi_env,
  wrapped_value: *mut std::ffi::c_void,
  ctor_ref: sys::napi_ref,
) -> Result<sys::napi_value> {
  let class_id = class_id_of::<T>().inspect_err(|_| {
    // Interning failed before the finalizer adopted the value.
    unsafe { drop_unadopted_class_value::<T>(wrapped_value) };
  })?;
  // Every error from `new_instance_raw` happens before `napi_wrap` adopts
  // `wrapped_value`, so ownership is still ours and it must be dropped here.
  // Errors after this point (type tagging) must NOT free it: the finalizer owns it.
  let result = match unsafe {
    new_instance_raw(
      env,
      wrapped_value,
      ctor_ref,
      Some(raw_finalize_unchecked::<T>),
      type_name::<T>(),
      class_id,
    )
  } {
    Ok(result) => result,
    Err(err) => {
      unsafe { drop_unadopted_class_value::<T>(wrapped_value) };
      return Err(err);
    }
  };

  // Stamp the type tag AFTER `add_ref` so a tag failure cannot leak the Arc +
  // napi_ref (see `CallbackInfo::_construct`). Compiled only on napi8 NATIVE
  // targets (the `T: MaybeTypeTag` bound provides `T::type_tag()` only there).
  #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
  unsafe {
    crate::bindgen_runtime::tag_object(env, result, &T::type_tag())?;
  }

  Ok(result)
}
