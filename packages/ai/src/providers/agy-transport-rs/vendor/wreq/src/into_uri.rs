//! URI conversion utilities.
//!
//! This module provides the [`IntoUri`] trait, allowing various types
//! (such as `&str`, `String`, `Vec<u8>`, etc.) to be fallibly converted into an [`http::Uri`].
//! The conversion is based on `TryFrom<T> for Uri` and ensures the resulting URI is valid and
//! contains a host.
//!
//! Internally, the trait is sealed to prevent

use bytes::Bytes;
use http::Uri;

use crate::{Error, Result};

/// Converts a value into a [`Uri`] with error handling.
///
/// This trait is implemented for common types such as [`Uri`], [`String`], [`&str`], and byte
/// slices, as well as any type that can be fallibly converted into a [`Uri`] via [`TryFrom`].
pub trait IntoUri: IntoUriSealed {}

impl IntoUri for Uri {}
impl IntoUri for &Uri {}
impl IntoUri for &str {}
impl IntoUri for String {}
impl IntoUri for &String {}
impl IntoUri for Vec<u8> {}
impl IntoUri for &[u8] {}

pub trait IntoUriSealed {
    // Besides parsing as a valid `Uri`.
    fn into_uri(self) -> Result<Uri>;
}

impl IntoUriSealed for &[u8] {
    fn into_uri(self) -> Result<Uri> {
        Uri::try_from(self)
            .or_else(|_| internal::parse(internal::Kind::Bytes(self)))
            .and_then(IntoUriSealed::into_uri)
    }
}

impl IntoUriSealed for Vec<u8> {
    fn into_uri(self) -> Result<Uri> {
        let bytes = Bytes::from(self);
        Uri::from_maybe_shared(bytes.clone())
            .or_else(|_| internal::parse(internal::Kind::Bytes(&bytes)))
            .and_then(IntoUriSealed::into_uri)
    }
}

impl IntoUriSealed for &str {
    fn into_uri(self) -> Result<Uri> {
        Uri::try_from(self)
            .or_else(|_| internal::parse(internal::Kind::Str(self)))
            .and_then(IntoUriSealed::into_uri)
    }
}

impl IntoUriSealed for String {
    #[inline]
    fn into_uri(self) -> Result<Uri> {
        self.into_bytes().into_uri()
    }
}

impl IntoUriSealed for &String {
    #[inline]
    fn into_uri(self) -> Result<Uri> {
        IntoUriSealed::into_uri(self.as_str())
    }
}

impl IntoUriSealed for Uri {
    fn into_uri(self) -> Result<Uri> {
        match (self.scheme(), self.authority()) {
            (Some(_), Some(_)) => Ok(self),
            _ => Err(Error::uri_bad_scheme(self)),
        }
    }
}

impl IntoUriSealed for &Uri {
    fn into_uri(self) -> Result<Uri> {
        match (self.scheme(), self.authority()) {
            (Some(_), Some(_)) => Ok(self.clone()),
            _ => Err(Error::uri_bad_scheme(self.clone())),
        }
    }
}

mod internal {
    use http::Uri;
    use url::Url;

    use crate::{Error, Result};

    pub(super) enum Kind<'a> {
        Bytes(&'a [u8]),
        Str(&'a str),
    }

    pub(super) fn parse(s: Kind) -> Result<Uri> {
        let s = match s {
            Kind::Bytes(bytes) => std::str::from_utf8(bytes).map_err(Error::decode),
            Kind::Str(s) => Ok(s),
        }?;

        Url::parse(s)
            .map(String::from)
            .map_err(Error::builder)
            .and_then(|s| Uri::try_from(s).map_err(Error::builder))
    }
}

#[cfg(test)]
mod tests {
    use super::IntoUriSealed;

    #[test]
    fn into_uri_bad_scheme() {
        let err = "/hello/world".into_uri().unwrap_err();
        assert_eq!(
            err.to_string(),
            "builder error for uri (/hello/world): URI scheme is not allowed"
        );

        let err = "127.0.0.1".into_uri().unwrap_err();
        assert_eq!(
            err.to_string(),
            "builder error for uri (127.0.0.1): URI scheme is not allowed"
        );
    }

    #[test]
    fn into_uri_with_space_in_path() {
        let uri = "http://example.com/hello world".into_uri().unwrap();
        assert_eq!(uri, "http://example.com/hello%20world");
    }

    #[test]
    fn into_uri_with_unicode_in_path() {
        let uri = "http://example.com/文件/测试".into_uri().unwrap();
        assert_eq!(uri, "http://example.com/文件/测试");
    }

    #[test]
    fn into_uri_with_special_chars_in_path() {
        let uri = "http://example.com/path<>{}".into_uri().unwrap();
        assert_eq!(uri, "http://example.com/path%3C%3E%7B%7D");
    }

    #[test]
    fn into_uri_with_query_preserved() {
        let uri = "http://example.com/path?key=value&foo=bar"
            .into_uri()
            .unwrap();
        assert_eq!(uri, "http://example.com/path?key=value&foo=bar");
    }

    #[test]
    fn into_uri_bytes_with_encoding() {
        let bytes = b"http://example.com/hello world";
        let uri = bytes.into_uri().unwrap();
        assert_eq!(uri, "http://example.com/hello%20world");
    }

    #[test]
    fn test_bytes_with_query() {
        let bytes = b"http://example.com/path?key=hello%20world";
        let uri = bytes.into_uri().unwrap();
        assert_eq!(uri.to_string(), "http://example.com/path?key=hello%20world");
    }

    #[test]
    fn test_bytes_with_unicode() {
        let bytes = b"http://example.com/\xE6\xB5\x8B\xE8\xAF\x95";
        let uri = bytes.into_uri().unwrap();
        assert_eq!(uri, "http://example.com/测试");
    }

    #[test]
    fn test_bytes_minimal() {
        let bytes = b"http://example.com";
        let uri = bytes.into_uri().unwrap();
        assert_eq!(uri, "http://example.com");
    }
}
