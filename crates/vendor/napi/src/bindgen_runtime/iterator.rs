use std::ffi::{c_void, CStr};
use std::ptr;

use crate::Value;
use crate::{bindgen_runtime::Unknown, check_status, check_status_or_throw, sys, Env, JsError};

use super::{FromNapiValue, ToNapiValue};

const GENERATOR_STATE_KEY: &CStr = c"[[GeneratorState]]";

/// Implement a Iterator for the JavaScript Class.
/// This feature is an experimental feature and is not yet stable.
pub trait Generator {
  type Yield: ToNapiValue;
  type Next: FromNapiValue;
  type Return: FromNapiValue;

  /// Handle the `Generator.next()`
  /// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/next>
  fn next(&mut self, value: Option<Self::Next>) -> Option<Self::Yield>;

  #[allow(unused_variables)]
  /// Implement complete to handle the `Generator.return()`
  /// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/return>
  fn complete(&mut self, value: Option<Self::Return>) -> Option<Self::Yield> {
    None
  }

  #[allow(unused_variables)]
  /// Implement catch to handle the `Generator.throw()`
  /// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/throw>
  fn catch<'env>(
    &'env mut self,
    env: Env,
    value: Unknown<'env>,
  ) -> Result<Option<Self::Yield>, Unknown<'env>> {
    Err(value)
  }
}

impl<'env, T: Generator + 'env> ScopedGenerator<'env> for T {
  type Yield = T::Yield;
  type Next = T::Next;
  type Return = T::Return;

  fn next(&mut self, _: &'env Env, value: Option<Self::Next>) -> Option<Self::Yield> {
    T::next(self, value)
  }

  fn complete(&mut self, value: Option<Self::Return>) -> Option<Self::Yield> {
    T::complete(self, value)
  }

  fn catch(
    &'env mut self,
    env: &'env Env,
    value: Unknown<'env>,
  ) -> Result<Option<Self::Yield>, Unknown<'env>> {
    T::catch(self, Env::from_raw(env.0), value)
  }
}

pub trait ScopedGenerator<'env> {
  type Yield: ToNapiValue + 'env;
  type Next: FromNapiValue;
  type Return: FromNapiValue;

  /// Handle the `Generator.next()`
  /// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/next>
  fn next(&mut self, env: &'env Env, value: Option<Self::Next>) -> Option<Self::Yield>;

  #[allow(unused_variables)]
  /// Implement complete to handle the `Generator.return()`
  /// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/return>
  fn complete(&mut self, value: Option<Self::Return>) -> Option<Self::Yield> {
    None
  }

  #[allow(unused_variables)]
  /// Implement catch to handle the `Generator.throw()`
  /// <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Generator/throw>
  fn catch(
    &'env mut self,
    env: &'env Env,
    value: Unknown<'env>,
  ) -> Result<Option<Self::Yield>, Unknown<'env>> {
    Err(value)
  }
}

#[doc(hidden)]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub unsafe fn setup_iterator_class(env: sys::napi_env, class_ctor: sys::napi_value) {
  let mut global = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_global(env, &mut global),
    "Get global object failed",
  );

  let mut iterator_ctor = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(env, global, c"Iterator".as_ptr().cast(), &mut iterator_ctor,),
    "Get Global.Iterator failed",
  );

  let mut iterator_ctor_type = 0;
  check_status_or_throw!(
    env,
    sys::napi_typeof(env, iterator_ctor, &mut iterator_ctor_type),
    "Get Global.Iterator type failed",
  );

  if iterator_ctor_type != sys::ValueType::napi_function {
    return;
  }

  let mut class_proto = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(
      env,
      class_ctor,
      c"prototype".as_ptr().cast(),
      &mut class_proto,
    ),
    "Failed to get class prototype",
  );

  let mut iterator_proto = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(
      env,
      iterator_ctor,
      c"prototype".as_ptr().cast(),
      &mut iterator_proto,
    ),
    "Failed to get Iterator.prototype",
  );

  let mut class_proto_parent = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_prototype(env, class_proto, &mut class_proto_parent),
    "Failed to get class prototype parent",
  );

  let mut already_inherits_iterator = false;
  check_status_or_throw!(
    env,
    sys::napi_strict_equals(
      env,
      class_proto_parent,
      iterator_proto,
      &mut already_inherits_iterator,
    ),
    "Failed to compare class prototype parent",
  );

  if already_inherits_iterator {
    return;
  }

  let mut object_ctor = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(env, global, c"Object".as_ptr().cast(), &mut object_ctor),
    "Failed to get Object constructor"
  );

  let mut set_prototype_function = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(
      env,
      object_ctor,
      c"setPrototypeOf".as_ptr().cast(),
      &mut set_prototype_function,
    ),
    "Failed to get Object.setPrototypeOf"
  );

  let mut argv = [class_proto, iterator_proto];
  check_status_or_throw!(
    env,
    sys::napi_call_function(
      env,
      object_ctor,
      set_prototype_function,
      2,
      argv.as_mut_ptr(),
      ptr::null_mut(),
    ),
    "Failed to set prototype on object"
  );
}

