use std::fmt::{Display, Formatter, Result};

use crate::sys;

#[repr(i32)]
#[derive(Eq, PartialEq, Debug, Clone, Copy, PartialOrd, Ord)]
pub enum Status {
  Ok = 0,
  InvalidArg,
  ObjectExpected,
  StringExpected,
  NameExpected,
  FunctionExpected,
  NumberExpected,
  BooleanExpected,
  ArrayExpected,
  GenericFailure,
  PendingException,
  Cancelled,
  EscapeCalledTwice,
  HandleScopeMismatch,
  CallbackScopeMismatch,
  /// ThreadSafeFunction queue is full
  QueueFull,
  /// ThreadSafeFunction closed
  Closing,
  BigintExpected,
  DateExpected,
  ArrayBufferExpected,
  DetachableArraybufferExpected,
  WouldDeadlock,
  NoExternalBuffersAllowed,
  Unknown = 1024, // unknown status. for example, using napi3 module in napi7 Node.js, and generate an invalid napi3 status
}

impl Display for Status {
  fn fmt(&self, f: &mut Formatter<'_>) -> Result {
    let status_string = format!("{self:?}");
    write!(f, "{status_string}")
  }
}

impl AsRef<str> for Status {
  fn as_ref(&self) -> &str {
    match self {
      Status::Ok => "Ok",
      Status::InvalidArg => "InvalidArg",
      Status::ObjectExpected => "ObjectExpected",
      Status::StringExpected => "StringExpected",
      Status::NameExpected => "NameExpected",
      Status::FunctionExpected => "FunctionExpected",
      Status::NumberExpected => "NumberExpected",
      Status::BooleanExpected => "BooleanExpected",
      Status::ArrayExpected => "ArrayExpected",
      Status::GenericFailure => "GenericFailure",
      Status::PendingException => "PendingException",
      Status::Cancelled => "Cancelled",
      Status::EscapeCalledTwice => "EscapeCalledTwice",
      Status::HandleScopeMismatch => "HandleScopeMismatch",
      Status::CallbackScopeMismatch => "CallbackScopeMismatch",
      Status::QueueFull => "QueueFull",
      Status::Closing => "Closing",
      Status::BigintExpected => "BigintExpected",
      Status::DateExpected => "DateExpected",
      Status::ArrayBufferExpected => "ArrayBufferExpected",
      Status::DetachableArraybufferExpected => "DetachableArraybufferExpected",
      Status::WouldDeadlock => "WouldDeadlock",
      Status::NoExternalBuffersAllowed => "NoExternalBuffersAllowed",
      _ => "Unknown",
    }
  }
}

impl From<i32> for Status {
  fn from(code: i32) -> Self {
    match code {
      sys::Status::napi_ok => Status::Ok,
      sys::Status::napi_invalid_arg => Status::InvalidArg,
      sys::Status::napi_object_expected => Status::ObjectExpected,
      sys::Status::napi_string_expected => Status::StringExpected,
      sys::Status::napi_name_expected => Status::NameExpected,
      sys::Status::napi_function_expected => Status::FunctionExpected,
      sys::Status::napi_number_expected => Status::NumberExpected,
      sys::Status::napi_boolean_expected => Status::BooleanExpected,
      sys::Status::napi_array_expected => Status::ArrayExpected,
      sys::Status::napi_generic_failure => Status::GenericFailure,
      sys::Status::napi_pending_exception => Status::PendingException,
      sys::Status::napi_cancelled => Status::Cancelled,
      sys::Status::napi_escape_called_twice => Status::EscapeCalledTwice,
      sys::Status::napi_handle_scope_mismatch => Status::HandleScopeMismatch,
      sys::Status::napi_callback_scope_mismatch => Status::CallbackScopeMismatch,
      sys::Status::napi_queue_full => Status::QueueFull,
      sys::Status::napi_closing => Status::Closing,
      sys::Status::napi_bigint_expected => Status::BigintExpected,
      sys::Status::napi_date_expected => Status::DateExpected,
      sys::Status::napi_arraybuffer_expected => Status::ArrayBufferExpected,
      sys::Status::napi_detachable_arraybuffer_expected => Status::DetachableArraybufferExpected,
      sys::Status::napi_would_deadlock => Status::WouldDeadlock,
      sys::Status::napi_no_external_buffers_allowed => Status::NoExternalBuffersAllowed,
      _ => Status::Unknown,
    }
  }
}

impl From<Status> for i32 {
  fn from(code: Status) -> Self {
    match code {
      Status::Ok => sys::Status::napi_ok,
      Status::InvalidArg => sys::Status::napi_invalid_arg,
      Status::ObjectExpected => sys::Status::napi_object_expected,
      Status::StringExpected => sys::Status::napi_string_expected,
      Status::NameExpected => sys::Status::napi_name_expected,
      Status::FunctionExpected => sys::Status::napi_function_expected,
      Status::NumberExpected => sys::Status::napi_number_expected,
      Status::BooleanExpected => sys::Status::napi_boolean_expected,
      Status::ArrayExpected => sys::Status::napi_array_expected,
      Status::GenericFailure => sys::Status::napi_generic_failure,
      Status::PendingException => sys::Status::napi_pending_exception,
      Status::Cancelled => sys::Status::napi_cancelled,
      Status::EscapeCalledTwice => sys::Status::napi_escape_called_twice,
      Status::HandleScopeMismatch => sys::Status::napi_handle_scope_mismatch,
      Status::CallbackScopeMismatch => sys::Status::napi_callback_scope_mismatch,
      Status::QueueFull => sys::Status::napi_queue_full,
      Status::Closing => sys::Status::napi_closing,
      Status::BigintExpected => sys::Status::napi_bigint_expected,
      Status::DateExpected => sys::Status::napi_date_expected,
      Status::ArrayBufferExpected => sys::Status::napi_arraybuffer_expected,
      Status::DetachableArraybufferExpected => sys::Status::napi_detachable_arraybuffer_expected,
      Status::WouldDeadlock => sys::Status::napi_would_deadlock,
      Status::NoExternalBuffersAllowed => sys::Status::napi_no_external_buffers_allowed,
      Status::Unknown => sys::Status::napi_generic_failure,
    }
  }
}
