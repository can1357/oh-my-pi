#![allow(deprecated)]

#[cfg(feature = "compat-mode")]
use std::convert::TryFrom;
#[cfg(feature = "compat-mode")]
use std::ffi::CString;
#[cfg(feature = "compat-mode")]
use std::ptr;

#[cfg(all(feature = "napi5", feature = "compat-mode"))]
use crate::bindgen_runtime::finalize_closures;
#[cfg(feature = "compat-mode")]
use crate::{
  bindgen_runtime::{FromNapiValue, ValidateNapiValue},
  check_status, type_of, Callback, Error, Status,
};
use crate::{
  bindgen_runtime::{JsObjectValue, ToNapiValue},
  sys, Result, ValueType,
};

#[cfg(feature = "compat-mode")]
mod arraybuffer;
#[cfg(all(feature = "napi6", feature = "compat-mode"))]
mod bigint;
#[cfg(feature = "compat-mode")]
mod boolean;
#[cfg(feature = "compat-mode")]
mod buffer;
#[cfg(feature = "napi5")]
mod date;
#[cfg(feature = "serde-json")]
mod de;
#[cfg(feature = "napi4")]
mod deferred;
mod either;
mod external;
#[cfg(feature = "compat-mode")]
mod function;
mod global;
#[cfg(feature = "compat-mode")]
mod null;
mod number;
#[cfg(feature = "compat-mode")]
mod object;
mod object_property;
#[cfg(feature = "serde-json")]
mod ser;
mod string;
mod symbol;
mod tagged_object;
#[cfg(feature = "compat-mode")]
mod undefined;
mod unknown;
mod value;
#[cfg(feature = "compat-mode")]
mod value_ref;

#[cfg(feature = "napi6")]
pub use crate::bindgen_prelude::{KeyCollectionMode, KeyConversion, KeyFilter};
#[cfg(feature = "compat-mode")]
pub use arraybuffer::*;
#[cfg(all(feature = "napi6", feature = "compat-mode"))]
pub use bigint::JsBigInt;
#[cfg(feature = "compat-mode")]
pub use boolean::JsBoolean;
#[cfg(feature = "compat-mode")]
pub use buffer::*;
#[cfg(feature = "napi5")]
pub use date::*;
#[cfg(feature = "serde-json")]
pub use de::De;
#[cfg(feature = "napi4")]
pub use deferred::*;
pub use either::Either;
pub use external::JsExternal;
#[cfg(feature = "compat-mode")]
pub use function::JsFunction;
pub use global::*;
#[cfg(feature = "compat-mode")]
pub use null::*;
pub use number::JsNumber;
#[cfg(feature = "compat-mode")]
pub use object::*;
pub use object_property::*;
#[cfg(feature = "serde-json")]
pub use ser::Ser;
pub use string::*;
pub use symbol::*;
#[cfg(feature = "napi6")]
pub(crate) use tagged_object::unregister_native_payload;
pub(crate) use tagged_object::{
  finalize_external_payload, finalize_tagged_object, is_registered_native_payload,
  register_native_payload, register_payload, unregister_payload, unwrap_tagged_object,
  TaggedObject,
};
#[cfg(feature = "compat-mode")]
pub use undefined::JsUndefined;
pub use unknown::{Unknown, UnknownRef};
pub use value::JsValue;
pub(crate) use value::Value;
#[cfg(feature = "compat-mode")]
pub use value_ref::*;

#[cfg(feature = "compat-mode")]
macro_rules! impl_napi_value_trait {
  ($js_value:ident, $value_type:expr) => {
    impl NapiValue for $js_value {
      unsafe fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Result<$js_value> {
        let value_type = type_of!(env, value)?;
        if value_type != $value_type {
          Err(Error::new(
            Status::InvalidArg,
            format!("expect {:?}, got: {:?}", $value_type, value_type),
          ))
        } else {
          Ok($js_value(Value {
            env,
            value,
            value_type: $value_type,
          }))
        }
      }

      unsafe fn from_raw_unchecked(env: sys::napi_env, value: sys::napi_value) -> $js_value {
        $js_value(Value {
          env,
          value,
          value_type: $value_type,
        })
      }
    }

    impl NapiRaw for $js_value {
      unsafe fn raw(&self) -> sys::napi_value {
        self.0.value
      }
    }

    impl<'env> NapiRaw for &'env $js_value {
      unsafe fn raw(&self) -> sys::napi_value {
        self.0.value
      }
    }

    impl TryFrom<Unknown<'_>> for $js_value {
      type Error = Error;
      fn try_from(value: Unknown) -> Result<$js_value> {
        unsafe { $js_value::from_raw(value.0.env, value.0.value) }
      }
    }
  };
}

