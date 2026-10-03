#[cfg(feature = "napi6")]
use std::convert::TryFrom;
#[cfg(feature = "napi5")]
use std::ffi::c_void;
use std::ffi::{c_char, CStr, CString};
use std::marker::PhantomData;
use std::ptr;

use crate::{
  bindgen_prelude::*, check_status, finalize_tagged_object, register_payload, sys, type_of,
  unregister_payload, unwrap_tagged_object, Callback, TaggedObject, Value,
};
#[cfg(feature = "napi5")]
use crate::{Env, PropertyClosures};

pub trait JsObjectValue<'env>: JsValue<'env> {
  /// Set the property value to the `Object`
  fn set_property<'k, 'v, K, V>(&mut self, key: K, value: V) -> Result<()>
  where
    K: JsValue<'k>,
    V: JsValue<'v>,
  {
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_set_property(env, self.value().value, key.raw(), value.raw())
    })
  }

  /// Get the property value from the `Object`
  ///
  /// Return the `InvalidArg` error if the property is not `T`
  fn get_property<'k, K, T>(&self, key: K) -> Result<T>
  where
    K: JsValue<'k>,
    T: FromNapiValue + ValidateNapiValue,
  {
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_get_property(env, self.value().value, key.raw(), &mut raw_value)
    })?;
    unsafe { T::validate(env, raw_value) }.map_err(|mut err| {
      err.reason = format!(
        "Object property '{:?}' type mismatch. {}",
        key
          .coerce_to_string()
          .and_then(|s| s.into_utf8())
          .and_then(|s| s.into_owned()),
        err.reason
      );
      err
    })?;
    unsafe { T::from_napi_value(env, raw_value) }
  }

  /// Get the property value from the `Object` without validation
  fn get_property_unchecked<'k, K, T>(&self, key: K) -> Result<T>
  where
    K: JsValue<'k>,
    T: FromNapiValue,
  {
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_get_property(env, self.value().value, key.raw(), &mut raw_value)
    })?;
    unsafe { T::from_napi_value(env, raw_value) }
  }

  /// Set the property value to the `Object`
  fn set_named_property<T>(&mut self, name: &str, value: T) -> Result<()>
  where
    T: ToNapiValue,
  {
    let key = CString::new(name)?;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_set_named_property(env, self.raw(), key.as_ptr(), T::to_napi_value(env, value)?)
    })
  }

  /// Set the property value to the `Object`, the property name is a `CStr`
  /// This is useful when the property name comes from a `C` library
  fn set_c_named_property<T>(&mut self, name: &CStr, value: T) -> Result<()>
  where
    T: ToNapiValue,
  {
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_set_named_property(
        env,
        self.raw(),
        name.as_ptr(),
        T::to_napi_value(env, value)?,
      )
    })
  }

  /// Create a named method on the `Object`
  fn create_named_method<K>(&mut self, name: K, function: Callback) -> Result<()>
  where
    K: AsRef<str>,
  {
    let mut js_function = ptr::null_mut();
    let len = name.as_ref().len();
    let name = CString::new(name.as_ref())?;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_function(
        env,
        name.as_ptr(),
        len as isize,
        Some(function),
        ptr::null_mut(),
        &mut js_function,
      )
    })?;
    check_status!(
      unsafe { sys::napi_set_named_property(env, self.value().value, name.as_ptr(), js_function) },
      "create_named_method error"
    )
  }

  /// Create a named method on the `Object`, the name is a `CStr`
  /// This is useful when the method name comes from a `C` library
  fn create_c_named_method(&mut self, name: &CStr, function: Callback) -> Result<()> {
    let mut js_function = ptr::null_mut();
    let len = name.count_bytes();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_function(
        env,
        name.as_ptr(),
        len as isize,
        Some(function),
        ptr::null_mut(),
        &mut js_function,
      )
    })?;
    check_status!(
      unsafe { sys::napi_set_named_property(env, self.value().value, name.as_ptr(), js_function) },
      "create_named_method error"
    )
  }

  /// Get the property value from the `Object`
  ///
  /// Return the `InvalidArg` error if the property is not `T`
  fn get_named_property<T>(&self, name: &str) -> Result<T>
  where
    T: FromNapiValue + ValidateNapiValue,
  {
    let key = CString::new(name)?;
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(
      unsafe {
        sys::napi_get_named_property(env, self.value().value, key.as_ptr(), &mut raw_value)
      },
      "get_named_property error"
    )?;
    unsafe { <T as ValidateNapiValue>::validate(env, raw_value) }.map_err(|mut err| {
      err.reason = format!("Object property '{name}' type mismatch. {}", err.reason);
      err
    })?;
    unsafe { <T as FromNapiValue>::from_napi_value(env, raw_value) }
  }

  /// Get the property value from the `Object`
  ///
  /// Return the `InvalidArg` error if the property is not `T`
  ///
  /// This is useful when the property name comes from a `C` library
  fn get_c_named_property<T>(&self, name: &CStr) -> Result<T>
  where
    T: FromNapiValue + ValidateNapiValue,
  {
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(
      unsafe {
        sys::napi_get_named_property(env, self.value().value, name.as_ptr(), &mut raw_value)
      },
      "get_named_property error"
    )?;
    unsafe { <T as ValidateNapiValue>::validate(env, raw_value) }.map_err(|mut err| {
      err.reason = format!(
        "Object property '{}' type mismatch. {}",
        name.to_string_lossy(),
        err.reason
      );
      err
    })?;
    unsafe { <T as FromNapiValue>::from_napi_value(env, raw_value) }
  }

  /// Get the property value from the `Object` without validation
  fn get_named_property_unchecked<T>(&self, name: &str) -> Result<T>
  where
    T: FromNapiValue,
  {
    let key = CString::new(name)?;
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(
      unsafe {
        sys::napi_get_named_property(env, self.value().value, key.as_ptr(), &mut raw_value)
      },
      "get_named_property_unchecked error"
    )?;
    unsafe { <T as FromNapiValue>::from_napi_value(env, raw_value) }
  }

  /// Get the property value from the `Object` without validation
  ///
  /// This is useful when the property name comes from a `C` library
  fn get_c_named_property_unchecked<T>(&self, name: &CStr) -> Result<T>
  where
    T: FromNapiValue,
  {
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(
      unsafe {
        sys::napi_get_named_property(env, self.value().value, name.as_ptr(), &mut raw_value)
      },
      "get_c_named_property_unchecked error"
    )?;
    unsafe { <T as FromNapiValue>::from_napi_value(env, raw_value) }
  }

  /// Check if the `Object` has the named property
  fn has_named_property<N: AsRef<str>>(&self, name: N) -> Result<bool> {
    let mut result = false;
    let key = CString::new(name.as_ref())?;
    let env = self.value().env;
    check_status!(
      unsafe { sys::napi_has_named_property(env, self.value().value, key.as_ptr(), &mut result) },
      "has_named_property error"
    )?;
    Ok(result)
  }

  /// Check if the `Object` has the named property
  ///
  /// This is useful when the property name comes from a `C` library
  fn has_c_named_property(&self, name: &CStr) -> Result<bool> {
    let mut result = false;
    let env = self.value().env;
    check_status!(
      unsafe { sys::napi_has_named_property(env, self.value().value, name.as_ptr(), &mut result) },
      "has_c_named_property error"
    )?;
    Ok(result)
  }

  /// Delete the property from the `Object`, the property name can be a `JsValue`
  fn delete_property<'s, S>(&mut self, name: S) -> Result<bool>
  where
    S: JsValue<'s>,
  {
    let mut result = false;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_delete_property(env, self.value().value, name.raw(), &mut result)
    })?;
    Ok(result)
  }

  /// Delete the property from the `Object`
  fn delete_named_property<K: AsRef<str>>(&mut self, name: K) -> Result<bool> {
    let name = name.as_ref();
    let mut result = false;
    let mut js_key = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_string_utf8(env, name.as_ptr().cast(), name.len() as isize, &mut js_key)
    })?;
    check_status!(unsafe {
      sys::napi_delete_property(env, self.value().value, js_key, &mut result)
    })?;
    Ok(result)
  }

  /// Delete the property from the `Object`
  ///
  /// This is useful when the property name comes from a `C` library
  fn delete_c_named_property(&mut self, name: &CStr) -> Result<bool> {
    let mut result = false;
    let mut js_key = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_string_utf8(env, name.as_ptr(), name.count_bytes() as isize, &mut js_key)
    })?;
    check_status!(unsafe {
      sys::napi_delete_property(env, self.value().value, js_key, &mut result)
    })?;
    Ok(result)
  }

  /// Check if the `Object` has the own property
  fn has_own_property(&self, key: &str) -> Result<bool> {
    let mut result = false;
    let mut js_key = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_string_utf8(env, key.as_ptr().cast(), key.len() as isize, &mut js_key)
    })?;
    check_status!(unsafe {
      sys::napi_has_own_property(env, self.value().value, js_key, &mut result)
    })?;
    Ok(result)
  }

  /// Check if the `Object` has the own property
  ///
  /// This is useful when the property name comes from a `C` library
  fn has_c_own_property(&self, key: &CStr) -> Result<bool> {
    let mut result = false;
    let mut js_key = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_string_utf8(env, key.as_ptr(), key.count_bytes() as isize, &mut js_key)
    })?;
    check_status!(unsafe {
      sys::napi_has_own_property(env, self.value().value, js_key, &mut result)
    })?;
    Ok(result)
  }

  /// The same as `has_own_property`, but accepts a `JsValue` as the property name.
  fn has_own_property_js<'k, K>(&self, key: K) -> Result<bool>
  where
    K: JsValue<'k>,
  {
    let mut result = false;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_has_own_property(env, self.value().value, key.raw(), &mut result)
    })?;
    Ok(result)
  }

  /// This API checks if the Object passed in has the named property.
  fn has_property(&self, name: &str) -> Result<bool> {
    let mut js_key = ptr::null_mut();
    let mut result = false;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_create_string_utf8(env, name.as_ptr().cast(), name.len() as isize, &mut js_key)
    })?;
    check_status!(unsafe { sys::napi_has_property(env, self.value().value, js_key, &mut result) })?;
    Ok(result)
  }

  /// This API is the same as `has_property`, but accepts a `JsValue` as the property name.
  /// So you can pass the `JsNumber` or `JsSymbol` as the property name.
  fn has_property_js<'k, K>(&self, name: K) -> Result<bool>
  where
    K: JsValue<'k>,
  {
    let mut result = false;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_has_property(env, self.value().value, name.raw(), &mut result)
    })?;
    Ok(result)
  }

  /// This API returns the names of the enumerable properties of object as an array of strings.
  /// The properties of object whose key is a symbol will not be included.
  fn get_property_names(&self) -> Result<Object<'env>> {
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_get_property_names(env, self.value().value, &mut raw_value)
    })?;
    Ok(Object::from_raw(env, raw_value))
  }

  #[cfg(feature = "napi6")]
  /// <https://nodejs.org/api/n-api.html#n_api_napi_get_all_property_names>
  /// This API returns an array containing the names of the available properties of this object.
  fn get_all_property_names(
    &self,
    mode: KeyCollectionMode,
    filter: KeyFilter,
    conversion: KeyConversion,
  ) -> Result<Object<'env>> {
    let mut properties_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_get_all_property_names(
        env,
        self.value().value,
        mode.into(),
        filter.into(),
        conversion.into(),
        &mut properties_value,
      )
    })?;
    Ok(Object::from_raw(env, properties_value))
  }

  /// This returns the equivalent of `Object.getPrototypeOf` (which is not the same as the function's prototype property).
  fn get_prototype(&self) -> Result<Unknown<'env>> {
    let mut result = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe { sys::napi_get_prototype(env, self.value().value, &mut result) })?;
    Ok(unsafe { Unknown::from_raw_unchecked(env, result) })
  }

  /// Get the prototype of the `Object`
  fn get_prototype_unchecked<T>(&self) -> Result<T>
  where
    T: FromNapiValue,
  {
    let mut result = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe { sys::napi_get_prototype(env, self.value().value, &mut result) })?;
    unsafe { T::from_napi_value(env, result) }
  }

  /// Set the element at the given index
  fn set_element<'t, T>(&mut self, index: u32, value: T) -> Result<()>
  where
    T: JsValue<'t>,
  {
    let env = self.value().env;
    check_status!(unsafe { sys::napi_set_element(env, self.value().value, index, value.raw()) })
  }

  /// Check if the `Array` has the element at the given index
  fn has_element(&self, index: u32) -> Result<bool> {
    let mut result = false;
    let env = self.value().env;
    check_status!(unsafe { sys::napi_has_element(env, self.value().value, index, &mut result) })?;
    Ok(result)
  }

  /// Delete the element at the given index
  fn delete_element(&mut self, index: u32) -> Result<bool> {
    let mut result = false;
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_delete_element(env, self.value().value, index, &mut result)
    })?;
    Ok(result)
  }

  /// Get the element at the given index
  ///
  /// If the `Object` is not an array, `ArrayExpected` error returned
  fn get_element<T>(&self, index: u32) -> Result<T>
  where
    T: FromNapiValue,
  {
    let mut raw_value = ptr::null_mut();
    let env = self.value().env;
    check_status!(unsafe {
      sys::napi_get_element(env, self.value().value, index, &mut raw_value)
    })?;
    unsafe { T::from_napi_value(env, raw_value) }
  }

  /// This method allows the efficient definition of multiple properties on a given object.
  fn define_properties(&mut self, properties: &[Property]) -> Result<()> {
    let property_descriptors = properties
      .iter()
      .map(|property| property.raw())
      .collect::<Vec<sys::napi_property_descriptor>>();
    let env = self.value().env;
    #[cfg(feature = "napi5")]
    {
      if !properties.is_empty() {
        let mut closures = properties
          .iter()
          .zip(property_descriptors.iter())
          .filter(|(property, _)| property.has_closure_data())
          .map(|(_, descriptor)| descriptor.data)
          .filter(|data| !data.is_null())
          .collect::<Vec<*mut std::ffi::c_void>>();
        if !closures.is_empty() {
          let finalize_hint = Box::into_raw(Box::new((closures.len(), closures.capacity())));
          check_status!(
            unsafe {
              sys::napi_add_finalizer(
                env,
                self.value().value,
                closures.as_mut_ptr().cast(),
                Some(finalize_closures),
                finalize_hint.cast(),
                ptr::null_mut(),
              )
            },
            "Failed to add finalizer"
          )?;
          std::mem::forget(closures);
        }
      }
    }
    check_status!(unsafe {
      sys::napi_define_properties(
        env,
        self.value().value,
        properties.len(),
        property_descriptors.as_ptr(),
      )
    })
  }

  /// Perform `is_array` check before get the length
  ///
  /// if `Object` is not array, `ArrayExpected` error returned
  fn get_array_length(&self) -> Result<u32> {
    if !(self.is_array()?) {
      return Err(Error::new(
        Status::ArrayExpected,
        "Object is not array".to_owned(),
      ));
    }
    self.get_array_length_unchecked()
  }

  /// use this API if you can ensure this `Object` is `Array`
  fn get_array_length_unchecked(&self) -> Result<u32> {
    let mut length: u32 = 0;
    let env = self.value().env;
    check_status!(unsafe { sys::napi_get_array_length(env, self.value().value, &mut length) })?;
    Ok(length)
  }

  /// Wrap the native value `T` to this `Object`
  /// the `T` will be dropped when this `Object` is finalized
  fn wrap<T: 'static>(&mut self, native_object: T, size_hint: Option<usize>) -> Result<()> {
    let env = self.value().env;
    let value = self.raw();
    let tagged_object = Box::into_raw(Box::new(TaggedObject::new(native_object)));
    let size_hint_ptr = Box::into_raw(Box::new(size_hint.unwrap_or(0) as i64));
    if let Err(err) = check_status!(unsafe {
      sys::napi_wrap(
        env,
        value,
        tagged_object.cast(),
        Some(finalize_tagged_object::<T>),
        size_hint_ptr.cast(),
        ptr::null_mut(),
      )
    }) {
      drop(unsafe { Box::from_raw(tagged_object) });
      drop(unsafe { Box::from_raw(size_hint_ptr) });
      return Err(err);
    }
    // Register the payload so `unwrap`/`remove_wrapped` can confirm it is a
    // live `TaggedObject` produced by this API before dereferencing it.
    register_payload(tagged_object.cast());
    Ok(())
  }

  /// Get the wrapped native value from the `Object`
  ///
  /// Return the `InvalidArg` error if the `Object` is not wrapped the `T`
  #[allow(clippy::mut_from_ref)]
  fn unwrap<T: 'static>(&self) -> Result<&mut T> {
    let env = self.value().env;
    let value = self.raw();
    unsafe {
      let tagged_object = unwrap_tagged_object::<T>(env, value)?;
      (*tagged_object).object.as_mut().ok_or_else(|| {
        Error::new(
          Status::InvalidArg,
          "Invalid argument, nothing attach to js_object".to_owned(),
        )
      })
    }
  }

  /// Remove the wrapped native value from the `Object`
  ///
  /// Return the `InvalidArg` error if the `Object` is not wrapped the `T`
  fn remove_wrapped<T: 'static>(&mut self) -> Result<()> {
    let env = self.value().env;
    let value = self.raw();
    unsafe {
      // Validate before detaching: on mismatch the wrap and its finalizer must
      // stay intact.
      unwrap_tagged_object::<T>(env, value)?;
      let mut detached = ptr::null_mut();
      check_status!(sys::napi_remove_wrap(env, value, &mut detached))?;
      unregister_payload(detached);
      drop(Box::from_raw(detached as *mut TaggedObject<T>));
      Ok(())
    }
  }

  #[cfg(feature = "napi5")]
  /// Adds a `finalize_cb` callback which will be called when the JavaScript object in js_object has been garbage-collected.
  ///
  /// This API can be called multiple times on a single JavaScript object.
  fn add_finalizer<T, Hint, F>(
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
    let env = self.value().env;
    let value = self.raw();
    let wrap_context = Box::leak(Box::new((native, finalize_cb, ptr::null_mut())));
    check_status!(unsafe {
      sys::napi_add_finalizer(
        env,
        value,
        (wrap_context as *mut (T, F, sys::napi_ref)).cast(),
        Some(finalize_callback::<T, Hint, F>),
        Box::into_raw(Box::new(finalize_hint)).cast(),
        &mut maybe_ref, // Note: this does not point to the boxed one…
      )
    })?;
    wrap_context.2 = maybe_ref;
    Ok(())
  }

  #[cfg(feature = "napi8")]
  /// This method freezes a given object.
  /// This prevents new properties from being added to it, existing properties from being removed, prevents changing the enumerability, configurability, or writability of existing properties, and prevents the values of existing properties from being changed.
  /// It also prevents the object's prototype from being changed. This is described in [Section 19.1.2.6](https://tc39.es/ecma262/#sec-object.freeze) of the ECMA-262 specification.
  fn freeze(&mut self) -> Result<()> {
    let env = self.value().env;
    check_status!(unsafe { sys::napi_object_freeze(env, self.value().value) })
  }

  #[cfg(feature = "napi8")]
  /// This method seals a given object. This prevents new properties from being added to it, as well as marking all existing properties as non-configurable.
  /// This is described in [Section 19.1.2.20](https://tc39.es/ecma262/#sec-object.seal) of the ECMA-262 specification.
  fn seal(&mut self) -> Result<()> {
    let env = self.value().env;
    check_status!(unsafe { sys::napi_object_seal(env, self.value().value) })
  }
}

