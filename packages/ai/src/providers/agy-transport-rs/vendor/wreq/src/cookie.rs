//! HTTP cookie storage and request selection.
//!
//! [`Jar`] stores cookies received through `Set-Cookie` response fields and selects the cookies
//! that apply to later requests. Domain, path, security, and expiration checks follow the
//! [RFC 6265 storage and retrieval model]. [`CookieStore`] can be implemented to provide another
//! storage backend while keeping the same client integration.
//!
//! [RFC 6265 storage and retrieval model]: https://www.rfc-editor.org/rfc/rfc6265.html#section-5

mod jar;
mod store;

use std::{convert::TryInto, fmt, sync::Arc, time::SystemTime};

use cookie::{Cookie as RawCookie, Expiration, SameSite};
use http::{Uri, Version};
use url::Host;

pub use self::jar::Jar;
use crate::{error::Error, header::HeaderValue};

/// A parsed HTTP cookie with optional [`Jar`] storage metadata.
#[derive(Debug, Clone)]
pub struct Cookie<'a> {
    inner: RawCookie<'a>,
    host: Option<Host<Box<str>>>,
}

impl<'a> Cookie<'a> {
    pub(crate) fn parse(value: &'a HeaderValue) -> crate::Result<Cookie<'a>> {
        std::str::from_utf8(value.as_bytes())
            .map_err(cookie::ParseError::from)
            .and_then(cookie::Cookie::parse)
            .map_err(Error::decode)
            .map(|cookie| Cookie {
                inner: cookie,
                host: None,
            })
    }

    #[inline]
    fn with_host(mut self, host: Host<Box<str>>) -> Self {
        self.host = Some(host);
        self
    }

    /// Returns the name of `self`.
    #[inline]
    pub fn name(&self) -> &str {
        self.inner.name()
    }

    /// Returns the value of `self`.
    ///
    /// Does not strip surrounding quotes.
    #[inline]
    pub fn value(&self) -> &str {
        self.inner.value()
    }

    /// Returns whether this cookie was marked `HttpOnly` or not.
    #[inline]
    pub fn http_only(&self) -> bool {
        self.inner.http_only().unwrap_or(false)
    }

    /// Returns whether this cookie was marked `Secure` or not.
    #[inline]
    pub fn secure(&self) -> bool {
        self.inner.secure().unwrap_or(false)
    }

    /// Returns whether the `SameSite` attribute of this cookie is `Lax`.
    #[inline]
    pub fn same_site_lax(&self) -> bool {
        self.inner.same_site() == Some(SameSite::Lax)
    }

    /// Returns whether the `SameSite` attribute of this cookie is `Strict`.
    #[inline]
    pub fn same_site_strict(&self) -> bool {
        self.inner.same_site() == Some(SameSite::Strict)
    }

    /// Returns the `Path` of the cookie if one was specified.
    #[inline]
    pub fn path(&self) -> Option<&str> {
        self.inner.path()
    }

    /// Returns the `Domain` of the cookie if one was specified.
    ///
    /// This does not consider whether the `Domain` is valid; validation is left to higher-level
    /// libraries, as needed. However, if the `Domain` starts with a leading `.`, the leading `.` is
    /// stripped.
    #[inline]
    pub fn domain(&self) -> Option<&str> {
        self.inner.domain()
    }

    /// Returns the canonical host used to store this cookie.
    ///
    /// Cookies returned by [`Jar`] query methods include this value.
    #[inline]
    pub fn host(&self) -> Option<Host<&str>> {
        self.host.as_ref().map(|host| match host {
            Host::Domain(domain) => Host::Domain(domain.as_ref()),
            Host::Ipv4(address) => Host::Ipv4(*address),
            Host::Ipv6(address) => Host::Ipv6(*address),
        })
    }

    /// Returns the specified max-age of the cookie if it is non-negative and representable.
    #[inline]
    pub fn max_age(&self) -> Option<std::time::Duration> {
        self.inner.max_age().and_then(|d| d.try_into().ok())
    }

    /// Returns the expiration date-time of the cookie if one was specified.
    ///
    /// Session cookies return `None`.
    #[inline]
    pub fn expires(&self) -> Option<SystemTime> {
        match self.inner.expires() {
            Some(Expiration::DateTime(offset)) => Some(SystemTime::from(offset)),
            None | Some(Expiration::Session) => None,
        }
    }

    /// Converts `self` into a `Cookie` with a static lifetime with as few allocations as possible.
    #[inline]
    pub fn into_owned(self) -> Cookie<'static> {
        Cookie {
            inner: self.inner.into_owned(),
            host: self.host,
        }
    }
}

