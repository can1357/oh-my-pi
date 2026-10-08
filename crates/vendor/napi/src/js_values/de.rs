use serde::de::Visitor;
use serde::de::{DeserializeSeed, EnumAccess, MapAccess, SeqAccess, Unexpected, VariantAccess};

#[cfg(feature = "napi6")]
use crate::bindgen_runtime::BigInt;
use crate::{
  bindgen_runtime::{ArrayBuffer, BufferSlice, FromNapiValue, JsObjectValue, Object, Unknown},
  type_of, Error, JsValue, Result, Status, Value, ValueType,
};

pub struct De<'env>(pub(crate) &'env Value);
impl<'env> De<'env> {
  pub fn new(value: &'env Object<'env>) -> Self {
    Self(&value.0)
  }
}

#[doc(hidden)]
impl<'x> serde::de::Deserializer<'x> for &mut De<'_> {
  type Error = Error;

  fn deserialize_any<V>(self, visitor: V) -> Result<V::Value>
  where
    V: Visitor<'x>,
  {
    let js_value_type = type_of!(self.0.env, self.0.value)?;
    match js_value_type {
      ValueType::Null | ValueType::Undefined => visitor.visit_unit(),
      ValueType::Boolean => {
        let val: bool = unsafe { FromNapiValue::from_napi_value(self.0.env, self.0.value)? };
        visitor.visit_bool(val)
      }
      ValueType::Number => {
        let js_number: f64 = unsafe { FromNapiValue::from_napi_value(self.0.env, self.0.value)? };
        if (js_number.trunc() - js_number).abs() < f64::EPSILON {
          visitor.visit_i64(js_number as i64)
        } else {
          visitor.visit_f64(js_number)
        }
      }
      ValueType::String => visitor.visit_str(
        unsafe { <String as FromNapiValue>::from_napi_value(self.0.env, self.0.value) }?.as_str(),
      ),
      ValueType::Object => {
        let js_object = Object::from_raw(self.0.env, self.0.value);
        if js_object.is_array()? {
          let mut deserializer =
            JsArrayAccess::new(&js_object, js_object.get_array_length_unchecked()?);
          visitor.visit_seq(&mut deserializer)
        } else if js_object.is_typedarray()? {
          visitor.visit_bytes(unsafe { FromNapiValue::from_napi_value(self.0.env, self.0.value)? })
        } else if js_object.is_buffer()? {
          visitor.visit_bytes(&unsafe { BufferSlice::from_napi_value(self.0.env, self.0.value)? })
        } else if js_object.is_arraybuffer()? {
          let array_buf = unsafe { ArrayBuffer::from_napi_value(self.0.env, self.0.value)? };
          if array_buf.data.is_empty() {
            return visitor.visit_bytes(&[]);
          }
          visitor.visit_bytes(array_buf.data)
        } else {
          let mut deserializer = JsObjectAccess::new(&js_object)?;
          visitor.visit_map(&mut deserializer)
        }
      }
      #[cfg(feature = "napi6")]
      ValueType::BigInt => {
        let js_bigint = unsafe { BigInt::from_napi_value(self.0.env, self.0.value)? };

        let BigInt { sign_bit, words } = &js_bigint;
        let word_sized = words.len() < 2;

        match (sign_bit, word_sized) {
          (true, true) => visitor.visit_i64(js_bigint.get_i64().0),
          (true, false) => visitor.visit_i128(js_bigint.get_i128().0),
          (false, true) => visitor.visit_u64(js_bigint.get_u64().1),
          (false, false) => visitor.visit_u128(js_bigint.get_u128().1),
        }
      }
      ValueType::External | ValueType::Function | ValueType::Symbol | ValueType::Unknown => {
        Err(Error::new(
          Status::InvalidArg,
          format!("typeof {js_value_type:?} value could not be deserialized"),
        ))
      }
    }
  }

  fn deserialize_bytes<V>(self, visitor: V) -> Result<V::Value>
  where
    V: Visitor<'x>,
  {
    let js_value_type = type_of!(self.0.env, self.0.value)?;
    match js_value_type {
      ValueType::Object => {
        let js_object = Object::from_raw(self.0.env, self.0.value);
        if js_object.is_buffer()? {
          return visitor
            .visit_bytes(&unsafe { BufferSlice::from_napi_value(self.0.env, self.0.value)? });
        } else if js_object.is_arraybuffer()? {
          let array_buf = unsafe { ArrayBuffer::from_napi_value(self.0.env, self.0.value)? };
          if array_buf.data.is_empty() {
            return visitor.visit_bytes(&[]);
          }
          return visitor.visit_bytes(array_buf.data);
        }
        visitor.visit_bytes(unsafe { FromNapiValue::from_napi_value(self.0.env, self.0.value)? })
      }
      _ => Err(Error::new(
        Status::InvalidArg,
        format!("{js_value_type:?} type could not deserialize to bytes"),
      )),
    }
  }

  fn deserialize_byte_buf<V>(self, visitor: V) -> Result<V::Value>
  where
    V: Visitor<'x>,
  {
    let js_value_type = type_of!(self.0.env, self.0.value)?;
    match js_value_type {
      ValueType::Object => {
        let js_object = Object::from_raw(self.0.env, self.0.value);
        if js_object.is_buffer()? {
          return visitor.visit_byte_buf(
            unsafe { BufferSlice::from_napi_value(self.0.env, self.0.value)? }.to_vec(),
          );
        } else if js_object.is_typedarray()? {
          return visitor.visit_byte_buf(unsafe {
            let u8_slice: &[u8] = FromNapiValue::from_napi_value(self.0.env, self.0.value)?;
            u8_slice.to_vec()
          });
        } else if js_object.is_arraybuffer()? {
          let array_buf = unsafe { ArrayBuffer::from_napi_value(self.0.env, self.0.value)? };
          if array_buf.data.is_empty() {
            return visitor.visit_byte_buf(Vec::new());
          }
          return visitor.visit_byte_buf(array_buf.data.to_vec());
        }
        visitor.visit_byte_buf(unsafe { FromNapiValue::from_napi_value(self.0.env, self.0.value)? })
      }
      _ => Err(Error::new(
        Status::InvalidArg,
        format!("{js_value_type:?} type could not deserialize to bytes"),
      )),
    }
  }

  fn deserialize_option<V>(self, visitor: V) -> Result<V::Value>
  where
    V: Visitor<'x>,
  {
    match type_of!(self.0.env, self.0.value)? {
      ValueType::Undefined | ValueType::Null => visitor.visit_none(),
      _ => visitor.visit_some(self),
    }
  }

  fn deserialize_enum<V>(
    self,
    _name: &'static str,
    _variants: &'static [&'static str],
    visitor: V,
  ) -> Result<V::Value>
  where
    V: Visitor<'x>,
  {
    let js_value_type = type_of!(self.0.env, self.0.value)?;
    match js_value_type {
      ValueType::String => visitor.visit_enum(JsEnumAccess::new(
        unsafe { FromNapiValue::from_napi_value(self.0.env, self.0.value) }?,
        None,
      )),
      ValueType::Object => {
        let js_object = Object::from_raw(self.0.env, self.0.value);
        let properties = js_object.get_property_names()?;
        let property_len = properties.get_array_length_unchecked()?;
        if property_len != 1 {
          Err(Error::new(
            Status::InvalidArg,
            format!("object key length: {property_len}, can not deserialize to Enum"),
          ))
        } else {
          let key = properties.get_element::<String>(0)?;
          let value: Unknown = js_object.get_named_property_unchecked(&key)?;
          visitor.visit_enum(JsEnumAccess::new(key, Some(&value.0)))
        }
      }
      _ => Err(Error::new(
        Status::InvalidArg,
        format!("{js_value_type:?} type could not deserialize to Enum type"),
      )),
    }
  }

  fn deserialize_ignored_any<V>(self, visitor: V) -> Result<V::Value>
  where
    V: Visitor<'x>,
  {
    visitor.visit_unit()
  }

  forward_to_deserialize_any! {
     <V: Visitor<'x>>
      bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
      unit unit_struct seq tuple tuple_struct map struct identifier
      newtype_struct
  }
}