#[derive(Clone, Copy)]
pub struct Object<'env>(pub(crate) Value, pub(crate) PhantomData<&'env ()>);

impl<'env> JsValue<'env> for Object<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl<'env> JsObjectValue<'env> for Object<'env> {}

impl TypeName for Object<'_> {
  fn type_name() -> &'static str {
    "Object"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for Object<'_> {}

impl FromNapiValue for Object<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Object,
      },
      PhantomData,
    ))
  }
}

impl ToNapiValue for &Object<'_> {
  unsafe fn to_napi_value(_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    Ok(val.0.value)
  }
}

/// # Safety
///
/// The caller must ensure that `env` and `obj` are valid N-API handles, and
/// `field` points to a valid nul-terminated C string.
#[doc(hidden)]
pub unsafe fn get_named_property_raw(
  env: sys::napi_env,
  obj: sys::napi_value,
  field: *const c_char,
) -> Result<Option<sys::napi_value>> {
  let mut ret = ptr::null_mut();

  check_status!(
    unsafe { sys::napi_get_named_property(env, obj, field, &mut ret) },
    "Failed to get property",
  )?;

  let ty = type_of!(env, ret)?;

  Ok(if ty == ValueType::Undefined {
    None
  } else {
    Some(ret)
  })
}

/// # Safety
///
/// The caller must ensure that `env`, `obj`, and `value` are valid N-API
/// handles, and `field` points to a valid nul-terminated C string.
#[doc(hidden)]
pub unsafe fn set_named_property_raw(
  env: sys::napi_env,
  obj: sys::napi_value,
  field: *const c_char,
  value: sys::napi_value,
) -> Result<()> {
  check_status!(
    unsafe { sys::napi_set_named_property(env, obj, field, value) },
    "Failed to set property"
  )
}

