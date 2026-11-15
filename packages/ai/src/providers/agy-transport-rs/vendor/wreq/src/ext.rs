//! Extension utilities.

use bytes::Bytes;
use http::uri::{Authority, Scheme, Uri};
use percent_encoding::{AsciiSet, CONTROLS};

use crate::Body;

/// See: <https://url.spec.whatwg.org/#fragment-percent-encode-set>
const FRAGMENT: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'<').add(b'>').add(b'`');

/// See: <https://url.spec.whatwg.org/#path-percent-encode-set>
const PATH: &AsciiSet = &FRAGMENT.add(b'#').add(b'?').add(b'{').add(b'}');

/// See: <https://url.spec.whatwg.org/#userinfo-percent-encode-set>
const USERINFO: &AsciiSet = &PATH
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'=')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'|');

macro_rules! impl_into_shared {
    ($(#[$meta:meta])* $vis:vis trait $name:ident => $target:path) => {
        $(#[$meta])*
        $vis trait $name {
            #[doc = concat!("Converts this type into a shared [`", stringify!($target), "`].")]
            fn into_shared(self) -> Arc<dyn $target>;
        }

        impl $name for Arc<dyn $target> {
            #[inline]
            fn into_shared(self) -> Arc<dyn $target> { self }
        }

        impl<R: $target + 'static> $name for Arc<R> {
            #[inline]
            fn into_shared(self) -> Arc<dyn $target> { self }
        }

        impl<R: $target + 'static> $name for R {
            #[inline]
            fn into_shared(self) -> Arc<dyn $target> { Arc::new(self) }
        }
    };
}

/// Extension trait for http::Response objects
///
/// Provides methods to extract URI information from HTTP responses
pub trait ResponseExt {
    /// Returns a reference to the `Uri` associated with this response, if available.
    fn uri(&self) -> Option<&Uri>;
}

/// Extension trait for http::response::Builder objects
///
/// Allows the user to add a `Uri` to the http::Response
pub trait ResponseBuilderExt {
    /// A builder method for the `http::response::Builder` type that allows the user to add a `Uri`
    /// to the `http::Response`
    fn uri(self, uri: Uri) -> Self;
}

/// Extension type to store the request URI in a response's extensions.
#[derive(Clone)]
pub(crate) struct RequestUri(pub Uri);

/// Extension trait for `Uri` helpers.
pub(crate) trait UriExt {
    /// Returns true if the URI scheme is HTTP.
    fn is_http(&self) -> bool;

    /// Returns true if the URI scheme is HTTPS.
    fn is_https(&self) -> bool;

    /// Returns the port of the URI, or the default port for the scheme if none is specified.
    fn port_or_default(&self) -> u16;

    /// Returns the username and password from the URI's userinfo, if present.
    fn userinfo(&self) -> (Option<&str>, Option<&str>);

    /// Sets the username and password in the URI's userinfo component.
    fn set_userinfo(&mut self, username: &str, password: Option<&str>);
}

// ===== impl ResponseExt =====

impl ResponseExt for http::Response<Body> {
    fn uri(&self) -> Option<&Uri> {
        self.extensions().get::<RequestUri>().map(|r| &r.0)
    }
}

// ===== impl ResponseBuilderExt =====

impl ResponseBuilderExt for http::response::Builder {
    fn uri(self, uri: Uri) -> Self {
        self.extension(RequestUri(uri))
    }
}

// ===== impl UriExt =====

impl UriExt for Uri {
    #[inline]
    fn is_http(&self) -> bool {
        self.scheme() == Some(&Scheme::HTTP)
    }

    #[inline]
    fn is_https(&self) -> bool {
        self.scheme() == Some(&Scheme::HTTPS)
    }

    fn port_or_default(&self) -> u16 {
        match Uri::port(self) {
            Some(p) => p.as_u16(),
            None if self.is_https() => 443u16,
            _ => 80u16,
        }
    }

    fn userinfo(&self) -> (Option<&str>, Option<&str>) {
        self.authority()
            .and_then(|auth| auth.as_str().rsplit_once('@'))
            .map_or((None, None), |(userinfo, _)| {
                match userinfo.split_once(':') {
                    Some((u, p)) => ((!u.is_empty()).then_some(u), (!p.is_empty()).then_some(p)),
                    None => (Some(userinfo), None),
                }
            })
    }

    fn set_userinfo(&mut self, username: &str, password: Option<&str>) {
        let mut parts = self.clone().into_parts();

        let authority = match self.authority() {
            Some(authority) => authority,
            None => return,
        };

        let host_and_port = authority
            .as_str()
            .rsplit_once('@')
            .map(|(_, host)| host)
            .unwrap_or_else(|| authority.as_str());

        let authority = match (username.is_empty(), password) {
            (true, None) => Bytes::from(host_and_port.to_owned()),
            (true, Some(password)) => {
                let pass = percent_encoding::utf8_percent_encode(password, USERINFO);
                Bytes::from(format!(":{pass}@{host_and_port}"))
            }
            (false, Some(password)) => {
                let username = percent_encoding::utf8_percent_encode(username, USERINFO);
                let password = percent_encoding::utf8_percent_encode(password, USERINFO);
                Bytes::from(format!("{username}:{password}@{host_and_port}"))
            }
            (false, None) => {
                let username = percent_encoding::utf8_percent_encode(username, USERINFO);
                Bytes::from(format!("{username}@{host_and_port}"))
            }
        };

        match Authority::from_maybe_shared(authority) {
            Ok(authority) => {
                parts.authority.replace(authority);
            }
            Err(_err) => {
                debug!("Failed to set userinfo in URI: {_err}");
                return;
            }
        };

        if let Ok(uri) = Uri::from_parts(parts) {
            *self = uri;
        }
    }
}

