use std::collections::HashMap;

use cookie::{
    Cookie as RawCookie,
    time::{Duration, OffsetDateTime},
};
use http::Uri;
use url::Host;

use crate::ext::UriExt;

pub const DEFAULT_PATH: &str = "/";

/// Canonical immutable host used as a cookie domain key.
type CanonicalHost = Host<Box<str>>;
type NameMap = HashMap<Box<str>, CookieEntry>;
type PathMap = HashMap<Box<str>, CookieScopeMap>;
type DomainMap = HashMap<CanonicalHost, PathMap>;

/// A stored cookie and its sequence number for request ordering.
#[derive(Debug)]
pub struct CookieEntry {
    pub cookie: RawCookie<'static>,
    pub creation_index: u64,
}

/// Keeps host-only and `Domain` cookies separate because the host-only flag is part of a cookie's
/// identity under the RFC 6265bis storage model.
///
/// https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-5.7
#[derive(Debug, Default)]
pub struct CookieScopeMap {
    host_only: NameMap,
    domain: NameMap,
}

impl CookieScopeMap {
    /// Returns a mutable cookie from the selected host-only or `Domain` scope.
    pub fn get_mut(&mut self, name: &str, host_only: bool) -> Option<&mut CookieEntry> {
        if host_only {
            self.host_only.get_mut(name)
        } else {
            self.domain.get_mut(name)
        }
    }

    /// Returns cookies with the requested name from both storage scopes.
    pub fn entries(&self, name: &str) -> impl Iterator<Item = &CookieEntry> {
        self.host_only
            .get(name)
            .into_iter()
            .chain(self.domain.get(name))
    }

    /// Inserts a cookie into its host-only or `Domain` scope.
    pub fn insert(&mut self, name: Box<str>, host_only: bool, entry: CookieEntry) {
        if host_only {
            self.host_only.insert(name, entry);
        } else {
            self.domain.insert(name, entry);
        }
    }

    /// Removes a cookie from the selected host-only or `Domain` scope.
    pub fn remove(&mut self, name: &str, host_only: bool) {
        if host_only {
            self.host_only.remove(name);
        } else {
            self.domain.remove(name);
        }
    }

    /// Removes both host-only and `Domain` cookies with the requested name.
    pub fn remove_all(&mut self, name: &str) {
        self.host_only.remove(name);
        self.domain.remove(name);
    }

    /// Returns every cookie in this domain and path scope.
    pub fn values(&self) -> impl Iterator<Item = &CookieEntry> {
        self.host_only.values().chain(self.domain.values())
    }

    /// Returns `true` when the host-only and `Domain` scopes are empty.
    pub fn is_empty(&self) -> bool {
        self.host_only.is_empty() && self.domain.is_empty()
    }
}

/// Stores cookies by domain, path, host-only scope, and name.
#[derive(Debug, Default)]
pub struct Store {
    pub cookies: DomainMap,
    next_creation_index: u64,
}

impl Store {
    /// Inserts or replaces a cookie in its domain and path scope.
    pub fn insert_stored_cookie(
        &mut self,
        domain: CanonicalHost,
        path: String,
        cookie: RawCookie<'static>,
    ) {
        let host_only = cookie.domain().is_none();

        // Chromium inherits the creation time only when the replacement keeps the same value. A
        // value change receives a new creation time and therefore moves later among equal-length
        // paths.
        // https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_monster.cc
        if let Some(entry) = self
            .cookies
            .get_mut(&domain)
            .and_then(|path_map| path_map.get_mut(path.as_str()))
            .and_then(|cookie_map| cookie_map.get_mut(cookie.name(), host_only))
        {
            if entry.cookie.value() != cookie.value() {
                entry.creation_index = self.next_creation_index;
                self.next_creation_index = self.next_creation_index.saturating_add(1);
            }
            entry.cookie = cookie;
            return;
        }

        let creation_index = self.next_creation_index;
        self.next_creation_index = self.next_creation_index.saturating_add(1);
        let name = Box::from(cookie.name());

        self.cookies
            .entry(domain)
            .or_default()
            .entry(path.into_boxed_str())
            .or_default()
            .insert(
                name,
                host_only,
                CookieEntry {
                    cookie,
                    creation_index,
                },
            );
    }

    /// Removes a cookie matching the domain, path, name, and selected storage scope.
    pub fn remove_stored_cookie(
        &mut self,
        domain: &CanonicalHost,
        path: &str,
        name: &str,
        host_only: bool,
    ) {
        self.remove_stored_cookie_inner(domain, path, name, Some(host_only));
    }

    /// Removes both host-only and `Domain` cookies matching the domain, path, and name.
    pub fn remove_stored_cookies(&mut self, domain: &CanonicalHost, path: &str, name: &str) {
        self.remove_stored_cookie_inner(domain, path, name, None);
    }

    fn remove_stored_cookie_inner(
        &mut self,
        domain: &CanonicalHost,
        path: &str,
        name: &str,
        host_only: Option<bool>,
    ) {
        let remove_domain = if let Some(path_map) = self.cookies.get_mut(domain) {
            let remove_path = if let Some(cookie_map) = path_map.get_mut(path) {
                if let Some(host_only) = host_only {
                    cookie_map.remove(name, host_only);
                } else {
                    cookie_map.remove_all(name);
                }
                cookie_map.is_empty()
            } else {
                false
            };

            if remove_path {
                path_map.remove(path);
            }

            path_map.is_empty()
        } else {
            false
        };

        if remove_domain {
            self.cookies.remove(domain);
        }
    }