#[doc(hidden)]
#[inline]
pub unsafe fn from_raw_required_field<T>(
  env: sys::napi_env,
  raw: Option<sys::napi_value>,
  struct_name: &str,
  field: &str,
) -> Result<T>
where
  T: FromNapiValue,
{
  let Some(raw) = raw else {
    return Err(crate::missing_field_error(field));
  };

  unsafe { T::from_napi_value(env, raw) }.map_err(|err| {
    if struct_name.is_empty() {
      err
    } else {
      crate::decorate_field_error(err, struct_name, field)
    }
  })
}

#[doc(hidden)]
#[inline]
pub unsafe fn from_raw_optional_field<T>(
  env: sys::napi_env,
  raw: Option<sys::napi_value>,
  struct_name: &str,
  field: &str,
) -> Result<Option<T>>
where
  T: FromNapiValue,
{
  match raw {
    Some(raw) => unsafe { T::from_napi_value(env, raw) }
      .map(Some)
      .map_err(|err| {
        if struct_name.is_empty() {
          err
        } else {
          crate::decorate_field_error(err, struct_name, field)
        }
      }),
    None => Ok(None),
  }
}

impl Object<'_> {
  /// create a new `Object` from raw values
  pub fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Self {
    Self(
      Value {
        env,
        value,
        value_type: ValueType::Object,
      },
      PhantomData,
    )
  }

  /// create a new `Object` from a `Env`
  pub fn new(env: &Env) -> Result<Self> {
    let mut ptr = ptr::null_mut();
    unsafe {
      check_status!(
        sys::napi_create_object(env.0, &mut ptr),
        "Failed to create napi Object"
      )?;
    }

    Ok(Self(
      crate::Value {
        env: env.0,
        value: ptr,
        value_type: ValueType::Object,
      },
      PhantomData,
    ))
  }

  /// Get the property value from the `Object`, if the property is not found, `None` is returned
  pub fn get<V: FromNapiValue>(&self, field: &str) -> Result<Option<V>> {
    unsafe {
      self
        .get_inner(field)?
        .map(|v| V::from_napi_value(self.0.env, v))
        .transpose()
    }
  }

  fn get_inner(&self, field: &str) -> Result<Option<sys::napi_value>> {
    unsafe {
      let mut property_key = std::ptr::null_mut();
      check_status!(
        sys::napi_create_string_utf8(
          self.0.env,
          field.as_ptr().cast(),
          field.len() as isize,
          &mut property_key,
        ),
        "Failed to create property key with `{field}`"
      )?;

      let mut ret = ptr::null_mut();

      check_status!(
        sys::napi_get_property(self.0.env, self.0.value, property_key, &mut ret),
        "Failed to get property with field `{field}`",
      )?;

      let ty = type_of!(self.0.env, ret)?;

      Ok(if ty == ValueType::Undefined {
        None
      } else {
        Some(ret)
      })
    }
  }

  /// Set the property value to the `Object`
  pub fn set<K: AsRef<str>, V: ToNapiValue>(&mut self, field: K, val: V) -> Result<()> {
    unsafe { self.set_inner(field.as_ref(), V::to_napi_value(self.0.env, val)?) }
  }

  unsafe fn set_inner(&mut self, field: &str, napi_val: sys::napi_value) -> Result<()> {
    let mut property_key = std::ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_string_utf8(
          self.0.env,
          field.as_ptr().cast(),
          field.len() as isize,
          &mut property_key,
        )
      },
      "Failed to create property key with `{field}`"
    )?;

    check_status!(
      unsafe { sys::napi_set_property(self.0.env, self.0.value, property_key, napi_val) },
      "Failed to set property with field `{field}`"
    )?;
    Ok(())
  }

  /// Get the string keys of the `Object`
  pub fn keys(obj: &Object) -> Result<Vec<String>> {
    let mut names = ptr::null_mut();
    unsafe {
      check_status!(
        sys::napi_get_property_names(obj.0.env, obj.0.value, &mut names),
        "Failed to get property names of given object"
      )?;
    }

    let names = unsafe { Array::from_napi_value(obj.0.env, names)? };
    let mut ret = vec![];

    for i in 0..names.len() {
      ret.push(names.get_element::<String>(i)?);
    }

    Ok(ret)
  }

  /// Create a reference to the object.
  ///
  /// Set the `LEAK_CHECK` to `false` to disable the leak check during the `Drop`
  pub fn create_ref<const LEAK_CHECK: bool>(&self) -> Result<ObjectRef<LEAK_CHECK>> {
    let mut ref_ = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(self.0.env, self.0.value, 1, &mut ref_) },
      "Failed to create reference"
    )?;
    Ok(ObjectRef { inner: ref_ })
  }
}