#[doc(hidden)]
#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub unsafe fn create_iterator<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  instance: sys::napi_value,
  generator_ptr: *mut T,
) {
  let mut global = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_global(env, &mut global),
    "Get global object failed",
  );

  let mut symbol_object = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(env, global, c"Symbol".as_ptr().cast(), &mut symbol_object),
    "Get global object failed",
  );

  let mut iterator_symbol = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_named_property(
      env,
      symbol_object,
      c"iterator".as_ptr().cast(),
      &mut iterator_symbol,
    ),
    "Get Symbol.iterator failed",
  );

  let mut next_function = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_create_function(
      env,
      c"next".as_ptr().cast(),
      4,
      Some(generator_next::<T>),
      generator_ptr as *mut c_void,
      &mut next_function,
    ),
    "Create next function failed"
  );

  let mut return_function = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_create_function(
      env,
      c"return".as_ptr().cast(),
      6,
      Some(generator_return::<T>),
      generator_ptr as *mut c_void,
      &mut return_function,
    ),
    "Create return function failed"
  );

  let mut throw_function = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_create_function(
      env,
      c"throw".as_ptr().cast(),
      5,
      Some(generator_throw::<T>),
      generator_ptr as *mut c_void,
      &mut throw_function,
    ),
    "Create throw function failed"
  );

  check_status_or_throw!(
    env,
    sys::napi_set_named_property(env, instance, c"next".as_ptr().cast(), next_function,),
    "Set next function on Generator object failed"
  );

  check_status_or_throw!(
    env,
    sys::napi_set_named_property(env, instance, c"return".as_ptr().cast(), return_function),
    "Set return function on Generator object failed"
  );

  check_status_or_throw!(
    env,
    sys::napi_set_named_property(env, instance, c"throw".as_ptr().cast(), throw_function),
    "Set throw function on Generator object failed"
  );

  let mut generator_state = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_get_boolean(env, false, &mut generator_state),
    "Create generator state failed"
  );

  let properties = [sys::napi_property_descriptor {
    utf8name: GENERATOR_STATE_KEY.as_ptr().cast(),
    name: ptr::null_mut(),
    method: None,
    getter: None,
    setter: None,
    value: generator_state,
    attributes: sys::PropertyAttributes::writable,
    data: ptr::null_mut(),
  }];

  check_status_or_throw!(
    env,
    sys::napi_define_properties(env, instance, 1, properties.as_ptr()),
    "Define properties on Generator object failed"
  );

  let mut generator_function = ptr::null_mut();
  check_status_or_throw!(
    env,
    sys::napi_create_function(
      env,
      c"Iterator".as_ptr().cast(),
      8,
      Some(symbol_generator::<T>),
      generator_ptr as *mut c_void,
      &mut generator_function,
    ),
    "Create iterator function failed",
  );

  check_status_or_throw!(
    env,
    sys::napi_set_property(env, instance, iterator_symbol, generator_function),
    "Failed to set Symbol.iterator on class instance",
  );
}

#[doc(hidden)]
pub unsafe extern "C" fn symbol_generator<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut this = ptr::null_mut();
  let mut argv: [sys::napi_value; 1] = [ptr::null_mut()];
  let mut argc = 0;
  let mut generator_ptr = ptr::null_mut();
  check_status_or_throw!(
    env,
    unsafe {
      sys::napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        &mut this,
        &mut generator_ptr,
      )
    },
    "Get callback info from generator function failed"
  );

  this
}

fn throw_generator_error(env: sys::napi_env, err: crate::Error) -> sys::napi_value {
  unsafe {
    let js_error: JsError = err.into();
    js_error.throw_into(env);
  }
  ptr::null_mut()
}

