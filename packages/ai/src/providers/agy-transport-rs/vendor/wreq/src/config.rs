//! The `config` module provides a generic mechanism for loading and managing
//! request-scoped configuration.
//!
//! # Design Overview
//!
//! This module is centered around two abstractions:
//!
//! - The [`RequestConfigValue`] trait, used to associate a config key type with its value type.
//! - The [`RequestConfig`] struct, which wraps an optional value of the type linked via
//!   [`RequestConfigValue`].
//!
//! Under the hood, the [`RequestConfig`] struct holds a single value for the associated config
//! type. This value can be conveniently accessed, inserted, or mutated using [`http::Extensions`],
//! enabling type-safe configuration storage and retrieval on a per-request basis.
//!
//! # Motivation
//!
//! The key design benefit is the ability to store multiple config types—potentially even with the
//! same value type (e.g., [`std::time::Duration`])—without code duplication or ambiguity. By
//! leveraging trait association, each config key is distinct at the type level, while code for
//! storage and access remains totally generic.
//!
//! # Usage
//!
//! Implement [`RequestConfigValue`] for any marker type you wish to use as a config key,
//! specifying the associated value type. Then use [`RequestConfig<T>`] in [`Extensions`]
//! to set or retrieve config values for each key type in a uniform way.

use http::Extensions;

/// Associate a marker key type with its associated value type stored in [`http::Extensions`].
/// Implement this trait for unit/marker types to declare the concrete `Value` used for that key.
pub(crate) trait RequestConfigValue: Clone + 'static {
    type Value: Clone + Send + Sync + 'static;
}

/// Typed wrapper that holds an optional configuration value for a given marker key `T`.
/// Instances of [`RequestConfig<T>`] are intended to be inserted into [`http::Extensions`].
#[derive(Clone, Copy)]
pub(crate) struct RequestConfig<T: RequestConfigValue>(Option<T::Value>);

impl<T: RequestConfigValue> Default for RequestConfig<T> {
    #[inline]
    fn default() -> Self {
        RequestConfig(None)
    }
}

impl<T> RequestConfig<T>
where
    T: RequestConfigValue,
{
    /// Creates a new `RequestConfig` with the provided value.
    #[inline]
    pub(crate) const fn new(v: Option<T::Value>) -> Self {
        RequestConfig(v)
    }

    /// Returns a reference to the inner value of this request-scoped configuration.
    #[inline]
    pub(crate) const fn as_ref(&self) -> Option<&T::Value> {
        self.0.as_ref()
    }

    /// Retrieve the value from the request-scoped configuration.
    ///
    /// If the request specifies a value, use that value; otherwise, attempt to retrieve it from the
    /// current instance (typically a client instance).
    #[inline]
    pub(crate) fn fetch<'a>(&'a self, ext: &'a Extensions) -> Option<&'a T::Value> {
        ext.get::<RequestConfig<T>>()
            .and_then(Self::as_ref)
            .or(self.as_ref())
    }

    /// Loads the internal value from the provided [`http::Extensions`], if present.
    ///
    /// This method attempts to remove a value of type [`RequestConfig<T>`] from the provided
    /// [`http::Extensions`]. If such a value exists, the current internal value is replaced with
    /// the removed value. If not, the internal value remains unchanged.
    #[inline]
    pub(crate) fn load(&mut self, ext: &mut Extensions) -> Option<&T::Value> {
        if let Some(value) = RequestConfig::<T>::remove(ext) {
            self.0.replace(value);
        }
        self.as_ref()
    }

    /// Removes and returns the value of this type from the given [`http::Extensions`],
    /// or returns a clone of the current value if not present.
    ///
    /// This method attempts to remove a [`RequestConfig<T>`] from the provided
    /// [`http::Extensions`]. If a value is found, it is returned. If not, the current value is
    /// cloned and returned instead.
    #[inline]
    pub(crate) fn take<'a>(&'a self, ext: &'a mut Extensions) -> Option<T::Value> {
        ext.remove().unwrap_or_else(|| self.clone()).0
    }

    /// Returns an immutable reference to the stored value from the given [`http::Extensions`], if
    /// present.
    ///
    /// Internally fetches [`RequestConfig<T>`] and returns a reference to its inner value, if set.
    #[inline]
    pub(crate) fn get(ext: &Extensions) -> Option<&T::Value> {
        ext.get::<RequestConfig<T>>()?.0.as_ref()
    }

    /// Returns a mutable reference to the inner value in [`http::Extensions`], inserting a default
    /// if missing.
    ///
    /// This ensures a [`RequestConfig<T>`] exists and returns a mutable reference to its inner
    /// `Option<T::Value>`.
    #[inline]
    pub(crate) fn get_mut(ext: &mut Extensions) -> &mut Option<T::Value> {
        &mut ext.get_or_insert_default::<RequestConfig<T>>().0
    }

    /// Removes and returns the stored value from the given [`http::Extensions`], if present.
    ///
    /// This consumes the [`RequestConfig<T>`] entry and extracts its inner value.
    #[inline]
    pub(crate) fn remove(ext: &mut Extensions) -> Option<T::Value> {
        ext.remove::<RequestConfig<T>>()?.0
    }
}

/// Implements [`RequestConfigValue`] for a given type.
macro_rules! impl_request_config_value {
    ($type:ty) => {
        impl crate::config::RequestConfigValue for $type {
            type Value = Self;
        }
    };
    ($type:ty, $value:ty) => {
        impl crate::config::RequestConfigValue for $type {
            type Value = $value;
        }
    };
}
