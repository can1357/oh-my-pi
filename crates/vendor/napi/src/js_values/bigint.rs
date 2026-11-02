use std::convert::TryFrom;
use std::ptr;

use super::*;
use crate::{
  bindgen_runtime::{FromNapiValue, TypeName},
  check_status, sys, Result,
};

#[deprecated(since = "3.0.0", note = "Use `napi::bindgen_prelude::BigInt` instead")]
#[derive(Clone, Copy)]
pub struct JsBigInt {
  pub(crate) raw: Value,
  pub word_count: usize,
}

impl TypeName for JsBigInt {
  fn type_name() -> &'static str {
    "BigInt"
  }

  fn value_type() -> ValueType {
    ValueType::BigInt
  }
}

impl ValidateNapiValue for JsBigInt {}

impl JsValue<'_> for JsBigInt {
  fn value(&self) -> Value {
    self.raw
  }
}

impl FromNapiValue for JsBigInt {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut word_count = 0usize;
    check_status!(unsafe {
      sys::napi_get_value_bigint_words(
        env,
        napi_val,
        ptr::null_mut(),
        &mut word_count,
        ptr::null_mut(),
      )
    })?;
    Ok(JsBigInt {
      raw: Value {
        env,
        value: napi_val,
        value_type: ValueType::BigInt,
      },
      word_count,
    })
  }
}

impl JsBigInt {
  pub(crate) fn from_raw_unchecked(
    env: sys::napi_env,
    value: sys::napi_value,
    word_count: usize,
  ) -> Self {
    Self {
      raw: Value {
        env,
        value,
        value_type: ValueType::Object,
      },
      word_count,
    }
  }
}

impl NapiRaw for JsBigInt {
  unsafe fn raw(&self) -> sys::napi_value {
    self.raw.value
  }
}

impl NapiRaw for &JsBigInt {
  unsafe fn raw(&self) -> sys::napi_value {
    self.raw.value
  }
}

impl NapiValue for JsBigInt {
  unsafe fn from_raw(env: sys::napi_env, value: sys::napi_value) -> Result<Self> {
    let mut word_count = 0usize;
    check_status!(unsafe {
      sys::napi_get_value_bigint_words(
        env,
        value,
        ptr::null_mut(),
        &mut word_count,
        ptr::null_mut(),
      )
    })?;
    Ok(JsBigInt {
      raw: Value {
        env,
        value,
        value_type: ValueType::BigInt,
      },
      word_count,
    })
  }

  unsafe fn from_raw_unchecked(env: sys::napi_env, value: sys::napi_value) -> Self {
    let mut word_count = 0usize;
    let status = unsafe {
      sys::napi_get_value_bigint_words(
        env,
        value,
        ptr::null_mut(),
        &mut word_count,
        ptr::null_mut(),
      )
    };
    debug_assert!(
      Status::from(status) == Status::Ok,
      "napi_get_value_bigint_words failed"
    );
    JsBigInt {
      raw: Value {
        env,
        value,
        value_type: ValueType::BigInt,
      },
      word_count,
    }
  }
}

/// The BigInt will be converted losslessly when the value is over what an int64 could hold.
impl TryFrom<JsBigInt> for i64 {
  type Error = Error;

  fn try_from(value: JsBigInt) -> Result<i64> {
    value.get_i64().map(|(v, _)| v)
  }
}

/// The BigInt will be converted losslessly when the value is over what an uint64 could hold.
impl TryFrom<JsBigInt> for u64 {
  type Error = Error;

  fn try_from(value: JsBigInt) -> Result<u64> {
    value.get_u64().map(|(v, _)| v)
  }
}

impl JsBigInt {
  /// <https://nodejs.org/api/n-api.html#n_api_napi_get_value_bigint_words>
  pub fn get_words(&mut self) -> Result<(bool, Vec<u64>)> {
    let mut words: Vec<u64> = Vec::with_capacity(self.word_count);
    let word_count = &mut self.word_count;
    let mut sign_bit = 0;
    check_status!(unsafe {
      sys::napi_get_value_bigint_words(
        self.raw.env,
        self.raw.value,
        &mut sign_bit,
        word_count,
        words.as_mut_ptr(),
      )
    })?;

    unsafe {
      words.set_len(self.word_count);
    };

    Ok((sign_bit == 1, words))
  }

  pub fn get_u64(&self) -> Result<(u64, bool)> {
    let mut val: u64 = 0;
    let mut lossless = false;
    check_status!(unsafe {
      sys::napi_get_value_bigint_uint64(self.raw.env, self.raw.value, &mut val, &mut lossless)
    })?;

    Ok((val, lossless))
  }

  pub fn get_i64(&self) -> Result<(i64, bool)> {
    let mut val: i64 = 0;
    let mut lossless: bool = false;
    check_status!(unsafe {
      sys::napi_get_value_bigint_int64(self.raw.env, self.raw.value, &mut val, &mut lossless)
    })?;
    Ok((val, lossless))
  }

  pub fn get_i128(&mut self) -> Result<(i128, bool)> {
    let (signed, words) = self.get_words()?;

    let low_part = words.first().copied().unwrap_or(0).to_ne_bytes();
    let high_part = words.get(1).copied().unwrap_or(0).to_ne_bytes();

    let mut val = [0_u8; std::mem::size_of::<i128>()];
    let high_val: &mut [u8];
    let low_val: &mut [u8];
    if cfg!(target_endian = "little") {
      (low_val, high_val) = val.split_at_mut(low_part.len());
    } else {
      (high_val, low_val) = val.split_at_mut(low_part.len());
    }

    high_val.copy_from_slice(&high_part);
    low_val.copy_from_slice(&low_part);

    let mut val = i128::from_ne_bytes(val);

    let mut loss = words.len() > 2;
    let mut overflow = false;

    if signed {
      let result = val.overflowing_neg();
      val = result.0;
      overflow = result.1;
    }

    loss = overflow || loss;

    Ok((val, loss))
  }

  pub fn get_u128(&mut self) -> Result<(bool, u128, bool)> {
    let (signed, words) = self.get_words()?;

    let low_part = words.first().copied().unwrap_or(0).to_ne_bytes();
    let high_part = words.get(1).copied().unwrap_or(0).to_ne_bytes();

    let mut val = [0_u8; std::mem::size_of::<i128>()];
    let high_val: &mut [u8];
    let low_val: &mut [u8];
    if cfg!(target_endian = "little") {
      (low_val, high_val) = val.split_at_mut(low_part.len());
    } else {
      (high_val, low_val) = val.split_at_mut(low_part.len());
    }

    high_val.copy_from_slice(&high_part);
    low_val.copy_from_slice(&low_part);

    let val = u128::from_ne_bytes(val);

    let len = words.len();

    Ok((signed, val, len > 2))
  }
}
