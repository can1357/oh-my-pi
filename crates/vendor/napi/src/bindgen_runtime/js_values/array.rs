use std::{marker::PhantomData, ptr};

use crate::{bindgen_prelude::*, check_status, Value};

#[derive(Clone, Copy)]
pub struct Array<'env> {
  pub(crate) env: sys::napi_env,
  pub(crate) inner: sys::napi_value,
  pub(crate) len: u32,
  _marker: std::marker::PhantomData<&'env ()>,
}

impl<'env> Array<'env> {
  pub(crate) fn new(env: sys::napi_env, len: u32) -> Result<Self> {
    let mut ptr = ptr::null_mut();
    unsafe {
      check_status!(
        sys::napi_create_array_with_length(env, len as usize, &mut ptr),
        "Failed to create napi Array"
      )?;
    }

    Ok(Array {
      env,
      inner: ptr,
      len,
      _marker: std::marker::PhantomData,
    })
  }

  pub fn get<T: FromNapiValue>(&self, index: u32) -> Result<Option<T>> {
    if index >= self.len() {
      return Ok(None);
    }

    let mut ret = ptr::null_mut();
    unsafe {
      check_status!(
        sys::napi_get_element(self.env, self.inner, index, &mut ret),
        "Failed to get element with index `{}`",
        index,
      )?;

      Ok(Some(T::from_napi_value(self.env, ret)?))
    }
  }

  /// Note: for `#[napi]` classes the generated [`FromNapiRef`] registers a native borrow, which
  /// is only permitted during generated callback argument conversion. Reading a class element
  /// from inside a native call should go through `ClassInstance<T>` (via [`Array::get`]) instead.
  pub fn get_ref<T: 'static + FromNapiRef>(&self, index: u32) -> Result<Option<&'env T>> {
    if index >= self.len() {
      return Ok(None);
    }

    let mut ret = ptr::null_mut();
    unsafe {
      check_status!(
        sys::napi_get_element(self.env, self.inner, index, &mut ret),
        "Failed to get element with index `{}`",
        index,
      )?;

      Ok(Some(T::from_napi_ref(self.env, ret)?))
    }
  }

  pub fn set<T: ToNapiValue>(&mut self, index: u32, val: T) -> Result<()> {
    unsafe {
      let napi_val = T::to_napi_value(self.env, val)?;

      check_status!(
        sys::napi_set_element(self.env, self.inner, index, napi_val),
        "Failed to set element with index `{}`",
        index,
      )?;

      if index >= self.len() {
        self.len = index + 1;
      }

      Ok(())
    }
  }

  pub fn insert<T: ToNapiValue>(&mut self, val: T) -> Result<()> {
    self.set(self.len(), val)?;
    Ok(())
  }

  #[allow(clippy::len_without_is_empty)]
  pub fn len(&self) -> u32 {
    self.len
  }

  pub fn coerce_to_object(self) -> Result<Object<'env>> {
    let mut new_raw_value = ptr::null_mut();
    check_status!(unsafe { sys::napi_coerce_to_object(self.env, self.inner, &mut new_raw_value) })?;
    Ok(Object(
      Value {
        env: self.env,
        value: new_raw_value,
        value_type: ValueType::Object,
      },
      PhantomData,
    ))
  }
}

impl TypeName for Array<'_> {
  fn type_name() -> &'static str {
    "Array"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<'env> JsValue<'env> for Array<'env> {
  fn value(&self) -> Value {
    Value {
      env: self.env,
      value: self.inner,
      value_type: ValueType::Object,
    }
  }
}

impl<'env> JsObjectValue<'env> for Array<'env> {}

impl FromNapiValue for Array<'_> {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let mut len = 0;

    check_status!(
      unsafe { sys::napi_get_array_length(env, napi_val, &mut len) },
      "Failed to get Array length",
    )?;

    Ok(Array {
      inner: napi_val,
      env,
      len,
      _marker: std::marker::PhantomData,
    })
  }
}

