use crate::{
  bindgen_runtime::{ToNapiValue, TypeName},
  Env, Error, Result,
};

pub trait Task: Send + Sized {
  type Output: Send + Sized + 'static;
  type JsValue: ToNapiValue + TypeName;

  /// Compute logic in libuv thread
  fn compute(&mut self) -> Result<Self::Output>;

  /// Into this method if `compute` return `Ok`
  fn resolve(&mut self, env: Env, output: Self::Output) -> Result<Self::JsValue>;

  #[allow(unused_variables)]
  /// Into this method if `compute` return `Err`
  fn reject(&mut self, env: Env, err: Error) -> Result<Self::JsValue> {
    Err(err)
  }

  #[allow(unused_variables)]
  /// after resolve or reject
  fn finally(self, env: Env) -> Result<()> {
    Ok(())
  }
}

impl<'a, T: Task> ScopedTask<'a> for T {
  type Output = T::Output;
  type JsValue = T::JsValue;

  fn compute(&mut self) -> Result<Self::Output> {
    T::compute(self)
  }

  fn resolve(&mut self, env: &'a Env, output: Self::Output) -> Result<Self::JsValue> {
    T::resolve(self, Env::from_raw(env.raw()), output)
  }

  fn reject(&mut self, env: &'a Env, err: Error) -> Result<Self::JsValue> {
    T::reject(self, Env::from_raw(env.raw()), err)
  }

  fn finally(self, env: Env) -> Result<()> {
    T::finally(self, env)
  }
}

/// Basically it's the same as the `Task` trait
///
/// The difference is it can be resolve or reject a `JsValue` with lifetime
pub trait ScopedTask<'task>: Send + Sized {
  type Output: Send + Sized + 'static;
  type JsValue: ToNapiValue + TypeName;

  /// Compute logic in libuv thread
  fn compute(&mut self) -> Result<Self::Output>;

  /// Into this method if `compute` return `Ok`
  fn resolve(&mut self, env: &'task Env, output: Self::Output) -> Result<Self::JsValue>;

  #[allow(unused_variables)]
  /// Into this method if `compute` return `Err`
  fn reject(&mut self, env: &'task Env, err: Error) -> Result<Self::JsValue> {
    Err(err)
  }

  #[allow(unused_variables)]
  /// after resolve or reject
  fn finally(self, env: Env) -> Result<()> {
    Ok(())
  }
}
