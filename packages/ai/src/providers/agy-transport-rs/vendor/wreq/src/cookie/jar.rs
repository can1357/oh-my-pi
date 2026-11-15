use bytes::Bytes;
use cookie::{
    Cookie as RawCookie,
    time::{Duration, OffsetDateTime},
};
use http::{Uri, Version};

use super::{
    Cookie, CookieStore, Cookies, IntoCookie,
    store::{DEFAULT_PATH, Store, canonical_host, cookie_is_expired, domain_match, normalize_path},
};
use crate::{IntoUri, ext::UriExt, header::HeaderValue, sync::RwLock};

/// A good default `CookieStore` implementation.
///
/// This is the implementation used when simply calling `cookie_store(true)`.
/// This type is exposed to allow creating one and filling it with some
/// existing cookies more easily, before creating a [`crate::Client`].
#[derive(Debug, Default)]
pub struct Jar(RwLock<Store>);

macro_rules! into_uri {
    ($expr:expr) => {
        match $expr.into_uri() {
            Ok(u) => u,
            Err(_) => return,
        }
    };
}

impl Jar {
    /// Returns an unexpired cookie by name for an exact URI scope.
    ///
    /// The URI host is canonicalized and its path is used as the exact stored cookie path. Use
    /// [`matches`](Self::matches) to select every cookie that would apply to a request URI through
    /// RFC domain and path matching. When both storage scopes contain the name, the older cookie is
    /// returned.
    ///
    /// # Example
    /// ```
    /// use wreq::cookie::Jar;
    /// let jar = Jar::default();
    /// jar.add("foo=bar; Path=/foo; Domain=example.com", "http://example.com/foo");
    /// let cookie = jar.get("foo", "http://example.com/foo").unwrap();
    /// assert_eq!(cookie.value(), "bar");
    /// ```
    pub fn get<U: IntoUri>(&self, name: &str, uri: U) -> Option<Cookie<'static>> {
        let uri = uri.into_uri().ok()?;
        let host = canonical_host(uri.host()?)?;
        let now = OffsetDateTime::now_utc();
        let store = self.0.read();
        let entry = store
            .cookies
            .get(&host)?
            .get(uri.path())?
            .entries(name)
            .filter(|entry| !cookie_is_expired(&entry.cookie, now))
            .min_by_key(|entry| entry.creation_index)?;

