use super::*;
use crate::bindgen_runtime::{FnArgs, FromNapiValue, Function, Unknown};

pub struct JsGlobal<'env>(
  pub(crate) Value,
  pub(crate) std::marker::PhantomData<&'env ()>,
);

impl FromNapiValue for JsGlobal<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JsGlobal(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Object,
      },
      std::marker::PhantomData,
    ))
  }
}

impl<'env> JsValue<'env> for JsGlobal<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl<'env> JsObjectValue<'env> for JsGlobal<'env> {}

pub struct JsTimeout<'env>(
  pub(crate) Value,
  pub(crate) std::marker::PhantomData<&'env ()>,
);

impl<'env> JsValue<'env> for JsTimeout<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl<'env> JsObjectValue<'env> for JsTimeout<'env> {}

impl FromNapiValue for JsTimeout<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JsTimeout(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Object,
      },
      std::marker::PhantomData,
    ))
  }
}
pub struct JSON<'env>(
  pub(crate) Value,
  pub(crate) std::marker::PhantomData<&'env ()>,
);

impl<'env> JsValue<'env> for JSON<'env> {
  fn value(&self) -> Value {
    self.0
  }
}

impl<'env> JsObjectValue<'env> for JSON<'env> {}

impl FromNapiValue for JSON<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    Ok(JSON(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Object,
      },
      std::marker::PhantomData,
    ))
  }
}

impl JSON<'_> {
  pub fn stringify<V: ToNapiValue>(&self, value: V) -> Result<std::string::String> {
    let func: Function<V, std::string::String> = self.get_named_property_unchecked("stringify")?;
    func.call(value)
  }
}

type SupportType<'a> = Function<'a, FnArgs<(Function<'a, (), Unknown<'a>>, f64)>, JsTimeout<'a>>;

impl<'env> JsGlobal<'env> {
  pub fn set_interval(
    &self,
    handler: Function<(), Unknown>,
    interval: f64,
  ) -> Result<JsTimeout<'env>> {
    let func: SupportType = self.get_named_property_unchecked("setInterval")?;
    func.call(FnArgs {
      data: (handler, interval),
    })
  }

  pub fn clear_interval(&self, timer: JsTimeout) -> Result<()> {
    let func: Function<JsTimeout, ()> = self.get_named_property_unchecked("clearInterval")?;
    func.call(timer)
  }

  pub fn set_timeout(
    &self,
    handler: Function<(), Unknown>,
    interval: f64,
  ) -> Result<JsTimeout<'env>> {
    let func: SupportType = self.get_named_property_unchecked("setTimeout")?;
    func.call(FnArgs {
      data: (handler, interval),
    })
  }

  pub fn clear_timeout(&self, timer: JsTimeout) -> Result<()> {
    let func: Function<JsTimeout, ()> = self.get_named_property_unchecked("clearTimeout")?;
    func.call(timer)
  }
}
