/// We don't implement `FromNapiValue` for `i64` `u64` `i128` `u128` `isize` `usize` here
/// Because converting directly from `JsBigInt` to these values may result in a loss of precision and thus unintended behavior
/// ```rust
/// use napi::{bindgen_prelude::*, JsBigint};
///
/// #[napi]
/// fn bigint_add(mut a: Bigint, mut b: Bigint) -> u128 {
///     a.get_u128().1 + b.get_u128().1 // We have opportunity to check if the `u128` has lost precision
/// }
/// ```
use std::{cmp::max, ptr};

use crate::{check_status, sys};

use super::{FromNapiValue, ToNapiValue, TypeName, ValidateNapiValue};

/// i64 is converted to `Number`
#[repr(transparent)]
#[allow(non_camel_case_types)]
pub struct i64n(pub i64);

/// <https://nodejs.org/api/n-api.html#napi_create_bigint_words>
/// The resulting BigInt is calculated as: (–1)^sign_bit (words\[0\] × (2^64)^0 + words\[1\] × (2^64)^1 + …)
#[derive(Debug, Clone, Eq)]
pub struct BigInt {
  /// true for negative numbers
  pub sign_bit: bool,
  pub words: Vec<u64>,
}

impl PartialEq for BigInt {
  fn eq(&self, other: &Self) -> bool {
    for i in 0..max(self.words.len(), other.words.len()) {
      if self.words.get(i).unwrap_or(&0) != other.words.get(i).unwrap_or(&0) {
        return false;
      }
    }
    self.sign_bit == other.sign_bit
  }
}

impl TypeName for BigInt {
  fn type_name() -> &'static str {
    "BigInt"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::BigInt
  }
}

impl ValidateNapiValue for BigInt {}

impl FromNapiValue for BigInt {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> crate::Result<Self> {
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
    let mut words: Vec<u64> = Vec::with_capacity(word_count);
    let mut sign_bit = 0;

    unsafe {
      check_status!(sys::napi_get_value_bigint_words(
        env,
        napi_val,
        &mut sign_bit,
        &mut word_count,
        words.as_mut_ptr(),
      ))?;

      words.set_len(word_count);
    }
    if word_count == 0 {
      words = vec![0];
    }
    Ok(BigInt {
      sign_bit: sign_bit == 1,
      words,
    })
  }
}

impl BigInt {
  /// (signed, value, lossless)
  /// get the first word of the BigInt as `u64`
  /// return true in the last element of tuple if the value is lossless
  /// or the value is truncated
  pub fn get_u64(&self) -> (bool, u64, bool) {
    let lo = self.words.first().copied().unwrap_or(0);
    let upper_zero = self.words.iter().skip(1).all(|&w| w == 0);
    (self.sign_bit, lo, !self.sign_bit && upper_zero)
  }

  /// (value, lossless)
  /// get the first word of the BigInt as `i64` with the sign applied
  /// return true if the value is lossless
  /// or the value is truncated
  pub fn get_i64(&self) -> (i64, bool) {
    let lo = self.words.first().copied().unwrap_or(0);
    let upper_zero = self.words.iter().skip(1).all(|&w| w == 0);
    if self.sign_bit && lo == i64::MIN.unsigned_abs() {
      return (i64::MIN, upper_zero);
    }
    let val = if self.sign_bit {
      (lo as i64).wrapping_neg()
    } else {
      lo as i64
    };
    (val, upper_zero && (lo as i64) >= 0)
  }

  /// (value, lossless)
  /// get the first two words of the BigInt as `i128` with the sign applied
  /// return true if the value is lossless
  /// or the value is truncated
  pub fn get_i128(&self) -> (i128, bool) {
    let lo = self.words.first().copied().unwrap_or(0);
    let hi = self.words.get(1).copied().unwrap_or(0);
    let val = (lo as u128) | ((hi as u128) << 64);
    let upper_zero = self.words.iter().skip(2).all(|&w| w == 0);
    if self.sign_bit && val == i128::MIN.unsigned_abs() {
      return (i128::MIN, upper_zero);
    }
    let signed_val = if self.sign_bit {
      (val as i128).wrapping_neg()
    } else {
      val as i128
    };
    (signed_val, upper_zero && (hi as i64) >= 0)
  }

  /// (signed, value, lossless)
  /// get the first two words of the BigInt as `u128`
  /// return true if the value is lossless
  /// or the value is truncated
  pub fn get_u128(&self) -> (bool, u128, bool) {
    let lo = self.words.first().copied().unwrap_or(0);
    let hi = self.words.get(1).copied().unwrap_or(0);
    let val = (lo as u128) | ((hi as u128) << 64);
    let upper_zero = self.words.iter().skip(2).all(|&w| w == 0);
    (self.sign_bit, val, upper_zero)
  }
}

impl ToNapiValue for BigInt {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut raw_value = ptr::null_mut();
    let len = val.words.len();
    check_status!(unsafe {
      sys::napi_create_bigint_words(
        env,
        match val.sign_bit {
          true => 1,
          false => 0,
        },
        len,
        val.words.as_ptr(),
        &mut raw_value,
      )
    })?;
    Ok(raw_value)
  }
}

