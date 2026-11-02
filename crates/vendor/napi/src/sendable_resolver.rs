use crate::Result;
use napi_sys as sys;
use std::marker::PhantomData;

pub struct SendableResolver<
  Data: 'static + Send,
  R: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>,
> {
  inner: R,
  _data: PhantomData<Data>,
}

// the `SendableResolver` will be only called in the `threadsafe_function_call_js` callback
// which means it will be always called in the Node.js JavaScript thread
// so the inner function is not required to be `Send`
// but the `Send` bound is required by the `execute_tokio_future` function
unsafe impl<Data: 'static + Send, R: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>>
  Send for SendableResolver<Data, R>
{
}

impl<Data: 'static + Send, R: 'static + FnOnce(sys::napi_env, Data) -> Result<sys::napi_value>>
  SendableResolver<Data, R>
{
  pub fn new(inner: R) -> Self {
    Self {
      inner,
      _data: PhantomData,
    }
  }

  pub fn resolve(self, env: sys::napi_env, data: Data) -> Result<sys::napi_value> {
    (self.inner)(env, data)
  }
}