impl<'env> ValidateNapiValue for Array<'env> {
  unsafe fn validate(env: sys::napi_env, napi_val: sys::napi_value) -> Result<sys::napi_value> {
    let mut is_array = false;
    check_status!(
      unsafe { sys::napi_is_array(env, napi_val, &mut is_array) },
      "Failed to check given napi value is array"
    )?;
    if !is_array {
      return Err(Error::new(
        Status::InvalidArg,
        "Expected an array".to_owned(),
      ));
    }
    Ok(ptr::null_mut())
  }
}

impl Array<'_> {
  /// Create `Array` from `Vec<T>`
  pub fn from_vec<T>(env: &Env, value: Vec<T>) -> Result<Self>
  where
    T: ToNapiValue,
  {
    let mut arr = Array::new(env.0, value.len() as u32)?;
    value.into_iter().enumerate().try_for_each(|(index, val)| {
      arr.set(index as u32, val)?;
      Ok::<(), Error>(())
    })?;
    Ok(arr)
  }

  /// Create `Array` from `&Vec<String>`
  pub fn from_ref_vec_string(env: &Env, value: &[String]) -> Result<Self> {
    let mut arr = Array::new(env.0, value.len() as u32)?;
    value.iter().enumerate().try_for_each(|(index, val)| {
      arr.set(index as u32, val.as_str())?;
      Ok::<(), Error>(())
    })?;
    Ok(arr)
  }

  /// Create `Array` from `&Vec<T: Copy + ToNapiValue>`
  pub fn from_ref_vec<T>(env: &Env, value: &[T]) -> Result<Self>
  where
    T: ToNapiValue + Copy,
  {
    let mut arr = Array::new(env.0, value.len() as u32)?;
    value.iter().enumerate().try_for_each(|(index, val)| {
      arr.set(index as u32, *val)?;
      Ok::<(), Error>(())
    })?;
    Ok(arr)
  }
}

impl<T> TypeName for Vec<T> {
  fn type_name() -> &'static str {
    "Array<T>"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<T, const N: usize> ToNapiValue for [T; N]
where
  T: ToNapiValue + Copy,
{
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut arr = Array::new(env, val.len() as u32)?;

    for (i, v) in val.into_iter().enumerate() {
      arr.set(i as u32, v)?;
    }

    unsafe { Array::to_napi_value(env, arr) }
  }
}

impl<T, const N: usize> ToNapiValue for &[T; N]
where
  for<'a> &'a T: ToNapiValue,
{
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut arr = Array::new(env, val.len() as u32)?;

    for (i, v) in val.iter().enumerate() {
      arr.set(i as u32, v)?;
    }

    unsafe { Array::to_napi_value(env, arr) }
  }
}

impl<T> ToNapiValue for Vec<T>
where
  T: ToNapiValue,
{
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut arr = Array::new(env, val.len() as u32)?;

    for (i, v) in val.into_iter().enumerate() {
      arr.set(i as u32, v)?;
    }

    unsafe { Array::to_napi_value(env, arr) }
  }
}

impl<T> ToNapiValue for &Vec<T>
where
  for<'a> &'a T: ToNapiValue,
{
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let mut arr = Array::new(env, val.len() as u32)?;

    for (i, v) in val.iter().enumerate() {
      arr.set(i as u32, v)?;
    }

    unsafe { Array::to_napi_value(env, arr) }
  }
}

impl<T> ToNapiValue for &mut Vec<T>
where
  for<'a> &'a T: ToNapiValue,
{
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    ToNapiValue::to_napi_value(env, &*val)
  }
}

impl<T> FromNapiValue for Vec<T>
where
  T: FromNapiValue,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let arr = unsafe { Array::from_napi_value(env, napi_val)? };
    let mut vec = Vec::with_capacity(arr.len() as usize);

    for i in 0..arr.len() {
      if let Some(val) = arr.get::<T>(i)? {
        vec.push(val);
      } else {
        return Err(Error::new(
          Status::InvalidArg,
          "Found inconsistent data type in Array<T> when converting to Rust Vec<T>".to_owned(),
        ));
      }
    }

    Ok(vec)
  }
}

