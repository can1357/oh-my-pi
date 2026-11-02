use std::convert::From;
use std::ffi::c_void;
use std::ffi::CString;
use std::ptr;

use bitflags::bitflags;

#[cfg(feature = "napi5")]
use crate::bindgen_runtime::{FromNapiValue, This};
use crate::{bindgen_runtime::ToNapiValue, sys, Callback, Env, JsValue, Result};

#[cfg(feature = "napi5")]
#[derive(Copy, Clone)]
pub struct PropertyClosures {
  pub setter_closure: *mut c_void,
  pub getter_closure: *mut c_void,
  pub setter_drop_fn: Option<unsafe fn(*mut c_void)>,
  pub getter_drop_fn: Option<unsafe fn(*mut c_void)>,
}

#[cfg(feature = "napi5")]
impl Default for PropertyClosures {
  fn default() -> Self {
    Self {
      setter_closure: ptr::null_mut(),
      getter_closure: ptr::null_mut(),
      setter_drop_fn: None,
      getter_drop_fn: None,
    }
  }
}

#[derive(Clone)]
pub struct Property {
  utf8_name: Option<CString>,
  name: sys::napi_value,
  getter: sys::napi_callback,
  setter: sys::napi_callback,
  method: sys::napi_callback,
  attrs: PropertyAttributes,
  value: sys::napi_value,
  data: *mut c_void,
  pub(crate) is_ctor: bool,
  #[cfg(feature = "napi5")]
  pub(crate) closures: PropertyClosures,
}

impl Default for Property {
  fn default() -> Self {
    Property {
      utf8_name: Default::default(),
      name: ptr::null_mut(),
      getter: Default::default(),
      setter: Default::default(),
      method: Default::default(),
      attrs: Default::default(),
      value: ptr::null_mut(),
      data: ptr::null_mut(),
      is_ctor: Default::default(),
      #[cfg(feature = "napi5")]
      closures: PropertyClosures::default(),
    }
  }
}

bitflags! {
  #[derive(Debug, Copy, Clone)]
  pub struct PropertyAttributes: i32 {
    const Default = sys::PropertyAttributes::default;
    const Writable = sys::PropertyAttributes::writable;
    const Enumerable = sys::PropertyAttributes::enumerable;
    const Configurable = sys::PropertyAttributes::configurable;
    const Static = sys::PropertyAttributes::static_;
  }
}

impl Default for PropertyAttributes {
  fn default() -> Self {
    PropertyAttributes::Configurable | PropertyAttributes::Enumerable | PropertyAttributes::Writable
  }
}

impl From<PropertyAttributes> for sys::napi_property_attributes {
  fn from(value: PropertyAttributes) -> Self {
    value.bits()
  }
}

impl Property {
  pub fn new() -> Self {
    Default::default()
  }

  pub fn with_utf8_name(mut self, name: &str) -> Result<Self> {
    self.utf8_name = Some(CString::new(name)?);
    Ok(self)
  }

  pub fn with_name<T: ToNapiValue>(mut self, env: &Env, name: T) -> Result<Self> {
    self.name = unsafe { T::to_napi_value(env.0, name)? };
    Ok(self)
  }

  pub fn with_method(mut self, callback: Callback) -> Self {
    self.method = Some(callback);
    self
  }

  pub fn with_getter(mut self, callback: Callback) -> Self {
    self.getter = Some(callback);
    self
  }

  #[cfg(feature = "napi5")]
  pub fn with_getter_closure<R, F>(mut self, callback: F) -> Self
  where
    F: 'static + Fn(Env, This) -> Result<R>,
    R: ToNapiValue,
  {
    let boxed_callback = Box::new(callback);
    let closure_data_ptr: *mut F = Box::into_raw(boxed_callback);
    self.closures.getter_closure = closure_data_ptr.cast();
    self.closures.getter_drop_fn = Some(|ptr: *mut c_void| unsafe {
      drop(Box::from_raw(ptr as *mut F));
    });

    let fun = crate::trampoline_getter::<R, F>;
    self.getter = Some(fun);
    self
  }

  pub fn with_setter(mut self, callback: Callback) -> Self {
    self.setter = Some(callback);
    self
  }

  #[cfg(feature = "napi5")]
  pub fn with_setter_closure<F, V>(mut self, callback: F) -> Self
  where
    F: 'static + Fn(crate::Env, This, V) -> Result<()>,
    V: FromNapiValue,
  {
    let boxed_callback = Box::new(callback);
    let closure_data_ptr: *mut F = Box::into_raw(boxed_callback);
    self.closures.setter_closure = closure_data_ptr.cast();
    self.closures.setter_drop_fn = Some(|ptr: *mut c_void| unsafe {
      drop(Box::from_raw(ptr as *mut F));
    });

    let fun = crate::trampoline_setter::<V, F>;
    self.setter = Some(fun);
    self
  }

  pub fn with_property_attributes(mut self, attributes: PropertyAttributes) -> Self {
    self.attrs = attributes;
    self
  }

  pub fn with_value<'env, T: JsValue<'env>>(mut self, value: &T) -> Self {
    self.value = T::raw(value);
    self
  }

  pub fn with_napi_value<T: ToNapiValue>(mut self, env: &Env, value: T) -> Result<Self> {
    self.value = unsafe { T::to_napi_value(env.0, value)? };
    Ok(self)
  }

  #[doc(hidden)]
  pub fn with_data(mut self, data: *mut c_void) -> Self {
    self.data = data;
    self
  }

  #[cfg(feature = "napi5")]
  pub(crate) fn has_closure_data(&self) -> bool {
    self.data.is_null()
      && (!self.closures.getter_closure.is_null() || !self.closures.setter_closure.is_null())
  }

  pub(crate) fn raw(&self) -> sys::napi_property_descriptor {
    #[cfg(feature = "napi5")]
    let data = if !self.data.is_null() {
      self.data
    } else if self.closures.getter_closure.is_null() && self.closures.setter_closure.is_null() {
      // No closures to allocate, avoid memory leak
      ptr::null_mut()
    } else {
      // Only allocate when we actually have closures
      Box::into_raw(Box::new(self.closures)).cast()
    };

    sys::napi_property_descriptor {
      utf8name: match self.utf8_name {
        Some(ref name) => name.as_ptr(),
        None => ptr::null(),
      },
      name: self.name,
      method: self.method,
      getter: self.getter,
      setter: self.setter,
      value: self.value,
      attributes: self.attrs.into(),
      #[cfg(not(feature = "napi5"))]
      data: self.data,
      #[cfg(feature = "napi5")]
      data,
    }
  }

  pub fn with_ctor(mut self, callback: Callback) -> Self {
    self.method = Some(callback);
    self.is_ctor = true;
    self
  }
}
