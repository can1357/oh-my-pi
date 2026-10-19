use std::{marker::PhantomData, ptr};

use serde_json::{Map, Number, Value};

use crate::{
  bindgen_runtime::{Array, Null, Object},
  check_status, sys, type_of, Env, Error, Result, Status, ValueType,
};

#[cfg(feature = "napi6")]
use super::BigInt;
use super::{FromNapiValue, ToNapiValue};

/// Maximum nesting depth allowed when converting between `serde_json::Value`
/// and JavaScript values. Mirrors `serde_json`'s default recursion limit so a
/// cyclic or deeply nested value fails with a catchable error instead of
/// overflowing the native stack.
const MAX_JSON_DEPTH: u32 = 128;

/// Maximum number of `serde_json::Value` nodes produced or consumed by a
/// single conversion. A depth limit alone cannot stop a shared-object DAG —
/// `{a: o, b: o}` nested 60 deep stays under 128 levels but expands to ~2^60
/// traversals — so the total work is budgeted too.
const MAX_JSON_NODES: usize = 1_000_000;

fn max_json_depth_error() -> Error {
  Error::new(
    Status::InvalidArg,
    "Exceeded maximum JSON nesting depth".to_owned(),
  )
}

fn max_json_nodes_error() -> Error {
  Error::new(
    Status::InvalidArg,
    "Exceeded maximum JSON value count".to_owned(),
  )
}

fn consume_json_node(remaining_nodes: &mut usize) -> Result<()> {
  if *remaining_nodes == 0 {
    return Err(max_json_nodes_error());
  }
  *remaining_nodes -= 1;
  Ok(())
}

impl ToNapiValue for &Value {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut remaining_nodes = MAX_JSON_NODES;
    unsafe { value_to_napi_value(env, val, MAX_JSON_DEPTH, &mut remaining_nodes) }
  }
}

unsafe fn value_to_napi_value(
  env: sys::napi_env,
  val: &Value,
  remaining_depth: u32,
  remaining_nodes: &mut usize,
) -> Result<sys::napi_value> {
  consume_json_node(remaining_nodes)?;
  match val {
    Value::Null => unsafe { Null::to_napi_value(env, Null) },
    Value::Bool(b) => unsafe { ToNapiValue::to_napi_value(env, b) },
    Value::Number(n) => unsafe { ToNapiValue::to_napi_value(env, n) },
    Value::String(s) => unsafe { ToNapiValue::to_napi_value(env, s) },
    Value::Array(arr) => {
      if remaining_depth == 0 {
        return Err(max_json_depth_error());
      }
      let js_arr = Array::new(env, arr.len() as u32)?;
      for (index, element) in arr.iter().enumerate() {
        let napi_val =
          unsafe { value_to_napi_value(env, element, remaining_depth - 1, remaining_nodes)? };
        check_status!(
          unsafe { sys::napi_set_element(env, js_arr.inner, index as u32, napi_val) },
          "Failed to set element with index `{}`",
          index,
        )?;
      }
      Ok(js_arr.inner)
    }
    Value::Object(obj) => {
      if remaining_depth == 0 {
        return Err(max_json_depth_error());
      }
      unsafe { map_to_napi_value(env, obj, remaining_depth, remaining_nodes) }
    }
  }
}

unsafe fn map_to_napi_value(
  env: sys::napi_env,
  val: &Map<String, Value>,
  remaining_depth: u32,
  remaining_nodes: &mut usize,
) -> Result<sys::napi_value> {
  let obj = Object::new(&Env::from(env))?;

  for (k, v) in val.iter() {
    let napi_val = unsafe { value_to_napi_value(env, v, remaining_depth - 1, remaining_nodes)? };
    let mut property_key = ptr::null_mut();
    check_status!(
      unsafe {
        sys::napi_create_string_utf8(env, k.as_ptr().cast(), k.len() as isize, &mut property_key)
      },
      "Failed to create property key with `{k}`"
    )?;
    check_status!(
      unsafe { sys::napi_set_property(env, obj.0.value, property_key, napi_val) },
      "Failed to set property with field `{k}`"
    )?;
  }

  Ok(obj.0.value)
}