#[doc(hidden)]
pub(crate) struct JsEnumAccess<'env> {
  variant: String,
  value: Option<&'env Value>,
}

#[doc(hidden)]
impl<'env> JsEnumAccess<'env> {
  fn new(variant: String, value: Option<&'env Value>) -> Self {
    Self { variant, value }
  }
}

#[doc(hidden)]
impl<'de, 'env> EnumAccess<'de> for JsEnumAccess<'env> {
  type Error = Error;
  type Variant = JsVariantAccess<'env>;

  fn variant_seed<V>(self, seed: V) -> Result<(V::Value, Self::Variant)>
  where
    V: DeserializeSeed<'de>,
  {
    use serde::de::IntoDeserializer;
    let variant = self.variant.into_deserializer();
    let variant_access = JsVariantAccess { value: self.value };
    seed.deserialize(variant).map(|v| (v, variant_access))
  }
}

#[doc(hidden)]
pub(crate) struct JsVariantAccess<'env> {
  value: Option<&'env Value>,
}

#[doc(hidden)]
impl<'de> VariantAccess<'de> for JsVariantAccess<'_> {
  type Error = Error;
  fn unit_variant(self) -> Result<()> {
    match self.value {
      Some(val) => {
        let mut deserializer = De(val);
        serde::de::Deserialize::deserialize(&mut deserializer)
      }
      None => Ok(()),
    }
  }

  fn newtype_variant_seed<T>(self, seed: T) -> Result<T::Value>
  where
    T: DeserializeSeed<'de>,
  {
    match self.value {
      Some(val) => {
        let mut deserializer = De(val);
        seed.deserialize(&mut deserializer)
      }
      None => Err(serde::de::Error::invalid_type(
        Unexpected::UnitVariant,
        &"newtype variant",
      )),
    }
  }

  fn tuple_variant<V>(self, _len: usize, visitor: V) -> Result<V::Value>
  where
    V: Visitor<'de>,
  {
    match self.value {
      Some(js_value) => {
        let js_object = Object::from_raw(js_value.env, js_value.value);
        if js_object.is_array()? {
          let mut deserializer =
            JsArrayAccess::new(&js_object, js_object.get_array_length_unchecked()?);
          visitor.visit_seq(&mut deserializer)
        } else {
          Err(serde::de::Error::invalid_type(
            Unexpected::Other("JsValue"),
            &"tuple variant",
          ))
        }
      }
      None => Err(serde::de::Error::invalid_type(
        Unexpected::UnitVariant,
        &"tuple variant",
      )),
    }
  }

  fn struct_variant<V>(self, _fields: &'static [&'static str], visitor: V) -> Result<V::Value>
  where
    V: Visitor<'de>,
  {
    match self.value {
      Some(js_value) => {
        if let Ok(val) = unsafe { Object::from_napi_value(js_value.env, js_value.value) } {
          let mut deserializer = JsObjectAccess::new(&val)?;
          visitor.visit_map(&mut deserializer)
        } else {
          Err(serde::de::Error::invalid_type(
            Unexpected::Other("JsValue"),
            &"struct variant",
          ))
        }
      }
      _ => Err(serde::de::Error::invalid_type(
        Unexpected::UnitVariant,
        &"struct variant",
      )),
    }
  }
}

