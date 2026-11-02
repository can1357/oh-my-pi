use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, Hash};

#[cfg(feature = "object_indexmap")]
use indexmap::IndexMap;

use crate::bindgen_prelude::*;

impl<K, V, S> TypeName for HashMap<K, V, S> {
  fn type_name() -> &'static str {
    "HashMap"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<K: From<String> + Eq + Hash, V: FromNapiValue, S> ValidateNapiValue for HashMap<K, V, S> {}

impl<K, V, S> ToNapiValue for HashMap<K, V, S>
where
  K: AsRef<str>,
  V: ToNapiValue,
{
  #[cfg(not(feature = "noop"))]
  unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let env = Env::from(raw_env);
    #[cfg_attr(feature = "napi10", allow(unused_mut))]
    let mut obj = Object::new(&env)?;
    #[cfg(all(
      feature = "napi10",
      feature = "node_version_detect",
      feature = "dyn-symbols",
      not(feature = "noop"),
    ))]
    let node_version = NODE_VERSION.get().unwrap();
    for (k, v) in val.into_iter() {
      #[cfg(all(
        feature = "napi10",
        feature = "node_version_detect",
        feature = "dyn-symbols",
        not(feature = "noop"),
      ))]
      {
        if node_version.major >= 20 && node_version.minor >= 18 {
          fast_set_property(raw_env, obj.0.value, k, v)?;
        } else {
          obj.set(k.as_ref(), v)?;
        }
      }
      #[cfg(not(all(
        feature = "napi10",
        feature = "node_version_detect",
        feature = "dyn-symbols"
      )))]
      obj.set(k.as_ref(), v)?;
    }

    unsafe { Object::to_napi_value(raw_env, obj) }
  }

  #[cfg(feature = "noop")]
  unsafe fn to_napi_value(_env: sys::napi_env, _val: Self) -> Result<sys::napi_value> {
    unimplemented!("HashMap is not supported in noop mode");
  }
}

impl<K, V, S> FromNapiValue for HashMap<K, V, S>
where
  K: From<String> + Eq + Hash,
  V: FromNapiValue,
  S: Default + BuildHasher,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let obj = unsafe { Object::from_napi_value(env, napi_val)? };
    let keys = Object::keys(&obj)?;
    let mut map: HashMap<K, V, S> = HashMap::with_capacity_and_hasher(keys.len(), S::default());
    for key in keys.into_iter() {
      if let Some(val) = obj.get(&key)? {
        map.insert(K::from(key), val);
      }
    }

    Ok(map)
  }
}

impl<K, V> TypeName for BTreeMap<K, V> {
  fn type_name() -> &'static str {
    "BTreeMap"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

impl<K: From<String> + Ord, V: FromNapiValue> ValidateNapiValue for BTreeMap<K, V> {}

impl<K, V> ToNapiValue for BTreeMap<K, V>
where
  K: AsRef<str>,
  V: ToNapiValue,
{
  #[cfg(not(feature = "noop"))]
  unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let env = Env::from(raw_env);
    #[cfg_attr(feature = "napi10", allow(unused_mut))]
    let mut obj = Object::new(&env)?;
    #[cfg(all(
      feature = "napi10",
      feature = "node_version_detect",
      feature = "dyn-symbols",
      not(feature = "noop"),
    ))]
    let node_version = NODE_VERSION.get().unwrap();
    for (k, v) in val.into_iter() {
      #[cfg(all(
        feature = "napi10",
        feature = "node_version_detect",
        feature = "dyn-symbols",
        not(feature = "noop"),
      ))]
      {
        if node_version.major >= 20 && node_version.minor >= 18 {
          fast_set_property(raw_env, obj.0.value, k, v)?;
        } else {
          obj.set(k.as_ref(), v)?;
        }
      }
      #[cfg(not(all(
        feature = "napi10",
        feature = "node_version_detect",
        feature = "dyn-symbols"
      )))]
      obj.set(k.as_ref(), v)?;
    }

    unsafe { Object::to_napi_value(raw_env, obj) }
  }

  #[cfg(feature = "noop")]
  unsafe fn to_napi_value(_env: sys::napi_env, _val: Self) -> Result<sys::napi_value> {
    unimplemented!("BTreeMap is not supported in noop mode");
  }
}