/// A reference to a JavaScript object.
///
/// You must call the `unref` method to release the reference, or the object under the hood will be leaked forever.
///
/// Set the `LEAK_CHECK` to `false` to disable the leak check during the `Drop`
pub struct ObjectRef<const LEAK_CHECK: bool = true> {
  pub(crate) inner: sys::napi_ref,
}

unsafe impl<const LEAK_CHECK: bool> Send for ObjectRef<LEAK_CHECK> {}

impl<const LEAK_CHECK: bool> Drop for ObjectRef<LEAK_CHECK> {
  fn drop(&mut self) {
    if LEAK_CHECK && !self.inner.is_null() {
      eprintln!("ObjectRef is not unref, it considered as a memory leak");
    }
  }
}

impl<const LEAK_CHECK: bool> ObjectRef<LEAK_CHECK> {
  /// Get the object from the reference
  pub fn get_value<'env>(&self, env: &'env Env) -> Result<Object<'env>> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env.0, self.inner, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(Object::from_raw(env.0, result))
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

impl<const LEAK_CHECK: bool> FromNapiValue for ObjectRef<LEAK_CHECK> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut ref_ = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_reference(env, napi_val, 1, &mut ref_) },
      "Failed to create reference"
    )?;
    Ok(Self { inner: ref_ })
  }
}

