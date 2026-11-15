use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

/// Trait for converting various types into a shared Unix Domain Socket path (`Arc<Path>`).
///
/// This trait is sealed to allow future extension while controlling which types can implement it.
/// It enables ergonomic conversion from common path types such as `String`, `&str`, `PathBuf`,
/// `&Path`, and `Arc<Path>` into a unified `Arc<Path>` representation for Unix socket usage.
///
/// # Supported types
/// - `String`
/// - `&str`
/// - `PathBuf`
/// - `&Path`
/// - `Arc<Path>`
pub trait IntoUnixSocket: sealed::Sealed {
    /// Returns the Unix Domain Socket path as an [`Arc<Path>`].
    fn unix_socket(self) -> Arc<Path>;
}

impl IntoUnixSocket for String {
    fn unix_socket(self) -> Arc<Path> {
        Arc::from(PathBuf::from(self))
    }
}

impl IntoUnixSocket for &'_ str {
    fn unix_socket(self) -> Arc<Path> {
        Arc::from(PathBuf::from(self))
    }
}

impl IntoUnixSocket for &'_ Path {
    fn unix_socket(self) -> Arc<Path> {
        Arc::from(self)
    }
}
impl IntoUnixSocket for PathBuf {
    fn unix_socket(self) -> Arc<Path> {
        Arc::from(self)
    }
}

impl IntoUnixSocket for Arc<Path> {
    fn unix_socket(self) -> Arc<Path> {
        self
    }
}

mod sealed {
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    /// Sealed trait to prevent external implementations of `IntoUnixSocket`.
    pub trait Sealed {}

    impl Sealed for String {}
    impl Sealed for &'_ str {}
    impl Sealed for &'_ Path {}
    impl Sealed for PathBuf {}
    impl Sealed for Arc<Path> {}
}