extern "C" fn generator_next<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let _napi_native_borrow_barrier = crate::bindgen_runtime::NativeBorrowBarrier::new();
  match generator_next_fn::<'a, T>(env, info) {
    Ok(value) => value,
    Err(e) => throw_generator_error(env, e),
  }
}

fn generator_next_fn<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> crate::Result<sys::napi_value> {
  let mut this = ptr::null_mut();
  let mut argv: [sys::napi_value; 1] = [ptr::null_mut()];
  let mut argc = 1;
  let mut generator_ptr = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        &mut this,
        &mut generator_ptr,
      )
    },
    "Get callback info from generator function failed"
  )?;
  let mut generator_state = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_get_named_property(
        env,
        this,
        GENERATOR_STATE_KEY.as_ptr().cast(),
        &mut generator_state,
      )
    },
    "Get generator state failed"
  )?;
  let mut completed = false;
  check_status!(
    unsafe { sys::napi_get_value_bool(env, generator_state, &mut completed) },
    "Get generator state failed"
  )?;
  let mut result = std::ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_object(env, &mut result) },
    "Failed to create iterator result object",
  )?;
  if !completed {
    let input = if argc == 0 {
      None
    } else {
      Some(unsafe { T::Next::from_napi_value(env, argv[0]) }?)
    };
    let g = unsafe { Box::leak(Box::from_raw(generator_ptr as *mut T)) };
    let env_ref = Env::from_raw(env);
    let item = g.next(
      // SAFETY: `Env` is long lived
      unsafe { std::mem::transmute::<&Env, &'a Env>(&env_ref) },
      input,
    );

    if let Some(value) = item {
      set_generator_value(env, result, value)?;
    } else {
      completed = true;
    }
  }
  let mut completed_value = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_get_boolean(env, completed, &mut completed_value) },
    "Failed to create completed value"
  )?;
  check_status!(
    unsafe { sys::napi_set_named_property(env, result, c"done".as_ptr().cast(), completed_value) },
    "Failed to set iterator result done",
  )?;

  Ok(result)
}

extern "C" fn generator_return<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let _napi_native_borrow_barrier = crate::bindgen_runtime::NativeBorrowBarrier::new();
  match generator_return_fn::<'a, T>(env, info) {
    Ok(value) => value,
    Err(e) => throw_generator_error(env, e),
  }
}

fn generator_return_fn<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> crate::Result<sys::napi_value> {
  let mut this = ptr::null_mut();
  let mut argv: [sys::napi_value; 1] = [ptr::null_mut()];
  let mut argc = 1;
  let mut generator_ptr = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        &mut this,
        &mut generator_ptr,
      )
    },
    "Get callback info from generator function failed"
  )?;

  let input = if argc == 0 {
    None
  } else {
    Some(unsafe { T::Return::from_napi_value(env, argv[0]) }?)
  };
  let g = unsafe { Box::leak(Box::from_raw(generator_ptr as *mut T)) };
  g.complete(input);

  let mut generator_state = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_get_boolean(env, true, &mut generator_state) },
    "Create generator state failed"
  )?;
  check_status!(
    unsafe {
      sys::napi_set_named_property(
        env,
        this,
        GENERATOR_STATE_KEY.as_ptr().cast(),
        generator_state,
      )
    },
    "Get generator state failed"
  )?;
  let mut result = std::ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_object(env, &mut result) },
    "Failed to create iterator result object",
  )?;
  if argc > 0 {
    check_status!(
      unsafe { sys::napi_set_named_property(env, result, c"value".as_ptr().cast(), argv[0]) },
      "Failed to set iterator result value",
    )?;
  }
  check_status!(
    unsafe {
      sys::napi_set_named_property(
        env,
        result,
        c"done".as_ptr() as *const std::os::raw::c_char,
        generator_state,
      )
    },
    "Failed to set iterator result done",
  )?;

  Ok(result)
}

extern "C" fn generator_throw<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let _napi_native_borrow_barrier = crate::bindgen_runtime::NativeBorrowBarrier::new();
  match generator_throw_fn::<'a, T>(env, info) {
    Ok(value) => value,
    Err(e) => throw_generator_error(env, e),
  }
}