impl<const LEAK_CHECK: bool> ToNapiValue for &ObjectRef<LEAK_CHECK> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, val.inner, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}

impl<const LEAK_CHECK: bool> ToNapiValue for ObjectRef<LEAK_CHECK> {
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

#[cfg(feature = "napi5")]
pub struct FinalizeContext<T: 'static, Hint: 'static> {
  pub env: Env,
  pub value: T,
  pub hint: Hint,
}

#[cfg(feature = "napi6")]
pub enum KeyCollectionMode {
  IncludePrototypes,
  OwnOnly,
}

#[cfg(feature = "napi6")]
impl TryFrom<sys::napi_key_collection_mode> for KeyCollectionMode {
  type Error = Error;

  fn try_from(value: sys::napi_key_collection_mode) -> Result<Self> {
    match value {
      sys::KeyCollectionMode::include_prototypes => Ok(Self::IncludePrototypes),
      sys::KeyCollectionMode::own_only => Ok(Self::OwnOnly),
      _ => Err(Error::new(
        crate::Status::InvalidArg,
        format!("Invalid key collection mode: {value}"),
      )),
    }
  }
}

#[cfg(feature = "napi6")]
impl From<KeyCollectionMode> for sys::napi_key_collection_mode {
  fn from(value: KeyCollectionMode) -> Self {
    match value {
      KeyCollectionMode::IncludePrototypes => sys::KeyCollectionMode::include_prototypes,
      KeyCollectionMode::OwnOnly => sys::KeyCollectionMode::own_only,
    }
  }
}

#[cfg(feature = "napi6")]
pub enum KeyFilter {
  AllProperties,
  Writable,
  Enumerable,
  Configurable,
  SkipStrings,
  SkipSymbols,
}

#[cfg(feature = "napi6")]
impl TryFrom<sys::napi_key_filter> for KeyFilter {
  type Error = Error;