#[cfg(test)]
mod tests {
    use http::{Uri, response::Builder};

    use super::{RequestUri, ResponseBuilderExt, ResponseExt, UriExt};
    use crate::Body;

    #[test]
    fn test_uri_ext_is_https() {
        let https_uri: Uri = "https://example.com".parse().unwrap();
        let http_uri: Uri = "http://example.com".parse().unwrap();

        assert!(https_uri.is_https());
        assert!(!http_uri.is_https());
        assert!(http_uri.is_http());
        assert!(!https_uri.is_http());
    }

    #[test]
    fn test_userinfo_with_username_and_password() {
        let uri: Uri = "http://user:pass@example.com".parse().unwrap();
        let (username, password) = uri.userinfo();

        assert_eq!(username, Some("user"));
        assert_eq!(password, Some("pass"));
    }

    #[test]
    fn test_userinfo_with_empty_username() {
        let uri: Uri = "http://:pass@example.com".parse().unwrap();
        let (username, password) = uri.userinfo();

        assert_eq!(username, None);
        assert_eq!(password, Some("pass"));
    }

    #[test]
    fn test_userinfo_with_empty_password() {
        let uri: Uri = "http://user:@example.com".parse().unwrap();
        let (username, password) = uri.userinfo();

        assert_eq!(username, Some("user"));
        assert_eq!(password, None);

        let uri: Uri = "http://user@example.com".parse().unwrap();
        let (username, password) = uri.userinfo();

        assert_eq!(username, Some("user"));
        assert_eq!(password, None);
    }

    #[test]
    fn test_userinfo_without_colon() {
        let uri: Uri = "http://something@example.com".parse().unwrap();
        let (username, password) = uri.userinfo();

        assert_eq!(username, Some("something"));
        assert_eq!(password, None);
    }

    #[test]
    fn test_userinfo_without_at() {
        let uri: Uri = "http://example.com".parse().unwrap();
        let (username, password) = uri.userinfo();

        assert_eq!(username, None);
        assert_eq!(password, None);
    }

    #[test]
    fn test_set_userinfo_both() {
        let mut uri: Uri = "http://example.com/path".parse().unwrap();
        uri.set_userinfo("user", Some("pass"));

        let (username, password) = uri.userinfo();
        assert_eq!(username, Some("user"));
        assert_eq!(password, Some("pass"));
        assert_eq!(uri.to_string(), "http://user:pass@example.com/path");
    }

    #[test]
    fn test_set_userinfo_empty_username() {
        let mut uri: Uri = "http://user:pass@example.com/path".parse().unwrap();
        uri.set_userinfo("", Some("pass"));

        let (username, password) = uri.userinfo();
        assert_eq!(username, None);
        assert_eq!(password, Some("pass"));
        assert_eq!(uri.to_string(), "http://:pass@example.com/path");
    }

    #[test]
    fn test_set_userinfo_none_password() {
        let mut uri: Uri = "http://user:pass@example.com/path".parse().unwrap();
        uri.set_userinfo("user", None);

        let (username, password) = uri.userinfo();
        assert_eq!(username, Some("user"));
        assert_eq!(password, None);
        assert_eq!(uri.to_string(), "http://user@example.com/path");
    }

    #[test]
    fn test_set_userinfo_empty_username_and_password() {
        let mut uri: Uri = "http://user:pass@example.com/path".parse().unwrap();
        uri.set_userinfo("", None);

        let (username, password) = uri.userinfo();
        assert_eq!(username, None);
        assert_eq!(password, None);
        assert_eq!(uri.to_string(), "http://example.com/path");
    }

    #[test]
    fn test_set_userinfo_with_encoding() {
        use http::Uri;

        use crate::ext::UriExt;

        let mut uri: Uri = "http://example.com/path".parse().unwrap();
        uri.set_userinfo("us er", Some("p@ss:word!"));

        let (username, password) = uri.userinfo();
        assert_eq!(username, Some("us%20er"));
        assert_eq!(password, Some("p%40ss%3Aword!"));

        assert_eq!(
            uri.to_string(),
            "http://us%20er:p%40ss%3Aword!@example.com/path"
        );
    }

    #[test]
    fn test_set_userinfo_only_username_with_encoding() {
        use http::Uri;

        use crate::ext::UriExt;

        let mut uri: Uri = "http://example.com/".parse().unwrap();
        uri.set_userinfo("user name", None);

        let (username, password) = uri.userinfo();
        assert_eq!(username, Some("user%20name"));
        assert_eq!(password, None);

        assert_eq!(uri.to_string(), "http://user%20name@example.com/");
    }

    #[test]
    fn test_set_userinfo_only_password_with_encoding() {
        use http::Uri;

        use crate::ext::UriExt;

        let mut uri: Uri = "http://example.com/".parse().unwrap();
        uri.set_userinfo("", Some("p@ss word"));

        let (username, password) = uri.userinfo();
        assert_eq!(username, None);
        assert_eq!(password, Some("p%40ss%20word"));

        assert_eq!(uri.to_string(), "http://:p%40ss%20word@example.com/");
    }

    #[test]
    fn test_response_builder_ext() {
        let uri = Uri::try_from("http://example.com").unwrap();
        let response = Builder::new()
            .status(200)
            .uri(uri.clone())
            .body(Body::empty())
            .unwrap();

        assert_eq!(response.uri(), Some(&uri));
    }

    #[test]
    fn test_response_ext() {
        let uri = Uri::try_from("http://example.com").unwrap();
        let response = http::Response::builder()
            .status(200)
            .extension(RequestUri(uri.clone()))
            .body(Body::empty())
            .unwrap();

        assert_eq!(response.uri(), Some(&uri));
    }
}
