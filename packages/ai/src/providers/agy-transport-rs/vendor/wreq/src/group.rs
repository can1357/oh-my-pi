//! # Request Grouping Mechanism
//!
//! This module provides the [`Group`] structure, which defines the logical boundaries
//! for categorizing and segregating outbound requests.
//!
//! ## Concept
//! A `Group` acts as a multi-dimensional identity for a request. In complex networking
//! stack environments, two requests targeting the same destination may belong to
//! distinct logical groups due to different metadata, security contexts, or
//! routing requirements.
//!
//! ## Logical Segregation
//! By assigning requests to different groups, the system ensures:
//! 1. **Contextual Isolation**: Requests are processed and dispatched within their defined logical
//!    partitions.
//! 2. **Deterministic Identity**: The internal `BTreeMap` ensures that the identity of a group is
//!    stable and invariant to the order in which grouping criteria are applied.
//! 3. **Resource Affinity**: Resource management (such as connection pooling) respects these
//!    boundaries, ensuring that resources are never leaked across different request groups.

use std::collections::BTreeMap;

use http::{Uri, Version};
use name::GroupId;

use crate::{conn::net::SocketBindOptions, proxy::Matcher};

macro_rules! impl_group_variants {
    ($($name:ident $(($ty:ty))?,)*) => {
        #[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord)]
        enum GroupKey {
            $($name,)*
        }

        #[derive(Debug, Clone, Hash, PartialEq, Eq)]
        enum GroupVariant {
            $($name $(($ty))?,)*
        }
    }
}

impl_group_variants! {
    Request(Group),
    Emulate(Group),
    Named(GroupId),
    Uri(Uri),
    Version(Version),
    Proxy(Matcher),
    SocketBind(Option<SocketBindOptions>),
}

/// A logical identifier for request grouping.
///
/// `Group` encapsulates the criteria that define a request's execution context.
/// Requests with non-identical `Group` states are treated as belonging to
/// different logical partitions, preventing unintended interaction or
/// resource sharing between them.
#[derive(Debug, Default, Clone, Hash, PartialEq, Eq)]
pub struct Group(BTreeMap<GroupKey, GroupVariant>);

impl Group {
    /// Creates a new [`Group`] with a custom string or numeric identifier.
    #[inline]
    pub fn new<N: Into<GroupId>>(name: N) -> Self {
        Group(BTreeMap::from([(
            GroupKey::Named,
            GroupVariant::Named(name.into()),
        )]))
    }

    /// Groups the request by a specific target [`Uri`].
    #[inline]
    pub(crate) fn uri(&mut self, uri: Uri) -> &mut Self {
        self.extend(GroupKey::Uri, GroupVariant::Uri(uri))
    }

    /// Groups the request by its required HTTP [`Version`].
    #[inline]
    pub(crate) fn version(&mut self, version: Option<Version>) -> &mut Self {
        self.extend(GroupKey::Version, version.map(GroupVariant::Version))
    }

    /// Groups the request based on its proxy [`Matcher`] criteria.
    #[inline]
    pub(crate) fn proxy(&mut self, proxy: Option<Matcher>) -> &mut Self {
        self.extend(GroupKey::Proxy, proxy.map(GroupVariant::Proxy))
    }

    /// Groups the request by its resolved socket bind options.
    #[inline]
    pub(crate) fn socket_bind(&mut self, opts: Option<SocketBindOptions>) -> &mut Self {
        self.extend(GroupKey::SocketBind, GroupVariant::SocketBind(opts))
    }

    /// Creates a nested request group.
    #[inline]
    pub(crate) fn request(&mut self, group: Group) -> &mut Self {
        self.extend(GroupKey::Request, GroupVariant::Request(group))
    }

    /// Groups the request by its emulation-layer characteristics.
    #[inline]
    pub(crate) fn emulate(&mut self, group: Group) -> &mut Self {
        self.extend(GroupKey::Emulate, GroupVariant::Emulate(group))
    }

    #[inline]
    fn extend<T: Into<Option<GroupVariant>>>(&mut self, id: GroupKey, entry: T) -> &mut Self {
        if let Some(entry) = entry.into() {
            self.0.insert(id, entry);
        }
        self
    }
}

impl From<u64> for Group {
    #[inline]
    fn from(value: u64) -> Self {
        Group::new(value)
    }
}

impl From<&'static str> for Group {
    #[inline]
    fn from(value: &'static str) -> Self {
        Group::new(value)
    }
}

impl From<String> for Group {
    #[inline]
    fn from(value: String) -> Self {
        Group::new(value)
    }
}

impl From<Box<str>> for Group {
    #[inline]
    fn from(value: Box<str>) -> Self {
        Group::new(value)
    }
}

mod name {

    /// A group identifier that can be a string or a numeric tag.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum GroupId {
        Borrowed(&'static str),
        Owned(Box<str>),
        Number(u64),
    }

    impl From<&'static str> for GroupId {
        #[inline]
        fn from(value: &'static str) -> Self {
            Self::Borrowed(value)
        }
    }

    impl From<String> for GroupId {
        #[inline]
        fn from(value: String) -> Self {
            Self::Owned(value.into_boxed_str())
        }
    }

    impl From<Box<str>> for GroupId {
        #[inline]
        fn from(value: Box<str>) -> Self {
            Self::Owned(value)
        }
    }

    impl From<u64> for GroupId {
        #[inline]
        fn from(value: u64) -> Self {
            Self::Number(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::hash::{DefaultHasher, Hash, Hasher};

    use super::*;

    #[test]
    fn test_group_identity_invariance() {
        let mut g1 = Group::default();
        g1.extend(GroupKey::Named, GroupVariant::Named("worker".into()));
        g1.extend(GroupKey::Version, GroupVariant::Version(Version::HTTP_2));

        let mut g2 = Group::default();
        g2.extend(GroupKey::Version, GroupVariant::Version(Version::HTTP_2));
        g2.extend(GroupKey::Named, GroupVariant::Named("worker".into()));

        let mut h1 = DefaultHasher::new();
        g1.hash(&mut h1);

        let mut h2 = DefaultHasher::new();
        g2.hash(&mut h2);

        assert_eq!(
            h1.finish(),
            h2.finish(),
            "Request groups must maintain identical hashes regardless of criteria insertion order"
        );
    }
}
