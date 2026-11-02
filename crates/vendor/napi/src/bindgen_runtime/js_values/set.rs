use std::collections::{BTreeSet, HashSet};
use std::hash::{BuildHasher, Hash};

#[cfg(feature = "object_indexmap")]
use indexmap::IndexSet;

use crate::bindgen_prelude::*;

impl<V, S> TypeName for HashSet<V, S> {
  fn type_name() -> &'static str {
    "HashSet"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<V: FromNapiValue, S> ValidateNapiValue for HashSet<V, S> {}

impl<V, S> ToNapiValue for HashSet<V, S>
where
  V: ToNapiValue,
{
  unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let env = Env::from(raw_env);
    let obj = env.get_global()?;
    let set_class = obj.get_named_property_unchecked::<Function<'_, Array, ()>>("Set")?;
    let set = set_class.new_instance(Array::from_vec(&env, val.into_iter().collect())?)?;

    Ok(set.0.value)
  }
}

impl<V, S> FromNapiValue for HashSet<V, S>
where
  V: FromNapiValue + PartialEq + Eq + Hash,
  S: Default + BuildHasher,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let obj = Object::from_raw(env, napi_val);
    let mut set = HashSet::default();
    let iter_creator: Function<'_, (), Object> = obj.get_named_property("values")?;
    let iter = iter_creator.apply(obj, ())?;
    let next: Function<'_, (), Object> = iter.get_named_property("next")?;
    while {
      let o: Object = next.apply(iter, ())?;
      let done: bool = o.get_named_property("done")?;
      if !done {
        let v = o.get_named_property_unchecked::<V>("value")?;
        set.insert(v);
      }
      !done
    } {}
    Ok(set)
  }
}

impl<V> TypeName for BTreeSet<V> {
  fn type_name() -> &'static str {
    "BTreeSet"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<V: FromNapiValue> ValidateNapiValue for BTreeSet<V> {}

impl<V> ToNapiValue for BTreeSet<V>
where
  V: ToNapiValue,
{
  unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let env = Env::from(raw_env);
    let obj = env.get_global()?;
    let set_class = obj.get_named_property_unchecked::<Function<'_, Array, ()>>("Set")?;
    let set = set_class.new_instance(Array::from_vec(&env, val.into_iter().collect())?)?;

    Ok(set.0.value)
  }
}

impl<V> FromNapiValue for BTreeSet<V>
where
  V: FromNapiValue + Ord,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let obj = unsafe { Object::from_napi_value(env, napi_val)? };
    let mut set = BTreeSet::default();
    let iter_creator: Function<'_, (), Object> = obj.get_named_property("values")?;
    let iter = iter_creator.apply(obj, ())?;
    let next: Function<'_, (), Object> = iter.get_named_property("next")?;
    while {
      let o: Object = next.apply(iter, ())?;
      let done: bool = o.get_named_property("done")?;
      if !done {
        let v = o.get_named_property_unchecked::<V>("value")?;
        set.insert(v);
      }
      !done
    } {}
    Ok(set)
  }
}

#[cfg(feature = "object_indexmap")]
impl<V, S> TypeName for IndexSet<V, S> {
  fn type_name() -> &'static str {
    "IndexSet"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}
#[cfg(feature = "object_indexmap")]
impl<V: FromNapiValue, S> ValidateNapiValue for IndexSet<V, S> {}
#[cfg(feature = "object_indexmap")]
impl<V, S> ToNapiValue for IndexSet<V, S>
where
  V: ToNapiValue,
{
  unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let env = Env::from(raw_env);
    let obj = env.get_global()?;
    let set_class = obj.get_named_property_unchecked::<Function<'_, Array, ()>>("Set")?;
    let set = set_class.new_instance(Array::from_vec(&env, val.into_iter().collect())?)?;

    Ok(set.0.value)
  }
}
#[cfg(feature = "object_indexmap")]
impl<V, S> FromNapiValue for IndexSet<V, S>
where
  V: FromNapiValue + PartialEq + Eq + Hash,
  S: Default + BuildHasher,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let obj = Object::from_raw(env, napi_val);
    let mut set = IndexSet::default();
    let iter_creator: Function<'_, (), Object> = obj.get_named_property("values")?;
    let iter = iter_creator.apply(obj, ())?;
    let next: Function<'_, (), Object> = iter.get_named_property("next")?;
    while {
      let o: Object = next.apply(iter, ())?;
      let done: bool = o.get_named_property("done")?;
      if !done {
        let v = o.get_named_property_unchecked::<V>("value")?;
        set.insert(v);
      }
      !done
    } {}
    Ok(set)
  }
}