impl fmt::Display for Cookie<'_> {
    #[inline]
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        self.inner.fmt(f)
    }
}

impl<'c> From<RawCookie<'c>> for Cookie<'c> {
    #[inline]
    fn from(cookie: RawCookie<'c>) -> Cookie<'c> {
        Cookie {
            inner: cookie,
            host: None,
        }
    }
}

impl<'c> From<Cookie<'c>> for RawCookie<'c> {
    #[inline]
    fn from(cookie: Cookie<'c>) -> RawCookie<'c> {
        cookie.inner
    }
}

/// Serialized `Cookie` field values selected for an outgoing request.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Cookies {
    /// All cookie pairs combined into one field value.
    Compressed(HeaderValue),

    /// Each cookie pair stored as a separate field value.
    Uncompressed(Vec<HeaderValue>),

    /// No cookie applies to the request.
    Empty,
}

/// Thread-safe cookie storage used by [`crate::Client`].
///
/// Implementors receive `Set-Cookie` response fields through [`set_cookies`](Self::set_cookies)
/// and produce `Cookie` request fields through [`cookies`](Self::cookies). Implementations are
/// responsible for applying the [RFC 6265 storage and retrieval model].
///
/// [RFC 6265 storage and retrieval model]: https://www.rfc-editor.org/rfc/rfc6265.html#section-5
pub trait CookieStore: Send + Sync {
    /// Stores `Set-Cookie` field values received from `uri`.
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, uri: &Uri);

    /// Serializes the cookies that apply to `uri` for the requested HTTP version.
    ///
    /// HTTP/1.1 combines cookie pairs into one field value using the format from
    /// [RFC 6265 section 5.4]. HTTP/2 and HTTP/3 may split them across field lines to improve
    /// compression, as described by [RFC 9113 section 8.2.3] and [RFC 9114 section 4.2.1].
    ///
    /// [RFC 6265 section 5.4]: https://www.rfc-editor.org/rfc/rfc6265.html#section-5.4
    /// [RFC 9113 section 8.2.3]: https://www.rfc-editor.org/rfc/rfc9113.html#section-8.2.3
    /// [RFC 9114 section 4.2.1]: https://www.rfc-editor.org/rfc/rfc9114.html#section-4.2.1
    fn cookies(&self, uri: &Uri, version: Version) -> Cookies;
}

/// Converts cookie stores into a shared [`CookieStore`].
pub trait IntoCookieStore {
    /// Converts this value into a shared cookie store.
    fn into_shared(self) -> Arc<dyn CookieStore>;
}

impl IntoCookieStore for Arc<dyn CookieStore> {
    #[inline]
    fn into_shared(self) -> Arc<dyn CookieStore> {
        self
    }
}

impl<S: CookieStore + 'static> IntoCookieStore for Arc<S> {
    #[inline]
    fn into_shared(self) -> Arc<dyn CookieStore> {
        self
    }
}

impl<S: CookieStore + 'static> IntoCookieStore for S {
    #[inline]
    fn into_shared(self) -> Arc<dyn CookieStore> {
        Arc::new(self)
    }
}

impl_request_config_value!(Arc<dyn CookieStore>);

/// Converts cookie-like values into an owned [`Cookie`].
///
/// String implementations return `None` when the value cannot be parsed as a `Set-Cookie` value.
pub trait IntoCookie {
    /// Converts this value into an optional owned [`Cookie`].
    fn into_cookie(self) -> Option<Cookie<'static>>;
}

impl IntoCookie for Cookie<'_> {
    #[inline]
    fn into_cookie(self) -> Option<Cookie<'static>> {
        Some(self.into_owned())
    }
}

impl IntoCookie for cookie::Cookie<'_> {
    #[inline]
    fn into_cookie(self) -> Option<Cookie<'static>> {
        Some(Cookie::from(self.into_owned()))
    }
}

impl IntoCookie for &str {
    #[inline]
    fn into_cookie(self) -> Option<Cookie<'static>> {
        cookie::Cookie::parse(self)
            .map(|cookie| Cookie::from(cookie.into_owned()))
            .ok()
    }
}

impl IntoCookie for String {
    #[inline]
    fn into_cookie(self) -> Option<Cookie<'static>> {
        cookie::Cookie::parse(self).map(Cookie::from).ok()
    }
}
