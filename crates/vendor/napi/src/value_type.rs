use std::fmt::{Display, Formatter, Result};

use crate::sys;

#[repr(i32)]
#[derive(Copy, Clone, Debug, PartialEq, PartialOrd, Ord, Eq, Hash)]
pub enum ValueType {
  Undefined = 0,
  Null = 1,
  Boolean = 2,
  Number = 3,
  String = 4,
  Symbol = 5,
  Object = 6,
  Function = 7,
  External = 8,
  #[cfg(feature = "napi6")]
  BigInt = 9,
  Unknown = 1024,
}

impl Display for ValueType {
  fn fmt(&self, f: &mut Formatter<'_>) -> Result {
    let status_string = format!("{self:?}");
    write!(f, "{status_string}")
  }
}

impl From<i32> for ValueType {
  fn from(value: i32) -> ValueType {
    match value {
      #[cfg(feature = "napi6")]
      sys::ValueType::napi_bigint => ValueType::BigInt,
      sys::ValueType::napi_boolean => ValueType::Boolean,
      sys::ValueType::napi_external => ValueType::External,
      sys::ValueType::napi_function => ValueType::Function,
      sys::ValueType::napi_null => ValueType::Null,
      sys::ValueType::napi_number => ValueType::Number,
      sys::ValueType::napi_object => ValueType::Object,
      sys::ValueType::napi_string => ValueType::String,
      sys::ValueType::napi_symbol => ValueType::Symbol,
      sys::ValueType::napi_undefined => ValueType::Undefined,
      _ => ValueType::Unknown,
    }
  }
}