#[doc(hidden)]
struct JsArrayAccess<'env> {
  input: &'env Object<'env>,
  idx: u32,
  len: u32,
}

#[doc(hidden)]
impl<'env> JsArrayAccess<'env> {
  fn new(input: &'env Object, len: u32) -> Self {
    Self { input, idx: 0, len }
  }
}

#[doc(hidden)]
impl<'de> SeqAccess<'de> for JsArrayAccess<'_> {
  type Error = Error;

  fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>>
  where
    T: DeserializeSeed<'de>,
  {
    if self.idx >= self.len {
      return Ok(None);
    }
    let v = self.input.get_element::<Unknown>(self.idx)?;
    self.idx += 1;

    let mut de = De(&v.0);
    seed.deserialize(&mut de).map(Some)
  }
}

#[doc(hidden)]
pub(crate) struct JsObjectAccess<'env> {
  value: &'env Object<'env>,
  properties: Object<'env>,
  idx: u32,
  property_len: u32,
}

#[doc(hidden)]
impl<'env> JsObjectAccess<'env> {
  fn new(value: &'env Object) -> Result<Self> {
    let properties = value.get_property_names()?;
    let property_len = properties.get_array_length_unchecked()?;
    Ok(Self {
      value,
      properties,
      idx: 0,
      property_len,
    })
  }
}

#[doc(hidden)]
impl<'de> MapAccess<'de> for JsObjectAccess<'_> {
  type Error = Error;

  fn next_key_seed<K>(&mut self, seed: K) -> Result<Option<K::Value>>
  where
    K: DeserializeSeed<'de>,
  {
    if self.idx >= self.property_len {
      return Ok(None);
    }

    let prop_name = self.properties.get_element::<Unknown>(self.idx)?;

    let mut de = De(&prop_name.0);
    seed.deserialize(&mut de).map(Some)
  }

  fn next_value_seed<V>(&mut self, seed: V) -> Result<V::Value>
  where
    V: DeserializeSeed<'de>,
  {
    if self.idx >= self.property_len {
      return Err(Error::new(
        Status::InvalidArg,
        format!("Index:{} out of range: {}", self.property_len, self.idx),
      ));
    }
    let prop_name = self.properties.get_element::<String>(self.idx)?;
    let value: Unknown = self.value.get_named_property_unchecked(&prop_name)?;

    self.idx += 1;
    let mut de = De(&value.0);
    let res = seed.deserialize(&mut de)?;
    Ok(res)
  }
}
