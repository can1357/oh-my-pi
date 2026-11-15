//! Proxy matchers
//!
//! This module contains different matchers to configure rules for when a proxy
//! should be used, and if so, with what arguments.
//!
//! A [`Matcher`] can be constructed either using environment variables, or
//! a [`Matcher::builder()`].
//!
//! Once constructed, the `Matcher` can be asked if it intercepts a `Uri` by
//! calling [`Matcher::intercept()`].
//!
//! An [`Intercept`] includes the destination for the proxy, and any parsed
//! authentication to be used.

use std::net::IpAddr;
#[cfg(unix)]
use std::{path::Path, sync::Arc};

use bytes::Bytes;
use http::{
    HeaderMap, Uri,
    header::HeaderValue,
    uri::{Authority, Scheme},
};
use ipnet::IpNet;
use percent_encoding::percent_decode_str;

use self::builder::IntoValue;
use super::{Extra, Intercepted};
use crate::ext::UriExt;

/// A proxy matcher, usually built from environment variables.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Matcher {
    http: Option<Intercept>,
    https: Option<Intercept>,
    no: NoProxy,
    #[cfg(unix)]
    unix: Option<Arc<Path>>,
}

/// A matched proxy,
///
/// This is returned by a matcher if a proxy should be used.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Intercept {
    uri: Uri,
    auth: Auth,
    extra: Extra,
}

/// A builder to create a [`Matcher`].
///
/// Construct with [`Matcher::builder()`].
#[derive(Default)]
pub struct Builder {
    pub(super) is_cgi: bool,
    pub(super) all: String,
    pub(super) http: String,
    pub(super) https: String,
    pub(super) no: String,
    #[cfg(unix)]
    pub(super) unix: Option<Arc<Path>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Auth {
    Empty,
    Basic(HeaderValue),
    Raw(Bytes, Bytes),
}

/// A filter for proxy matchers.
///
/// This type is based off the `NO_PROXY` rules used by curl.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
struct NoProxy {
    ips: IpMatcher,
    domains: DomainMatcher,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
struct DomainMatcher(Vec<String>);

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
struct IpMatcher(Vec<Ip>);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Ip {
    Address(IpAddr),
    Network(IpNet),
}

// ===== impl Matcher =====

impl Matcher {
    /// Create a matcher from the environment or system.
    ///
    /// This checks the same environment variables as `from_env()`, and if not
    /// set, checks the system configuration for values for the OS.
    ///
    /// This constructor is always available, but if the `client-proxy-system`
    /// feature is enabled, it will check more configuration. Use this
    /// constructor if you want to allow users to optionally enable more, or
    /// use `from_env` if you do not want the values to change based on an
    /// enabled feature.
    pub fn from_system() -> Self {
        Builder::from_system().build(Extra::default())
    }

    /// Start a builder to configure a matcher.
    pub fn builder() -> Builder {
        Builder::default()
    }

    /// Check if the destination should be intercepted by a proxy.
    ///
    /// If the proxy rules match the destination, a new `Uri` will be returned
    /// to connect to.
    pub fn intercept(&self, dst: &Uri) -> Option<Intercepted> {
        // if unix sockets are configured, check them first
        #[cfg(unix)]
        if let Some(unix) = &self.unix {
            return Some(Intercepted::Unix(unix.clone()));
        }

        // TODO(perf): don't need to check `no` if below doesn't match...
        if self.no.contains(dst.host()?) {
            return None;
        }
        if dst.is_http() {
            return self.http.clone().map(Intercepted::Proxy);
        }

        if dst.is_https() {
            return self.https.clone().map(Intercepted::Proxy);
        }

        None
    }
}

// ===== impl Intercept =====

impl Intercept {
    #[inline]
    pub(crate) fn uri(&self) -> &Uri {
        &self.uri
    }

    pub(crate) fn basic_auth(&self) -> Option<&HeaderValue> {
        if let Some(ref val) = self.extra.auth {
            return Some(val);
        }

        if let Auth::Basic(ref val) = self.auth {
            Some(val)
        } else {
            None
        }
    }

