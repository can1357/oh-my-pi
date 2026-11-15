use btls::x509::store::{X509Store, X509StoreBuilder};

use super::{Certificate, CertificateInput};
use crate::{Error, Result};

pub fn parse_certs<'c, I>(
    certs: I,
    parser: fn(&'c [u8]) -> crate::Result<Certificate>,
) -> Result<X509Store>
where
    I: IntoIterator,
    I::Item: Into<CertificateInput<'c>>,
{
    let mut store = X509StoreBuilder::new().map_err(Error::tls)?;
    let certs = filter_map_certs(certs, parser);
    process_certs(certs.into_iter(), &mut store)?;
    Ok(store.build())
}

pub fn parse_certs_with_stack<C, F>(certs: C, parse: F) -> Result<X509Store>
where
    C: AsRef<[u8]>,
    F: Fn(C) -> Result<Vec<Certificate>>,
{
    let mut store = X509StoreBuilder::new().map_err(Error::tls)?;
    let certs = parse(certs)?;
    process_certs(certs.into_iter(), &mut store)?;
    Ok(store.build())
}

pub fn process_certs<I>(iter: I, store: &mut X509StoreBuilder) -> Result<()>
where
    I: Iterator<Item = Certificate>,
{
    let mut valid_count = 0;
    let mut invalid_count = 0;
    for cert in iter {
        if let Err(_err) = store.add_cert(cert.0) {
            invalid_count += 1;
            warn!("tls failed to parse certificate: {:?}", _err);
        } else {
            valid_count += 1;
        }
    }

    if valid_count == 0 && invalid_count > 0 {
        return Err(Error::builder("invalid certificate"));
    }

    Ok(())
}

pub fn filter_map_certs<'c, I>(
    certs: I,
    parser: fn(&'c [u8]) -> Result<Certificate>,
) -> impl Iterator<Item = Certificate>
where
    I: IntoIterator,
    I::Item: Into<CertificateInput<'c>>,
{
    certs
        .into_iter()
        .map(Into::into)
        .filter_map(move |data| match data.with_parser(parser) {
            Ok(cert) => Some(cert),
            Err(_err) => {
                warn!("tls failed to parse certificate: {:?}", _err);
                None
            }
        })
}