  fn try_from(value: sys::napi_key_filter) -> Result<Self> {
    match value {
      sys::KeyFilter::all_properties => Ok(Self::AllProperties),
      sys::KeyFilter::writable => Ok(Self::Writable),
      sys::KeyFilter::enumerable => Ok(Self::Enumerable),
      sys::KeyFilter::configurable => Ok(Self::Configurable),
      sys::KeyFilter::skip_strings => Ok(Self::SkipStrings),
      sys::KeyFilter::skip_symbols => Ok(Self::SkipSymbols),
      _ => Err(Error::new(
        crate::Status::InvalidArg,
        format!("Invalid key filter [{value}]"),
      )),
    }
  }
}

#[cfg(feature = "napi6")]
impl From<KeyFilter> for sys::napi_key_filter {
  fn from(value: KeyFilter) -> Self {
    match value {
      KeyFilter::AllProperties => sys::KeyFilter::all_properties,
      KeyFilter::Writable => sys::KeyFilter::writable,
      KeyFilter::Enumerable => sys::KeyFilter::enumerable,
      KeyFilter::Configurable => sys::KeyFilter::configurable,
      KeyFilter::SkipStrings => sys::KeyFilter::skip_strings,
      KeyFilter::SkipSymbols => sys::KeyFilter::skip_symbols,
    }
  }
}

#[cfg(feature = "napi6")]
pub enum KeyConversion {
  KeepNumbers,
  NumbersToStrings,
}

#[cfg(feature = "napi6")]
impl TryFrom<sys::napi_key_conversion> for KeyConversion {
  type Error = Error;