    #[inline]
    pub(crate) fn custom_headers(&self) -> Option<&HeaderMap> {
        self.extra.misc.as_ref()
    }

    #[cfg(feature = "socks")]
    pub(crate) fn raw_auth(&self) -> Option<(Bytes, Bytes)> {
        if let Auth::Raw(ref u, ref p) = self.auth {
            Some((u.clone(), p.clone()))
        } else {
            None
        }
    }
}

// ===== impl Builder =====

impl Builder {
    fn from_env() -> Self {
        Builder {
            is_cgi: std::env::var_os("REQUEST_METHOD").is_some(),
            all: get_first_env(&["ALL_PROXY", "all_proxy"]),
            http: get_first_env(&["HTTP_PROXY", "http_proxy"]),
            https: get_first_env(&["HTTPS_PROXY", "https_proxy"]),
            no: get_first_env(&["NO_PROXY", "no_proxy"]),
            #[cfg(unix)]
            unix: None,
        }
    }

    fn from_system() -> Self {
        #[allow(unused_mut)]
        let mut builder = Self::from_env();

        #[cfg(all(target_os = "macos", feature = "system-proxy"))]
        super::mac::with_system(&mut builder);

        #[cfg(all(windows, feature = "system-proxy"))]
        super::win::with_system(&mut builder);

        builder
    }

    /// Set the target proxy for all destinations.
    pub fn all<S>(mut self, val: S) -> Self
    where
        S: IntoValue,
    {
        self.all = val.into_value();
        self
    }

    /// Set the target proxy for HTTP destinations.
    pub fn http<S>(mut self, val: S) -> Self
    where
        S: IntoValue,
    {
        self.http = val.into_value();
        self
    }

    /// Set the target proxy for HTTPS destinations.
    pub fn https<S>(mut self, val: S) -> Self
    where
        S: IntoValue,
    {
        self.https = val.into_value();
        self
    }

    /// Set the "no" proxy filter.
    ///
    /// The rules are as follows:
    /// * Entries are expected to be comma-separated (whitespace between entries is ignored)
    /// * IP addresses (both IPv4 and IPv6) are allowed, as are optional subnet masks (by adding
    ///   /size, for example "`192.168.1.0/24`").
    /// * An entry "`*`" matches all hostnames (this is the only wildcard allowed)
    /// * Any other entry is considered a domain name (and may contain a leading dot, for example
    ///   `google.com` and `.google.com` are equivalent) and would match both that domain AND all
    ///   subdomains.
    ///
    /// For example, if `"NO_PROXY=google.com, 192.168.1.0/24"` was set, all of the following would
    /// match (and therefore would bypass the proxy):
    /// * `http://google.com/`
    /// * `http://www.google.com/`
    /// * `http://192.168.1.42/`
    ///
    /// The URI `http://notgoogle.com/` would not match.
    pub fn no<S>(mut self, val: S) -> Self
    where
        S: IntoValue,
    {
        self.no = val.into_value();
        self
    }

    // / Set the unix socket target proxy for all destinations.
    #[cfg(unix)]
    pub fn unix<S>(mut self, val: S) -> Self
    where
        S: super::uds::IntoUnixSocket,
    {
        self.unix = Some(val.unix_socket());
        self
    }