impl<K, V> FromNapiValue for BTreeMap<K, V>
where
  K: From<String> + Ord,
  V: FromNapiValue,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let obj = unsafe { Object::from_napi_value(env, napi_val)? };
    let mut map = BTreeMap::default();
    for key in Object::keys(&obj)?.into_iter() {
      if let Some(val) = obj.get(&key)? {
        map.insert(K::from(key), val);
      }
    }

    Ok(map)
  }
}

#[cfg(feature = "object_indexmap")]
impl<K, V, S> TypeName for IndexMap<K, V, S> {
  fn type_name() -> &'static str {
    "IndexMap"
  }

  fn value_type() -> ValueType {
    ValueType::Object
  }
}

#[cfg(feature = "object_indexmap")]
impl<K: From<String> + Hash + Eq, V: FromNapiValue> ValidateNapiValue for IndexMap<K, V> {}

#[cfg(feature = "object_indexmap")]
impl<K, V, S> ToNapiValue for IndexMap<K, V, S>
where
  K: AsRef<str>,
  V: ToNapiValue,
  S: Default + BuildHasher,
{
  #[cfg(not(feature = "noop"))]
  unsafe fn to_napi_value(raw_env: sys::napi_env, val: Self) -> Result<sys::napi_value> {
    let env = Env::from(raw_env);
    #[cfg_attr(feature = "napi10", allow(unused_mut))]
    let mut obj = Object::new(&env)?;
    #[cfg(all(
      feature = "napi10",
      feature = "node_version_detect",
      feature = "dyn-symbols",
      not(feature = "noop"),
    ))]
    let node_version = NODE_VERSION.get().unwrap();
    for (k, v) in val.into_iter() {
      #[cfg(all(
        feature = "napi10",
        feature = "node_version_detect",
        feature = "dyn-symbols",
        not(feature = "noop"),
      ))]
      {
        if node_version.major >= 20 && node_version.minor >= 18 {
          fast_set_property(raw_env, obj.0.value, k, v)?;
        } else {
          obj.set(k.as_ref(), v)?;
        }
      }
      #[cfg(not(all(
        feature = "experimental",
        feature = "node_version_detect",
        feature = "dyn-symbols"
      )))]
      obj.set(k.as_ref(), v)?;
    }

    unsafe { Object::to_napi_value(raw_env, obj) }
  }

  #[cfg(feature = "noop")]
  unsafe fn to_napi_value(_env: sys::napi_env, _val: Self) -> Result<sys::napi_value> {
    unimplemented!("BTreeMap is not supported in noop mode");
  }
}

#[cfg(feature = "object_indexmap")]
impl<K, V, S> FromNapiValue for IndexMap<K, V, S>
where
  K: From<String> + Hash + Eq,
  V: FromNapiValue,
  S: Default + BuildHasher,
{
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> Result<Self> {
    let obj = unsafe { Object::from_napi_value(env, napi_val)? };
    let mut map = IndexMap::default();
    for key in Object::keys(&obj)?.into_iter() {
      if let Some(val) = obj.get(&key)? {
        map.insert(K::from(key), val);
      }
    }

    Ok(map)
  }
}

#[cfg(all(
  feature = "napi10",
  feature = "node_version_detect",
  feature = "dyn-symbols",
  not(feature = "noop"),
))]
fn fast_set_property<K: AsRef<str>, V: ToNapiValue>(
  raw_env: sys::napi_env,
  obj: sys::napi_value,
  k: K,
  v: V,
) -> Result<()> {
  let mut property_key = std::ptr::null_mut();
  check_status!(
    unsafe {
      sys::node_api_create_property_key_utf8(
        raw_env,
        k.as_ref().as_ptr().cast(),
        k.as_ref().len() as isize,
        &mut property_key,
      )
    },
    "Create property key failed"
  )?;
  check_status!(
    unsafe { sys::napi_set_property(raw_env, obj, property_key, V::to_napi_value(raw_env, v)?,) },
    "Failed to set property"
  )?;
  Ok(())
}