  fn try_from(value: sys::napi_key_conversion) -> Result<Self> {
    match value {
      sys::KeyConversion::keep_numbers => Ok(Self::KeepNumbers),
      sys::KeyConversion::numbers_to_strings => Ok(Self::NumbersToStrings),
      _ => Err(Error::new(
        crate::Status::InvalidArg,
        format!("Invalid key conversion [{value}]"),
      )),
    }
  }
}

#[cfg(feature = "napi6")]
impl From<KeyConversion> for sys::napi_key_conversion {
  fn from(value: KeyConversion) -> Self {
    match value {
      KeyConversion::KeepNumbers => sys::KeyConversion::keep_numbers,
      KeyConversion::NumbersToStrings => sys::KeyConversion::numbers_to_strings,
    }
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
  use crate::Env;

  let (value, callback, raw_ref) =
    unsafe { *Box::from_raw(finalize_data as *mut (T, F, sys::napi_ref)) };
  let hint = unsafe { *Box::from_raw(finalize_hint as *mut Hint) };
  let env = Env::from_raw(raw_env);
  callback(FinalizeContext { env, value, hint });
  if !raw_ref.is_null() {
    check_status_or_throw!(
      raw_env,
      unsafe { sys::napi_delete_reference(raw_env, raw_ref) },
      "Delete reference in finalize callback failed"
    );
  }
}

#[cfg(feature = "napi5")]
pub(crate) unsafe extern "C" fn finalize_closures(
  _env: sys::napi_env,
  data: *mut c_void,
  len: *mut c_void,
) {
  let (length, capacity): (usize, usize) = *unsafe { Box::from_raw(len.cast()) };
  let closures: Vec<*mut PropertyClosures> =
    unsafe { Vec::from_raw_parts(data.cast(), length, capacity) };
  for closure_ptr in closures.into_iter() {
    if !closure_ptr.is_null() {
      let closures = unsafe { Box::from_raw(closure_ptr) };
      // Free the actual closure functions using the stored drop functions
      if !closures.getter_closure.is_null() {
        if let Some(drop_fn) = closures.getter_drop_fn {
          unsafe { drop_fn(closures.getter_closure) };
        }
      }
      if !closures.setter_closure.is_null() {
        if let Some(drop_fn) = closures.setter_drop_fn {
          unsafe { drop_fn(closures.setter_closure) };
        }
      }
    }
  }
}