        Some(Cookie::from(entry.cookie.clone()).with_host(host))
    }

    /// Returns whether an unexpired cookie exists for an exact URI scope.
    ///
    /// This performs the same scope lookup as [`get`](Self::get) without cloning the cookie.
    pub fn contains<U: IntoUri>(&self, name: &str, uri: U) -> bool {
        let Ok(uri) = uri.into_uri() else {
            return false;
        };
        let Some(host) = uri.host().and_then(canonical_host) else {
            return false;
        };

        let now = OffsetDateTime::now_utc();

        self.0
            .read()
            .cookies
            .get(&host)
            .and_then(|path_map| path_map.get(uri.path()))
            .is_some_and(|cookie_map| {
                cookie_map
                    .entries(name)
                    .any(|entry| !cookie_is_expired(&entry.cookie, now))
            })
    }

    /// Returns all unexpired cookies in creation order.
    ///
    /// Each snapshot preserves its effective `Path` and canonical storage host. Host-only cookies
    /// keep `Domain` absent; use [`Cookie::host`] when restoring them.
    ///
    /// # Example
    /// ```
    /// use wreq::cookie::Jar;
    /// let source = Jar::default();
    /// source.add("session=abc; Secure", "https://example.com");
    ///
    /// let target = Jar::default();
    /// for cookie in source.get_all() {
    ///     if let Some(host) = cookie.host() {
    ///         let scheme = if cookie.secure() { "https" } else { "http" };
    ///         let uri = format!("{scheme}://{host}/");
    ///         target.add(cookie, uri);
    ///     }
    /// }
    /// assert_eq!(target.get_all().count(), 1);
    /// ```
    pub fn get_all(&self) -> impl Iterator<Item = Cookie<'static>> {
        let now = OffsetDateTime::now_utc();
        let mut cookies = self
            .0
            .read()
            .cookies
            .iter()
            .flat_map(|(host, path_map)| {
                path_map.values().flat_map(move |cookie_map| {
                    cookie_map.values().filter_map(move |entry| {
                        if cookie_is_expired(&entry.cookie, now) {
                            return None;
                        }

                        let cookie = Cookie::from(entry.cookie.clone()).with_host(host.clone());
                        Some((entry.creation_index, cookie))
                    })
                })
            })
            .collect::<Vec<_>>();
        cookies.sort_unstable_by_key(|(creation_index, _)| *creation_index);
        cookies.into_iter().map(|(_, cookie)| cookie)
    }

    /// Returns the number of unexpired cookies in the jar.
    ///
    /// Expired cookies are excluded even if their internal entries have not yet been overwritten or
    /// cleared.
    pub fn len(&self) -> usize {
        let now = OffsetDateTime::now_utc();
        self.0
            .read()
            .cookies
            .values()
            .flat_map(|path_map| path_map.values())
            .flat_map(|cookie_map| cookie_map.values())
            .filter(|entry| !cookie_is_expired(&entry.cookie, now))
            .count()
    }

    /// Returns `true` when the jar has no unexpired cookies.
    pub fn is_empty(&self) -> bool {
        let now = OffsetDateTime::now_utc();
        !self
            .0
            .read()
            .cookies
            .values()
            .flat_map(|path_map| path_map.values())
            .flat_map(|cookie_map| cookie_map.values())
            .any(|entry| !cookie_is_expired(&entry.cookie, now))
    }

    /// Returns the unexpired cookies that apply to an HTTP or HTTPS request URI.
    ///
    /// Selection applies domain matching, path matching, host-only scope, the `Secure` attribute,
    /// and expiration rules from the [RFC 6265 retrieval model]. Returned cookies are owned
    /// snapshots that preserve host-only scope. Unsupported URI schemes do not match any cookies.
    ///
    /// # Example
    ///
    /// ```
    /// use wreq::cookie::Jar;
    ///
    /// let jar = Jar::default();
    /// jar.add("root=1; Domain=example.com; Path=/", "https://example.com/");
    /// jar.add("api=2; Domain=example.com; Path=/api", "https://example.com/api");
    ///
    /// let cookies = jar
    ///     .matches("https://www.example.com/api/users")
    ///     .collect::<Vec<_>>();
    /// assert_eq!(cookies.len(), 2);
    /// assert!(cookies.iter().any(|cookie| cookie.name() == "root"));
    /// assert!(cookies.iter().any(|cookie| cookie.name() == "api"));
    /// ```
    ///
    /// [RFC 6265 retrieval model]: https://www.rfc-editor.org/rfc/rfc6265.html#section-5.4
    pub fn matches<U: IntoUri>(&self, uri: U) -> impl Iterator<Item = Cookie<'static>> {
        let Ok(uri) = uri.into_uri() else {
            return Vec::new().into_iter();
        };
        let Some(host) = uri.host().and_then(canonical_host) else {
            return Vec::new().into_iter();
        };

        let now = OffsetDateTime::now_utc();
        let store = self.0.read();
        store
            .matching_cookies(&uri, &host, now)
            .map(|(host, _, entry)| Cookie::from(entry.cookie.clone()).with_host(host.clone()))
            .collect::<Vec<_>>()
            .into_iter()
    }

    /// Stores a cookie received from a URI.
    ///
    /// The URI supplies the host-only domain and default path when those attributes are absent.
    /// Cookies with an invalid URI or an invalid or mismatched `Domain` are ignored. A non-positive
    /// `Max-Age` removes an existing cookie in the same scope, as required by the
    /// [RFC 6265 storage model]. A positive `Max-Age` is stored as an absolute deadline. Insecure
    /// origins cannot set `Secure` cookies or overlay an existing `Secure` cookie, following the
    /// [RFC 6265bis storage model].
    ///
    /// # Example
    ///
    /// ```
    /// use wreq::cookie::Jar;
    /// use cookie::CookieBuilder;
    /// let jar = Jar::default();
    /// let cookie = CookieBuilder::new("foo", "bar")
    ///     .domain("example.com")
    ///     .path("/")
    ///     .build();
    /// jar.add(cookie, "http://example.com");
    /// ```
    ///
    /// [RFC 6265 storage model]: https://www.rfc-editor.org/rfc/rfc6265.html#section-5.3
    /// [RFC 6265bis storage model]: https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-5.7
    pub fn add<C, U>(&self, cookie: C, uri: U)
    where
        C: IntoCookie,
        U: IntoUri,
    {
        if let Some(cookie) = cookie.into_cookie() {
            let uri = into_uri!(uri);
            let mut cookie: RawCookie<'static> = cookie.into();
            let secure_origin = uri.is_https();

            if cookie.secure() == Some(true) && !secure_origin {
                return;
            }

            // If the request-uri contains no host component:
            let Some(host) = uri.host().and_then(canonical_host) else {
                return;
            };
            let host_only = cookie.domain().is_none();

            // If the canonicalized request-host does not domain-match the
            // domain-attribute:
            //    Ignore the cookie entirely and abort these steps.
            //
            // RFC 6265 §5.3 + §5.1.3:
            // https://datatracker.ietf.org/doc/html/rfc6265#section-5.3
            // https://datatracker.ietf.org/doc/html/rfc6265#section-5.1.3
            let domain = if let Some(raw_domain) = cookie.domain() {
                let Some(domain) = canonical_host(raw_domain) else {
                    return;
                };
                if !domain_match(&host, &domain) {
                    return;
                }

                cookie.set_domain(domain.to_string());
                domain
            } else {
                host
            };

            // Max-Age takes precedence over Expires and is relative to when the cookie is
            // received. Store its effective deadline so every read path applies the same
            // expiration decision. RFC 6265 sections 5.2.2 and 5.3:
            // https://www.rfc-editor.org/rfc/rfc6265.html#section-5.2.2
            // https://www.rfc-editor.org/rfc/rfc6265.html#section-5.3
            let now = OffsetDateTime::now_utc();
            let expired = match cookie.max_age() {
                Some(max_age) if max_age <= Duration::ZERO => true,
                Some(max_age) => {
                    let deadline = now.saturating_add(max_age);
                    cookie.set_max_age(None);
                    cookie.set_expires(deadline);
                    false
                }
                None => cookie
                    .expires_datetime()
                    .is_some_and(|deadline| deadline <= now),
            };

            // If the request-uri contains no path component or if the first character of the
            // path component of the request-uri is not a %x2F ("/") OR if the cookie's path-
            // attribute is missing or does not start with a %x2F ("/"):
            //    Let cookie-path be the default-path of the request-uri.
            // Otherwise:
            //    Let cookie-path be the substring of the request-uri's path from the first
            // character    up to, not including, the right-most %x2F ("/").
            //
            // RFC 6265 §5.2.4 + §5.1.4:
            // https://datatracker.ietf.org/doc/html/rfc6265#section-5.2.4
            // https://datatracker.ietf.org/doc/html/rfc6265#section-5.1.4
            let path = cookie
                .path()
                .filter(|path| path.starts_with(DEFAULT_PATH))
                .unwrap_or_else(|| normalize_path(uri.path()))
                .to_owned();

            let mut store = self.0.write();
            if !secure_origin
                && store.would_overlay_secure_cookie(cookie.name(), &domain, &path, now)
            {
                return;
            }

            if expired {
                store.remove_stored_cookie(&domain, &path, cookie.name(), host_only);
            } else {
                cookie.set_path(path.clone());
                store.insert_stored_cookie(domain, path, cookie);
            }
        }
    }

    /// Removes a cookie from an exact URI scope.
    ///
    /// The URI host and path identify the stored scope. Both host-only and `Domain` cookies with
    /// the same name in that scope are removed; other domains and paths are left unchanged.
    ///
    /// # Example
    /// ```
    /// use wreq::cookie::Jar;
    /// let jar = Jar::default();
    /// jar.add("foo=bar; Path=/foo; Domain=example.com", "http://example.com/foo");
    /// assert!(jar.get("foo", "http://example.com/foo").is_some());
    /// jar.remove("foo", "http://example.com/foo");
    /// assert!(jar.get("foo", "http://example.com/foo").is_none());
    /// ```
    pub fn remove<C, U>(&self, cookie: C, uri: U)
    where
        C: Into<RawCookie<'static>>,
        U: IntoUri,
    {
        let uri = into_uri!(uri);
        if let Some(host) = uri.host() {
            let Some(host) = canonical_host(host) else {
                return;
            };
            let cookie = cookie.into();
            let mut store = self.0.write();
            store.remove_stored_cookies(&host, uri.path(), cookie.name());
        }
    }

    /// Removes every cookie from the jar, leaving it empty.
    ///
    /// # Example
    /// ```
    /// use wreq::cookie::Jar;
    /// let jar = Jar::default();
    /// jar.add("foo=bar; Domain=example.com", "http://example.com");
    /// assert_eq!(jar.get_all().count(), 1);
    /// jar.clear();
    /// assert_eq!(jar.get_all().count(), 0);
    /// ```
    pub fn clear(&self) {
        *self.0.write() = Store::default();
    }
}

