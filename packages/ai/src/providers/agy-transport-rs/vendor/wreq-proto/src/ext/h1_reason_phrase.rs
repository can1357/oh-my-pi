/// A reason phrase in an HTTP/1 response.
///
/// # Clients
///
/// For clients, a `ReasonPhrase` will be present in the extensions of the `http::Response`
/// returned for a request if the reason phrase is different from the canonical reason phrase
/// for the response's status code. For example, if a server returns `HTTP/1.1 200 Awesome`,
/// the `ReasonPhrase` will be present and contain `Awesome`, but if a server returns `HTTP/1.1
/// 200 OK`, the response will not contain a `ReasonPhrase`.
use bytes::Bytes;

/// A reason phrase in an HTTP/1 response.
///
/// # Clients
///
/// For clients, a `ReasonPhrase` will be present in the extensions of the `http::Response` returned
/// for a request if the reason phrase is different from the canonical reason phrase for the
/// response's status code. For example, if a server returns `HTTP/1.1 200 Awesome`, the
/// `ReasonPhrase` will be present and contain `Awesome`, but if a server returns `HTTP/1.1 200 OK`,
/// the response will not contain a `ReasonPhrase`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ReasonPhrase(Bytes);

impl ReasonPhrase {
    // Not public on purpose.
    /// Converts a `Bytes` directly into a `ReasonPhrase` without validating.
    ///
    /// Use with care; invalid bytes in a reason phrase can cause serious security problems if
    /// emitted in a response.
    #[inline]
    pub(crate) fn from_bytes_unchecked(reason: Bytes) -> Self {
        Self(reason)
    }
}

impl AsRef<[u8]> for ReasonPhrase {
    /// Gets the reason phrase as bytes.
    #[inline]
    fn as_ref(&self) -> &[u8] {
        &self.0
    }
}