impl ToNapiValue for Value {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut val = std::mem::ManuallyDrop::new(val);
    let mut remaining_nodes = MAX_JSON_NODES;
    match unsafe { value_to_napi_value(env, &val, MAX_JSON_DEPTH, &mut remaining_nodes) } {
      Ok(v) => {
        // A converted Value never exceeds the depth budget, so the normal
        // recursive drop cannot overflow the stack.
        drop(unsafe { std::mem::ManuallyDrop::take(&mut val) });
        Ok(v)
      }
      Err(e) => {
        drop_serde_value_iteratively(unsafe { std::mem::ManuallyDrop::take(&mut val) });
        Err(e)
      }
    }
  }
}

/// Drain a `serde_json::Value` without recursive `Drop` glue, so an
/// iteratively-constructed tree deeper than the native stack does not
/// overflow while unwinding a failed conversion.
fn drop_serde_value_iteratively(root: Value) {
  let mut stack = vec![root];
  while let Some(value) = stack.pop() {
    match value {
      Value::Array(elements) => stack.extend(elements),
      Value::Object(map) => stack.extend(map.into_values()),
      _ => {}
    }
  }
}

impl FromNapiValue for Value {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut remaining_nodes = MAX_JSON_NODES;
    unsafe { value_from_napi_value(env, napi_val, MAX_JSON_DEPTH, &mut remaining_nodes) }
  }
}

unsafe fn value_from_napi_value(
  env: sys::napi_env,
  napi_val: sys::napi_value,
  remaining_depth: u32,
  remaining_nodes: &mut usize,
) -> Result<Value> {
  consume_json_node(remaining_nodes)?;
  let ty = type_of!(env, napi_val)?;
  let val = match ty {
    ValueType::Boolean => Value::Bool(unsafe { bool::from_napi_value(env, napi_val)? }),
    ValueType::Number => Value::Number(unsafe { Number::from_napi_value(env, napi_val)? }),
    ValueType::String => Value::String(unsafe { String::from_napi_value(env, napi_val)? }),
    ValueType::Object => {
      if remaining_depth == 0 {
        return Err(max_json_depth_error());
      }
      let mut is_arr = false;
      check_status!(
        unsafe { sys::napi_is_array(env, napi_val, &mut is_arr) },
        "Failed to detect whether given js is an array"
      )?;

      if is_arr {
        let arr = unsafe { Array::from_napi_value(env, napi_val)? };
        let mut vec = Vec::with_capacity(arr.len() as usize);
        for i in 0..arr.len() {
          let mut element = ptr::null_mut();
          check_status!(
            unsafe { sys::napi_get_element(env, arr.inner, i, &mut element) },
            "Failed to get element with index `{}`",
            i,
          )?;
          vec.push(unsafe {
            value_from_napi_value(env, element, remaining_depth - 1, remaining_nodes)?
          });
        }
        Value::Array(vec)
      } else {
        Value::Object(unsafe {
          map_from_napi_value(env, napi_val, remaining_depth, remaining_nodes)?
        })
      }
    }
    #[cfg(feature = "napi6")]
    ValueType::BigInt => {
      let n = unsafe { BigInt::from_napi_value(env, napi_val)? };
      // negative
      if n.sign_bit {
        let (v, lossless) = n.get_i64();
        if lossless {
          Value::Number(v.into())
        } else {
          Value::String(to_string(env, napi_val)?)
        }
      } else {
        let (_, v, lossless) = n.get_u64();
        if lossless {
          Value::Number(v.into())
        } else {
          Value::String(to_string(env, napi_val)?)
        }
      }
    }
    ValueType::Null => Value::Null,
    ValueType::Function => {
      return Err(Error::new(
        Status::InvalidArg,
        "JS functions cannot be represented as a serde_json::Value".to_owned(),
      ))
    }
    ValueType::Undefined => {
      return Err(Error::new(
        Status::InvalidArg,
        "undefined cannot be represented as a serde_json::Value".to_owned(),
      ))
    }
    ValueType::Symbol => {
      return Err(Error::new(
        Status::InvalidArg,
        "JS symbols cannot be represented as a serde_json::Value".to_owned(),
      ))
    }
    ValueType::External => {
      return Err(Error::new(
        Status::InvalidArg,
        "External JS objects cannot be represented as a serde_json::Value".to_owned(),
      ))
    }
    _ => {
      return Err(Error::new(
        Status::InvalidArg,
        "Unknown JS variables cannot be represented as a serde_json::Value".to_owned(),
      ))
    }
  };

  Ok(val)
}