impl CookieStore for Jar {
    fn set_cookies(&self, cookie_headers: &mut dyn Iterator<Item = &HeaderValue>, uri: &Uri) {
        let cookies = cookie_headers
            .map(Cookie::parse)
            .filter_map(Result::ok)
            .map(|cookie| RawCookie::from(cookie).into_owned());

        for cookie in cookies {
            self.add(cookie, uri);
        }
    }

    fn cookies(&self, uri: &Uri, version: Version) -> Cookies {
        let host = match uri.host() {
            Some(host) => match canonical_host(host) {
                Some(host) => host,
                None => return Cookies::Empty,
            },
            None => return Cookies::Empty,
        };

        let now = OffsetDateTime::now_utc();
        let store = self.0.read();
        let mut matches = store.matching_cookies(uri, &host, now).collect::<Vec<_>>();

        // Chromium sorts cookies selected for a request by longest path first, then oldest
        // creation time. Cookie names and domains do not participate in the comparison.
        // RFC 6265 section 5.4: https://www.rfc-editor.org/rfc/rfc6265.html#section-5.4
        // Chromium: https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_monster.cc
        matches.sort_unstable_by(|(_, left_path, left), (_, right_path, right)| {
            right_path
                .len()
                .cmp(&left_path.len())
                .then_with(|| left.creation_index.cmp(&right.creation_index))
        });

        let iter = matches.into_iter().map(|(_, _, entry)| &entry.cookie);

        if matches!(version, Version::HTTP_2 | Version::HTTP_3) {
            let cookies = iter
                .map(|cookie| {
                    let name = cookie.name();
                    let value = cookie.value();

                    let mut cookie_str = String::with_capacity(name.len() + 1 + value.len());
                    cookie_str.push_str(name);
                    cookie_str.push('=');
                    cookie_str.push_str(value);

                    HeaderValue::from_maybe_shared(Bytes::from(cookie_str))
                })
                .filter_map(Result::ok)
                .collect();

            Cookies::Uncompressed(cookies)
        } else {
            let cookies = iter.fold(String::new(), |mut cookies, cookie| {
                if !cookies.is_empty() {
                    cookies.push_str("; ");
                }
                cookies.push_str(cookie.name());
                cookies.push('=');
                cookies.push_str(cookie.value());
                cookies
            });

            if cookies.is_empty() {
                return Cookies::Empty;
            }

            HeaderValue::from_maybe_shared(Bytes::from(cookies))
                .map(Cookies::Compressed)
                .unwrap_or(Cookies::Empty)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        net::{Ipv4Addr, Ipv6Addr},
        thread,
        time::Duration as StdDuration,
    };

    use http::{Uri, Version};
    use url::Host;

    use super::{CookieStore, Cookies, Jar};

    #[test]
    fn jar_get_all_preserves_host_only_scope_and_effective_path() {
        let jar = Jar::default();
        jar.add("session=abc", "http://example.com/foo/bar");

        let cookies = jar.get_all().collect::<Vec<_>>();
        assert_eq!(cookies.len(), 1);

        let cookie = &cookies[0];
        assert_eq!(cookie.name(), "session");
        assert_eq!(cookie.value(), "abc");
        assert_eq!(cookie.domain(), None);
        assert_eq!(cookie.path(), Some("/foo"));
    }

    #[test]
    fn jar_get_all_keeps_existing_domain_and_path() {
        let jar = Jar::default();
        jar.add(
            "session=abc; Domain=example.com; Path=/custom",
            "http://example.com/foo/bar",
        );

        let cookies = jar.get_all().collect::<Vec<_>>();
        assert_eq!(cookies.len(), 1);

        let cookie = &cookies[0];
        assert_eq!(cookie.name(), "session");
        assert_eq!(cookie.value(), "abc");
        assert_eq!(cookie.domain(), Some("example.com"));
        assert_eq!(cookie.path(), Some("/custom"));
    }

    #[test]
    fn jar_get_all_preserves_explicit_domain_and_host_only_scope() {
        let jar = Jar::default();
        jar.add("a=1; Domain=example.com", "http://example.com/foo/bar");
        jar.add("b=2; Path=/fixed", "http://example.com/foo/bar");

        let mut cookies = jar.get_all().collect::<Vec<_>>();
        cookies.sort_by(|left, right| left.name().cmp(right.name()));

        let a = &cookies[0];
        assert_eq!(a.name(), "a");
        assert_eq!(a.domain(), Some("example.com"));
        assert_eq!(a.path(), Some("/foo"));

        let b = &cookies[1];
        assert_eq!(b.name(), "b");
        assert_eq!(b.domain(), None);
        assert_eq!(b.path(), Some("/fixed"));
    }

    #[test]
    fn jar_add_rejects_mismatched_domain() {
        let jar = Jar::default();
        jar.add("session=abc; Domain=other.com", "http://example.com/foo");

        assert_eq!(jar.get_all().count(), 0);
    }

    #[test]
    fn jar_add_accepts_matching_parent_domain() {
        let jar = Jar::default();
        jar.add(
            "session=abc; Domain=example.com",
            "http://api.example.com/foo",
        );

        let cookies = jar.get_all().collect::<Vec<_>>();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].domain(), Some("example.com"));
    }

    #[test]
    fn jar_rejects_secure_cookie_from_insecure_origin() {
        let jar = Jar::default();

        jar.add("session=secure; Secure; Path=/", "http://example.com/");
        assert!(jar.is_empty());

        jar.add("session=plain; Path=/", "https://example.com/");
        jar.add(
            "session=gone; Secure; Max-Age=0; Path=/",
            "http://example.com/",
        );

        let cookie = jar
            .get("session", "https://example.com/")
            .expect("insecure deletion must not remove the stored cookie");
        assert_eq!(cookie.value(), "plain");
    }

    #[test]
    fn jar_blocks_insecure_cookie_that_overlays_secure_path() {
        let jar = Jar::default();
        jar.add(
            "session=secure; Secure; Domain=example.com; Path=/login",
            "https://example.com/login",
        );

        for cookie in [
            "session=exact; Domain=example.com; Path=/login",
            "session=deeper; Domain=example.com; Path=/login/profile",
            "session=gone; Domain=example.com; Path=/login; Max-Age=0",
        ] {
            jar.add(cookie, "http://example.com/login/profile");
        }

        // A shorter path does not overlay the existing Secure cookie.
        jar.add(
            "session=root; Domain=example.com; Path=/",
            "http://example.com/",
        );

        let uri = Uri::from_static("https://example.com/login/profile");
        match jar.cookies(&uri, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "session=secure; session=root"),
            other => panic!("expected protected Secure cookie, got {other:?}"),
        }
    }

    #[test]
    fn jar_blocks_secure_cookie_overlay_across_related_domains() {
        let parent = Jar::default();
        parent.add(
            "session=secure; Secure; Domain=example.com; Path=/",
            "https://example.com/",
        );
        parent.add(
            "session=child; Domain=api.example.com; Path=/",
            "http://api.example.com/",
        );
        assert_eq!(parent.get_all().count(), 1);

        let child = Jar::default();
        child.add(
            "session=secure; Secure; Domain=api.example.com; Path=/",
            "https://api.example.com/",
        );
        child.add(
            "session=parent; Domain=example.com; Path=/",
            "http://example.com/",
        );
        assert_eq!(child.get_all().count(), 1);
    }

    #[test]
    fn jar_allows_secure_origin_to_replace_secure_cookie() {
        let jar = Jar::default();
        let uri = "https://example.com/";
        jar.add("session=secure; Secure; Path=/", uri);
        jar.add("session=plain; Path=/", uri);

        let cookie = jar
            .get("session", uri)
            .expect("secure origin should replace the cookie");
        assert_eq!(cookie.value(), "plain");
        assert!(!cookie.secure());
    }

    #[test]
    fn jar_get_all_preserves_storage_scope() {
        let source = Jar::default();
        source.add("session=abc", "http://example.com/foo/bar");
        source.add("pref=dark; Domain=example.com", "http://www.example.com/");
        source.add("secure=1; Secure", "https://secure.example/");
        source.add("v6=1", "http://[::1]:8080/");
        source.add("v4=1", "http://127.0.0.1:8080/");

        let exported = source.get_all().collect::<Vec<_>>();
        assert_eq!(exported.len(), 5);

        let session = &exported[0];
        assert_eq!(session.host(), Some(Host::Domain("example.com")));
        assert_eq!(session.domain(), None);
        assert_eq!(session.path(), Some("/foo"));

        let pref = &exported[1];
        assert_eq!(pref.host(), Some(Host::Domain("example.com")));
        assert_eq!(pref.domain(), Some("example.com"));
        assert_eq!(exported[2].host(), Some(Host::Domain("secure.example")));
        assert_eq!(exported[3].host(), Some(Host::Ipv6(Ipv6Addr::LOCALHOST)));
        assert_eq!(exported[4].host(), Some(Host::Ipv4(Ipv4Addr::LOCALHOST)));

        let exact = source.get("session", "http://example.com/foo").unwrap();
        assert_eq!(exact.host(), Some(Host::Domain("example.com")));

        let matched = source
            .matches("http://example.com/foo/bar")
            .find(|cookie| cookie.name() == "session")
            .unwrap();
        assert_eq!(matched.host(), Some(Host::Domain("example.com")));

        let target = Jar::default();
        for cookie in exported {
            let scheme = if cookie.secure() { "https" } else { "http" };
            let uri = format!("{scheme}://{}/", cookie.host().unwrap());
            target.add(cookie, uri);
        }

        for uri in [
            "http://example.com/foo/bar",
            "http://api.example.com/",
            "https://secure.example/",
            "http://secure.example/",
            "http://[::1]:9999/",
            "http://127.0.0.1:9999/",
        ] {
            let uri = uri.parse::<Uri>().unwrap();
            assert_eq!(
                format!("{:?}", target.cookies(&uri, Version::HTTP_11)),
                format!("{:?}", source.cookies(&uri, Version::HTTP_11)),
                "restored jar should select the same cookies for {uri}"
            );
        }
    }

    #[test]
    fn jar_get_all_export_import_preserves_absolute_expiration() {
        let source = Jar::default();
        let uri = "http://example.com/";
        source.add("session=abc; Max-Age=60; Path=/", uri);

        let exported = source
            .get_all()
            .next()
            .expect("source cookie should be stored");
        let expires = exported.expires();
        assert_eq!(exported.max_age(), None);
        assert!(expires.is_some());

        let target = Jar::default();
        target.add(exported, uri);

        let imported = target
            .get("session", uri)
            .expect("snapshot should be imported");
        assert_eq!(imported.max_age(), None);
        assert_eq!(imported.expires(), expires);
    }

    #[test]
    fn jar_get_all_export_import_preserves_creation_order() {
        let source = Jar::default();
        let uri = "http://example.com/";
        source.add("B=first; Path=/", uri);
        source.add("A=second; Path=/", uri);

        let exported = source.get_all().collect::<Vec<_>>();
        assert_eq!(
            exported
                .iter()
                .map(|cookie| cookie.name())
                .collect::<Vec<_>>(),
            ["B", "A"]
        );

        let target = Jar::default();
        for cookie in exported {
            target.add(cookie, uri);
        }

        let uri = Uri::from_static("http://example.com/");
        match target.cookies(&uri, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "B=first; A=second"),
            other => panic!("expected imported Cookie field, got {other:?}"),
        }
    }

    #[test]
    fn cookie_store_invalid_explicit_path_falls_back_to_default_path() {
        let jar = Jar::default();
        jar.add("key=val; Path=noslash", "http://example.com/foo/bar");

        assert!(jar.get("key", "http://example.com/foo").is_some());
        assert!(jar.get("key", "http://example.com/noslash").is_none());

        let cookies = jar.get_all().collect::<Vec<_>>();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].path(), Some("/foo"));
    }

    #[test]
    fn jar_collection_queries_use_unexpired_exact_scopes() {
        let jar = Jar::default();
        assert!(jar.is_empty());
        assert_eq!(jar.len(), 0);

        jar.add("first=1; Path=/one", "https://example.com/one");
        jar.add("second=2; Path=/two", "https://example.com/two");

        assert_eq!(jar.len(), 2);
        assert!(!jar.is_empty());
        assert!(jar.contains("first", "https://example.com/one"));
        assert!(jar.contains("first", "https://EXAMPLE.COM/one"));
        assert!(!jar.contains("first", "https://example.com/one/child"));
        assert!(!jar.contains("first", "https://other.example/one"));
        assert!(!jar.contains("missing", "https://example.com/one"));
        assert!(!jar.contains("first", "/relative"));

        jar.add("first=updated; Path=/one", "https://example.com/one");
        assert_eq!(jar.len(), 2);
        assert_eq!(
            jar.get("first", "https://example.com/one")
                .map(|cookie| cookie.value().to_owned()),
            Some("updated".to_owned())
        );

        jar.remove("first", "https://example.com/one");
        assert_eq!(jar.len(), 1);
        assert!(!jar.contains("first", "https://example.com/one"));

        jar.clear();
        assert!(jar.is_empty());
    }

    #[test]
    fn jar_matches_request_scope() {
        let jar = Jar::default();
        jar.add("host=1; Path=/", "https://example.com/");
        jar.add(
            "domain=2; Domain=example.com; Path=/api",
            "https://example.com/api",
        );
        jar.add(
            "secure=3; Domain=example.com; Path=/; Secure",
            "https://example.com/",
        );
        jar.add(
            "http_only=4; Domain=example.com; Path=/api; HttpOnly",
            "https://example.com/api",
        );
        jar.add(
            "admin=5; Domain=example.com; Path=/admin",
            "https://example.com/admin",
        );
        jar.add("other=6; Domain=other.com; Path=/", "https://other.com/");

        let names = |uri| {
            let mut names = jar
                .matches(uri)
                .map(|cookie| cookie.name().to_owned())
                .collect::<Vec<_>>();
            names.sort();
            names
        };

        assert_eq!(
            names("https://api.example.com/api/users"),
            ["domain", "http_only", "secure"]
        );
        assert_eq!(
            names("http://api.example.com/api/users"),
            ["domain", "http_only"]
        );
        assert_eq!(
            names("https://example.com/api/users"),
            ["domain", "host", "http_only", "secure"]
        );
        assert!(jar.matches("ftp://example.com/api/users").next().is_none());
        assert!(jar.matches("/relative").next().is_none());
    }

    #[test]
    fn jar_matches_same_name_across_domain_and_path_scopes() {
        let jar = Jar::default();
        jar.add("id=host; Path=/", "https://bus.example.com/");
        jar.add(
            "id=domain; Domain=example.com; Path=/",
            "https://example.com/",
        );
        jar.add(
            "id=path; Domain=example.com; Path=/api",
            "https://example.com/api",
        );

        let values = |uri| {
            let mut values = jar
                .matches(uri)
                .map(|cookie| cookie.value().to_owned())
                .collect::<Vec<_>>();
            values.sort();
            values
        };

        assert_eq!(
            values("https://bus.example.com/api/users"),
            ["domain", "host", "path"]
        );
        assert_eq!(
            values("https://foo.bus.example.com/api/users"),
            ["domain", "path"]
        );
        assert_eq!(values("https://example.com/api/users"), ["domain", "path"]);
        assert!(values("https://other.example/api/users").is_empty());
    }

    #[test]
    fn jar_keeps_host_only_and_domain_cookies_with_the_same_key() {
        let jar = Jar::default();
        let origin = "https://example.com/";
        jar.add("id=host; Path=/", origin);
        jar.add("id=domain; Domain=example.com; Path=/", origin);

        assert_eq!(jar.len(), 2);
        assert_eq!(
            jar.get("id", origin)
                .map(|cookie| cookie.value().to_owned()),
            Some("host".to_owned())
        );

        let origin_uri = Uri::from_static("https://example.com/");
        match jar.cookies(&origin_uri, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "id=host; id=domain"),
            other => panic!("expected both origin cookies, got {other:?}"),
        }

        let subdomain = Uri::from_static("https://api.example.com/");
        match jar.cookies(&subdomain, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "id=domain"),
            other => panic!("expected only the domain cookie, got {other:?}"),
        }

        jar.add("id=gone; Max-Age=0; Path=/", origin);
        assert_eq!(jar.len(), 1);
        assert!(jar.contains("id", origin));
        assert_eq!(
            jar.get("id", origin)
                .map(|cookie| cookie.value().to_owned()),
            Some("domain".to_owned())
        );
        match jar.cookies(&origin_uri, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "id=domain"),
            other => panic!("expected the remaining domain cookie, got {other:?}"),
        }

        jar.add("id=gone; Max-Age=0; Domain=example.com; Path=/", origin);
        assert!(jar.is_empty());

        jar.add("id=host; Path=/", origin);
        jar.add("id=domain; Domain=example.com; Path=/", origin);
        jar.remove("id", origin);
        assert!(jar.is_empty());
    }

    #[test]
    fn jar_matches_rfc_path_boundaries() {
        let jar = Jar::default();
        jar.add(
            "plain=1; Domain=example.com; Path=/foo",
            "https://example.com/foo",
        );
        jar.add(
            "slash=2; Domain=example.com; Path=/foo/",
            "https://example.com/foo/",
        );

        let names = |uri| {
            let mut names = jar
                .matches(uri)
                .map(|cookie| cookie.name().to_owned())
                .collect::<Vec<_>>();
            names.sort();
            names
        };

        assert_eq!(names("https://example.com/foo"), ["plain"]);
        assert_eq!(names("https://example.com/foo/"), ["plain", "slash"]);
        assert_eq!(names("https://example.com/foo/bar"), ["plain", "slash"]);
        assert!(names("https://example.com/foobar").is_empty());
        assert!(names("https://example.com/fo").is_empty());
        assert!(names("https://example.com/").is_empty());
    }

    #[test]
    fn jar_orders_request_cookies_by_path_length_then_creation() {
        let jar = Jar::default();
        let origin = "https://example.com/";

        for cookie in [
            "B=B1; Path=/",
            "B=B2; Path=/foo",
            "B=B3; Path=/foo/bar",
            "A=A1; Path=/",
            "A=A2; Path=/foo",
            "A=A3; Path=/foo/bar",
        ] {
            jar.add(cookie, origin);
        }

        let uri = Uri::from_static("https://example.com/foo/bar/resource");
        match jar.cookies(&uri, Version::HTTP_11) {
            Cookies::Compressed(value) => {
                assert_eq!(value, "B=B3; A=A3; B=B2; A=A2; B=B1; A=A1");
            }
            other => panic!("expected compressed Cookie field, got {other:?}"),
        }

        for version in [Version::HTTP_2, Version::HTTP_3] {
            match jar.cookies(&uri, version) {
                Cookies::Uncompressed(values) => {
                    let values = values
                        .iter()
                        .map(|value| value.to_str().unwrap())
                        .collect::<Vec<_>>();
                    assert_eq!(values, ["B=B3", "A=A3", "B=B2", "A=A2", "B=B1", "A=A1"]);
                }
                other => panic!("expected uncompressed Cookie fields, got {other:?}"),
            }
        }
    }

    #[test]
    fn jar_inherits_creation_order_only_when_value_is_unchanged() {
        let jar = Jar::default();
        let origin = "https://example.com/foo";
        let uri = Uri::from_static("https://example.com/foo/bar");

        jar.add("B=old; Path=/foo", origin);
        jar.add("A=value; Path=/foo", origin);
        jar.add("B=old; Path=/foo; HttpOnly", origin);

        match jar.cookies(&uri, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "B=old; A=value"),
            other => panic!("expected compressed Cookie field, got {other:?}"),
        }

        jar.add("B=new; Path=/foo", origin);

        match jar.cookies(&uri, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "A=value; B=new"),
            other => panic!("expected compressed Cookie field, got {other:?}"),
        }
    }

    #[test]
    fn jar_sends_parent_domain_cookie_to_subdomain() {
        let jar = Jar::default();
        jar.add(
            "session=abc; Domain=example.com; Path=/",
            "http://example.com/login",
        );

        let should_receive = [
            "http://example.com/dashboard",
            "http://api.example.com/dashboard",
            "http://sub.api.example.com/dashboard",
        ];
        for uri_str in &should_receive {
            let uri = Uri::from_static(uri_str);
            match jar.cookies(&uri, Version::HTTP_11) {
                Cookies::Compressed(v) => assert_eq!(
                    v.to_str().unwrap(),
                    "session=abc",
                    "expected cookie to be sent to {uri_str}"
                ),
                other => panic!("expected Compressed cookie for {uri_str}, got {other:?}"),
            }
        }

        let should_not_receive = [
            "http://notexample.com/dashboard",
            "http://fakeexample.com/dashboard",
        ];
        for uri_str in &should_not_receive {
            let uri = Uri::from_static(uri_str);
            assert!(
                matches!(jar.cookies(&uri, Version::HTTP_11), Cookies::Empty),
                "cookie must NOT be sent to {uri_str}"
            );
        }
    }

    #[test]
    fn jar_does_not_send_host_only_cookie_to_subdomain() {
        let jar = Jar::default();
        jar.add("session=abc; Path=/", "http://example.com/login");

        let origin = Uri::from_static("http://example.com/dashboard");
        match jar.cookies(&origin, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "session=abc"),
            other => panic!("expected host-only cookie for origin host, got {other:?}"),
        }

        let subdomain = Uri::from_static("http://api.example.com/dashboard");
        assert!(
            matches!(jar.cookies(&subdomain, Version::HTTP_11), Cookies::Empty),
            "host-only cookie must not be sent to a subdomain"
        );
    }

    #[test]
    fn jar_accepts_and_normalizes_mixed_case_domain() {
        let jar = Jar::default();
        jar.add(
            "session=abc; Domain=EXAMPLE.COM; Path=/",
            "https://example.com/login",
        );

        let cookies = jar.get_all().collect::<Vec<_>>();
        assert_eq!(cookies.len(), 1);
        assert_eq!(cookies[0].domain(), Some("example.com"));

        let subdomain = Uri::from_static("https://api.example.com/dashboard");
        match jar.cookies(&subdomain, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "session=abc"),
            other => panic!("expected domain cookie for matching subdomain, got {other:?}"),
        }
    }

    #[test]
    fn jar_ignores_leading_dot_in_domain() {
        let jar = Jar::default();
        jar.add(
            "session=abc; Domain=.example.com; Path=/",
            "https://example.com/login",
        );

        let subdomain = Uri::from_static("https://api.example.com/dashboard");
        match jar.cookies(&subdomain, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "session=abc"),
            other => panic!("expected domain cookie for matching subdomain, got {other:?}"),
        }
    }

    #[test]
    fn jar_enforces_positive_max_age_deadline() {
        let jar = Jar::default();
        let uri = Uri::from_static("http://example.com/");
        jar.add("short=lived; Max-Age=1; Path=/", &uri);

        let cookie = jar.get("short", &uri).expect("cookie should be stored");
        assert_eq!(cookie.max_age(), None);
        assert!(cookie.expires().is_some());
        assert!(jar.contains("short", &uri));
        assert_eq!(jar.len(), 1);
        assert!(!jar.is_empty());
        assert_eq!(jar.matches(&uri).count(), 1);
        assert_eq!(jar.get_all().count(), 1);
        assert!(matches!(
            jar.cookies(&uri, Version::HTTP_11),
            Cookies::Compressed(_)
        ));

        thread::sleep(StdDuration::from_millis(1100));

        assert!(jar.get("short", &uri).is_none());
        assert!(!jar.contains("short", &uri));
        assert_eq!(jar.len(), 0);
        assert!(jar.is_empty());
        assert_eq!(jar.matches(&uri).count(), 0);
        assert_eq!(jar.get_all().count(), 0);
        assert!(matches!(
            jar.cookies(&uri, Version::HTTP_11),
            Cookies::Empty
        ));
    }

    #[test]
    fn jar_removes_non_positive_max_age() {
        let jar = Jar::default();
        let uri = "http://example.com/";

        jar.add("zero=old; Path=/", uri);
        jar.add("zero=gone; Max-Age=0; Path=/", uri);
        assert!(jar.get("zero", uri).is_none());

        jar.add("negative=old; Path=/", uri);
        jar.add("negative=gone; Max-Age=-10; Path=/", uri);
        assert!(jar.get("negative", uri).is_none());
    }

    #[test]
    fn jar_max_age_overrides_expires_in_either_order() {
        let jar = Jar::default();
        let uri = "http://example.com/";

        jar.add(
            "first=kept; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
            uri,
        );
        jar.add(
            "last=kept; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60; Path=/",
            uri,
        );
        assert!(jar.get("first", uri).is_some());
        assert!(jar.get("last", uri).is_some());

        jar.add("remove_first=old; Path=/", uri);
        jar.add(
            "remove_first=gone; Max-Age=0; Expires=Fri, 31 Dec 9999 23:59:59 GMT; Path=/",
            uri,
        );
        jar.add("remove_last=old; Path=/", uri);
        jar.add(
            "remove_last=gone; Expires=Fri, 31 Dec 9999 23:59:59 GMT; Max-Age=0; Path=/",
            uri,
        );
        assert!(jar.get("remove_first", uri).is_none());
        assert!(jar.get("remove_last", uri).is_none());
    }

    #[test]
    fn jar_uses_last_valid_max_age() {
        let jar = Jar::default();
        let uri = "http://example.com/";

        jar.add("kept=value; Max-Age=0; Max-Age=60; Path=/", uri);
        assert!(jar.get("kept", uri).is_some());

        jar.add("removed=old; Path=/", uri);
        jar.add("removed=gone; Max-Age=60; Max-Age=0; Path=/", uri);
        assert!(jar.get("removed", uri).is_none());

        jar.add(
            "malformed=kept; Max-Age=60; Max-Age=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
            uri,
        );
        assert!(jar.get("malformed", uri).is_some());
    }

    #[test]
    fn jar_ignores_malformed_max_age() {
        let jar = Jar::default();
        let uri = "http://example.com/";

        jar.add(
            "persistent=value; Max-Age=invalid; Expires=Fri, 31 Dec 9999 23:59:59 GMT; Path=/",
            uri,
        );
        assert!(jar.get("persistent", uri).is_some());

        jar.add(
            "expired=value; Max-Age=invalid; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
            uri,
        );
        assert!(jar.get("expired", uri).is_none());

        jar.add(
            "plus=value; Max-Age=+60; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
            uri,
        );
        assert!(jar.get("plus", uri).is_none());

        jar.add("session=value; Max-Age=invalid; Path=/", uri);
        let session = jar
            .get("session", uri)
            .expect("session cookie should be stored");
        assert_eq!(session.max_age(), None);
        assert_eq!(session.expires(), None);
    }

    #[test]
    fn jar_does_not_suffix_match_ipv4_addresses() {
        let jar = Jar::default();
        jar.add("session=abc; Domain=0.1; Path=/", "http://192.168.0.1/");

        assert_eq!(jar.get_all().count(), 0);

        let unrelated = Uri::from_static("http://10.0.0.1/");
        assert!(matches!(
            jar.cookies(&unrelated, Version::HTTP_11),
            Cookies::Empty
        ));
    }

    #[test]
    fn jar_preserves_ipv6_host_identity() {
        let jar = Jar::default();
        jar.add("session=abc; Path=/", "http://[2001:db8::1]/");

        let equivalent = Uri::from_static("http://[2001:0db8:0:0:0:0:0:1]/");
        match jar.cookies(&equivalent, Version::HTTP_11) {
            Cookies::Compressed(value) => assert_eq!(value, "session=abc"),
            other => panic!("expected cookie for equivalent IPv6 host, got {other:?}"),
        }

        let unrelated = Uri::from_static("http://[2001:db8::2]/");
        assert!(matches!(
            jar.cookies(&unrelated, Version::HTTP_11),
            Cookies::Empty
        ));
    }

    #[test]
    fn jar_subdomain_cookie_does_not_leak_to_parent_or_sibling() {
        let jar = Jar::default();
        jar.add(
            "token=xyz; Domain=api.example.com; Path=/",
            "http://api.example.com/",
        );

        let uri = Uri::from_static("http://api.example.com/");
        assert!(
            matches!(jar.cookies(&uri, Version::HTTP_11), Cookies::Compressed(_)),
            "cookie must be sent to api.example.com"
        );

        let must_not_receive = [
            "http://example.com/",
            "http://other.example.com/",
            "http://notapi.example.com/",
        ];
        for uri_str in &must_not_receive {
            let uri = Uri::from_static(uri_str);
            assert!(
                matches!(jar.cookies(&uri, Version::HTTP_11), Cookies::Empty),
                "cookie must NOT leak to {uri_str}"
            );
        }
    }
}
