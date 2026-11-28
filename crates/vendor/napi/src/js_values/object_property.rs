use std::convert::From;
use std::ffi::{c_void, CStr, CString};
use std::ptr;
use std::rc::Rc;
use std::thread::ThreadId;

use bitflags::bitflags;

#[cfg(feature = "napi5")]
use crate::bindgen_runtime::{FromNapiValue, This};
use crate::{
  bindgen_runtime::ToNapiValue, check_status, sys, Callback, Env, Error, JsValue, Result, Status,
};

/// Property key of the private holder object used to retain a JS value that
/// `napi_create_reference` cannot reference directly (primitives, or values
/// rejected with `napi_invalid_arg` before Node-API 10).
const PROPERTY_VALUE_KEY: &CStr = c"[[PropertyValue]]";

/// Owns a thread-affine `napi_ref` keeping a JS value (or property key) alive
/// across `HandleScope` boundaries for as long as any [`Property`] clone holds it.
struct RetainedValue {
  raw: sys::napi_ref,
  // `true` when `raw` references a private holder object carrying the retained
  // value under `PROPERTY_VALUE_KEY` instead of the value itself.
  indirect: bool,
  env: sys::napi_env,
  owner_thread: ThreadId,
  #[cfg(not(feature = "noop"))]
  registration: Option<crate::bindgen_runtime::env_registration::RegistrationId>,
  #[cfg(all(feature = "napi4", not(feature = "noop")))]
  custom_gc: Option<std::sync::Arc<crate::bindgen_prelude::CustomGcHandle>>,
}

impl RetainedValue {
  fn new(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    if env.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "Cannot retain property value with null napi_env",
      ));
    }
    if value.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "Cannot retain null napi_value on Property",
      ));
    }

    #[cfg(not(feature = "noop"))]
    let registration = match crate::bindgen_runtime::env_registration::env_state(env) {
      crate::bindgen_runtime::env_registration::EnvState::Live(id) => Some(id),
      crate::bindgen_runtime::env_registration::EnvState::Unregistered => None,
      crate::bindgen_runtime::env_registration::EnvState::TornDown => {
        return Err(Error::new(
          Status::InvalidArg,
          "Cannot retain property value for a torn-down JavaScript environment",
        ));
      }
    };

    let mut value_type = 0;
    check_status!(
      unsafe { sys::napi_typeof(env, value, &mut value_type) },
      "Failed to inspect JS value type for Property"
    )?;

    let mut raw = ptr::null_mut();
    let can_ref_directly = matches!(
      value_type,
      sys::ValueType::napi_object | sys::ValueType::napi_function | sys::ValueType::napi_symbol
    );

    let indirect = if can_ref_directly {
      let status = unsafe { sys::napi_create_reference(env, value, 1, &mut raw) };
      if status == sys::Status::napi_ok {
        false
      } else if status == sys::Status::napi_invalid_arg {
        true
      } else {
        check_status!(status, "Failed to retain JS value for Property")?;
        unreachable!()
      }
    } else {
      true
    };

    if indirect {
      let mut holder = ptr::null_mut();
      check_status!(
        unsafe { sys::napi_create_object(env, &mut holder) },
        "Failed to create holder object for Property value"
      )?;
      let descriptor = sys::napi_property_descriptor {
        utf8name: PROPERTY_VALUE_KEY.as_ptr().cast(),
        name: ptr::null_mut(),
        method: None,
        getter: None,
        setter: None,
        value,
        attributes: sys::PropertyAttributes::default,
        data: ptr::null_mut(),
      };
      check_status!(
        unsafe { sys::napi_define_properties(env, holder, 1, &descriptor) },
        "Failed to store value on Property holder object"
      )?;
      check_status!(
        unsafe { sys::napi_create_reference(env, holder, 1, &mut raw) },
        "Failed to retain Property holder object"
      )?;
    }

    Ok(Self {
      raw,
      indirect,
      env,
      owner_thread: std::thread::current().id(),
      #[cfg(not(feature = "noop"))]
      registration,
      #[cfg(all(feature = "napi4", not(feature = "noop")))]
      custom_gc: crate::bindgen_prelude::custom_gc_handle_for_env(env),
    })
  }

  fn get(&self, env: sys::napi_env) -> Result<sys::napi_value> {
    if self.env != env || self.owner_thread != std::thread::current().id() {
      return Err(Error::new(
        Status::InvalidArg,
        "Property value belongs to a different JavaScript environment or thread",
      ));
    }
    #[cfg(all(feature = "napi4", not(feature = "noop")))]
    if let Some(handle) = &self.custom_gc {
      if !crate::bindgen_prelude::current_thread_owns_custom_gc(handle) {
        return Err(Error::new(
          Status::InvalidArg,
          "Property value belongs to a torn-down JavaScript environment",
        ));
      }
    }
    #[cfg(not(feature = "noop"))]
    match self.registration {
      Some(id) => {
        if !crate::bindgen_runtime::env_registration::is_registration_alive(id, env) {
          return Err(Error::new(
            Status::InvalidArg,
            "Property value belongs to a torn-down JavaScript environment",
          ));
        }
      }
      None => {
        if crate::bindgen_runtime::env_registration::env_state(env)
          == crate::bindgen_runtime::env_registration::EnvState::TornDown
        {
          return Err(Error::new(
            Status::InvalidArg,
            "Property value belongs to a torn-down JavaScript environment",
          ));
        }
      }
    }

    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_reference_value(env, self.raw, &mut result) },
      "Failed to resolve retained Property value"
    )?;
    if result.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "Retained Property value is no longer alive",
      ));
    }
    if self.indirect {
      check_status!(
        unsafe {
          sys::napi_get_named_property(env, result, PROPERTY_VALUE_KEY.as_ptr().cast(), &mut result)
        },
        "Failed to unwrap retained Property value"
      )?;
    }
    Ok(result)
  }
}