    /// Returns the unexpired cookies that apply to a request URI.
    pub fn matching_cookies<'a>(
        &'a self,
        uri: &'a Uri,
        request_host: &'a CanonicalHost,
        now: OffsetDateTime,
    ) -> impl Iterator<Item = (&'a CanonicalHost, &'a str, &'a CookieEntry)> + 'a {
        self.cookies.iter().flat_map(move |(domain, path_map)| {
            path_map.iter().flat_map(move |(path, cookie_map)| {
                cookie_map.values().filter_map(move |entry| {
                    request_matches_cookie(uri, request_host, domain, path, &entry.cookie, now)
                        .then_some((domain, path.as_ref(), entry))
                })
            })
        })
    }

    /// Returns whether an insecure cookie would overlay an unexpired `Secure` cookie.
    ///
    /// RFC 6265bis section 5.7:
    /// https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html#section-5.7
    pub fn would_overlay_secure_cookie(
        &self,
        name: &str,
        domain: &CanonicalHost,
        path: &str,
        now: OffsetDateTime,
    ) -> bool {
        self.cookies.iter().any(|(stored_domain, path_map)| {
            (domain_match(stored_domain, domain) || domain_match(domain, stored_domain))
                && path_map.iter().any(|(stored_path, cookie_map)| {
                    path_match(path, stored_path)
                        && cookie_map.entries(name).any(|entry| {
                            entry.cookie.secure() == Some(true)
                                && !cookie_is_expired(&entry.cookie, now)
                        })
                })
        })
    }
}

/// Applies the RFC 6265 request selection rules supported by this HTTP client.
fn request_matches_cookie(
    uri: &Uri,
    request_host: &CanonicalHost,
    cookie_domain: &CanonicalHost,
    cookie_path: &str,
    cookie: &RawCookie<'_>,
    now: OffsetDateTime,
) -> bool {
    // Host-only cookies require an exact host match. A Domain attribute enables suffix matching.
    // RFC 6265 section 5.4: https://www.rfc-editor.org/rfc/rfc6265.html#section-5.4
    if !(uri.is_http() || uri.is_https())
        || !domain_match(request_host, cookie_domain)
        || cookie.domain().is_none() && request_host != cookie_domain
        || !path_match(uri.path(), cookie_path)
        || cookie.secure() == Some(true) && uri.is_http()
    {
        return false;
    }

    !cookie_is_expired(cookie, now)
}

/// Returns whether a stored cookie has reached its effective expiration deadline.
pub fn cookie_is_expired(cookie: &RawCookie<'_>, now: OffsetDateTime) -> bool {
    cookie
        .max_age()
        .is_some_and(|max_age| max_age <= Duration::ZERO)
        || cookie
            .expires_datetime()
            .is_some_and(|deadline| deadline <= now)
}

/// Determines whether `host` domain-matches `domain` as defined by RFC 6265 section 5.1.3.
///
/// https://www.rfc-editor.org/rfc/rfc6265.html#section-5.1.3
pub fn domain_match(host: &CanonicalHost, domain: &CanonicalHost) -> bool {
    if host == domain {
        return true;
    }

    let (Host::Domain(host), Host::Domain(domain)) = (host, domain) else {
        return false;
    };

    host.len() > domain.len()
        && host.as_bytes()[host.len() - domain.len() - 1] == b'.'
        && host.ends_with(domain.as_ref())
}

/// Determines whether `request_path` path-matches `cookie_path` under RFC 6265 section 5.1.4.
///
/// https://www.rfc-editor.org/rfc/rfc6265.html#section-5.1.4
fn path_match(request_path: &str, cookie_path: &str) -> bool {
    request_path == cookie_path
        || request_path.starts_with(cookie_path)
            && (cookie_path.ends_with(DEFAULT_PATH)
                || request_path[cookie_path.len()..].starts_with(DEFAULT_PATH))
}

/// Canonicalizes a DNS name or IP literal for cookie domain matching.
pub fn canonical_host(host: &str) -> Option<CanonicalHost> {
    // RFC 6265 section 5.2.3 requires a leading dot in Domain to be ignored.
    // https://www.rfc-editor.org/rfc/rfc6265.html#section-5.2.3
    let host = host.strip_prefix('.').unwrap_or(host);

    match Host::parse(host).ok()? {
        Host::Domain(domain) => Some(Host::Domain(domain.into_boxed_str())),
        Host::Ipv4(address) => Some(Host::Ipv4(address)),
        Host::Ipv6(address) => Some(Host::Ipv6(address)),
    }
}

/// Computes the default cookie path from a request path under RFC 6265 section 5.1.4.
///
/// https://www.rfc-editor.org/rfc/rfc6265.html#section-5.1.4
pub fn normalize_path(path: &str) -> &str {
    if !path.starts_with(DEFAULT_PATH) {
        return DEFAULT_PATH;
    }
    if let Some(pos) = path.rfind(DEFAULT_PATH) {
        if pos == 0 {
            return DEFAULT_PATH;
        }
        return &path[..pos];
    }
    DEFAULT_PATH
}
