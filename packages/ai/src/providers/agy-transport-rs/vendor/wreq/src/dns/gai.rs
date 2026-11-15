if_tokio_rt! {
    mod tokio;
}

if_compio_rt!(
    mod compio;
);

if_all_rt!(
    mod tokio;
);

use std::net::SocketAddr;

use crate::dns::SocketAddrs;

/// A resolver using blocking `getaddrinfo` calls in a threadpool.
#[derive(Clone, Default)]
pub struct GaiResolver {
    _priv: (),
}

/// An iterator of IP addresses returned from `getaddrinfo`.
pub struct GaiAddrs {
    inner: SocketAddrs,
}

impl Iterator for GaiAddrs {
    type Item = SocketAddr;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next()
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use crate::dns::{Name, SocketAddrs};

    #[test]
    fn test_ip_addrs_split_by_preference() {
        let ip_v4 = Ipv4Addr::new(127, 0, 0, 1);
        let ip_v6 = Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1);
        let v4_addr = (ip_v4, 80).into();
        let v6_addr = (ip_v6, 80).into();

        let (mut preferred, mut fallback) = SocketAddrs {
            iter: vec![v4_addr, v6_addr].into_iter(),
        }
        .split_by_preference(None, None);
        assert!(preferred.next().unwrap().is_ipv4());
        assert!(fallback.next().unwrap().is_ipv6());

        let (mut preferred, mut fallback) = SocketAddrs {
            iter: vec![v6_addr, v4_addr].into_iter(),
        }
        .split_by_preference(None, None);
        assert!(preferred.next().unwrap().is_ipv6());
        assert!(fallback.next().unwrap().is_ipv4());

        let (mut preferred, mut fallback) = SocketAddrs {
            iter: vec![v4_addr, v6_addr].into_iter(),
        }
        .split_by_preference(Some(ip_v4), Some(ip_v6));
        assert!(preferred.next().unwrap().is_ipv4());
        assert!(fallback.next().unwrap().is_ipv6());

        let (mut preferred, mut fallback) = SocketAddrs {
            iter: vec![v6_addr, v4_addr].into_iter(),
        }
        .split_by_preference(Some(ip_v4), Some(ip_v6));
        assert!(preferred.next().unwrap().is_ipv6());
        assert!(fallback.next().unwrap().is_ipv4());

        let (mut preferred, fallback) = SocketAddrs {
            iter: vec![v4_addr, v6_addr].into_iter(),
        }
        .split_by_preference(Some(ip_v4), None);
        assert!(preferred.next().unwrap().is_ipv4());
        assert!(fallback.is_empty());

        let (mut preferred, fallback) = SocketAddrs {
            iter: vec![v4_addr, v6_addr].into_iter(),
        }
        .split_by_preference(None, Some(ip_v6));
        assert!(preferred.next().unwrap().is_ipv6());
        assert!(fallback.is_empty());
    }

    #[test]
    fn test_name_from_str() {
        const DOMAIN: &str = "test.example.com";
        let name = Name::from(DOMAIN);
        assert_eq!(name.as_str(), DOMAIN);
        assert_eq!(name.to_string(), DOMAIN);
    }
}
