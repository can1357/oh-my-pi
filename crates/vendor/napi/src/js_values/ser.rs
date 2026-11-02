use std::{marker::PhantomData, result::Result as StdResult};

use serde::{ser, Serialize, Serializer};

use crate::{
  bindgen_runtime::{Array, BufferSlice, JsObjectValue, Null, Object, ToNapiValue},
  Env, Error, JsString, JsValue, Result, Unknown, Value, ValueType,
};

pub struct Ser<'env>(pub(crate) &'env Env);

impl<'env> Ser<'env> {
  pub fn new(env: &'env Env) -> Self {
    Self(env)
  }
}

impl<'env> Serializer for Ser<'env> {
  type Ok = Value;
  type Error = Error;

  type SerializeSeq = SeqSerializer<'env>;
  type SerializeTuple = SeqSerializer<'env>;
  type SerializeTupleStruct = SeqSerializer<'env>;
  type SerializeTupleVariant = SeqSerializer<'env>;
  type SerializeMap = MapSerializer<'env>;
  type SerializeStruct = StructSerializer<'env>;
  type SerializeStructVariant = StructSerializer<'env>;

  fn serialize_bool(self, v: bool) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0 .0,
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Boolean,
    })
  }

  fn serialize_bytes(self, v: &[u8]) -> Result<Self::Ok> {
    BufferSlice::from_data(self.0, v.to_owned()).map(|bs| Value {
      env: self.0.raw(),
      value: bs.raw_value,
      value_type: ValueType::Object,
    })
  }

  fn serialize_char(self, v: char) -> Result<Self::Ok> {
    let mut b = [0; 4];
    let result = v.encode_utf8(&mut b);
    self.0.create_string(result).map(|js_string| js_string.0)
  }

  fn serialize_f32(self, v: f32) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_f64(self, v: f64) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_i16(self, v: i16) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v as i32)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_i32(self, v: i32) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_i64(self, v: i64) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_i8(self, v: i8) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v as i32)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_u8(self, v: u8) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v as u32)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_u16(self, v: u16) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v as u32)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_u32(self, v: u32) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  #[cfg(all(
    any(
      feature = "napi2",
      feature = "napi3",
      feature = "napi4",
      feature = "napi5"
    ),
    not(feature = "napi6")
  ))]
  fn serialize_u64(self, v: u64) -> Result<Self::Ok> {
    if v <= u32::MAX.into() {
      self.serialize_u32(v as u32)
    } else {
      Err(Error::new(
        crate::Status::InvalidArg,
        "u64 is too large to serialize, enable napi6 feature and serialize it as BigInt instead",
      ))
    }
  }

  #[cfg(feature = "napi6")]
  fn serialize_u64(self, v: u64) -> Result<Self::Ok> {
    // https://github.com/napi-rs/napi-rs/issues/1470
    // serde_json::Value by default uses u64 for positive integers. This results in napirs using a BigInt instead of a number when converting to a js value.
    // To avoid this, we need to check if the value fits into a smaller number type.
    // If this is the case, we use the smaller type instead.
    if v <= u32::MAX.into() {
      self.serialize_u32(v as u32)
    } else {
      Ok(Value {
        env: self.0.raw(),
        value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
        value_type: ValueType::Number,
      })
    }
  }

  #[cfg(all(
    any(
      feature = "napi2",
      feature = "napi3",
      feature = "napi4",
      feature = "napi5"
    ),
    not(feature = "napi6")
  ))]
  fn serialize_u128(self, v: u128) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v.to_string())? },
      value_type: ValueType::Number,
    })
  }

  #[cfg(feature = "napi6")]
  fn serialize_u128(self, v: u128) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  #[cfg(all(
    any(
      feature = "napi2",
      feature = "napi3",
      feature = "napi4",
      feature = "napi5"
    ),
    not(feature = "napi6")
  ))]
  fn serialize_i128(self, v: i128) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v.to_string())? },
      value_type: ValueType::Number,
    })
  }

  #[cfg(feature = "napi6")]
  fn serialize_i128(self, v: i128) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, v)? },
      value_type: ValueType::Number,
    })
  }

  fn serialize_unit(self) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, Null) }?,
      value_type: ValueType::Null,
    })
  }

  fn serialize_none(self) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, Null) }?,
      value_type: ValueType::Null,
    })
  }

  fn serialize_str(self, v: &str) -> Result<Self::Ok> {
    self.0.create_string(v).map(|string| string.0)
  }

  fn serialize_some<T>(self, value: &T) -> Result<Self::Ok>
  where
    T: ?Sized + Serialize,
  {
    value.serialize(self)
  }

  fn serialize_map(self, _len: Option<usize>) -> Result<Self::SerializeMap> {
    let env = self.0;
    let key = env.create_string("")?;
    let obj = Object::new(env)?;
    Ok(MapSerializer { key, obj })
  }

  fn serialize_seq(self, len: Option<usize>) -> Result<Self::SerializeSeq> {
    let array = Array::new(self.0.raw(), len.unwrap_or(0) as u32)?;
    Ok(SeqSerializer {
      current_index: 0,
      array,
    })
  }

  fn serialize_tuple_variant(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
    len: usize,
  ) -> Result<Self::SerializeTupleVariant> {
    let env = self.0;
    let array = Array::new(env.raw(), len as u32)?;
    let mut object = Object::new(env)?;
    object.set_named_property(
      variant,
      Object(
        Value {
          value: array.inner,
          env: array.env,
          value_type: ValueType::Object,
        },
        PhantomData,
      ),
    )?;
    Ok(SeqSerializer {
      current_index: 0,
      array,
    })
  }

  fn serialize_unit_struct(self, _name: &'static str) -> Result<Self::Ok> {
    Ok(Value {
      env: self.0.raw(),
      value: unsafe { ToNapiValue::to_napi_value(self.0 .0, Null) }?,
      value_type: ValueType::Null,
    })
  }

  fn serialize_unit_variant(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
  ) -> Result<Self::Ok> {
    self.0.create_string(variant).map(|string| string.0)
  }

  fn serialize_newtype_struct<T>(self, _name: &'static str, value: &T) -> Result<Self::Ok>
  where
    T: ?Sized + Serialize,
  {
    value.serialize(self)
  }

  fn serialize_newtype_variant<T>(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
    value: &T,
  ) -> Result<Self::Ok>
  where
    T: ?Sized + Serialize,
  {
    let mut obj = Object::new(self.0)?;
    obj.set_named_property(
      variant,
      Unknown(value.serialize(self)?, std::marker::PhantomData),
    )?;
    Ok(obj.0)
  }

  fn serialize_tuple(self, len: usize) -> Result<Self::SerializeTuple> {
    Ok(SeqSerializer {
      array: Array::new(self.0.raw(), len as u32)?,
      current_index: 0,
    })
  }

  fn serialize_tuple_struct(
    self,
    _name: &'static str,
    len: usize,
  ) -> Result<Self::SerializeTupleStruct> {
    Ok(SeqSerializer {
      array: Array::new(self.0.raw(), len as u32)?,
      current_index: 0,
    })
  }

  fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self::SerializeStruct> {
    Ok(StructSerializer {
      obj: Object::new(self.0)?,
    })
  }

  fn serialize_struct_variant(
    self,
    _name: &'static str,
    _variant_index: u32,
    variant: &'static str,
    _len: usize,
  ) -> Result<Self::SerializeStructVariant> {
    let mut outer = Object::new(self.0)?;
    let inner = Object::new(self.0)?;
    outer.set_named_property(
      variant,
      Object(
        Value {
          env: inner.0.env,
          value: inner.0.value,
          value_type: ValueType::Object,
        },
        PhantomData,
      ),
    )?;
    Ok(StructSerializer {
      obj: Object::new(self.0)?,
    })
  }
}