    /// Construct a [`Matcher`] using the configured values.
    pub(super) fn build(self, extra: Extra) -> Matcher {
        if self.is_cgi {
            return Matcher {
                http: None,
                https: None,
                no: NoProxy::empty(),
                #[cfg(unix)]
                unix: None,
            };
        }

        let mut all = parse_env_uri(&self.all);
        let mut http = parse_env_uri(&self.http);
        let mut https = parse_env_uri(&self.https);

        if let Some(http) = http.as_mut() {
            http.extra = extra.clone();
        }
        if let Some(https) = https.as_mut() {
            https.extra = extra.clone();
        }
        if (http.is_none() || https.is_none())
            && let Some(all) = all.as_mut()
        {
            all.extra = extra;
        }

        Matcher {
            http: http.or_else(|| all.clone()),
            https: https.or(all),
            no: NoProxy::from_string(&self.no),
            #[cfg(unix)]
            unix: self.unix,
        }
    }
}

fn get_first_env(names: &[&str]) -> String {
    for name in names {
        if let Ok(val) = std::env::var(name) {
            return val;
        }
    }

    String::new()
}

fn parse_env_uri(val: &str) -> Option<Intercept> {
    let uri = val.parse::<Uri>().ok()?;
    let mut builder = Uri::builder();
    let mut is_httpish = false;
    let mut is_socks = false;
    let mut auth = Auth::Empty;

    builder = builder.scheme(match uri.scheme() {
        Some(s) => {
            if s == &Scheme::HTTP || s == &Scheme::HTTPS {
                is_httpish = true;
                s.clone()
            } else if matches!(s.as_str(), "socks4" | "socks4a" | "socks5" | "socks5h") {
                is_socks = true;
                s.clone()
            } else {
                // can't use this proxy scheme
                return None;
            }
        }
        // if no scheme provided, assume they meant 'http'
        None => {
            is_httpish = true;
            Scheme::HTTP
        }
    });

    let authority = {
        let authority = uri.authority()?;
        // default SOCKS port to 1080 if missing
        if is_socks && authority.port().is_none() {
            Authority::from_maybe_shared(Bytes::from(format!("{authority}:1080"))).ok()?
        } else {
            authority.clone()
        }
    };

    if let Some((userinfo, host_port)) = authority.as_str().rsplit_once('@') {
        let (user, pass) = match userinfo.split_once(':') {
            Some((user, pass)) => (user, Some(pass)),
            None => (userinfo, None),
        };

        let user = percent_decode_str(user).decode_utf8_lossy();
        let pass = pass.map(|pass| percent_decode_str(pass).decode_utf8_lossy());
        if is_httpish {
            auth = Auth::Basic(crate::util::basic_auth(&user, pass.as_deref()));
        } else {
            auth = Auth::Raw(
                Bytes::from(user.into_owned()),
                Bytes::from(pass.map_or_else(String::new, std::borrow::Cow::into_owned)),
            );
        }
        builder = builder.authority(host_port);
    } else {
        builder = builder.authority(authority);
    }

    // removing any path, but we MUST specify one or the builder errors
    builder = builder.path_and_query("/");

    Some(Intercept {
        auth,
        extra: Extra::default(),
        uri: builder.build().ok()?,
    })
}

impl NoProxy {
    fn empty() -> NoProxy {
        NoProxy {
            ips: IpMatcher(Vec::new()),
            domains: DomainMatcher(Vec::new()),
        }
    }

    /// Returns a new no-proxy configuration based on a `no_proxy` string (or `None` if no variables
    /// are set)
    /// The rules are as follows:
    /// * The environment variable `NO_PROXY` is checked, if it is not set, `no_proxy` is checked
    /// * If neither environment variable is set, `None` is returned
    /// * Entries are expected to be comma-separated (whitespace between entries is ignored)
    /// * IP addresses (both IPv4 and IPv6) are allowed, as are optional subnet masks (by adding
    ///   /size, for example "`192.168.1.0/24`").
    /// * An entry "`*`" matches all hostnames (this is the only wildcard allowed)
    /// * Any other entry is considered a domain name (and may contain a leading dot, for example
    ///   `google.com` and `.google.com` are equivalent) and would match both that domain AND all
    ///   subdomains.
    ///
    /// For example, if `"NO_PROXY=google.com, 192.168.1.0/24"` was set, all of the following would
    /// match (and therefore would bypass the proxy):
    /// * `http://google.com/`
    /// * `http://www.google.com/`
    /// * `http://192.168.1.42/`
    ///
    /// The URI `http://notgoogle.com/` would not match.
    pub fn from_string(no_proxy_list: &str) -> Self {
        let mut ips = Vec::new();
        let mut domains = Vec::new();
        let parts = no_proxy_list.split(',').map(str::trim);
        for part in parts {
            match part.parse::<IpNet>() {
                // If we can parse an IP net or address, then use it, otherwise, assume it is a
                // domain
                Ok(ip) => ips.push(Ip::Network(ip)),
                Err(_) => match part.parse::<IpAddr>() {
                    Ok(addr) => ips.push(Ip::Address(addr)),
                    Err(_) => {
                        if !part.trim().is_empty() {
                            domains.push(part.to_owned())
                        }
                    }
                },
            }
        }
        NoProxy {
            ips: IpMatcher(ips),
            domains: DomainMatcher(domains),
        }
    }