fn generator_throw_fn<'a, T: ScopedGenerator<'a> + 'a>(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> crate::Result<sys::napi_value> {
  let mut this = ptr::null_mut();
  let mut argv: [sys::napi_value; 1] = [ptr::null_mut()];
  let mut argc = 1;
  let mut generator_ptr = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_get_cb_info(
        env,
        info,
        &mut argc,
        argv.as_mut_ptr(),
        &mut this,
        &mut generator_ptr,
      )
    },
    "Get callback info from generator function failed"
  )?;

  let arg = if argc == 0 {
    let mut undefined = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_get_undefined(env, &mut undefined) },
      "Get undefined failed"
    )?;
    Unknown(
      Value {
        env,
        value: undefined,
        value_type: crate::ValueType::Unknown,
      },
      std::marker::PhantomData,
    )
  } else {
    Unknown(
      Value {
        env,
        value: argv[0],
        value_type: crate::ValueType::Unknown,
      },
      std::marker::PhantomData,
    )
  };
  let g = unsafe { Box::leak(Box::from_raw(generator_ptr as *mut T)) };
  let env_ref = Env::from_raw(env);
  let catch_result = g.catch(
    // SAFETY: `Env` is long lived
    unsafe { std::mem::transmute::<&Env, &'a Env>(&env_ref) },
    arg,
  );
  let mut generator_state = ptr::null_mut();
  let mut generator_state_value = false;
  let mut result = ptr::null_mut();
  match catch_result {
    Err(e) => {
      let mut is_pending = false;
      check_status!(
        unsafe { sys::napi_is_exception_pending(env, &mut is_pending) },
        "Failed to check pending exception"
      )?;
      let exception_to_throw = if is_pending {
        let mut pending_exception = ptr::null_mut();
        check_status!(
          unsafe { sys::napi_get_and_clear_last_exception(env, &mut pending_exception) },
          "Failed to get pending exception"
        )?;
        pending_exception
      } else {
        e.0.value
      };

      // Mark the generator completed while no exception is pending so subsequent
      // `next()` calls do not invoke the Rust generator again.
      let state_set = if unsafe { sys::napi_get_boolean(env, true, &mut generator_state) }
        == sys::Status::napi_ok
      {
        unsafe {
          sys::napi_set_named_property(
            env,
            this,
            GENERATOR_STATE_KEY.as_ptr().cast(),
            generator_state,
          )
        }
      } else {
        sys::Status::napi_generic_failure
      };

      if !is_pending && state_set != sys::Status::napi_ok {
        return Err(crate::Error::new(
          crate::Status::from(state_set),
          "Get generator state failed".to_owned(),
        ));
      }

      // If `set_named_property` itself threw while restoring an already-pending
      // exception, clear the secondary exception so the original one wins.
      if is_pending && state_set != sys::Status::napi_ok {
        let mut ignored = ptr::null_mut();
        let _ = unsafe { sys::napi_get_and_clear_last_exception(env, &mut ignored) };
      }

      let throw_status = unsafe { sys::napi_throw(env, exception_to_throw) };
      if throw_status != sys::Status::napi_ok
        && throw_status != sys::Status::napi_pending_exception
        && throw_status != sys::Status::napi_cannot_run_js
      {
        return Err(crate::Error::new(
          crate::Status::from(throw_status),
          "Failed to throw error".to_owned(),
        ));
      }
      return Ok(ptr::null_mut());
    }
    Ok(Some(v)) => {
      check_status!(
        unsafe { sys::napi_create_object(env, &mut result) },
        "Failed to create iterator result object",
      )?;
      set_generator_value(env, result, v)?;
    }
    Ok(None) => {
      check_status!(
        unsafe { sys::napi_create_object(env, &mut result) },
        "Failed to create iterator result object",
      )?;
      generator_state_value = true;
    }
  }
  check_status!(
    unsafe { sys::napi_get_boolean(env, generator_state_value, &mut generator_state) },
    "Create generator state failed"
  )?;
  check_status!(
    unsafe {
      sys::napi_set_named_property(
        env,
        this,
        GENERATOR_STATE_KEY.as_ptr().cast(),
        generator_state,
      )
    },
    "Get generator state failed"
  )?;
  check_status!(
    unsafe { sys::napi_set_named_property(env, result, c"done".as_ptr().cast(), generator_state) },
    "Get generator state failed"
  )?;

  Ok(result)
}

fn set_generator_value<V: ToNapiValue>(
  env: sys::napi_env,
  result: sys::napi_value,
  value: V,
) -> crate::Result<()> {
  let val = unsafe { ToNapiValue::to_napi_value(env, value)? };
  check_status!(
    unsafe { sys::napi_set_named_property(env, result, c"value".as_ptr().cast(), val) },
    "Failed to set iterator result value",
  )
}