unsafe fn map_from_napi_value(
  env: sys::napi_env,
  napi_val: sys::napi_value,
  remaining_depth: u32,
  remaining_nodes: &mut usize,
) -> Result<Map<String, Value>> {
  let obj = Object(
    crate::Value {
      env,
      value: napi_val,
      value_type: ValueType::Object,
    },
    PhantomData,
  );

  let mut map = Map::new();
  for key in Object::keys(&obj)?.into_iter() {
    if let Some(val) = obj.get_inner(&key)? {
      map.insert(key, unsafe {
        value_from_napi_value(env, val, remaining_depth - 1, remaining_nodes)?
      });
    }
  }

  Ok(map)
}

#[cfg(feature = "napi6")]
fn to_string(env: sys::napi_env, napi_val: sys::napi_value) -> Result<String> {
  let mut string = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_coerce_to_string(env, napi_val, &mut string) },
    "Failed to coerce to string"
  )?;
  let s = unsafe { String::from_napi_value(env, string) }?;
  Ok(s)
}

impl ToNapiValue for &Map<String, Value> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut remaining_nodes = MAX_JSON_NODES;
    consume_json_node(&mut remaining_nodes)?;
    unsafe { map_to_napi_value(env, val, MAX_JSON_DEPTH, &mut remaining_nodes) }
  }
}

impl ToNapiValue for Map<String, Value> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut val = std::mem::ManuallyDrop::new(val);
    let mut remaining_nodes = MAX_JSON_NODES;
    if let Err(e) = consume_json_node(&mut remaining_nodes) {
      drop_serde_value_iteratively(Value::Object(unsafe {
        std::mem::ManuallyDrop::take(&mut val)
      }));
      return Err(e);
    }
    match unsafe { map_to_napi_value(env, &val, MAX_JSON_DEPTH, &mut remaining_nodes) } {
      Ok(v) => {
        drop(unsafe { std::mem::ManuallyDrop::take(&mut val) });
        Ok(v)
      }
      Err(e) => {
        drop_serde_value_iteratively(Value::Object(unsafe {
          std::mem::ManuallyDrop::take(&mut val)
        }));
        Err(e)
      }
    }
  }
}

impl FromNapiValue for Map<String, Value> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut remaining_nodes = MAX_JSON_NODES;
    consume_json_node(&mut remaining_nodes)?;
    unsafe { map_from_napi_value(env, napi_val, MAX_JSON_DEPTH, &mut remaining_nodes) }
  }
}

impl ToNapiValue for &Number {
  unsafe fn to_napi_value(env: sys::napi_env, n: Self) -> Result<sys::napi_value> {
    #[cfg(feature = "napi6")]
    const MAX_SAFE_INT: i64 = 9007199254740991i64; // 2 ^ 53 - 1
    if n.is_i64() {
      let n = n.as_i64().unwrap();
      #[cfg(feature = "napi6")]
      {
        if !(-MAX_SAFE_INT..=MAX_SAFE_INT).contains(&n) {
          return unsafe { BigInt::to_napi_value(env, BigInt::from(n)) };
        }
      }

      unsafe { i64::to_napi_value(env, n) }
    } else if n.is_f64() {
      unsafe { f64::to_napi_value(env, n.as_f64().unwrap()) }
    } else {
      let n = n.as_u64().unwrap();
      if n > u32::MAX as u64 {
        #[cfg(feature = "napi6")]
        {
          unsafe { BigInt::to_napi_value(env, BigInt::from(n)) }
        }

        #[cfg(not(feature = "napi6"))]
        return unsafe { String::to_napi_value(env, n.to_string()) };
      } else {
        unsafe { u32::to_napi_value(env, n as u32) }
      }
    }
  }
}

impl ToNapiValue for Number {
  unsafe fn to_napi_value(env: sys::napi_env, n: Self) -> Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, &n)
  }
}

impl FromNapiValue for Number {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let n = unsafe { f64::from_napi_value(env, napi_val)? };
    // Try to auto-convert to integers
    let n = if n.trunc() == n {
      if n >= 0.0f64 && n <= u32::MAX as f64 {
        // This can be represented as u32
        Some(Number::from(n as u32))
      } else if n < 0.0f64 && n >= i32::MIN as f64 {
        Some(Number::from(n as i32))
      } else {
        // must be a float
        Number::from_f64(n)
      }
    } else {
      // must be a float
      Number::from_f64(n)
    };

    let n = n.ok_or_else(|| {
      Error::new(
        Status::InvalidArg,
        "Failed to convert js number to serde_json::Number".to_owned(),
      )
    })?;

    Ok(n)
  }
}