pub(crate) unsafe fn u128_with_sign_to_napi_value(
  env: sys::napi_env,
  val: u128,
  sign_bit: i32,
) -> crate::Result<sys::napi_value> {
  let mut raw_value = ptr::null_mut();
  if cfg!(target_endian = "little") {
    let words = &val as *const u128 as *const u64;
    check_status!(
      unsafe { sys::napi_create_bigint_words(env, sign_bit, 2, words, &mut raw_value) },
      "Failed to create BigInt from u128"
    )?;
    return Ok(raw_value);
  }

  let arr: [u64; 2] = [val as _, (val >> 64) as _];
  let words = &arr as *const u64;
  check_status!(
    unsafe { sys::napi_create_bigint_words(env, sign_bit, 2, words, &mut raw_value) },
    "Failed to create BigInt from u128"
  )?;
  Ok(raw_value)
}

impl ToNapiValue for i128 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let sign_bit = i32::from(val <= 0);
    let val = val.unsigned_abs();
    u128_with_sign_to_napi_value(env, val, sign_bit)
  }
}

impl ToNapiValue for &i128 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for &mut i128 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for u128 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    u128_with_sign_to_napi_value(env, val, 0)
  }
}

impl ToNapiValue for &u128 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for &mut u128 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for i64n {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_bigint_int64(env, val.0, &mut raw_value) })?;
    Ok(raw_value)
  }
}

impl ToNapiValue for &i64n {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, i64n(val.0))
  }
}

impl ToNapiValue for &mut i64n {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, i64n(val.0))
  }
}

impl ToNapiValue for u64 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut raw_value = ptr::null_mut();
    check_status!(
      unsafe { sys::napi_create_bigint_uint64(env, val, &mut raw_value) },
      "Failed to create BigInt from u64"
    )?;
    Ok(raw_value)
  }
}

impl ToNapiValue for &u64 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for &mut u64 {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for usize {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_bigint_uint64(env, val as u64, &mut raw_value) })?;
    Ok(raw_value)
  }
}

impl ToNapiValue for isize {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    let mut raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_create_bigint_int64(env, val as i64, &mut raw_value) })?;
    Ok(raw_value)
  }
}

impl ToNapiValue for &usize {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl ToNapiValue for &mut usize {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, *val)
  }
}

impl From<i64> for BigInt {
  fn from(val: i64) -> Self {
    BigInt {
      sign_bit: val < 0,
      words: vec![val.unsigned_abs()],
    }
  }
}

impl From<u64> for BigInt {
  fn from(val: u64) -> Self {
    BigInt {
      sign_bit: false,
      words: vec![val],
    }
  }
}

impl From<i128> for BigInt {
  fn from(val: i128) -> Self {
    let sign_bit = val < 0;
    let val = val.unsigned_abs();
    BigInt {
      sign_bit,
      words: vec![val as _, (val >> 64) as _],
    }
  }
}

impl From<u128> for BigInt {
  fn from(val: u128) -> Self {
    BigInt {
      sign_bit: false,
      words: vec![val as _, (val >> 64) as _],
    }
  }
}

#[test]
fn test_bigint_comparison() {
  assert_eq!(BigInt::from(1_i64), BigInt::from(1_i64));
  assert_eq!(BigInt::from(1_i64), BigInt::from(1_i128));
  assert_eq!(BigInt::from(1_i64), BigInt::from(1_u128));
  assert_eq!(BigInt::from(1_i64), BigInt::from(1_u64));

  assert_eq!(BigInt::from(-1_i64), BigInt::from(-1_i128));

  assert_ne!(BigInt::from(1_i64), BigInt::from(-1_i128));
  assert_ne!(BigInt::from(1_i64), BigInt::from(2_i64));

  assert_eq!(BigInt::from(i128::MAX), BigInt::from(i128::MAX));
  assert_ne!(BigInt::from(i64::MAX), BigInt::from(i128::MAX));
}

#[test]
fn test_bigint_lossless_conversions() {
  assert_eq!(BigInt::from(i64::MIN).get_i64(), (i64::MIN, true));
  assert_eq!(BigInt::from(i64::MAX).get_i64(), (i64::MAX, true));
  assert_eq!(BigInt::from(i64::MIN).get_i128(), (i64::MIN as i128, true));

  // Negative 1-word value below i64::MIN must report lossy for i64 and lossless for i128
  let below_i64_min = BigInt {
    sign_bit: true,
    words: vec![i64::MIN.unsigned_abs() + 1],
  };
  assert!(!below_i64_min.get_i64().1);
  assert_eq!(below_i64_min.get_i128(), (i64::MIN as i128 - 1, true));

  // Exact i128::MIN must be lossless; >128-bit with the same low 128 bits must be lossy
  assert_eq!(BigInt::from(i128::MIN).get_i128(), (i128::MIN, true));
  let truncated_i128_min = BigInt {
    sign_bit: true,
    words: vec![0, i64::MIN.unsigned_abs(), 1],
  };
  assert_eq!(truncated_i128_min.get_i128(), (i128::MIN, false));

  assert_eq!(BigInt::from(i128::MAX).get_i128(), (i128::MAX, true));
  let above_i128_max = BigInt {
    sign_bit: false,
    words: vec![0, i64::MIN.unsigned_abs()],
  };
  assert!(!above_i128_max.get_i128().1);

  assert_eq!(BigInt::from(u64::MAX).get_u64(), (false, u64::MAX, true));
  assert_eq!(BigInt::from(u128::MAX).get_u128(), (false, u128::MAX, true));
  let above_u128_max = BigInt {
    sign_bit: false,
    words: vec![0, 0, 1],
  };
  assert_eq!(above_u128_max.get_u128(), (false, 0, false));

  // Trailing zero words (as produced by From<i128> / From<u128>) remain lossless
  assert_eq!(BigInt::from(1_i128).get_i64(), (1, true));
  assert_eq!(BigInt::from(1_u128).get_u64(), (false, 1, true));
}
