use system_configuration::{
    core_foundation::{
        base::CFType,
        dictionary::CFDictionary,
        number::CFNumber,
        string::{CFString, CFStringRef},
    },
    dynamic_store::SCDynamicStoreBuilder,
    sys::schema_definitions::{
        kSCPropNetProxiesHTTPEnable, kSCPropNetProxiesHTTPPort, kSCPropNetProxiesHTTPProxy,
        kSCPropNetProxiesHTTPSEnable, kSCPropNetProxiesHTTPSPort, kSCPropNetProxiesHTTPSProxy,
    },
};

#[allow(unsafe_code)]
pub(super) fn with_system(builder: &mut super::matcher::Builder) {
    let Some(proxies_map) = SCDynamicStoreBuilder::new("")
        .build()
        .and_then(|store| store.get_proxies())
    else {
        return;
    };

    if builder.http.is_empty() {
        let http_proxy_config = parse_setting_from_dynamic_store(
            &proxies_map,
            unsafe { kSCPropNetProxiesHTTPEnable },
            unsafe { kSCPropNetProxiesHTTPProxy },
            unsafe { kSCPropNetProxiesHTTPPort },
        );
        if let Some(http) = http_proxy_config {
            builder.http = http;
        }
    }

    if builder.https.is_empty() {
        let https_proxy_config = parse_setting_from_dynamic_store(
            &proxies_map,
            unsafe { kSCPropNetProxiesHTTPSEnable },
            unsafe { kSCPropNetProxiesHTTPSProxy },
            unsafe { kSCPropNetProxiesHTTPSPort },
        );

        if let Some(https) = https_proxy_config {
            builder.https = https;
        }
    }
}

fn parse_setting_from_dynamic_store(
    proxies_map: &CFDictionary<CFString, CFType>,
    enabled_key: CFStringRef,
    host_key: CFStringRef,
    port_key: CFStringRef,
) -> Option<String> {
    let proxy_enabled = proxies_map
        .find(enabled_key)
        .and_then(|flag| flag.downcast::<CFNumber>())
        .and_then(|flag| flag.to_i32())
        .unwrap_or(0)
        == 1;

    if proxy_enabled {
        let proxy_host = proxies_map
            .find(host_key)
            .and_then(|host| host.downcast::<CFString>())
            .map(|host| host.to_string());
        let proxy_port = proxies_map
            .find(port_key)
            .and_then(|port| port.downcast::<CFNumber>())
            .and_then(|port| port.to_i32());

        return match (proxy_host, proxy_port) {
            (Some(proxy_host), Some(proxy_port)) => Some(format!("{proxy_host}:{proxy_port}")),
            (Some(proxy_host), None) => Some(proxy_host),
            (None, Some(_)) => None,
            (None, None) => None,
        };
    }

    None
}
