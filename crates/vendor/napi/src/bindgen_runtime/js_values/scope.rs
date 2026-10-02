use std::ptr;

use crate::{bindgen_runtime::FromNapiValue, check_status, sys, Env, JsValue, Result};

pub struct HandleScope {
  pub(crate) scope: sys::napi_handle_scope,
}

impl HandleScope {
  pub fn create(env: &Env) -> Result<Self> {
    let mut scope = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_open_handle_scope(env.0, &mut scope) },
      "Failed to open handle scope"
    )?;
    Ok(Self { scope })
  }

  /// # Safety
  ///
  /// This function is unsafe because it will invalidate the JsValue created within the HandleScope.
  ///
  /// For example:
  ///
  /// ```no_run
  /// #[napi]
  /// pub fn shorter_scope(env: &Env, arr: Array) -> Result<Vec<u32>> {
  ///   let len = arr.len();
  ///   let mut result = Vec::with_capacity(len as usize);
  ///   for i in 0..len {
  ///     let scope = HandleScope::create(env)?;
  ///     let value: Unknown = arr.get_element(i)?;
  ///         ^^^ this will be invalidated after the scope is closed
  ///     let len = unsafe { scope.close(value, |v| match v.get_type()? {
  ///       ValueType::String => Ok(v.utf8_len()? as u32),
  ///       _ => Ok(0),
  ///     })? };
  ///   }
  /// }
  /// ```
  pub unsafe fn close<A, T>(self, arg: A, f: impl FnOnce(A) -> Result<T>) -> Result<T>
  where
    A: JsValuesTuple,
  {
    let env = arg.env();
    let ret = f(arg);
    check_status!(
      unsafe { sys::napi_close_handle_scope(env, self.scope) },
      "Failed to close handle scope"
    )?;
    ret
  }
}

pub struct EscapableHandleScope<'env> {
  pub(crate) scope: sys::napi_escapable_handle_scope,
  pub(crate) env: sys::napi_env,
  pub(crate) phantom: std::marker::PhantomData<&'env ()>,
}

impl<'env, 'scope: 'env> EscapableHandleScope<'scope> {
  pub fn with<
    T,
    Args: JsValuesTuple,
    F: 'env + FnOnce(EscapableHandleScope<'env>, Args) -> Result<T>,
  >(
    env: &'env Env,
    args: Args,
    scope_fn: F,
  ) -> Result<T> {
    let mut scope = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_open_escapable_handle_scope(env.0, &mut scope) },
      "Failed to open handle scope"
    )?;
    let scope: EscapableHandleScope<'env> = Self {
      scope,
      env: env.0,
      phantom: std::marker::PhantomData,
    };
    scope_fn(scope, args)
  }

  pub fn escape<V: JsValue<'env> + FromNapiValue>(&self, value: V) -> Result<V> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_escape_handle(self.env, self.scope, value.raw(), &mut result) },
      "Failed to escape handle"
    )?;
    unsafe { V::from_napi_value(self.env, result) }
  }
}

impl Drop for EscapableHandleScope<'_> {
  fn drop(&mut self) {
    let status = unsafe { sys::napi_close_escapable_handle_scope(self.env, self.scope) };
    if status != sys::Status::napi_ok {
      panic!(
        "Failed to close handle scope: {}",
        crate::Status::from(status)
      );
    }
  }
}

pub trait JsValuesTuple {
  fn env(&self) -> sys::napi_env;
}

impl<'env, T: JsValue<'env>> JsValuesTuple for T {
  fn env(&self) -> sys::napi_env {
    self.value().env
  }
}

impl<'env, T1: JsValue<'env>, T2: JsValue<'env>> JsValuesTuple for (T1, T2) {
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<'env, T1: JsValue<'env>, T2: JsValue<'env>, T3: JsValue<'env>> JsValuesTuple for (T1, T2, T3) {
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<'env, T1: JsValue<'env>, T2: JsValue<'env>, T3: JsValue<'env>, T4: JsValue<'env>> JsValuesTuple
  for (T1, T2, T3, T4)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
    T7: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6, T7)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
    T7: JsValue<'env>,
    T8: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6, T7, T8)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
    T7: JsValue<'env>,
    T8: JsValue<'env>,
    T9: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6, T7, T8, T9)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
    T7: JsValue<'env>,
    T8: JsValue<'env>,
    T9: JsValue<'env>,
    T10: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6, T7, T8, T9, T10)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
    T7: JsValue<'env>,
    T8: JsValue<'env>,
    T9: JsValue<'env>,
    T10: JsValue<'env>,
    T11: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}

impl<
    'env,
    T1: JsValue<'env>,
    T2: JsValue<'env>,
    T3: JsValue<'env>,
    T4: JsValue<'env>,
    T5: JsValue<'env>,
    T6: JsValue<'env>,
    T7: JsValue<'env>,
    T8: JsValue<'env>,
    T9: JsValue<'env>,
    T10: JsValue<'env>,
    T11: JsValue<'env>,
    T12: JsValue<'env>,
  > JsValuesTuple for (T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12)
{
  fn env(&self) -> sys::napi_env {
    self.0.value().env
  }
}