    /// Return true if this matches the host (domain or IP).
    pub fn contains(&self, host: &str) -> bool {
        let host = crate::util::strip_ipv6_brackets(host);
        match host.parse::<IpAddr>() {
            // If we can parse an IP addr, then use it, otherwise, assume it is a domain
            Ok(ip) => self.ips.contains(ip),
            Err(_) => self.domains.contains(host),
        }
    }
}

impl IpMatcher {
    fn contains(&self, addr: IpAddr) -> bool {
        for ip in &self.0 {
            match ip {
                Ip::Address(address) => {
                    if &addr == address {
                        return true;
                    }
                }
                Ip::Network(net) => {
                    if net.contains(&addr) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

impl DomainMatcher {
    // The following links may be useful to understand the origin of these rules:
    // * https://curl.se/libcurl/c/CURLOPT_NOPROXY.html
    // * https://github.com/curl/curl/issues/1208
    fn contains(&self, domain: &str) -> bool {
        let domain_len = domain.len();
        for d in &self.0 {
            if d.eq_ignore_ascii_case(domain)
                || d.strip_prefix('.')
                    .is_some_and(|s| s.eq_ignore_ascii_case(domain))
            {
                return true;
            } else if domain
                .get(domain_len.saturating_sub(d.len())..)
                .is_some_and(|s| s.eq_ignore_ascii_case(d))
            {
                if d.starts_with('.') {
                    // If the first character of d is a dot, that means the first character of
                    // domain must also be a dot, so we are looking at a
                    // subdomain of d and that matches
                    return true;
                } else if domain
                    .as_bytes()
                    .get(domain_len.saturating_sub(d.len() + 1))
                    == Some(&b'.')
                {
                    // Given that d is a prefix of domain, if the prior character in domain is a dot
                    // then that means we must be matching a subdomain of d, and that matches
                    return true;
                }
            } else if d == "*" {
                return true;
            }
        }
        false
    }
}

mod builder {
    /// A type that can used as a `Builder` value.
    ///
    /// Private and sealed, only visible in docs.
    pub trait IntoValue {
        #[doc(hidden)]
        fn into_value(self) -> String;
    }

    impl IntoValue for String {
        #[doc(hidden)]
        fn into_value(self) -> String {
            self
        }
    }

    impl IntoValue for &String {
        #[doc(hidden)]
        fn into_value(self) -> String {
            self.into()
        }
    }

    impl IntoValue for &str {
        #[doc(hidden)]
        fn into_value(self) -> String {
            self.into()
        }
    }
}

#[cfg(test)]
mod tests {
    #[cfg(all(feature = "system-proxy", windows))]
    use super::super::win;
    use super::*;

    #[test]
    fn test_domain_matcher() {
        let domains = vec![".foo.bar".into(), "bar.foo".into()];
        let matcher = DomainMatcher(domains);

        // domains match with leading `.`
        assert!(matcher.contains("foo.bar"));
        assert!(matcher.contains("FOO.BAR"));
        // subdomains match with leading `.`
        assert!(matcher.contains("www.foo.bar"));
        assert!(matcher.contains("WWW.FOO.BAR"));

        // domains match with no leading `.`
        assert!(matcher.contains("bar.foo"));
        assert!(matcher.contains("Bar.foo"));
        // subdomains match with no leading `.`
        assert!(matcher.contains("www.bar.foo"));
        assert!(matcher.contains("WWW.BAR.FOO"));

        // non-subdomain string prefixes don't match
        assert!(!matcher.contains("notfoo.bar"));
        assert!(!matcher.contains("notbar.foo"));
    }

    #[test]
    fn test_no_proxy_wildcard() {
        let no_proxy = NoProxy::from_string("*");
        assert!(no_proxy.contains("any.where"));
    }

    #[test]
    fn test_no_proxy_ip_ranges() {
        let no_proxy =
            NoProxy::from_string(".foo.bar, bar.baz,10.42.1.1/24,::1,10.124.7.8,2001::/17");

        let should_not_match = [
            // random uri, not in no_proxy
            "hyper.rs",
            // make sure that random non-subdomain string prefixes don't match
            "notfoo.bar",
            // make sure that random non-subdomain string prefixes don't match
            "notbar.baz",
            // ipv4 address out of range
            "10.43.1.1",
            // ipv4 address out of range
            "10.124.7.7",
            // ipv6 address out of range
            "[ffff:db8:a0b:12f0::1]",
            // ipv6 address out of range
            "[2005:db8:a0b:12f0::1]",
        ];

        for host in &should_not_match {
            assert!(!no_proxy.contains(host), "should not contain {host:?}");
        }

        let should_match = [
            // make sure subdomains (with leading .) match
            "hello.foo.bar",
            // make sure exact matches (without leading .) match (also makes sure spaces between
            // entries work)
            "bar.baz",
            // make sure subdomains (without leading . in no_proxy) match
            "foo.bar.baz",
            // make sure subdomains (without leading . in no_proxy) match - this differs from cURL
            "foo.bar",
            // ipv4 address match within range
            "10.42.1.100",
            // ipv6 address exact match
            "[::1]",
            // ipv6 address match within range
            "[2001:db8:a0b:12f0::1]",
            // ipv4 address exact match
            "10.124.7.8",
        ];

        for host in &should_match {
            assert!(no_proxy.contains(host), "should contain {host:?}");
        }
    }

    #[cfg(all(feature = "system-proxy", windows))]
    #[test]
    fn test_windows_proxy_override_ip_wildcard() {
        let normalized =
            win::normalize_proxy_override("127.*; 10.*.*.*; 192.168.*; 192.168.1.*; *.example.com");
        let no_proxy = NoProxy::from_string(&normalized);

        assert!(no_proxy.contains("127.0.0.1"));
        assert!(no_proxy.contains("10.12.34.56"));
        assert!(no_proxy.contains("192.168.42.1"));
        assert!(no_proxy.contains("192.168.1.42"));
        assert!(no_proxy.contains("www.example.com"));
        assert!(!no_proxy.contains("128.0.0.1"));
        assert!(!no_proxy.contains("192.169.42.1"));

        let subnet = NoProxy::from_string(&win::normalize_proxy_override("192.168.1.*"));
        assert!(!subnet.contains("192.168.2.42"));
    }

    macro_rules! p {
        ($($n:ident = $v:expr,)*) => ({Builder {
            $($n: $v.into(),)*
            ..Builder::default()
        }.build(Extra::default())});
    }

    fn intercept(p: &Matcher, u: &str) -> Intercept {
        match p.intercept(&u.parse().unwrap()).unwrap() {
            Intercepted::Proxy(intercept) => intercept,
            #[cfg(unix)]
            Intercepted::Unix(path) => {
                unreachable!("should not intercept unix socket: {path:?}")
            }
        }
    }

    #[test]
    fn test_all_proxy() {
        let p = p! {
            all = "http://om.nom",
        };

        assert_eq!("http://om.nom", intercept(&p, "http://example.com").uri());

        assert_eq!("http://om.nom", intercept(&p, "https://example.com").uri());
    }

    #[test]
    fn test_specific_overrides_all() {
        let p = p! {
            all = "http://no.pe",
            http = "http://y.ep",
        };

        assert_eq!("http://no.pe", intercept(&p, "https://example.com").uri());

        // the http rule is "more specific" than the all rule
        assert_eq!("http://y.ep", intercept(&p, "http://example.com").uri());
    }

    #[test]
    fn test_parse_no_scheme_defaults_to_http() {
        let p = p! {
            https = "y.ep",
            http = "127.0.0.1:8887",
        };

        assert_eq!(intercept(&p, "https://example.local").uri(), "http://y.ep");
        assert_eq!(
            intercept(&p, "http://example.local").uri(),
            "http://127.0.0.1:8887"
        );
    }

    #[test]
    fn test_parse_http_auth() {
        let p = p! {
            all = "http://Aladdin:opensesame@y.ep",
        };

        let proxy = intercept(&p, "https://example.local");
        assert_eq!(proxy.uri(), "http://y.ep");
        assert_eq!(
            proxy.basic_auth().expect("basic_auth"),
            "Basic QWxhZGRpbjpvcGVuc2VzYW1l"
        );
    }

    #[test]
    fn test_parse_http_auth_without_password() {
        let p = p! {
            all = "http://Aladdin@y.ep",
        };
        let proxy = intercept(&p, "https://example.local");
        assert_eq!(proxy.uri(), "http://y.ep");
        assert_eq!(
            proxy.basic_auth().expect("basic_auth"),
            "Basic QWxhZGRpbjo="
        );
    }

    #[test]
    fn test_parse_http_auth_without_scheme() {
        let p = p! {
            all = "Aladdin:opensesame@y.ep",
        };

        let proxy = intercept(&p, "https://example.local");
        assert_eq!(proxy.uri(), "http://y.ep");
        assert_eq!(
            proxy.basic_auth().expect("basic_auth"),
            "Basic QWxhZGRpbjpvcGVuc2VzYW1l"
        );
    }

    #[test]
    fn test_dont_parse_http_when_is_cgi() {
        let mut builder = Matcher::builder();
        builder.is_cgi = true;
        builder.http = "http://never.gonna.let.you.go".into();
        let m = builder.build(Extra::default());

        assert!(m.intercept(&"http://rick.roll".parse().unwrap()).is_none());
    }

    fn test_parse_socks(uri: &str) {
        let p = p! {
            all = uri,
        };

        let proxy = intercept(&p, "https://example.local");
        assert_eq!(proxy.uri(), uri);
    }

    #[test]
    fn test_parse_socks4() {
        test_parse_socks("socks4://localhost:8887");
        test_parse_socks("socks4a://localhost:8887");
    }

    #[test]
    fn test_parse_socks5() {
        test_parse_socks("socks5://localhost:8887");
        test_parse_socks("socks5h://localhost:8887");
    }

    #[test]
    fn test_domain_matcher_case_insensitive() {
        let domains = vec![".foo.bar".into()];
        let matcher = DomainMatcher(domains);

        assert!(matcher.contains("foo.bar"));
        assert!(matcher.contains("FOO.BAR"));
        assert!(matcher.contains("Foo.Bar"));

        assert!(matcher.contains("www.foo.bar"));
        assert!(matcher.contains("WWW.FOO.BAR"));
        assert!(matcher.contains("Www.Foo.Bar"));
    }

    #[test]
    fn test_no_proxy_case_insensitive() {
        let p = p! {
            all = "http://proxy.local",
            no = ".example.com",
        };

        // should bypass proxy (case insensitive match)
        assert!(
            p.intercept(&"http://example.com".parse().unwrap())
                .is_none()
        );
        assert!(
            p.intercept(&"http://EXAMPLE.COM".parse().unwrap())
                .is_none()
        );
        assert!(
            p.intercept(&"http://Example.com".parse().unwrap())
                .is_none()
        );

        // subdomain should bypass proxy (case insensitive match)
        assert!(
            p.intercept(&"http://www.example.com".parse().unwrap())
                .is_none()
        );
        assert!(
            p.intercept(&"http://WWW.EXAMPLE.COM".parse().unwrap())
                .is_none()
        );
        assert!(
            p.intercept(&"http://Www.Example.Com".parse().unwrap())
                .is_none()
        );
    }
}