/// Releases a retained property `napi_ref` on the owning JS thread: unref to 0,
/// then delete. Called exactly once, from `RetainedValue::drop`.
#[cfg(not(feature = "noop"))]
fn release_retained_reference(env: sys::napi_env, reference: sys::napi_ref) {
  let mut ref_count = 0;
  let status = unsafe { sys::napi_reference_unref(env, reference, &mut ref_count) };
  if status != sys::Status::napi_ok {
    eprintln!(
      "unref property value reference failed: {}",
      Status::from(status)
    );
    return;
  }
  if ref_count == 0 {
    let status = unsafe { sys::napi_delete_reference(env, reference) };
    if status != sys::Status::napi_ok {
      eprintln!(
        "delete property value reference failed: {}",
        Status::from(status)
      );
    }
  }
}

#[cfg(not(feature = "noop"))]
impl Drop for RetainedValue {
  fn drop(&mut self) {
    #[cfg(all(feature = "napi4", not(feature = "noop")))]
    if let Some(handle) = self.custom_gc.take() {
      let env = self.env;
      let raw = self.raw;
      crate::bindgen_prelude::CustomGcHandle::release_ref(&handle, raw, || {
        release_retained_reference(env, raw)
      });
      return;
    }
    if self.owner_thread != std::thread::current().id() {
      return;
    }
    match self.registration {
      Some(id) => {
        if !crate::bindgen_runtime::env_registration::is_registration_alive(id, self.env) {
          return;
        }
      }
      None => {
        if crate::bindgen_runtime::env_registration::env_state(self.env)
          == crate::bindgen_runtime::env_registration::EnvState::TornDown
        {
          return;
        }
      }
    }
    release_retained_reference(self.env, self.raw);
  }
}