#[cfg(feature = "compat-mode")]
macro_rules! impl_js_value_methods {
  ($js_value:ident) => {
    impl $js_value {
      pub fn into_unknown<'env>(self) -> Unknown<'env> {
        unsafe { Unknown::from_raw_unchecked(self.0.env, self.0.value) }
      }

      #[cfg(feature = "compat-mode")]
      pub fn coerce_to_bool(self) -> Result<JsBoolean> {
        let mut new_raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_coerce_to_bool(self.0.env, self.0.value, &mut new_raw_value)
        })?;
        Ok(JsBoolean(Value {
          env: self.0.env,
          value: new_raw_value,
          value_type: ValueType::Boolean,
        }))
      }

      pub fn coerce_to_number<'env>(self) -> Result<JsNumber<'env>> {
        let mut new_raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_coerce_to_number(self.0.env, self.0.value, &mut new_raw_value)
        })?;
        Ok(JsNumber(
          Value {
            env: self.0.env,
            value: new_raw_value,
            value_type: ValueType::Number,
          },
          std::marker::PhantomData,
        ))
      }

      pub fn coerce_to_string<'env>(self) -> Result<JsString<'env>> {
        let mut new_raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_coerce_to_string(self.0.env, self.0.value, &mut new_raw_value)
        })?;
        Ok(JsString(
          Value {
            env: self.0.env,
            value: new_raw_value,
            value_type: ValueType::String,
          },
          std::marker::PhantomData,
        ))
      }

      pub fn coerce_to_object(self) -> Result<JsObject> {
        let mut new_raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_coerce_to_object(self.0.env, self.0.value, &mut new_raw_value)
        })?;
        Ok(JsObject(Value {
          env: self.0.env,
          value: new_raw_value,
          value_type: ValueType::Object,
        }))
      }

      #[cfg(feature = "napi5")]
      pub fn is_date(&self) -> Result<bool> {
        let mut is_date = true;
        check_status!(unsafe { sys::napi_is_date(self.0.env, self.0.value, &mut is_date) })?;
        Ok(is_date)
      }

      pub fn is_promise(&self) -> Result<bool> {
        let mut is_promise = true;
        check_status!(unsafe { sys::napi_is_promise(self.0.env, self.0.value, &mut is_promise) })?;
        Ok(is_promise)
      }

      pub fn is_error(&self) -> Result<bool> {
        let mut result = false;
        check_status!(unsafe { sys::napi_is_error(self.0.env, self.0.value, &mut result) })?;
        Ok(result)
      }

      pub fn is_typedarray(&self) -> Result<bool> {
        let mut result = false;
        check_status!(unsafe { sys::napi_is_typedarray(self.0.env, self.0.value, &mut result) })?;
        Ok(result)
      }

      pub fn is_dataview(&self) -> Result<bool> {
        let mut result = false;
        check_status!(unsafe { sys::napi_is_dataview(self.0.env, self.0.value, &mut result) })?;
        Ok(result)
      }

      pub fn is_array(&self) -> Result<bool> {
        let mut is_array = false;
        check_status!(unsafe { sys::napi_is_array(self.0.env, self.0.value, &mut is_array) })?;
        Ok(is_array)
      }

      pub fn is_buffer(&self) -> Result<bool> {
        let mut is_buffer = false;
        check_status!(unsafe { sys::napi_is_buffer(self.0.env, self.0.value, &mut is_buffer) })?;
        Ok(is_buffer)
      }

      pub fn is_arraybuffer(&self) -> Result<bool> {
        let mut is_buffer = false;
        check_status!(unsafe {
          sys::napi_is_arraybuffer(self.0.env, self.0.value, &mut is_buffer)
        })?;
        Ok(is_buffer)
      }

      pub fn instanceof<Constructor>(&self, constructor: Constructor) -> Result<bool>
      where
        Constructor: NapiRaw,
      {
        let mut result = false;
        check_status!(unsafe {
          sys::napi_instanceof(self.0.env, self.0.value, constructor.raw(), &mut result)
        })?;
        Ok(result)
      }
    }
  };
}

