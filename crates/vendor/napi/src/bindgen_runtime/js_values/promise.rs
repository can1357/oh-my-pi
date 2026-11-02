use std::{
  cell::Cell,
  convert::identity,
  future,
  pin::Pin,
  rc::Rc,
  task::{Context, Poll},
};

use futures::channel::oneshot::{channel, Receiver};

use crate::{sys, Error, Result, Status};

use super::{CallbackContext, FromNapiValue, PromiseRaw, TypeName, Unknown, ValidateNapiValue};

/// The JavaScript Promise object representation
///
/// This `Promise<T>` can be awaited in the Rust
/// This `Promise<T>` can also be passed from `#[napi]` fn
///
/// example:
///
/// ```no_run
/// #[napi]
/// pub fn await_promise_in_rust(promise: Promise<u32>) {
///   let value = promise.await.unwrap();
///
///   println!("{value}");
/// }
/// ```
///
/// But this `Promise<T>` can not be pass back to `JavaScript`.
/// If you want to use raw JavaScript `Promise` API, you can use the [`PromiseRaw`](./PromiseRaw) instead.
pub struct Promise<T: 'static + FromNapiValue> {
  value: Pin<Box<Receiver<Result<T>>>>,
}

impl<T: FromNapiValue> TypeName for Promise<T> {
  fn type_name() -> &'static str {
    "Promise"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::Object
  }
}

impl<T: FromNapiValue> ValidateNapiValue for Promise<T> {
  unsafe fn validate(
    env: crate::sys::napi_env,
    napi_val: crate::sys::napi_value,
  ) -> Result<sys::napi_value> {
    use super::validate_promise;

    validate_promise(env, napi_val)
  }
}

unsafe impl<T: FromNapiValue + Send> Send for Promise<T> {}

impl<T: FromNapiValue> FromNapiValue for Promise<T> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> crate::Result<Self> {
    let (tx, rx) = channel();
    let promise_object = unsafe { PromiseRaw::<T>::from_napi_value(env, napi_val)? };
    let tx_box = Rc::new(Cell::new(Some(tx)));
    let tx_in_catch = tx_box.clone();
    promise_object
      .then(move |ctx| {
        if let Some(sender) = tx_box.replace(None) {
          // no need to handle the send error here, the receiver has been dropped
          let _ = sender.send(Ok(ctx.value));
        }
        Ok(())
      })?
      .catch(move |ctx: CallbackContext<Unknown>| {
        if let Some(sender) = tx_in_catch.replace(None) {
          // A promise may reject with *any* value, including primitives, so the
          // rejection reason is captured without coercing it — `From<Unknown>`
          // would fail outright on a primitive.
          // no need to handle the send error here, the receiver has been dropped
          let _ = sender.send(Err(Error::from_unknown_without_coercion(ctx.value)));
        }
        Ok(())
      })?;

    Ok(Promise {
      value: Box::pin(rx),
    })
  }
}

impl<T: FromNapiValue> future::Future for Promise<T> {
  type Output = Result<T>;

  fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
    match self.value.as_mut().poll(cx) {
      Poll::Pending => Poll::Pending,
      Poll::Ready(v) => Poll::Ready(
        v.map_err(|e| Error::new(Status::GenericFailure, format!("{e}")))
          .and_then(identity),
      ),
    }
  }
}
