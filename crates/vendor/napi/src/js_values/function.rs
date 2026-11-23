use std::ptr;

use super::Value;
#[cfg(feature = "napi4")]
use crate::{
  bindgen_runtime::JsValuesTupleIntoVec,
  threadsafe_function::{ThreadsafeCallContext, ThreadsafeFunction},
};
use crate::{
  bindgen_runtime::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue},
  check_pending_exception, sys, Error, JsObject, JsString, NapiRaw, NapiValue, Result, Status,
  Unknown, ValueType,
};

#[deprecated(since = "2.17.0", note = "Please use `Function` instead")]
pub struct JsFunction(pub(crate) Value);

impl ValidateNapiValue for JsFunction {}

impl TypeName for JsFunction {
  fn type_name() -> &'static str {
    "Function"
  }

  fn value_type() -> crate::ValueType {
    ValueType::Function
  }
}

/// See [Working with JavaScript Functions](https://nodejs.org/api/n-api.html#n_api_working_with_javascript_functions).
///
/// Example:
/// ```
/// use napi::{JsFunction, CallContext, JsNull, Result};
///
/// #[js_function(1)]
/// pub fn call_function(ctx: CallContext) -> Result<JsNull> {
///     let js_func = ctx.get::<JsFunction>(0)?;
///     let js_string = ctx.env.create_string("hello".as_ref())?.into_unknown()?;
///     js_func.call(None, &[js_string])?;
///     Ok(ctx.env.get_null()?)
/// }
/// ```
impl JsFunction {
  /// [napi_call_function](https://nodejs.org/api/n-api.html#n_api_napi_call_function)
  pub fn call<V>(&self, this: Option<&JsObject>, args: &[V]) -> Result<Unknown<'_>>
  where
    V: NapiRaw,
  {
    let raw_this = this
      .map(|v| unsafe { v.raw() })
      .or_else(|| unsafe { ToNapiValue::to_napi_value(self.0.env, ()) }.ok())
      .ok_or_else(|| Error::new(Status::GenericFailure, "Get raw this failed".to_owned()))?;
    let raw_args = args
      .iter()
      .map(|arg| unsafe { arg.raw() })
      .collect::<Vec<sys::napi_value>>();
    let mut return_value = ptr::null_mut();
    check_pending_exception!(self.0.env, unsafe {
      sys::napi_call_function(
        self.0.env,
        raw_this,
        self.0.value,
        args.len(),
        raw_args.as_ptr(),
        &mut return_value,
      )
    })?;

    Ok(unsafe { Unknown::from_raw_unchecked(self.0.env, return_value) })
  }

  /// [napi_call_function](https://nodejs.org/api/n-api.html#n_api_napi_call_function)
  /// The same with `call`, but without arguments
  pub fn call_without_args(&self, this: Option<&JsObject>) -> Result<Unknown<'_>> {
    let raw_this = this
      .map(|v| unsafe { v.raw() })
      .or_else(|| unsafe { ToNapiValue::to_napi_value(self.0.env, ()) }.ok())
      .ok_or_else(|| Error::new(Status::GenericFailure, "Get raw this failed".to_owned()))?;
    let mut return_value = ptr::null_mut();
    check_pending_exception!(self.0.env, unsafe {
      sys::napi_call_function(
        self.0.env,
        raw_this,
        self.0.value,
        0,
        ptr::null_mut(),
        &mut return_value,
      )
    })?;

    Ok(unsafe { Unknown::from_raw_unchecked(self.0.env, return_value) })
  }

  /// <https://nodejs.org/api/n-api.html#n_api_napi_new_instance>
  ///
  /// This method is used to instantiate a new `JavaScript` value using a given `JsFunction` that represents the constructor for the object.
  pub fn new_instance<V>(&self, args: &[V]) -> Result<JsObject>
  where
    V: NapiRaw,
  {
    let mut js_instance = ptr::null_mut();
    let length = args.len();
    let raw_args = args
      .iter()
      .map(|arg| unsafe { arg.raw() })
      .collect::<Vec<sys::napi_value>>();
    check_pending_exception!(self.0.env, unsafe {
      sys::napi_new_instance(
        self.0.env,
        self.0.value,
        length,
        raw_args.as_ptr(),
        &mut js_instance,
      )
    })?;
    Ok(unsafe { JsObject::from_raw_unchecked(self.0.env, js_instance) })
  }

  /// function name
  pub fn name(&self) -> Result<String> {
    let mut name = ptr::null_mut();
    check_pending_exception!(self.0.env, unsafe {
      sys::napi_get_named_property(self.0.env, self.0.value, c"name".as_ptr().cast(), &mut name)
    })?;
    let name_value = unsafe { JsString::from_napi_value(self.0.env, name) }?;
    Ok(name_value.into_utf8()?.as_str()?.to_owned())
  }

  #[cfg(feature = "napi4")]
  pub fn create_threadsafe_function<
    T,
    NewArgs,
    Return,
    ErrorStatus,
    F,
    const ES: bool,
    const Weak: bool,
    const MaxQueueSize: usize,
  >(
    &self,
    callback: F,
  ) -> Result<ThreadsafeFunction<T, Return, NewArgs, ErrorStatus, ES, Weak, MaxQueueSize>>
  where
    T: 'static,
    NewArgs: 'static + JsValuesTupleIntoVec,
    Return: crate::bindgen_runtime::FromNapiValue,
    F: 'static + Send + FnMut(ThreadsafeCallContext<T>) -> Result<NewArgs>,
    ErrorStatus: AsRef<str> + From<Status>,
  {
    ThreadsafeFunction::<T, Return, NewArgs, ErrorStatus, ES, Weak, MaxQueueSize>::create(
      self.0.env,
      self.0.value,
      callback,
    )
  }
}