#[cfg(feature = "compat-mode")]
macro_rules! impl_object_methods {
  ($js_value:ident) => {
    impl $js_value {
      pub fn set_property<K, V>(&mut self, key: K, value: V) -> Result<()>
      where
        K: ToNapiValue,
        V: ToNapiValue,
      {
        check_status!(unsafe {
          sys::napi_set_property(
            self.0.env,
            self.0.value,
            ToNapiValue::to_napi_value(self.0.env, key)?,
            ToNapiValue::to_napi_value(self.0.env, value)?,
          )
        })
      }

      pub fn get_property<K, T>(&self, key: K) -> Result<T>
      where
        K: ToNapiValue,
        T: FromNapiValue,
      {
        let mut raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_get_property(
            self.0.env,
            self.0.value,
            ToNapiValue::to_napi_value(self.0.env, key)?,
            &mut raw_value,
          )
        })?;
        unsafe { T::from_napi_value(self.0.env, raw_value) }
      }

      pub fn get_property_unchecked<K, T>(&self, key: K) -> Result<T>
      where
        K: NapiRaw,
        T: NapiValue,
      {
        let mut raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_get_property(self.0.env, self.0.value, key.raw(), &mut raw_value)
        })?;
        Ok(unsafe { T::from_raw_unchecked(self.0.env, raw_value) })
      }

      pub fn set_named_property<T>(&mut self, name: &str, value: T) -> Result<()>
      where
        T: ToNapiValue,
      {
        let key = CString::new(name)?;
        check_status!(unsafe {
          sys::napi_set_named_property(
            self.0.env,
            self.0.value,
            key.as_ptr(),
            T::to_napi_value(self.0.env, value)?,
          )
        })
      }

      pub fn create_named_method(&mut self, name: &str, function: Callback) -> Result<()> {
        let mut js_function = ptr::null_mut();
        let len = name.len();
        let name = CString::new(name)?;
        check_status!(unsafe {
          sys::napi_create_function(
            self.0.env,
            name.as_ptr(),
            len as isize,
            Some(function),
            ptr::null_mut(),
            &mut js_function,
          )
        })?;
        check_status!(
          unsafe {
            sys::napi_set_named_property(self.0.env, self.0.value, name.as_ptr(), js_function)
          },
          "create_named_method error"
        )
      }

      pub fn get_named_property<T>(&self, name: &str) -> Result<T>
      where
        T: FromNapiValue + ValidateNapiValue,
      {
        let key = CString::new(name)?;
        let mut raw_value = ptr::null_mut();
        check_status!(
          unsafe {
            sys::napi_get_named_property(self.0.env, self.0.value, key.as_ptr(), &mut raw_value)
          },
          "get_named_property error"
        )?;
        unsafe { <T as ValidateNapiValue>::validate(self.0.env, raw_value) }.map_err(
          |mut err| {
            err.reason = format!("Object property '{name}' type mismatch. {}", err.reason);
            err
          },
        )?;
        unsafe { <T as FromNapiValue>::from_napi_value(self.0.env, raw_value) }
      }

      pub fn get_named_property_unchecked<T>(&self, name: &str) -> Result<T>
      where
        T: FromNapiValue,
      {
        let key = CString::new(name)?;
        let mut raw_value = ptr::null_mut();
        check_status!(
          unsafe {
            sys::napi_get_named_property(self.0.env, self.0.value, key.as_ptr(), &mut raw_value)
          },
          "get_named_property_unchecked error"
        )?;
        unsafe { <T as FromNapiValue>::from_napi_value(self.0.env, raw_value) }
      }

      pub fn has_named_property<N: AsRef<str>>(&self, name: N) -> Result<bool> {
        let mut result = false;
        let key = CString::new(name.as_ref())?;
        check_status!(
          unsafe {
            sys::napi_has_named_property(self.0.env, self.0.value, key.as_ptr(), &mut result)
          },
          "napi_has_named_property error"
        )?;
        Ok(result)
      }

      pub fn delete_property<S>(&mut self, name: S) -> Result<bool>
      where
        S: ToNapiValue,
      {
        let mut result = false;
        check_status!(unsafe {
          sys::napi_delete_property(
            self.0.env,
            self.0.value,
            ToNapiValue::to_napi_value(self.0.env, name)?,
            &mut result,
          )
        })?;
        Ok(result)
      }

      pub fn delete_named_property(&mut self, name: &str) -> Result<bool> {
        let mut result = false;
        let mut js_key = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_create_string_utf8(
            self.0.env,
            name.as_ptr().cast(),
            name.len() as isize,
            &mut js_key,
          )
        })?;
        check_status!(unsafe {
          sys::napi_delete_property(self.0.env, self.0.value, js_key, &mut result)
        })?;
        Ok(result)
      }

      pub fn has_own_property(&self, key: &str) -> Result<bool> {
        let mut result = false;
        let mut js_key = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_create_string_utf8(
            self.0.env,
            key.as_ptr().cast(),
            key.len() as isize,
            &mut js_key,
          )
        })?;
        check_status!(unsafe {
          sys::napi_has_own_property(self.0.env, self.0.value, js_key, &mut result)
        })?;
        Ok(result)
      }

      pub fn has_own_property_js<K>(&self, key: K) -> Result<bool>
      where
        K: ToNapiValue,
      {
        let mut result = false;
        check_status!(unsafe {
          sys::napi_has_own_property(
            self.0.env,
            self.0.value,
            ToNapiValue::to_napi_value(self.0.env, key)?,
            &mut result,
          )
        })?;
        Ok(result)
      }

      pub fn has_property(&self, name: &str) -> Result<bool> {
        let mut js_key = ptr::null_mut();
        let mut result = false;
        check_status!(unsafe {
          sys::napi_create_string_utf8(
            self.0.env,
            name.as_ptr().cast(),
            name.len() as isize,
            &mut js_key,
          )
        })?;
        check_status!(unsafe {
          sys::napi_has_property(self.0.env, self.0.value, js_key, &mut result)
        })?;
        Ok(result)
      }

      pub fn has_property_js<K>(&self, name: K) -> Result<bool>
      where
        K: ToNapiValue,
      {
        let mut result = false;
        check_status!(unsafe {
          sys::napi_has_property(
            self.0.env,
            self.0.value,
            ToNapiValue::to_napi_value(self.0.env, name)?,
            &mut result,
          )
        })?;
        Ok(result)
      }

      pub fn get_property_names(&self) -> Result<JsObject> {
        let mut raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_get_property_names(self.0.env, self.0.value, &mut raw_value)
        })?;
        Ok(unsafe { JsObject::from_raw_unchecked(self.0.env, raw_value) })
      }

      /// <https://nodejs.org/api/n-api.html#n_api_napi_get_all_property_names>
      /// return `Array` of property names
      #[cfg(feature = "napi6")]
      pub fn get_all_property_names(
        &self,
        mode: KeyCollectionMode,
        filter: KeyFilter,
        conversion: KeyConversion,
      ) -> Result<JsObject> {
        let mut properties_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_get_all_property_names(
            self.0.env,
            self.0.value,
            mode.into(),
            filter.into(),
            conversion.into(),
            &mut properties_value,
          )
        })?;
        Ok(unsafe { JsObject::from_raw_unchecked(self.0.env, properties_value) })
      }

      /// This returns the equivalent of `Object.getPrototypeOf` (which is not the same as the function's prototype property).
      pub fn get_prototype<T>(&self) -> Result<T>
      where
        T: NapiValue,
      {
        let mut result = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_prototype(self.0.env, self.0.value, &mut result) })?;
        unsafe { T::from_raw(self.0.env, result) }
      }

      pub fn get_prototype_unchecked<T>(&self) -> Result<T>
      where
        T: NapiValue,
      {
        let mut result = ptr::null_mut();
        check_status!(unsafe { sys::napi_get_prototype(self.0.env, self.0.value, &mut result) })?;
        Ok(unsafe { T::from_raw_unchecked(self.0.env, result) })
      }

      pub fn set_element<T>(&mut self, index: u32, value: T) -> Result<()>
      where
        T: ToNapiValue,
      {
        check_status!(unsafe {
          sys::napi_set_element(
            self.0.env,
            self.0.value,
            index,
            ToNapiValue::to_napi_value(self.0.env, value)?,
          )
        })
      }

      pub fn has_element(&self, index: u32) -> Result<bool> {
        let mut result = false;
        check_status!(unsafe {
          sys::napi_has_element(self.0.env, self.0.value, index, &mut result)
        })?;
        Ok(result)
      }

      pub fn delete_element(&mut self, index: u32) -> Result<bool> {
        let mut result = false;
        check_status!(unsafe {
          sys::napi_delete_element(self.0.env, self.0.value, index, &mut result)
        })?;
        Ok(result)
      }

      pub fn get_element<T>(&self, index: u32) -> Result<T>
      where
        T: FromNapiValue,
      {
        let mut raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_get_element(self.0.env, self.0.value, index, &mut raw_value)
        })?;
        unsafe { T::from_napi_value(self.0.env, raw_value) }
      }

      pub fn get_element_unchecked<T>(&self, index: u32) -> Result<T>
      where
        T: NapiValue,
      {
        let mut raw_value = ptr::null_mut();
        check_status!(unsafe {
          sys::napi_get_element(self.0.env, self.0.value, index, &mut raw_value)
        })?;
        Ok(unsafe { T::from_raw_unchecked(self.0.env, raw_value) })
      }

      /// This method allows the efficient definition of multiple properties on a given object.
      pub fn define_properties(&mut self, properties: &[Property]) -> Result<()> {
        let property_descriptors = properties
          .iter()
          .map(|property| property.raw())
          .collect::<Vec<sys::napi_property_descriptor>>();
        #[cfg(feature = "napi5")]
        {
          let mut closures = properties
            .iter()
            .zip(property_descriptors.iter())
            .filter(|(property, _)| property.has_closure_data())
            .map(|(_, descriptor)| descriptor.data)
            .filter(|data| !data.is_null())
            .collect::<Vec<*mut std::ffi::c_void>>();
          if !closures.is_empty() {
            let finalize_hint = Box::into_raw(Box::new((closures.len(), closures.capacity())));
            check_status!(unsafe {
              sys::napi_add_finalizer(
                self.0.env,
                self.0.value,
                closures.as_mut_ptr().cast(),
                Some(finalize_closures),
                finalize_hint.cast(),
                ptr::null_mut(),
              )
            })?;
            std::mem::forget(closures);
          }
        }
        check_status!(unsafe {
          sys::napi_define_properties(
            self.0.env,
            self.0.value,
            properties.len(),
            property_descriptors.as_ptr(),
          )
        })
      }

      /// Perform `is_array` check before get the length
      /// if `Object` is not array, `ArrayExpected` error returned
      pub fn get_array_length(&self) -> Result<u32> {
        if self.is_array()? != true {
          return Err(Error::new(
            Status::ArrayExpected,
            "Object is not array".to_owned(),
          ));
        }
        self.get_array_length_unchecked()
      }

      /// use this API if you can ensure this `Object` is `Array`
      pub fn get_array_length_unchecked(&self) -> Result<u32> {
        let mut length: u32 = 0;
        check_status!(unsafe {
          sys::napi_get_array_length(self.0.env, self.0.value, &mut length)
        })?;
        Ok(length)
      }

      #[cfg(feature = "napi8")]
      pub fn freeze(&mut self) -> Result<()> {
        check_status!(unsafe { sys::napi_object_freeze(self.0.env, self.0.value) })
      }

      #[cfg(feature = "napi8")]
      pub fn seal(&mut self) -> Result<()> {
        check_status!(unsafe { sys::napi_object_seal(self.0.env, self.0.value) })
      }
    }
  };
}