#[cfg(feature = "napi5")]
#[derive(Copy, Clone)]
pub struct PropertyClosures {
  pub setter_closure: *mut c_void,
  pub getter_closure: *mut c_void,
  /// Still filled, but no longer used to drop the closure: the boxed callback
  /// data owns it now. Kept so this public struct does not change.
  pub setter_drop_fn: Option<unsafe fn(*mut c_void)>,
  /// See `setter_drop_fn`.
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

/// Owns one boxed accessor closure and drops it with the last reference.
#[cfg(feature = "napi5")]
pub(crate) struct OwnedClosure {
  ptr: *mut c_void,
  drop_fn: unsafe fn(*mut c_void),
}

#[cfg(feature = "napi5")]
impl Drop for OwnedClosure {
  fn drop(&mut self) {
    unsafe { (self.drop_fn)(self.ptr) };
  }
}

/// The callback data `Property::raw` boxes. `closures` comes first, so the
/// trampolines can read the data as a `PropertyClosures`.
#[cfg(feature = "napi5")]
#[repr(C)]
pub(crate) struct PropertyClosuresData {
  closures: PropertyClosures,
  _owners: [Option<Rc<OwnedClosure>>; 2],
}

/// A property key, resolved in the current environment when the property is
/// defined.
#[derive(Clone)]
enum PropertyKey {
  Utf8(CString),
  /// A `Symbol.for` registry key.
  #[cfg(feature = "napi9")]
  SymbolFor(String),
  /// The name of a well-known symbol, such as `iterator` for `Symbol.iterator`.
  WellKnownSymbol(&'static str),
  /// A retained JS value (string or symbol) passed via [`Property::with_name`].
  Value(Rc<RetainedValue>),
}

/// A property value passed via [`Property::with_value`] or
/// [`Property::with_napi_value`].
#[derive(Clone)]
enum PropertyValue {
  Retained(Rc<RetainedValue>),
  /// Retaining the value failed in [`Property::with_value`] (which is
  /// infallible); surfaced when the property is materialized in [`Property::raw`].
  Err(Status, String),
}

#[derive(Clone)]
pub struct Property {
  key: Option<PropertyKey>,
  getter: sys::napi_callback,
  setter: sys::napi_callback,
  method: sys::napi_callback,
  attrs: PropertyAttributes,
  value: Option<PropertyValue>,
  data: *mut c_void,
  pub(crate) is_ctor: bool,
  #[cfg(feature = "napi5")]
  pub(crate) closures: PropertyClosures,
  #[cfg(feature = "napi5")]
  getter_owner: Option<Rc<OwnedClosure>>,
  #[cfg(feature = "napi5")]
  setter_owner: Option<Rc<OwnedClosure>>,
}

impl Default for Property {
  fn default() -> Self {
    Property {
      key: None,
      getter: Default::default(),
      setter: Default::default(),
      method: Default::default(),
      attrs: Default::default(),
      value: None,
      data: ptr::null_mut(),
      is_ctor: Default::default(),
      #[cfg(feature = "napi5")]
      closures: PropertyClosures::default(),
      #[cfg(feature = "napi5")]
      getter_owner: None,
      #[cfg(feature = "napi5")]
      setter_owner: None,
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

  /// Replaces any key set earlier on this `Property`.
  pub fn with_utf8_name(mut self, name: &str) -> Result<Self> {
    self.key = Some(PropertyKey::Utf8(CString::new(name)?));
    Ok(self)
  }

  /// Stores a global symbol key, resolved in the current environment when the
  /// property is defined. Replaces any key set earlier on this `Property`.
  /// Requires the `napi9` feature or a higher Node-API feature.
  ///
  /// Used by `#[napi(symbol_for)]` codegen. Not public API and not covered by
  /// semver.
  #[cfg(feature = "napi9")]
  #[doc(hidden)]
  pub fn with_symbol_name(mut self, name: &str) -> Self {
    self.key = Some(PropertyKey::SymbolFor(name.to_owned()));
    self
  }

  /// Stores the name of a well-known symbol, such as `iterator` for
  /// `Symbol.iterator`. The symbol is read from `globalThis.Symbol` in the
  /// current environment when the property is defined. Replaces any key set
  /// earlier on this `Property`.
  ///
  /// Used by `#[napi(well_known_symbol)]` codegen. Not public API and not
  /// covered by semver.
  #[doc(hidden)]
  pub fn with_well_known_symbol(mut self, name: &'static str) -> Self {
    self.key = Some(PropertyKey::WellKnownSymbol(name));
    self
  }

  /// Replaces any key set earlier on this `Property`.
  pub fn with_name<T: ToNapiValue>(mut self, env: &Env, name: T) -> Result<Self> {
    let raw = unsafe { T::to_napi_value(env.0, name)? };
    let retained = RetainedValue::new(env.0, raw)?;
    self.key = Some(PropertyKey::Value(Rc::new(retained)));
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
    let drop_fn = |ptr: *mut c_void| unsafe {
      drop(Box::from_raw(ptr as *mut F));
    };
    self.closures.getter_closure = closure_data_ptr.cast();
    self.closures.getter_drop_fn = Some(drop_fn);
    self.getter_owner = Some(Rc::new(OwnedClosure {
      ptr: closure_data_ptr.cast(),
      drop_fn,
    }));

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
    let drop_fn = |ptr: *mut c_void| unsafe {
      drop(Box::from_raw(ptr as *mut F));
    };
    self.closures.setter_closure = closure_data_ptr.cast();
    self.closures.setter_drop_fn = Some(drop_fn);
    self.setter_owner = Some(Rc::new(OwnedClosure {
      ptr: closure_data_ptr.cast(),
      drop_fn,
    }));

    let fun = crate::trampoline_setter::<V, F>;
    self.setter = Some(fun);
    self
  }

  pub fn with_property_attributes(mut self, attributes: PropertyAttributes) -> Self {
    self.attrs = attributes;
    self
  }

  pub fn with_value<'env, T: JsValue<'env>>(mut self, value: &T) -> Self {
    let val = T::value(value);
    self.value = Some(match RetainedValue::new(val.env, val.value) {
      Ok(retained) => PropertyValue::Retained(Rc::new(retained)),
      Err(err) => PropertyValue::Err(err.status, err.reason),
    });
    self
  }

  pub fn with_napi_value<T: ToNapiValue>(mut self, env: &Env, value: T) -> Result<Self> {
    let raw = unsafe { T::to_napi_value(env.0, value)? };
    let retained = RetainedValue::new(env.0, raw)?;
    self.value = Some(PropertyValue::Retained(Rc::new(retained)));
    Ok(self)
  }

  #[doc(hidden)]
  pub fn with_data(mut self, data: *mut c_void) -> Self {
    self.data = data;
    self
  }

  #[cfg(all(feature = "napi5", not(feature = "noop")))]
  pub(crate) fn has_owned_closure(&self) -> bool {
    self.getter_owner.is_some() || self.setter_owner.is_some()
  }

  #[cfg(not(feature = "noop"))]
  pub(crate) fn has_js_value(&self) -> bool {
    matches!(self.key, Some(PropertyKey::Value(_))) || self.value.is_some()
  }

  #[cfg(feature = "napi5")]
  pub(crate) fn has_closure_data(&self) -> bool {
    self.data.is_null()
      && (!self.closures.getter_closure.is_null() || !self.closures.setter_closure.is_null())
  }

  pub(crate) fn raw(&self, env: sys::napi_env) -> Result<sys::napi_property_descriptor> {
    // Resolve both the key and value before allocating closure data, so an
    // error here never leaks a boxed `PropertyClosuresData`.
    let (utf8name, name) = match &self.key {
      None => (ptr::null(), ptr::null_mut()),
      Some(PropertyKey::Utf8(name)) => (name.as_ptr(), ptr::null_mut()),
      #[cfg(feature = "napi9")]
      Some(PropertyKey::SymbolFor(symbol_name)) => {
        let mut symbol = ptr::null_mut();
        check_status!(unsafe {
          sys::node_api_symbol_for(
            env,
            symbol_name.as_ptr().cast(),
            symbol_name.len() as isize,
            &mut symbol,
          )
        })?;
        (ptr::null(), symbol)
      }
      Some(PropertyKey::WellKnownSymbol(name)) => (ptr::null(), well_known_symbol(env, name)?),
      Some(PropertyKey::Value(retained)) => (ptr::null(), retained.get(env)?),
    };

    let value = match &self.value {
      None => ptr::null_mut(),
      Some(PropertyValue::Retained(retained)) => retained.get(env)?,
      Some(PropertyValue::Err(status, reason)) => {
        let mut status = *status;
        if status == Status::PendingException {
          let mut is_pending = false;
          let check = unsafe { sys::napi_is_exception_pending(env, &mut is_pending) };
          if check != sys::Status::napi_ok || !is_pending {
            status = Status::GenericFailure;
          }
        }
        return Err(Error::new(status, reason.clone()));
      }
    };

    #[cfg(feature = "napi5")]
    let data = if !self.data.is_null() {
      self.data
    } else if self.closures.getter_closure.is_null() && self.closures.setter_closure.is_null() {
      // No closures to allocate, avoid memory leak
      ptr::null_mut()
    } else {
      // Only allocate when we actually have closures
      Box::into_raw(Box::new(PropertyClosuresData {
        closures: self.closures,
        _owners: [self.getter_owner.clone(), self.setter_owner.clone()],
      }))
      .cast()
    };

    Ok(sys::napi_property_descriptor {
      utf8name,
      name,
      method: self.method,
      getter: self.getter,
      setter: self.setter,
      value,
      attributes: self.attrs.into(),
      #[cfg(not(feature = "napi5"))]
      data: self.data,
      #[cfg(feature = "napi5")]
      data,
    })
  }

  pub fn with_ctor(mut self, callback: Callback) -> Self {
    self.method = Some(callback);
    self.is_ctor = true;
    self
  }
}

/// Reads `globalThis.Symbol[name]`, and fails instead of returning a value
/// that is not a symbol, so a missing symbol is never used as a property key.
fn well_known_symbol(env: sys::napi_env, name: &str) -> Result<sys::napi_value> {
  let mut global = ptr::null_mut();
  crate::check_status!(
    unsafe { sys::napi_get_global(env, &mut global) },
    "Get global object failed"
  )?;
  let mut symbol_ctor = ptr::null_mut();
  crate::check_status!(
    unsafe { sys::napi_get_named_property(env, global, c"Symbol".as_ptr(), &mut symbol_ctor) },
    "Get global Symbol failed"
  )?;
  let not_available = || {
    crate::Error::new(
      crate::Status::GenericFailure,
      format!("Symbol.{name} is not available in this runtime"),
    )
  };
  // Reading a property of `undefined` or `null` would throw a JS exception,
  // which hides the error below.
  let mut value_type = 0;
  crate::check_status!(unsafe { sys::napi_typeof(env, symbol_ctor, &mut value_type) })?;
  if value_type != sys::ValueType::napi_function && value_type != sys::ValueType::napi_object {
    return Err(not_available());
  }
  let mut key = ptr::null_mut();
  crate::check_status!(unsafe {
    sys::napi_create_string_utf8(env, name.as_ptr().cast(), name.len() as isize, &mut key)
  })?;
  let mut symbol = ptr::null_mut();
  crate::check_status!(
    unsafe { sys::napi_get_property(env, symbol_ctor, key, &mut symbol) },
    "Get Symbol.{} failed",
    name
  )?;
  crate::check_status!(unsafe { sys::napi_typeof(env, symbol, &mut value_type) })?;
  if value_type != sys::ValueType::napi_symbol {
    return Err(not_available());
  }
  Ok(symbol)
}

/// Builds the symbol-keyed `Property` for `#[napi(symbol_for = "...")]`.
/// Checked against the features of this crate, so a missing `napi9` gives a
/// clear error instead of a missing method.
#[cfg(feature = "napi9")]
#[doc(hidden)]
#[macro_export]
macro_rules! symbol_for_property {
  ($name:expr) => {
    $crate::bindgen_prelude::Property::new().with_symbol_name($name)
  };
}

#[cfg(not(feature = "napi9"))]
#[doc(hidden)]
#[macro_export]
macro_rules! symbol_for_property {
  ($name:expr) => {{
    compile_error!("`symbol_for` requires the `napi9` feature of the `napi` crate");
    $crate::bindgen_prelude::Property::new()
  }};
}

#[cfg(all(test, feature = "napi9"))]
mod tests {
  use super::*;

  fn old_keys() -> [Property; 3] {
    [
      Property::new().with_utf8_name("old").unwrap(),
      Property::new().with_symbol_name("old"),
      Property::new().with_well_known_symbol("dispose"),
    ]
  }

  #[test]
  fn utf8_name_replaces_other_names() {
    for property in old_keys() {
      let property = property.with_utf8_name("new").unwrap();
      assert!(matches!(
        &property.key,
        Some(PropertyKey::Utf8(name)) if name.as_bytes() == b"new"
      ));
    }
  }

  #[test]
  fn symbol_name_replaces_other_names() {
    for property in old_keys() {
      let property = property.with_symbol_name("new");
      assert!(matches!(
        &property.key,
        Some(PropertyKey::SymbolFor(name)) if name == "new"
      ));
    }
  }

  #[test]
  fn well_known_symbol_replaces_other_names() {
    for property in old_keys() {
      let property = property.with_well_known_symbol("iterator");
      assert!(matches!(
        property.key,
        Some(PropertyKey::WellKnownSymbol("iterator"))
      ));
    }
  }

  #[test]
  fn retained_value_rejects_null_env() {
    let err = RetainedValue::new(ptr::null_mut(), ptr::dangling_mut())
      .err()
      .unwrap();
    assert_eq!(err.status, Status::InvalidArg);
  }

  #[cfg(not(feature = "noop"))]
  #[test]
  fn retained_value_rejects_torn_down_env_without_calling_napi() {
    let fake_env = std::ptr::without_provenance_mut::<sys::napi_env__>(0x1000);
    crate::bindgen_runtime::env_registration::test_helpers::mark_env_torn_down(fake_env);
    let err = RetainedValue::new(fake_env, ptr::dangling_mut())
      .err()
      .unwrap();
    assert_eq!(err.status, Status::InvalidArg);
    assert!(err.reason.contains("torn-down"));

    // A previously created unregistered value must also refuse `get` and skip
    // N-API calls in `drop` once the env is marked torn down.
    let stale = RetainedValue {
      raw: ptr::dangling_mut(),
      indirect: false,
      env: fake_env,
      owner_thread: std::thread::current().id(),
      registration: None,
      #[cfg(feature = "napi4")]
      custom_gc: None,
    };
    let get_err = stale.get(fake_env).unwrap_err();
    assert_eq!(get_err.status, Status::InvalidArg);
    drop(stale);

    crate::bindgen_runtime::env_registration::test_helpers::clear_env_torn_down(fake_env);
  }

  #[cfg(not(feature = "noop"))]
  #[test]
  #[should_panic(expected = "register_class does not accept closure-backed properties")]
  fn register_class_rejects_closure_properties() {
    struct ClosureClass;
    let property = Property::new()
      .with_utf8_name("value")
      .unwrap()
      .with_getter_closure(|_env, _this| Ok(1u32));
    crate::bindgen_runtime::register_class(
      std::any::TypeId::of::<ClosureClass>(),
      None,
      "ClosureClass",
      vec![property],
      false,
    );
  }

  #[cfg(not(feature = "noop"))]
  #[test]
  #[should_panic(expected = "register_class does not accept properties with JS values or names")]
  fn register_class_rejects_js_value_properties() {
    struct ValueClass;
    let property = Property {
      key: Some(PropertyKey::Utf8(CString::new("value").unwrap())),
      value: Some(PropertyValue::Err(Status::InvalidArg, "dummy".to_owned())),
      ..Default::default()
    };
    crate::bindgen_runtime::register_class(
      std::any::TypeId::of::<ValueClass>(),
      None,
      "ValueClass",
      vec![property],
      false,
    );
  }
}
