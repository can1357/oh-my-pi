use std::{marker::PhantomData, ptr};

use crate::{
  bindgen_prelude::{
    FromNapiValue, Function, JsObjectValue, PromiseRaw, ToNapiValue, TypeName, ValidateNapiValue,
  },
  check_status, sys, Env, Error, JsValue, Result, Status, Value, ValueType,
};

pub struct WriteableStream<'env> {
  pub(crate) value: sys::napi_value,
  pub(crate) env: sys::napi_env,
  pub(crate) _scope: &'env PhantomData<()>,
}

impl<'env> JsValue<'env> for WriteableStream<'env> {
  fn value(&self) -> Value {
    Value {
      env: self.env,
      value: self.value,
      value_type: ValueType::Object,
    }
  }
}

impl<'env> JsObjectValue<'env> for WriteableStream<'env> {}

impl TypeName for WriteableStream<'_> {
  fn type_name() -> &'static str {
    "WriteableStream"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl ValidateNapiValue for WriteableStream<'_> {
  unsafe fn validate(
    env: napi_sys::napi_env,
    napi_val: napi_sys::napi_value,
  ) -> Result<napi_sys::napi_value> {
    let constructor = Env::from(env)
      .get_global()?
      .get_named_property_unchecked::<Function>("WritableStream")?;
    let mut is_instance = false;
    check_status!(
      unsafe { sys::napi_instanceof(env, napi_val, constructor.value, &mut is_instance) },
      "Check WritableStream instance failed"
    )?;
    if !is_instance {
      return Err(Error::new(
        Status::InvalidArg,
        "Value is not a WritableStream",
      ));
    }
    Ok(ptr::null_mut())
  }
}

impl FromNapiValue for WriteableStream<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(Self {
      value: napi_val,
      env,
      _scope: &PhantomData,
    })
  }
}

impl WriteableStream<'_> {
  pub fn ready(&self) -> Result<PromiseRaw<'_, ()>> {
    let mut promise = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(self.env, self.value, c"ready".as_ptr().cast(), &mut promise)
      },
      "Get ready property failed"
    )?;
    Ok(PromiseRaw::new(self.env, promise))
  }

  /// The `abort()` method of the `WritableStream` interface aborts the stream,
  /// signaling that the producer can no longer successfully write to the stream and it is to be immediately moved to an error state,
  /// with any queued writes discarded.
  pub fn abort(&mut self, reason: String) -> Result<PromiseRaw<'_, ()>> {
    let mut abort_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          self.value,
          c"abort".as_ptr().cast(),
          &mut abort_fn,
        )
      },
      "Get abort property failed"
    )?;
    let reason_value = unsafe { ToNapiValue::to_napi_value(self.env, reason)? };
    let mut promise = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_call_function(
          self.env,
          self.value,
          abort_fn,
          1,
          [reason_value].as_ptr(),
          &mut promise,
        )
      },
      "Call abort function failed"
    )?;
    Ok(PromiseRaw::new(self.env, promise))
  }

  /// The `close()` method of the `WritableStream` interface closes the associated stream.
  ///
  /// All chunks written before this method is called are sent before the returned promise is fulfilled.
  pub fn close(&mut self) -> Result<PromiseRaw<'_, ()>> {
    let mut close_fn = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_get_named_property(
          self.env,
          self.value,
          c"close".as_ptr().cast(),
          &mut close_fn,
        )
      },
      "Get close property failed"
    )?;
    let mut promise = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_call_function(
          self.env,
          self.value,
          close_fn,
          0,
          ptr::null_mut(),
          &mut promise,
        )
      },
      "Call close function failed"
    )?;
    Ok(PromiseRaw::new(self.env, promise))
  }
}