#[cfg(feature = "compat-mode")]
pub trait NapiRaw {
  #[allow(clippy::missing_safety_doc)]
  unsafe fn raw(&self) -> sys::napi_value;
}

#[cfg(feature = "compat-mode")]
pub trait NapiValue: Sized + NapiRaw {
  #[allow(clippy::missing_safety_doc)]
  unsafe fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Result<Self>;

  #[allow(clippy::missing_safety_doc)]
  unsafe fn from_raw_unchecked(env: sys::napi_env, value: sys::napi_value) -> Self;
}

#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsUndefined);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsNull);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsBoolean);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsBuffer);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsArrayBuffer);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsTypedArray);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsDataView);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsObject);
#[cfg(feature = "compat-mode")]
impl_js_value_methods!(JsFunction);

#[cfg(feature = "compat-mode")]
impl_object_methods!(JsObject);
#[cfg(feature = "compat-mode")]
impl_object_methods!(JsBuffer);
#[cfg(feature = "compat-mode")]
impl_object_methods!(JsArrayBuffer);
#[cfg(feature = "compat-mode")]
impl_object_methods!(JsTypedArray);
#[cfg(feature = "compat-mode")]
impl_object_methods!(JsDataView);

#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsUndefined, ValueType::Undefined);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsNull, ValueType::Null);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsBoolean, ValueType::Boolean);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsBuffer, ValueType::Object);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsArrayBuffer, ValueType::Object);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsTypedArray, ValueType::Object);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsDataView, ValueType::Object);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsObject, ValueType::Object);
#[cfg(feature = "compat-mode")]
impl_napi_value_trait!(JsFunction, ValueType::Object);