pub struct SeqSerializer<'env> {
  array: Array<'env>,
  current_index: usize,
}

impl ser::SerializeSeq for SeqSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_element<T>(&mut self, value: &T) -> StdResult<(), Self::Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.array.env);
    self.array.set_element(
      self.current_index as _,
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    self.current_index += 1;
    Ok(())
  }

  fn end(self) -> Result<Self::Ok> {
    Ok(self.array.value())
  }
}

#[doc(hidden)]
impl ser::SerializeTuple for SeqSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_element<T>(&mut self, value: &T) -> StdResult<(), Self::Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.array.env);
    self.array.set_element(
      self.current_index as _,
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    self.current_index += 1;
    Ok(())
  }

  fn end(self) -> StdResult<Self::Ok, Self::Error> {
    Ok(self.array.value())
  }
}

#[doc(hidden)]
impl ser::SerializeTupleStruct for SeqSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, value: &T) -> StdResult<(), Self::Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.array.env);
    self.array.set_element(
      self.current_index as _,
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    self.current_index += 1;
    Ok(())
  }

  fn end(self) -> StdResult<Self::Ok, Self::Error> {
    Ok(self.array.value())
  }
}

#[doc(hidden)]
impl ser::SerializeTupleVariant for SeqSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, value: &T) -> StdResult<(), Self::Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.array.env);
    self.array.set_element(
      self.current_index as _,
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    self.current_index += 1;
    Ok(())
  }

  fn end(self) -> Result<Self::Ok> {
    Ok(self.array.value())
  }
}

pub struct MapSerializer<'env> {
  key: JsString<'env>,
  obj: Object<'env>,
}

#[doc(hidden)]
impl ser::SerializeMap for MapSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_key<T>(&mut self, key: &T) -> StdResult<(), Self::Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.obj.0.env);
    self.key = JsString(key.serialize(Ser::new(&env))?, std::marker::PhantomData);
    Ok(())
  }

  fn serialize_value<T>(&mut self, value: &T) -> StdResult<(), Self::Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.obj.0.env);
    self.obj.set_property(
      JsString::from_raw(self.key.0.env, self.key.0.value),
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    Ok(())
  }

  fn serialize_entry<K, V>(&mut self, key: &K, value: &V) -> StdResult<(), Self::Error>
  where
    K: ?Sized + Serialize,
    V: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.obj.0.env);
    self.obj.set_property(
      JsString(key.serialize(Ser::new(&env))?, std::marker::PhantomData),
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    Ok(())
  }

  fn end(self) -> Result<Self::Ok> {
    Ok(self.obj.0)
  }
}

pub struct StructSerializer<'env> {
  obj: Object<'env>,
}

#[doc(hidden)]
impl ser::SerializeStruct for StructSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, key: &'static str, value: &T) -> StdResult<(), Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.obj.0.env);
    self.obj.set_named_property(
      key,
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    Ok(())
  }

  fn end(self) -> Result<Self::Ok> {
    Ok(self.obj.0)
  }
}

#[doc(hidden)]
impl ser::SerializeStructVariant for StructSerializer<'_> {
  type Ok = Value;
  type Error = Error;

  fn serialize_field<T>(&mut self, key: &'static str, value: &T) -> StdResult<(), Error>
  where
    T: ?Sized + Serialize,
  {
    let env = Env::from_raw(self.obj.0.env);
    self.obj.set_named_property(
      key,
      Unknown(value.serialize(Ser::new(&env))?, std::marker::PhantomData),
    )?;
    Ok(())
  }

  fn end(self) -> Result<Self::Ok> {
    Ok(self.obj.0)
  }
}
