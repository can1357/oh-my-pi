fn ipv4_wildcard_to_cidr(value: &str) -> Option<String> {
    let parts = value.split('.').collect::<Vec<_>>();
    let wildcard = parts.iter().position(|part| *part == "*")?;

    if wildcard == 0 || wildcard > 3 || parts[wildcard..].iter().any(|part| *part != "*") {
        return None;
    }

    let mut octets = [0; 4];
    for (index, part) in parts[..wildcard].iter().enumerate() {
        octets[index] = part.parse().ok()?;
    }

    Some(format!(
        "{}.{}.{}.{}/{}",
        octets[0],
        octets[1],
        octets[2],
        octets[3],
        wildcard * 8
    ))
}

pub(super) fn normalize_proxy_override(value: &str) -> String {
    value
        .split(';')
        .map(|entry| {
            let entry = entry.trim();
            ipv4_wildcard_to_cidr(entry).unwrap_or_else(|| entry.to_string())
        })
        .collect::<Vec<_>>()
        .join(",")
        .replace("*.", "")
}

pub(super) fn with_system(builder: &mut super::matcher::Builder) {
    let Ok(settings) = windows_registry::CURRENT_USER
        .open("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
    else {
        return;
    };

    if settings.get_u32("ProxyEnable").unwrap_or(0) == 0 {
        return;
    }

    if let Ok(val) = settings.get_string("ProxyServer") {
        if builder.http.is_empty() {
            builder.http = val.clone();
        }
        if builder.https.is_empty() {
            builder.https = val;
        }
    }

    if builder.no.is_empty()
        && let Ok(val) = settings.get_string("ProxyOverride")
    {
        builder.no = normalize_proxy_override(&val);
    }
}