impl<T> ValidateNapiValue for Vec<T>
where
  T: FromNapiValue,
{
  unsafe fn validate(env: sys::napi_env, napi_val: sys::napi_value) -> Result<sys::napi_value> {
    let mut is_array = false;
    check_status!(
      unsafe { sys::napi_is_array(env, napi_val, &mut is_array) },
      "Failed to check given napi value is array"
    )?;
    if !is_array {
      return Err(Error::new(
        Status::InvalidArg,
        "Expected an array".to_owned(),
      ));
    }
    Ok(ptr::null_mut())
  }
}

macro_rules! arr_get {
  ($arr:expr, $n:expr, $err:expr) => {
    if let Some(e) = $arr.get($n)? {
      e
    } else {
      return $err($n);
    }
  };
}

macro_rules! tuple_from_napi_value {
  ($total:expr, $($n:expr),+,) => {
    unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
      let arr = unsafe { Array::from_napi_value(env, napi_val)? };
      let err = |v| Err(Error::new(
        Status::InvalidArg,
        format!(
          "Found inconsistent data type in Array[{}] when converting to Rust T",
          v
        )
        .to_owned(),
      ));
      if arr.len() < $total {
        return Err(Error::new(
            Status::InvalidArg,
            format!("Array length < {}",$total).to_owned(),
        ));
      }
      Ok(($(arr_get!(arr,$n,err),)+))
    }
  }
}

macro_rules! impl_tuple_validate_napi_value {
  ($($ident:ident),+) => {
    impl<$($ident: FromNapiValue),*> ValidateNapiValue for ($($ident,)*) {}
    impl<$($ident: FromNapiValue),*> TypeName for ($($ident,)*) {
      fn type_name() -> &'static str {
        concat!("Tuple", "(", $(stringify!($ident), ","),*, ")")
      }
      fn value_type() -> ValueType {
        ValueType::Object
      }
    }
  };
}

macro_rules! impl_from_tuple {
  (
    $($typs:ident),*;
    $($tidents:expr),+;
    $length:expr
  ) => {
    impl<$($typs),*> FromNapiValue for ($($typs,)*)
      where $($typs: FromNapiValue,)* {
      tuple_from_napi_value!($length, $($tidents,)*);
    }
  };
}

macro_rules! impl_to_tuple {
  (
    $($typs:ident),*;
    $($tidents:expr),+;
    $length:expr
  ) => {
    impl<$($typs),*> ToNapiValue for ($($typs,)*)
      where $($typs: ToNapiValue,)* {
      unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
        let mut arr = Array::new(env, $length as u32)?;

        #[allow(non_snake_case)]
        let ($($typs,)*) = val;
        let mut i = 0;

        $(i+=1; unsafe {arr.set(i-1, <$typs as ToNapiValue>::to_napi_value(env, $typs)? )?}; )*

        unsafe { Array::to_napi_value(env, arr) }
      }
    }
  };
}

macro_rules! impl_tuples {
  (
    ;;$length:expr,
    $shift:expr
  ) => {};
  (
    $typ:ident$(, $($typs:ident),*)?;
    $tident:expr$(, $($tidents:expr),*)?;
    $length:expr,
    $shift:expr
  ) => {
    impl_tuples!(
      $($($typs),*)?;
      $($($tidents),*)?;
      $length - 1,
      $shift + 1
    );
    impl_from_tuple!(
      $typ$(, $($typs),*)?;
      $tident - $shift$(, $($tidents - $shift),*)?;
      $length
    );
    impl_to_tuple!(
      $typ$(, $($typs),*)?;
      $tident - $shift$(, $($tidents - $shift),*)?;
      $length
    );
    impl_tuple_validate_napi_value!($typ$(, $($typs),*)?);
  };
}

impl_tuples!(
  T0, T1, T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12, T13, T14, T15;
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15;
  16, 0
);
