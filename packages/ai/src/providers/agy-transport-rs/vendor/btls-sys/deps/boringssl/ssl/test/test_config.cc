// Copyright 2014 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "test_config.h"

#include <assert.h>
#include <ctype.h>
#include <errno.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <algorithm>
#include <functional>
#include <limits>
#include <memory>
#include <type_traits>

#include <openssl/aead.h>
#include <openssl/base64.h>
#include <openssl/hmac.h>
#include <openssl/hpke.h>
#include <openssl/rand.h>
#include <openssl/span.h>
#include <openssl/ssl.h>

#include "../../crypto/internal.h"
#include "handshake_util.h"
#include "mock_quic_transport.h"
#include "test_state.h"

#if defined(OPENSSL_WINDOWS)
// Windows defines struct timeval in winsock2.h.
#include <winsock2.h>
#else
#include <sys/time.h>
#endif

namespace {

template <typename Config>
struct Flag {
  const char *name;
  // has_param, if true, causes the parser to look for a param value following
  // this flag's name.
  bool has_param;
  // skip_handshaker, if true, causes this flag to be skipped when
  // forwarding flags to the handshaker. This should be used with flags
  // that only impact connecting to the runner.
  bool skip_handshaker;
  // set_param is called after parsing to interpret and set the result on
  // `config`. If `has_param` is false for this flag, `param` will be nullptr.
  // This function should return whether the param value (or lack thereof) was
  // valid for this flag.
  std::function<bool(Config *config, const char *param)> set_param;
};

template <typename Config>
Flag<Config> BoolFlag(const char *name, bool Config::*field,
                      bool skip_handshaker = false) {
  return Flag<Config>{name, false, skip_handshaker,
                      [=](Config *config, const char *) -> bool {
                        config->*field = true;
                        return true;
                      }};
}

template <typename Config>
Flag<Config> OptionalBoolTrueFlag(const char *name,
                                  std::optional<bool> Config::*field,
                                  bool skip_handshaker = false) {
  return Flag<Config>{name, false, skip_handshaker,
                      [=](Config *config, const char *) -> bool {
                        config->*field = true;
                        return true;
                      }};
}

template <typename Config>
Flag<Config> OptionalBoolFalseFlag(const char *name,
                                   std::optional<bool> Config::*field,
                                   bool skip_handshaker = false) {
  return Flag<Config>{name, false, skip_handshaker,
                      [=](Config *config, const char *) -> bool {
                        config->*field = false;
                        return true;
                      }};
}

template <typename T>
bool StringToInt(T *out, const char *str) {
  static_assert(std::is_integral<T>::value, "not an integral type");

  // |strtoull| allows leading '-' with wraparound. Additionally, both
  // functions accept empty strings and leading whitespace.
  if (!OPENSSL_isdigit(static_cast<unsigned char>(*str)) &&
      (!std::is_signed<T>::value || *str != '-')) {
    return false;
  }

  errno = 0;
  char *end;
  if (std::is_signed<T>::value) {
    static_assert(sizeof(T) <= sizeof(long long),
                  "type too large for long long");
    long long value = strtoll(str, &end, 10);
    if (value < static_cast<long long>(std::numeric_limits<T>::min()) ||
        value > static_cast<long long>(std::numeric_limits<T>::max())) {
      return false;
    }
    *out = static_cast<T>(value);
  } else {
    static_assert(sizeof(T) <= sizeof(unsigned long long),
                  "type too large for unsigned long long");
    unsigned long long value = strtoull(str, &end, 10);
    if (value >
        static_cast<unsigned long long>(std::numeric_limits<T>::max())) {
      return false;
    }
    *out = static_cast<T>(value);
  }

  // Check for overflow and that the whole input was consumed.
  return errno != ERANGE && *end == '\0';
}

template <typename Config, typename T>
Flag<Config> IntFlag(const char *name, T Config::*field,
                     bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        return StringToInt(&(config->*field), param);
                      }};
}

template <typename Config, typename T>
Flag<Config> OptionalIntFlag(const char *name, std::optional<T> Config::*field,
                             bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        T value;
                        if (!StringToInt(&value, param)) {
                          return false;
                        }
                        config->*field = value;
                        return true;
                      }};
}

template <typename Config, typename T>
Flag<Config> IntVectorFlag(const char *name, std::vector<T> Config::*field,
                           bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        T value;
                        if (!StringToInt(&value, param)) {
                          return false;
                        }
                        (config->*field).push_back(value);
                        return true;
                      }};
}

// Defines a flag which adds an integer param value to an optional vector of
// integers.
template <typename Config, typename T>
Flag<Config> OptionalIntVectorFlag(const char *name,
                                   std::optional<std::vector<T>> Config::*field,
                                   bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        if (!(config->*field)) {
                          (config->*field).emplace();
                        }
                        T value;
                        if (!StringToInt(&value, param)) {
                          return false;
                        }
                        (config->*field)->push_back(value);
                        return true;
                      }};
}

// Defines a flag which resets a std::optional field to its default constructed
// value.
template <typename Config, typename T>
Flag<Config> OptionalDefaultInitFlag(const char *name,
                                     std::optional<T> Config::*field,
                                     bool skip_handshaker = false) {
  return Flag<Config>{name, false, skip_handshaker,
                      [=](Config *config, const char *) -> bool {
                        (config->*field).emplace();
                        return true;
                      }};
}

template <typename Config>
Flag<Config> StringFlag(const char *name, std::string Config::*field,
                        bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        config->*field = param;
                        return true;
                      }};
}

template <typename Config>
Flag<Config> OptionalStringFlag(const char *name,
                                std::optional<std::string> Config::*field,
                                bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        (config->*field).emplace(param);
                        return true;
                      }};
}

bool DecodeBase64(std::vector<uint8_t> *out, const std::string &in) {
  size_t len;
  if (!EVP_DecodedLength(&len, in.size())) {
    fprintf(stderr, "Invalid base64: %s.\n", in.c_str());
    return false;
  }
  out->resize(len);
  if (!EVP_DecodeBase64(out->data(), &len, out->size(),
                        reinterpret_cast<const uint8_t *>(in.data()),
                        in.size())) {
    fprintf(stderr, "Invalid base64: %s.\n", in.c_str());
    return false;
  }
  out->resize(len);
  return true;
}

template <typename Config>
Flag<Config> Base64Flag(const char *name, std::vector<uint8_t> Config::*field,
                        bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        return DecodeBase64(&(config->*field), param);
                      }};
}

template <typename Config>
Flag<Config> OptionalBase64Flag(
    const char *name, std::optional<std::vector<uint8_t>> Config::*field,
    bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        (config->*field).emplace();
                        return DecodeBase64(&*(config->*field), param);
                      }};
}

template <typename Config>
Flag<Config> Base64VectorFlag(const char *name,
                              std::vector<std::vector<uint8_t>> Config::*field,
                              bool skip_handshaker = false) {
  return Flag<Config>{name, true, skip_handshaker,
                      [=](Config *config, const char *param) -> bool {
                        std::vector<uint8_t> value;
                        if (!DecodeBase64(&value, param)) {
                          return false;
                        }
                        (config->*field).push_back(std::move(value));
                        return true;
                      }};
}

template <typename Config>
Flag<Config> StringPairVectorFlag(
    const char *name,
    std::vector<std::pair<std::string, std::string>> Config::*field,
    bool skip_handshaker = false) {
  return Flag<Config>{
      name, true, skip_handshaker,
      [=](Config *config, const char *param) -> bool {
        const char *comma = strchr(param, ',');
        if (!comma) {
          return false;
        }
        (config->*field)
            .push_back(std::make_pair(std::string(param, comma - param),
                                      std::string(comma + 1)));
        return true;
      }};
}

Flag<TestConfig> NewCredentialFlag(const char *name,
                                   CredentialConfigType type) {
  return Flag<TestConfig>{name, /*has_param=*/false, /*skip_handshaker=*/false,
                          [=](TestConfig *config, const char *param) -> bool {
                            config->credentials.emplace_back();
                            config->credentials.back().type = type;
                            return true;
                          }};
}

Flag<TestConfig> CredentialFlagWithDefault(Flag<TestConfig> default_flag,
                                           Flag<CredentialConfig> flag) {
  BSSL_CHECK(strcmp(default_flag.name, flag.name) == 0);
  BSSL_CHECK(default_flag.has_param == flag.has_param);
  return Flag<TestConfig>{flag.name, flag.has_param, /*skip_handshaker=*/false,
                          [=](TestConfig *config, const char *param) -> bool {
                            if (config->credentials.empty()) {
                              return default_flag.set_param(config, param);
                            }
                            return flag.set_param(&config->credentials.back(),
                                                  param);
                          }};
}

Flag<TestConfig> CredentialFlag(Flag<CredentialConfig> flag) {
  return Flag<TestConfig>{flag.name, flag.has_param, /*skip_handshaker=*/false,
                          [=](TestConfig *config, const char *param) -> bool {
                            if (config->credentials.empty()) {
                              fprintf(stderr, "No credentials configured.\n");
                              return false;
                            }
                            return flag.set_param(&config->credentials.back(),
                                                  param);
                          }};
}

struct FlagNameComparator {
  template <typename Config>
  bool operator()(const Flag<Config> &flag1, const Flag<Config> &flag2) const {
    return strcmp(flag1.name, flag2.name) < 0;
  }

  template <typename Config>
  bool operator()(const Flag<Config> &flag, const char *name) const {
    return strcmp(flag.name, name) < 0;
  }
};

const Flag<TestConfig> *FindFlag(const char *name) {
  static const std::vector<Flag<TestConfig>> flags = [] {
    std::vector<Flag<TestConfig>> ret = {
        IntFlag("-port", &TestConfig::port, /*skip_handshaker=*/true),
        BoolFlag("-ipv6", &TestConfig::ipv6, /*skip_handshaker=*/true),
        IntFlag("-shim-id", &TestConfig::shim_id, /*skip_handshaker=*/true),
        BoolFlag("-server", &TestConfig::is_server),
        BoolFlag("-dtls", &TestConfig::is_dtls),
        BoolFlag("-quic", &TestConfig::is_quic),
        IntFlag("-resume-count", &TestConfig::resume_count),
        StringFlag("-write-settings", &TestConfig::write_settings),
#if defined(FUZZING_BUILD_MODE_UNSAFE_FOR_PRODUCTION)
        BoolFlag("-fuzzer-mode", &TestConfig::fuzzer_mode),
#endif
        BoolFlag("-fallback-scsv", &TestConfig::fallback_scsv),
        IntVectorFlag("-verify-prefs", &TestConfig::verify_prefs),
        IntVectorFlag("-expect-peer-verify-pref",
                      &TestConfig::expect_peer_verify_prefs),
        IntVectorFlag("-curves", &TestConfig::curves),
        OptionalIntVectorFlag("-key-shares", &TestConfig::key_shares),
        OptionalDefaultInitFlag("-no-key-shares", &TestConfig::key_shares),
        IntVectorFlag("-server-supported-groups-hint",
                      &TestConfig::server_supported_groups_hint),
        StringFlag("-trust-cert", &TestConfig::trust_cert),
        StringFlag("-expect-server-name", &TestConfig::expect_server_name),
        BoolFlag("-enable-ech-grease", &TestConfig::enable_ech_grease),
        Base64VectorFlag("-ech-server-config", &TestConfig::ech_server_configs),
        Base64VectorFlag("-ech-server-key", &TestConfig::ech_server_keys),
        IntVectorFlag("-ech-is-retry-config", &TestConfig::ech_is_retry_config),
        BoolFlag("-expect-ech-accept", &TestConfig::expect_ech_accept),
        StringFlag("-expect-ech-name-override",
                   &TestConfig::expect_ech_name_override),
        BoolFlag("-expect-no-ech-name-override",
                 &TestConfig::expect_no_ech_name_override),
        Base64Flag("-expect-ech-retry-configs",
                   &TestConfig::expect_ech_retry_configs),
        BoolFlag("-expect-no-ech-retry-configs",
                 &TestConfig::expect_no_ech_retry_configs),
        Base64Flag("-ech-config-list", &TestConfig::ech_config_list),
        Base64Flag("-expect-certificate-types",
                   &TestConfig::expect_certificate_types),
        BoolFlag("-require-any-client-certificate",
                 &TestConfig::require_any_client_certificate),
        StringFlag("-advertise-npn", &TestConfig::advertise_npn),
        BoolFlag("-advertise-empty-npn", &TestConfig::advertise_empty_npn),
        StringFlag("-expect-next-proto", &TestConfig::expect_next_proto),
        BoolFlag("-expect-no-next-proto", &TestConfig::expect_no_next_proto),
        BoolFlag("-false-start", &TestConfig::false_start),
        StringFlag("-select-next-proto", &TestConfig::select_next_proto),
        BoolFlag("-select-empty-next-proto",
                 &TestConfig::select_empty_next_proto),
        BoolFlag("-async", &TestConfig::async),
        BoolFlag("-write-different-record-sizes",
                 &TestConfig::write_different_record_sizes),
        BoolFlag("-cbc-record-splitting", &TestConfig::cbc_record_splitting),
        BoolFlag("-partial-write", &TestConfig::partial_write),
        BoolFlag("-no-tls13", &TestConfig::no_tls13),
        BoolFlag("-no-tls12", &TestConfig::no_tls12),
        BoolFlag("-no-tls11", &TestConfig::no_tls11),
        BoolFlag("-no-tls1", &TestConfig::no_tls1),
        BoolFlag("-no-ticket", &TestConfig::no_ticket),
        Base64Flag("-expect-channel-id", &TestConfig::expect_channel_id),
        BoolFlag("-enable-channel-id", &TestConfig::enable_channel_id),
        StringFlag("-send-channel-id", &TestConfig::send_channel_id),
        BoolFlag("-shim-writes-first", &TestConfig::shim_writes_first),
        StringFlag("-host-name", &TestConfig::host_name),
        StringFlag("-advertise-alpn", &TestConfig::advertise_alpn),
        StringFlag("-expect-alpn", &TestConfig::expect_alpn),
        StringFlag("-expect-advertised-alpn",
                   &TestConfig::expect_advertised_alpn),
        StringFlag("-select-alpn", &TestConfig::select_alpn),
        BoolFlag("-decline-alpn", &TestConfig::decline_alpn),
        BoolFlag("-reject-alpn", &TestConfig::reject_alpn),
        BoolFlag("-select-empty-alpn", &TestConfig::select_empty_alpn),
        BoolFlag("-defer-alps", &TestConfig::defer_alps),
        StringPairVectorFlag("-application-settings",
                             &TestConfig::application_settings),
        OptionalStringFlag("-expect-peer-application-settings",
                           &TestConfig::expect_peer_application_settings),
        IntFlag("-alps-use-new-codepoint", &TestConfig::alps_use_new_codepoint),
        Base64Flag("-quic-transport-params",
                   &TestConfig::quic_transport_params),
        Base64Flag("-expect-quic-transport-params",
                   &TestConfig::expect_quic_transport_params),
        IntFlag("-quic-use-legacy-codepoint",
                &TestConfig::quic_use_legacy_codepoint),
        BoolFlag("-expect-session-miss", &TestConfig::expect_session_miss),
        BoolFlag("-expect-extended-master-secret",
                 &TestConfig::expect_extended_master_secret),
        StringFlag("-psk", &TestConfig::psk),
        StringFlag("-psk-identity", &TestConfig::psk_identity),
        StringFlag("-srtp-profiles", &TestConfig::srtp_profiles),
        BoolFlag("-enable-ocsp-stapling", &TestConfig::enable_ocsp_stapling),
        BoolFlag("-enable-signed-cert-timestamps",
                 &TestConfig::enable_signed_cert_timestamps),
        Base64Flag("-expect-signed-cert-timestamps",
                   &TestConfig::expect_signed_cert_timestamps),
        IntFlag("-min-version", &TestConfig::min_version),
        IntFlag("-max-version", &TestConfig::max_version),
        IntFlag("-expect-version", &TestConfig::expect_version),
        IntFlag("-mtu", &TestConfig::mtu),
        BoolFlag("-implicit-handshake", &TestConfig::implicit_handshake),
        BoolFlag("-use-early-callback", &TestConfig::use_early_callback),
        BoolFlag("-fail-early-callback", &TestConfig::fail_early_callback),
        BoolFlag("-fail-early-callback-ech-rewind",
                 &TestConfig::fail_early_callback_ech_rewind),
        BoolFlag("-install-ddos-callback", &TestConfig::install_ddos_callback),
        BoolFlag("-fail-ddos-callback", &TestConfig::fail_ddos_callback),
        BoolFlag("-fail-cert-callback", &TestConfig::fail_cert_callback),
        StringFlag("-cipher", &TestConfig::cipher),
        BoolFlag("-handshake-never-done", &TestConfig::handshake_never_done),
        IntFlag("-export-keying-material", &TestConfig::export_keying_material),
        StringFlag("-export-label", &TestConfig::export_label),
        StringFlag("-export-context", &TestConfig::export_context),
        BoolFlag("-use-export-context", &TestConfig::use_export_context),
        BoolFlag("-tls-unique", &TestConfig::tls_unique),
        BoolFlag("-expect-ticket-renewal", &TestConfig::expect_ticket_renewal),
        BoolFlag("-expect-no-session", &TestConfig::expect_no_session),
        BoolFlag("-expect-ticket-supports-early-data",
                 &TestConfig::expect_ticket_supports_early_data),
        BoolFlag("-expect-accept-early-data",
                 &TestConfig::expect_accept_early_data),
        BoolFlag("-expect-reject-early-data",
                 &TestConfig::expect_reject_early_data),
        BoolFlag("-expect-no-offer-early-data",
                 &TestConfig::expect_no_offer_early_data),
        BoolFlag("-expect-no-server-name", &TestConfig::expect_no_server_name),
        BoolFlag("-use-ticket-callback", &TestConfig::use_ticket_callback),
        BoolFlag("-use-ticket-aead-callback",
                 &TestConfig::use_ticket_aead_callback),
        BoolFlag("-renew-ticket", &TestConfig::renew_ticket),
        BoolFlag("-skip-ticket", &TestConfig::skip_ticket),
        BoolFlag("-enable-early-data", &TestConfig::enable_early_data),
        Base64Flag("-expect-ocsp-response", &TestConfig::expect_ocsp_response),
        BoolFlag("-check-close-notify", &TestConfig::check_close_notify),
        BoolFlag("-shim-shuts-down", &TestConfig::shim_shuts_down),
        BoolFlag("-verify-fail", &TestConfig::verify_fail),
        BoolFlag("-verify-peer", &TestConfig::verify_peer),
        BoolFlag("-expect-verify-result", &TestConfig::expect_verify_result),
        IntFlag("-expect-total-renegotiations",
                &TestConfig::expect_total_renegotiations),
        BoolFlag("-renegotiate-once", &TestConfig::renegotiate_once),
        BoolFlag("-renegotiate-freely", &TestConfig::renegotiate_freely),
        BoolFlag("-renegotiate-ignore", &TestConfig::renegotiate_ignore),
        BoolFlag("-renegotiate-explicit", &TestConfig::renegotiate_explicit),
        BoolFlag("-forbid-renegotiation-after-handshake",
                 &TestConfig::forbid_renegotiation_after_handshake),
        IntFlag("-expect-peer-signature-algorithm",
                &TestConfig::expect_peer_signature_algorithm),
        IntFlag("-expect-curve-id", &TestConfig::expect_curve_id),
        BoolFlag("-use-old-client-cert-callback",
                 &TestConfig::use_old_client_cert_callback),
        IntFlag("-initial-timeout-duration-ms",
                &TestConfig::initial_timeout_duration_ms),
        StringFlag("-use-client-ca-list", &TestConfig::use_client_ca_list),
        StringFlag("-expect-client-ca-list",
                   &TestConfig::expect_client_ca_list),
        BoolFlag("-send-alert", &TestConfig::send_alert),
        BoolFlag("-peek-then-read", &TestConfig::peek_then_read),
        BoolFlag("-enable-grease", &TestConfig::enable_grease),
        BoolFlag("-permute-extensions", &TestConfig::permute_extensions),
        IntFlag("-max-cert-list", &TestConfig::max_cert_list),
        Base64Flag("-ticket-key", &TestConfig::ticket_key),
        BoolFlag("-use-exporter-between-reads",
                 &TestConfig::use_exporter_between_reads),
        IntFlag("-expect-cipher-aes", &TestConfig::expect_cipher_aes),
        IntFlag("-expect-cipher-no-aes", &TestConfig::expect_cipher_no_aes),
        IntFlag("-expect-cipher", &TestConfig::expect_cipher),
        StringFlag("-expect-peer-cert-file",
                   &TestConfig::expect_peer_cert_file),
        IntFlag("-resumption-delay", &TestConfig::resumption_delay),
        BoolFlag("-retain-only-sha256-client-cert",
                 &TestConfig::retain_only_sha256_client_cert),
        BoolFlag("-expect-sha256-client-cert",
                 &TestConfig::expect_sha256_client_cert),
        BoolFlag("-read-with-unfinished-write",
                 &TestConfig::read_with_unfinished_write),
        BoolFlag("-expect-secure-renegotiation",
                 &TestConfig::expect_secure_renegotiation),
        BoolFlag("-expect-no-secure-renegotiation",
                 &TestConfig::expect_no_secure_renegotiation),
        IntFlag("-max-send-fragment", &TestConfig::max_send_fragment),
        IntFlag("-read-size", &TestConfig::read_size),
        BoolFlag("-expect-session-id", &TestConfig::expect_session_id),
        BoolFlag("-expect-no-session-id", &TestConfig::expect_no_session_id),
        IntFlag("-expect-ticket-age-skew", &TestConfig::expect_ticket_age_skew),
        BoolFlag("-no-op-extra-handshake", &TestConfig::no_op_extra_handshake),
        BoolFlag("-handshake-twice", &TestConfig::handshake_twice),
        BoolFlag("-allow-unknown-alpn-protos",
                 &TestConfig::allow_unknown_alpn_protos),
        BoolFlag("-use-custom-verify-callback",
                 &TestConfig::use_custom_verify_callback),
        StringFlag("-expect-msg-callback", &TestConfig::expect_msg_callback),
        BoolFlag("-allow-false-start-without-alpn",
                 &TestConfig::allow_false_start_without_alpn),
        BoolFlag("-handoff", &TestConfig::handoff),
        BoolFlag("-handshake-hints", &TestConfig::handshake_hints),
        BoolFlag("-allow-hint-mismatch", &TestConfig::allow_hint_mismatch),
        BoolFlag("-use-ocsp-callback", &TestConfig::use_ocsp_callback),
        BoolFlag("-set-ocsp-in-callback", &TestConfig::set_ocsp_in_callback),
        BoolFlag("-decline-ocsp-callback", &TestConfig::decline_ocsp_callback),
        BoolFlag("-fail-ocsp-callback", &TestConfig::fail_ocsp_callback),
        BoolFlag("-install-cert-compression-algs",
                 &TestConfig::install_cert_compression_algs),
        IntFlag("-install-one-cert-compression-alg",
                &TestConfig::install_one_cert_compression_alg),
        BoolFlag("-reverify-on-resume", &TestConfig::reverify_on_resume),
        BoolFlag("-ignore-rsa-key-usage", &TestConfig::ignore_rsa_key_usage),
        BoolFlag("-expect-key-usage-invalid",
                 &TestConfig::expect_key_usage_invalid),
        BoolFlag("-is-handshaker-supported",
                 &TestConfig::is_handshaker_supported),
        BoolFlag("-handshaker-resume", &TestConfig::handshaker_resume),
        StringFlag("-handshaker-path", &TestConfig::handshaker_path),
        BoolFlag("-jdk11-workaround", &TestConfig::jdk11_workaround),
        BoolFlag("-server-preference", &TestConfig::server_preference),
        BoolFlag("-export-traffic-secrets",
                 &TestConfig::export_traffic_secrets),
        BoolFlag("-key-update", &TestConfig::key_update),
        BoolFlag("-key-update-before-read",
                 &TestConfig::key_update_before_read),
        StringFlag("-expect-early-data-reason",
                   &TestConfig::expect_early_data_reason),
        BoolFlag("-expect-hrr", &TestConfig::expect_hrr),
        BoolFlag("-expect-no-hrr", &TestConfig::expect_no_hrr),
        BoolFlag("-wait-for-debugger", &TestConfig::wait_for_debugger),
        StringFlag("-quic-early-data-context",
                   &TestConfig::quic_early_data_context),
        IntFlag("-early-write-after-message",
                &TestConfig::early_write_after_message),
        BoolFlag("-fips-202205", &TestConfig::fips_202205),
        BoolFlag("-wpa-202304", &TestConfig::wpa_202304),
        BoolFlag("-cnsa-202407", &TestConfig::cnsa_202407),
        OptionalBoolTrueFlag("-expect-peer-match-trust-anchor",
                             &TestConfig::expect_peer_match_trust_anchor),
        OptionalBoolFalseFlag("-expect-no-peer-match-trust-anchor",
                              &TestConfig::expect_peer_match_trust_anchor),
        OptionalBase64Flag("-expect-peer-available-trust-anchors",
                           &TestConfig::expect_peer_available_trust_anchors),
        OptionalBase64Flag("-requested-trust-anchors",
                           &TestConfig::requested_trust_anchors),
        OptionalIntFlag("-expect-selected-credential",
                        &TestConfig::expect_selected_credential),
        // Credential flags are stateful. First, use one of the
        // -new-*-credential flags to introduce a new credential. Then the flags
        // below switch from acting on the legacy credential to the newly-added
        // one. Repeat this process to continue adding them.
        NewCredentialFlag("-new-x509-credential", CredentialConfigType::kX509),
        NewCredentialFlag("-new-delegated-credential",
                          CredentialConfigType::kDelegated),
        NewCredentialFlag("-new-spake2plusv1-credential",
                          CredentialConfigType::kSPAKE2PlusV1),
        CredentialFlagWithDefault(
            StringFlag("-cert-file", &TestConfig::cert_file),
            StringFlag("-cert-file", &CredentialConfig::cert_file)),
        CredentialFlagWithDefault(
            StringFlag("-key-file", &TestConfig::key_file),
            StringFlag("-key-file", &CredentialConfig::key_file)),
        CredentialFlagWithDefault(
            IntVectorFlag("-signing-prefs", &TestConfig::signing_prefs),
            IntVectorFlag("-signing-prefs", &CredentialConfig::signing_prefs)),
        CredentialFlag(Base64Flag("-delegated-credential",
                                  &CredentialConfig::delegated_credential)),
        CredentialFlagWithDefault(
            Base64Flag("-ocsp-response", &TestConfig::ocsp_response),
            Base64Flag("-ocsp-response", &CredentialConfig::ocsp_response)),
        CredentialFlagWithDefault(
            Base64Flag("-signed-cert-timestamps",
                       &TestConfig::signed_cert_timestamps),
            Base64Flag("-signed-cert-timestamps",
                       &CredentialConfig::signed_cert_timestamps)),
        CredentialFlag(BoolFlag("-must-match-issuer",
                                &CredentialConfig::must_match_issuer)),
        CredentialFlag(
            Base64Flag("-pake-context", &CredentialConfig::pake_context)),
        CredentialFlag(
            Base64Flag("-pake-client-id", &CredentialConfig::pake_client_id)),
        CredentialFlag(
            Base64Flag("-pake-server-id", &CredentialConfig::pake_server_id)),
        CredentialFlag(
            Base64Flag("-pake-password", &CredentialConfig::pake_password)),
        CredentialFlag(
            BoolFlag("-wrong-pake-role", &CredentialConfig::wrong_pake_role)),
        CredentialFlag(
            Base64Flag("-trust-anchor-id", &CredentialConfig::trust_anchor_id)),
        IntFlag("-private-key-delay-ms", &TestConfig::private_key_delay_ms),
        BoolFlag("-resumption-across-names-enabled",
                 &TestConfig::resumption_across_names_enabled),
        OptionalBoolTrueFlag("-expect-resumable-across-names",
                             &TestConfig::expect_resumable_across_names),
        OptionalBoolFalseFlag("-expect-not-resumable-across-names",
                              &TestConfig::expect_resumable_across_names),
        BoolFlag("-no-server-name-ack", &TestConfig::no_server_name_ack),
    };
    std::sort(ret.begin(), ret.end(), FlagNameComparator{});
    return ret;
  }();
  auto iter =
      std::lower_bound(flags.begin(), flags.end(), name, FlagNameComparator{});
  if (iter == flags.end() || strcmp(iter->name, name) != 0) {
    return nullptr;
  }
  return &*iter;
}

// RemovePrefix checks if |*str| begins with |prefix| + "-". If so, it advances
// |*str| past |prefix| (but not past the "-") and returns true. Otherwise, it
// returns false and leaves |*str| unmodified.
bool RemovePrefix(const char **str, const char *prefix) {
  size_t prefix_len = strlen(prefix);
  if (strncmp(*str, prefix, strlen(prefix)) == 0 && (*str)[prefix_len] == '-') {
    *str += strlen(prefix);
    return true;
  }
  return false;
}

}  // namespace

bool ParseConfig(int argc, char **argv, bool is_shim, TestConfig *out_initial,
                 TestConfig *out_resume, TestConfig *out_retry) {
  for (int i = 0; i < argc; i++) {
    bool skip = false;
    const char *arg = argv[i];
    const char *name = arg;

    // -on-shim and -on-handshaker prefixes enable flags only on the shim or
    // handshaker.
    if (RemovePrefix(&name, "-on-shim")) {
      if (!is_shim) {
        skip = true;
      }
    } else if (RemovePrefix(&name, "-on-handshaker")) {
      if (is_shim) {
        skip = true;
      }
    }

    // The following prefixes allow different configurations for each of the
    // initial, resumption, and 0-RTT retry handshakes.
    TestConfig *out = nullptr;
    if (RemovePrefix(&name, "-on-initial")) {
      out = out_initial;
    } else if (RemovePrefix(&name, "-on-resume")) {
      out = out_resume;
    } else if (RemovePrefix(&name, "-on-retry")) {
      out = out_retry;
    }

    const Flag<TestConfig> *flag = FindFlag(name);
    if (flag == nullptr) {
      fprintf(stderr, "Unrecognized flag: %s\n", name);
      return false;
    }

    const char *param = nullptr;
    if (flag->has_param) {
      if (i >= argc) {
        fprintf(stderr, "Missing parameter for %s\n", name);
        return false;
      }
      i++;
      param = argv[i];
    }

    if (!flag->skip_handshaker) {
      out_initial->handshaker_args.push_back(arg);
      if (flag->has_param) {
        out_initial->handshaker_args.push_back(param);
      }
    }

    if (!skip) {
      if (out != nullptr) {
        if (!flag->set_param(out, param)) {
          if (!param) {
            param = "(no parameter)";
          }
          fprintf(stderr, "Invalid parameter for %s: %s\n", name, param);
          return false;
        }
      } else {
        // Unprefixed flags apply to all three.
        if (!flag->set_param(out_initial, param) ||
            !flag->set_param(out_resume, param) ||
            !flag->set_param(out_retry, param)) {
          if (!param) {
            param = "(no parameter)";
          }
          fprintf(stderr, "Invalid parameter for %s: %s\n", name, param);
          return false;
        }
      }
    }
  }

  out_resume->handshaker_args = out_initial->handshaker_args;
  out_retry->handshaker_args = out_initial->handshaker_args;
  return true;
}

static CRYPTO_BUFFER_POOL *BufferPool() {
  static CRYPTO_BUFFER_POOL *pool = [&] {
    OPENSSL_disable_malloc_failures_for_testing();
    CRYPTO_BUFFER_POOL *ret = CRYPTO_BUFFER_POOL_new();
    BSSL_CHECK(ret != nullptr);
    OPENSSL_enable_malloc_failures_for_testing();
    return ret;
  }();
  return pool;
}

static int TestConfigExDataIndex() {
  static int index = [&] {
    OPENSSL_disable_malloc_failures_for_testing();
    int ret = SSL_get_ex_new_index(0, nullptr, nullptr, nullptr, nullptr);
    BSSL_CHECK(ret >= 0);
    OPENSSL_enable_malloc_failures_for_testing();
    return ret;
  }();
  return index;
}

bool SetTestConfig(SSL *ssl, const TestConfig *config) {
  return SSL_set_ex_data(ssl, TestConfigExDataIndex(), (void *)config) == 1;
}

const TestConfig *GetTestConfig(const SSL *ssl) {
  return static_cast<const TestConfig *>(
      SSL_get_ex_data(ssl, TestConfigExDataIndex()));
}

struct CredentialInfo {
  int number = -1;
  bssl::UniquePtr<EVP_PKEY> private_key;
};

static void CredentialInfoExDataFree(void *parent, void *ptr,
                                     CRYPTO_EX_DATA *ad, int index, long argl,
                                     void *argp) {
  delete static_cast<CredentialInfo *>(ptr);
}

static int CredentialInfoExDataIndex() {
  static int index = [&] {
    OPENSSL_disable_malloc_failures_for_testing();
    int ret = SSL_CREDENTIAL_get_ex_new_index(0, nullptr, nullptr, nullptr,
                                              CredentialInfoExDataFree);
    BSSL_CHECK(ret >= 0);
    OPENSSL_enable_malloc_failures_for_testing();
    return ret;
  }();
  return index;
}

static const CredentialInfo *GetCredentialInfo(const SSL_CREDENTIAL *cred) {
  return static_cast<const CredentialInfo *>(
      SSL_CREDENTIAL_get_ex_data(cred, CredentialInfoExDataIndex()));
}

static bool SetCredentialInfo(SSL_CREDENTIAL *cred,
                              std::unique_ptr<CredentialInfo> info) {
  if (!SSL_CREDENTIAL_set_ex_data(cred, CredentialInfoExDataIndex(),
                                  info.get())) {
    return false;
  }
  info.release();  // |cred| takes ownership on success.
  return true;
}

static int LegacyOCSPCallback(SSL *ssl, void *arg) {
  const TestConfig *config = GetTestConfig(ssl);
  if (!SSL_is_server(ssl)) {
    return !config->fail_ocsp_callback;
  }

  if (!config->ocsp_response.empty() && config->set_ocsp_in_callback &&
      !SSL_set_ocsp_response(ssl, (const uint8_t *)config->ocsp_response.data(),
                             config->ocsp_response.size())) {
    return SSL_TLSEXT_ERR_ALERT_FATAL;
  }
  if (config->fail_ocsp_callback) {
    return SSL_TLSEXT_ERR_ALERT_FATAL;
  }
  if (config->decline_ocsp_callback) {
    return SSL_TLSEXT_ERR_NOACK;
  }
  return SSL_TLSEXT_ERR_OK;
}

static int ServerNameCallback(SSL *ssl, int *out_alert, void *arg) {
  // SNI must be accessible from the SNI callback.
  const TestConfig *config = GetTestConfig(ssl);
  if (!config->expect_server_name.empty()) {
    const char *server_name =
        SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);
    if (server_name == nullptr ||
        std::string(server_name) != config->expect_server_name) {
      fprintf(stderr, "servername mismatch (got %s; want %s).\n", server_name,
              config->expect_server_name.c_str());
      return SSL_TLSEXT_ERR_ALERT_FATAL;
    }
  }

  return config->no_server_name_ack ? SSL_TLSEXT_ERR_NOACK : SSL_TLSEXT_ERR_OK;
}

static int NextProtoSelectCallback(SSL *ssl, uint8_t **out, uint8_t *outlen,
                                   const uint8_t *in, unsigned inlen,
                                   void *arg) {
  const TestConfig *config = GetTestConfig(ssl);
  *out = (uint8_t *)config->select_next_proto.data();
  *outlen = config->select_next_proto.size();
  return SSL_TLSEXT_ERR_OK;
}

static int NextProtosAdvertisedCallback(SSL *ssl, const uint8_t **out,
                                        unsigned int *out_len, void *arg) {
  const TestConfig *config = GetTestConfig(ssl);
  if (config->advertise_npn.empty() && !config->advertise_empty_npn) {
    return SSL_TLSEXT_ERR_NOACK;
  }

  if (config->advertise_npn.size() > UINT_MAX) {
    fprintf(stderr, "NPN value too large.\n");
    return SSL_TLSEXT_ERR_ALERT_FATAL;
  }

  *out = reinterpret_cast<const uint8_t *>(config->advertise_npn.data());
  *out_len = static_cast<unsigned>(config->advertise_npn.size());
  return SSL_TLSEXT_ERR_OK;
}

static void MessageCallback(int is_write, int version, int content_type,
                            const void *buf, size_t len, SSL *ssl, void *arg) {
  const uint8_t *buf_u8 = reinterpret_cast<const uint8_t *>(buf);
  const TestConfig *config = GetTestConfig(ssl);
  TestState *state = GetTestState(ssl);
  if (!state->msg_callback_ok) {
    return;
  }

  if (content_type == SSL3_RT_HEADER) {
    if (config->is_dtls) {
      // Starting DTLS 1.3, record headers are variable-length, but they will
      // not be longer than DTLS 1.2's 13-byte header.
      if (len > 13) {
        fprintf(stderr, "DTLS record header is too long: %zu.\n", len);
      }
      return;
    }
    if (len != SSL3_RT_HEADER_LENGTH) {
      fprintf(stderr, "Incorrect length for record header: %zu.\n", len);
      state->msg_callback_ok = false;
    }
    return;
  }

  state->msg_callback_text += is_write ? "write " : "read ";
  switch (content_type) {
    case 0:
      if (version != SSL2_VERSION) {
        fprintf(stderr, "Incorrect version for V2ClientHello: %x.\n",
                static_cast<unsigned>(version));
        state->msg_callback_ok = false;
        return;
      }
      state->msg_callback_text += "v2clienthello\n";
      return;

    case SSL3_RT_CLIENT_HELLO_INNER:
    case SSL3_RT_HANDSHAKE: {
      CBS cbs;
      CBS_init(&cbs, buf_u8, len);
      uint8_t type;
      uint32_t msg_len;
      if (!CBS_get_u8(&cbs, &type) ||
          // TODO(davidben): Reporting on entire messages would be more
          // consistent than fragments.
          (config->is_dtls &&
           !CBS_skip(&cbs, 3 /* total */ + 2 /* seq */ + 3 /* frag_off */)) ||
          !CBS_get_u24(&cbs, &msg_len) || !CBS_skip(&cbs, msg_len) ||
          CBS_len(&cbs) != 0) {
        fprintf(stderr, "Could not parse handshake message.\n");
        state->msg_callback_ok = false;
        return;
      }
      char text[16];
      if (content_type == SSL3_RT_CLIENT_HELLO_INNER) {
        if (type != SSL3_MT_CLIENT_HELLO) {
          fprintf(stderr, "Invalid header for ClientHelloInner.\n");
          state->msg_callback_ok = false;
          return;
        }
        state->msg_callback_text += "clienthelloinner\n";
      } else {
        snprintf(text, sizeof(text), "hs %d\n", type);
        state->msg_callback_text += text;
        if (!is_write) {
          state->last_message_received = type;
        }
      }
      return;
    }

    case SSL3_RT_CHANGE_CIPHER_SPEC:
      if (len != 1 || buf_u8[0] != 1) {
        fprintf(stderr, "Invalid ChangeCipherSpec.\n");
        state->msg_callback_ok = false;
        return;
      }
      state->msg_callback_text += "ccs\n";
      return;

    case SSL3_RT_ALERT:
      if (len != 2) {
        fprintf(stderr, "Invalid alert.\n");
        state->msg_callback_ok = false;
        return;
      }
      char text[16];
      snprintf(text, sizeof(text), "alert %d %d\n", buf_u8[0], buf_u8[1]);
      state->msg_callback_text += text;
      return;

    case SSL3_RT_ACK:
      state->msg_callback_text += "ack\n";
      return;

    default:
      fprintf(stderr, "Invalid content_type: %d.\n", content_type);
      state->msg_callback_ok = false;
  }
}

static int TicketKeyCallback(SSL *ssl, uint8_t *key_name, uint8_t *iv,
                             EVP_CIPHER_CTX *ctx, HMAC_CTX *hmac_ctx,
                             int encrypt) {
  if (!encrypt) {
    if (GetTestState(ssl)->ticket_decrypt_done) {
      fprintf(stderr, "TicketKeyCallback called after completion.\n");
      return -1;
    }

    GetTestState(ssl)->ticket_decrypt_done = true;
  }

  // This is just test code, so use the all-zeros key.
  static const uint8_t kZeros[16] = {0};

  if (encrypt) {
    if (GetTestConfig(ssl)->skip_ticket) {
      return 0;
    }
    OPENSSL_memcpy(key_name, kZeros, sizeof(kZeros));
    RAND_bytes(iv, 16);
  } else if (OPENSSL_memcmp(key_name, kZeros, 16) != 0) {
    return 0;
  }

  if (!HMAC_Init_ex(hmac_ctx, kZeros, sizeof(kZeros), EVP_sha256(), nullptr) ||
      !EVP_CipherInit_ex(ctx, EVP_aes_128_cbc(), nullptr, kZeros, iv,
                         encrypt)) {
    return -1;
  }

  if (!encrypt) {
    return GetTestConfig(ssl)->renew_ticket ? 2 : 1;
  }
  return 1;
}

static int NewSessionCallback(SSL *ssl, SSL_SESSION *session) {
  // This callback is called as the handshake completes. |SSL_get_session|
  // must continue to work and, historically, |SSL_in_init| returned false at
  // this point.
  if (SSL_in_init(ssl) || SSL_get_session(ssl) == nullptr) {
    fprintf(stderr, "Invalid state for NewSessionCallback.\n");
    abort();
  }

  GetTestState(ssl)->got_new_session = true;
  GetTestState(ssl)->new_session.reset(session);
  return 1;
}

static void InfoCallback(const SSL *ssl, int type, int val) {
  if (type == SSL_CB_HANDSHAKE_DONE) {
    if (GetTestConfig(ssl)->handshake_never_done) {
      fprintf(stderr, "Handshake unexpectedly completed.\n");
      // Abort before any expected error code is printed, to ensure the overall
      // test fails.
      abort();
    }

    // This callback is called when the handshake completes. |SSL_get_session|
    // must continue to work and |SSL_in_init| must return false.
    if (SSL_in_init(ssl) || SSL_get_session(ssl) == nullptr) {
      fprintf(stderr, "Invalid state for SSL_CB_HANDSHAKE_DONE.\n");
      abort();
    }

    TestState *test_state = GetTestState(ssl);
    test_state->handshake_done = true;

    // Save the selected credential for the tests to assert on.
    const SSL_CREDENTIAL *cred = SSL_get0_selected_credential(ssl);
    const CredentialInfo *cred_info =
        cred != nullptr ? GetCredentialInfo(cred) : nullptr;
    test_state->selected_credential =
        cred_info != nullptr ? cred_info->number : -1;
  }
}

static SSL_SESSION *GetSessionCallback(SSL *ssl, const uint8_t *data, int len,
                                       int *copy) {
  TestState *async_state = GetTestState(ssl);
  if (async_state->session) {
    *copy = 0;
    return async_state->session.release();
  } else if (async_state->pending_session) {
    return SSL_magic_pending_session_ptr();
  } else {
    return nullptr;
  }
}

static void CurrentTimeCallback(const SSL *ssl, timeval *out_clock) {
  *out_clock = *GetClock();
}

static int AlpnSelectCallback(SSL *ssl, const uint8_t **out, uint8_t *outlen,
                              const uint8_t *in, unsigned inlen, void *arg) {
  if (GetTestState(ssl)->alpn_select_done) {
    fprintf(stderr, "AlpnSelectCallback called after completion.\n");
    exit(1);
  }

  GetTestState(ssl)->alpn_select_done = true;

  const TestConfig *config = GetTestConfig(ssl);
  if (config->decline_alpn) {
    return SSL_TLSEXT_ERR_NOACK;
  }
  if (config->reject_alpn) {
    return SSL_TLSEXT_ERR_ALERT_FATAL;
  }

  if (!config->expect_advertised_alpn.empty() &&
      bssl::StringAsBytes(config->expect_advertised_alpn) !=
          bssl::Span(in, inlen)) {
    fprintf(stderr, "bad ALPN select callback inputs.\n");
    exit(1);
  }

  if (config->defer_alps) {
    for (const auto &pair : config->application_settings) {
      if (!SSL_add_application_settings(
              ssl, reinterpret_cast<const uint8_t *>(pair.first.data()),
              pair.first.size(),
              reinterpret_cast<const uint8_t *>(pair.second.data()),
              pair.second.size())) {
        fprintf(stderr, "error configuring ALPS.\n");
        exit(1);
      }
    }
  }

  assert(config->select_alpn.empty() || !config->select_empty_alpn);
  *out = (const uint8_t *)config->select_alpn.data();
  *outlen = config->select_alpn.size();
  return SSL_TLSEXT_ERR_OK;
}

static bool CheckVerifyCallback(SSL *ssl) {
  const TestConfig *config = GetTestConfig(ssl);
  if (!config->expect_ocsp_response.empty()) {
    const uint8_t *data;
    size_t len;
    SSL_get0_ocsp_response(ssl, &data, &len);
    if (len == 0) {
      fprintf(stderr, "OCSP response not available in verify callback.\n");
      return false;
    }
  }

  const char *name_override;
  size_t name_override_len;
  SSL_get0_ech_name_override(ssl, &name_override, &name_override_len);
  if (config->expect_no_ech_name_override && name_override_len != 0) {
    fprintf(stderr, "Unexpected ECH name override.\n");
    return false;
  }
  if (!config->expect_ech_name_override.empty() &&
      config->expect_ech_name_override !=
          std::string(name_override, name_override_len)) {
    fprintf(stderr, "ECH name did not match expected value.\n");
    return false;
  }

  if (config->expect_peer_match_trust_anchor.has_value() &&
      !!SSL_peer_matched_trust_anchor(ssl) !=
          config->expect_peer_match_trust_anchor.value()) {
    fprintf(stderr, "Peer unexpected %s a requested trust anchor",
            SSL_peer_matched_trust_anchor(ssl) ? "matched" : "failed to match");
    return false;
  }

  if (config->expect_peer_available_trust_anchors.has_value()) {
    const uint8_t *peer_ids;
    size_t peer_ids_len;
    SSL_get0_peer_available_trust_anchors(ssl, &peer_ids, &peer_ids_len);
    if (bssl::Span(peer_ids, peer_ids_len) !=
        *config->expect_peer_available_trust_anchors) {
      fprintf(stderr,
              "Peer's available trust anchors did not match expectations.");
      return false;
    }
  }

  if (GetTestState(ssl)->cert_verified) {
    fprintf(stderr, "Certificate verified twice.\n");
    return false;
  }

  return true;
}

static int CertVerifyCallback(X509_STORE_CTX *store_ctx, void *arg) {
  SSL *ssl = (SSL *)X509_STORE_CTX_get_ex_data(
      store_ctx, SSL_get_ex_data_X509_STORE_CTX_idx());
  const TestConfig *config = GetTestConfig(ssl);
  if (!CheckVerifyCallback(ssl)) {
    return 0;
  }

  GetTestState(ssl)->cert_verified = true;
  if (config->verify_fail) {
    X509_STORE_CTX_set_error(store_ctx, X509_V_ERR_APPLICATION_VERIFICATION);
    return 0;
  }

  return 1;
}

bool LoadCertificate(bssl::UniquePtr<X509> *out_x509,
                     bssl::UniquePtr<STACK_OF(X509)> *out_chain,
                     const std::string &file) {
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_file()));
  if (!bio || !BIO_read_filename(bio.get(), file.c_str())) {
    return false;
  }

  out_x509->reset(PEM_read_bio_X509(bio.get(), nullptr, nullptr, nullptr));
  if (!*out_x509) {
    return false;
  }

  out_chain->reset(sk_X509_new_null());
  if (!*out_chain) {
    return false;
  }

  // Keep reading the certificate chain.
  for (;;) {
    bssl::UniquePtr<X509> cert(
        PEM_read_bio_X509(bio.get(), nullptr, nullptr, nullptr));
    if (!cert) {
      break;
    }

    if (!bssl::PushToStack(out_chain->get(), std::move(cert))) {
      return false;
    }
  }

  if (!ERR_equals(ERR_peek_last_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE)) {
    return false;
  }

  ERR_clear_error();
  return true;
}

bssl::UniquePtr<EVP_PKEY> LoadPrivateKey(const std::string &file) {
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_file()));
  if (!bio || !BIO_read_filename(bio.get(), file.c_str())) {
    return nullptr;
  }
  return bssl::UniquePtr<EVP_PKEY>(
      PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr));
}

static bssl::UniquePtr<CRYPTO_BUFFER> X509ToBuffer(X509 *x509) {
  uint8_t *der = nullptr;
  int der_len = i2d_X509(x509, &der);
  if (der_len < 0) {
    return nullptr;
  }
  bssl::UniquePtr<uint8_t> free_der(der);
  return bssl::UniquePtr<CRYPTO_BUFFER>(
      CRYPTO_BUFFER_new(der, der_len, nullptr));
}


static ssl_private_key_result_t AsyncPrivateKeyComplete(SSL *ssl, uint8_t *out,
                                                        size_t *out_len,
                                                        size_t max_out);

static EVP_PKEY *GetPrivateKey(SSL *ssl) {
  const CredentialInfo *cred_info =
      GetCredentialInfo(SSL_get0_selected_credential(ssl));
  if (cred_info != nullptr) {
    return cred_info->private_key.get();
  }

  return GetTestState(ssl)->private_key.get();
}

static ssl_private_key_result_t AsyncPrivateKeySign(
    SSL *ssl, uint8_t *out, size_t *out_len, size_t max_out,
    uint16_t signature_algorithm, const uint8_t *in, size_t in_len) {
  TestState *test_state = GetTestState(ssl);
  test_state->used_private_key = true;
  if (!test_state->private_key_result.empty()) {
    fprintf(stderr, "AsyncPrivateKeySign called with operation pending.\n");
    abort();
  }

  EVP_PKEY *private_key = GetPrivateKey(ssl);
  if (EVP_PKEY_id(private_key) !=
      SSL_get_signature_algorithm_key_type(signature_algorithm)) {
    fprintf(stderr, "Key type does not match signature algorithm.\n");
    abort();
  }

  // Determine the hash.
  const EVP_MD *md = SSL_get_signature_algorithm_digest(signature_algorithm);
  bssl::ScopedEVP_MD_CTX ctx;
  EVP_PKEY_CTX *pctx;
  if (!EVP_DigestSignInit(ctx.get(), &pctx, md, nullptr, private_key)) {
    return ssl_private_key_failure;
  }

  // Configure additional signature parameters.
  if (SSL_is_signature_algorithm_rsa_pss(signature_algorithm)) {
    if (!EVP_PKEY_CTX_set_rsa_padding(pctx, RSA_PKCS1_PSS_PADDING) ||
        !EVP_PKEY_CTX_set_rsa_pss_saltlen(pctx, RSA_PSS_SALTLEN_DIGEST)) {
      return ssl_private_key_failure;
    }
  }

  // Write the signature into |test_state|.
  size_t len = 0;
  if (!EVP_DigestSign(ctx.get(), nullptr, &len, in, in_len)) {
    return ssl_private_key_failure;
  }
  test_state->private_key_result.resize(len);
  if (!EVP_DigestSign(ctx.get(), test_state->private_key_result.data(), &len,
                      in, in_len)) {
    return ssl_private_key_failure;
  }
  test_state->private_key_result.resize(len);

  return AsyncPrivateKeyComplete(ssl, out, out_len, max_out);
}

static ssl_private_key_result_t AsyncPrivateKeyDecrypt(SSL *ssl, uint8_t *out,
                                                       size_t *out_len,
                                                       size_t max_out,
                                                       const uint8_t *in,
                                                       size_t in_len) {
  TestState *test_state = GetTestState(ssl);
  test_state->used_private_key = true;
  if (!test_state->private_key_result.empty()) {
    fprintf(stderr, "AsyncPrivateKeyDecrypt called with operation pending.\n");
    abort();
  }

  EVP_PKEY *private_key = GetPrivateKey(ssl);
  RSA *rsa = EVP_PKEY_get0_RSA(private_key);
  if (rsa == nullptr) {
    fprintf(stderr, "AsyncPrivateKeyDecrypt called with incorrect key type.\n");
    abort();
  }
  test_state->private_key_result.resize(RSA_size(rsa));
  if (!RSA_decrypt(rsa, out_len, test_state->private_key_result.data(),
                   RSA_size(rsa), in, in_len, RSA_NO_PADDING)) {
    return ssl_private_key_failure;
  }

  test_state->private_key_result.resize(*out_len);

  return AsyncPrivateKeyComplete(ssl, out, out_len, max_out);
}

static ssl_private_key_result_t AsyncPrivateKeyComplete(SSL *ssl, uint8_t *out,
                                                        size_t *out_len,
                                                        size_t max_out) {
  TestState *test_state = GetTestState(ssl);
  if (test_state->private_key_result.empty()) {
    fprintf(stderr,
            "AsyncPrivateKeyComplete called without operation pending.\n");
    abort();
  }

  if (GetTestConfig(ssl)->async && test_state->private_key_retries < 2) {
    // Only return the decryption on the second attempt, to test both incomplete
    // |sign|/|decrypt| and |complete|.
    return ssl_private_key_retry;
  }

  if (max_out < test_state->private_key_result.size()) {
    fprintf(stderr, "Output buffer too small.\n");
    return ssl_private_key_failure;
  }
  OPENSSL_memcpy(out, test_state->private_key_result.data(),
                 test_state->private_key_result.size());
  *out_len = test_state->private_key_result.size();

  test_state->private_key_result.clear();
  test_state->private_key_retries = 0;
  return ssl_private_key_success;
}

static const SSL_PRIVATE_KEY_METHOD g_async_private_key_method = {
    AsyncPrivateKeySign,
    AsyncPrivateKeyDecrypt,
    AsyncPrivateKeyComplete,
};

static size_t AsyncTicketMaxOverhead(SSL *ssl) {
  const EVP_AEAD *aead = EVP_aead_aes_128_gcm_siv();
  return EVP_AEAD_max_overhead(aead) + EVP_AEAD_nonce_length(aead);
}

static int AsyncTicketSeal(SSL *ssl, uint8_t *out, size_t *out_len,
                           size_t max_out_len, const uint8_t *in,
                           size_t in_len) {
  if (GetTestConfig(ssl)->skip_ticket) {
    *out_len = 0;
    return 1;
  }

  auto out_span = bssl::Span(out, max_out_len);
  // Encrypt the ticket with the all zero key and a random nonce.
  static const uint8_t kKey[16] = {0};
  const EVP_AEAD *aead = EVP_aead_aes_128_gcm_siv();
  size_t nonce_len = EVP_AEAD_nonce_length(aead);
  if (out_span.size() < nonce_len) {
    return 0;
  }
  auto nonce = out_span.first(nonce_len);
  out_span = out_span.subspan(nonce_len);
  RAND_bytes(nonce.data(), nonce.size());
  bssl::ScopedEVP_AEAD_CTX ctx;
  size_t len;
  if (!EVP_AEAD_CTX_init(ctx.get(), EVP_aead_aes_128_gcm_siv(), kKey,
                         sizeof(kKey), EVP_AEAD_DEFAULT_TAG_LENGTH, nullptr) ||
      !EVP_AEAD_CTX_seal(ctx.get(), out_span.data(), &len, out_span.size(),
                         nonce.data(), nonce.size(), in, in_len,
                         /*ad=*/nullptr, /*ad_len=*/0)) {
    return 0;
  }
  *out_len = nonce.size() + len;
  return 1;
}

static ssl_ticket_aead_result_t AsyncTicketOpen(SSL *ssl, uint8_t *out,
                                                size_t *out_len,
                                                size_t max_out_len,
                                                const uint8_t *in,
                                                size_t in_len) {
  auto in_span = bssl::Span(in, in_len);
  const TestConfig *test_config = GetTestConfig(ssl);
  TestState *test_state = GetTestState(ssl);
  if (test_state->ticket_decrypt_done) {
    fprintf(stderr, "AsyncTicketOpen called after completion.\n");
    return ssl_ticket_aead_error;
  }
  if (test_config->renew_ticket) {
    fprintf(stderr, "-renew-ticket not supported with async tickets.\n");
    return ssl_ticket_aead_error;
  }
  if (test_config->async && !test_state->async_ticket_decrypt_ready) {
    return ssl_ticket_aead_retry;
  }

  const EVP_AEAD *aead = EVP_aead_aes_128_gcm_siv();
  size_t nonce_len = EVP_AEAD_nonce_length(aead);
  if (in_span.size() < nonce_len) {
    return ssl_ticket_aead_error;
  }
  auto nonce = in_span.first(nonce_len);
  in_span = in_span.subspan(nonce_len);

  static const uint8_t kKey[16] = {0};
  bssl::ScopedEVP_AEAD_CTX ctx;
  if (!EVP_AEAD_CTX_init(ctx.get(), EVP_aead_aes_128_gcm_siv(), kKey,
                         sizeof(kKey), EVP_AEAD_DEFAULT_TAG_LENGTH, nullptr)) {
    return ssl_ticket_aead_error;
  }
  if (!EVP_AEAD_CTX_open(ctx.get(), out, out_len, max_out_len, nonce.data(),
                         nonce.size(), in_span.data(), in_span.size(),
                         /*ad=*/nullptr, /*ad_len=*/0)) {
    ERR_clear_error();
    return ssl_ticket_aead_ignore_ticket;
  }
  test_state->ticket_decrypt_done = true;
  return ssl_ticket_aead_success;
}

static const SSL_TICKET_AEAD_METHOD g_async_ticket_aead_method = {
    AsyncTicketMaxOverhead,
    AsyncTicketSeal,
    AsyncTicketOpen,
};

static bssl::UniquePtr<SSL_CREDENTIAL> CredentialFromConfig(
    const TestConfig &config, const CredentialConfig &cred_config, int number) {
  bssl::UniquePtr<SSL_CREDENTIAL> cred;
  switch (cred_config.type) {
    case CredentialConfigType::kX509:
      cred.reset(SSL_CREDENTIAL_new_x509());
      break;
    case CredentialConfigType::kDelegated:
      cred.reset(SSL_CREDENTIAL_new_delegated());
      break;
    case CredentialConfigType::kSPAKE2PlusV1: {
      uint8_t pw_verifier_w0[32];
      uint8_t pw_verifier_w1[32];
      uint8_t registration_record[65];
      if (!SSL_spake2plusv1_register(pw_verifier_w0, pw_verifier_w1,
                                     registration_record,
                                     cred_config.pake_password.data(),
                                     cred_config.pake_password.size(),
                                     cred_config.pake_client_id.data(),
                                     cred_config.pake_client_id.size(),
                                     cred_config.pake_server_id.data(),
                                     cred_config.pake_server_id.size())) {
        return nullptr;
      }
      bool is_server =
          cred_config.wrong_pake_role ? !config.is_server : config.is_server;
      if (is_server) {
        cred.reset(SSL_CREDENTIAL_new_spake2plusv1_server(
            cred_config.pake_context.data(), cred_config.pake_context.size(),
            cred_config.pake_client_id.data(),
            cred_config.pake_client_id.size(),
            cred_config.pake_server_id.data(),
            cred_config.pake_server_id.size(),
            /*attempts=*/1, pw_verifier_w0, sizeof(pw_verifier_w0),
            registration_record, sizeof(registration_record)));
      } else {
        cred.reset(SSL_CREDENTIAL_new_spake2plusv1_client(
            cred_config.pake_context.data(), cred_config.pake_context.size(),
            cred_config.pake_client_id.data(),
            cred_config.pake_client_id.size(),
            cred_config.pake_server_id.data(),
            cred_config.pake_server_id.size(),
            /*attempts=*/1, pw_verifier_w0, sizeof(pw_verifier_w0),
            pw_verifier_w1, sizeof(pw_verifier_w1)));
      }
      break;
    }
  }
  if (cred == nullptr) {
    return nullptr;
  }

  auto info = std::make_unique<CredentialInfo>();
  info->number = number;

  if (!cred_config.cert_file.empty()) {
    bssl::UniquePtr<X509> x509;
    bssl::UniquePtr<STACK_OF(X509)> chain;
    if (!LoadCertificate(&x509, &chain, cred_config.cert_file.c_str())) {
      return nullptr;
    }
    std::vector<bssl::UniquePtr<CRYPTO_BUFFER>> buffers;
    buffers.push_back(X509ToBuffer(x509.get()));
    if (buffers.back() == nullptr) {
      return nullptr;
    }
    for (X509 *cert : chain.get()) {
      buffers.push_back(X509ToBuffer(cert));
      if (buffers.back() == nullptr) {
        return nullptr;
      }
    }
    std::vector<CRYPTO_BUFFER *> buffers_raw;
    for (const auto &buffer : buffers) {
      buffers_raw.push_back(buffer.get());
    }
    if (!SSL_CREDENTIAL_set1_cert_chain(cred.get(), buffers_raw.data(),
                                        buffers_raw.size())) {
      return nullptr;
    }
  }

  if (!cred_config.key_file.empty()) {
    bssl::UniquePtr<EVP_PKEY> pkey =
        LoadPrivateKey(cred_config.key_file.c_str());
    if (pkey == nullptr) {
      return nullptr;
    }
    if (config.async || config.handshake_hints) {
      info->private_key = std::move(pkey);
      if (!SSL_CREDENTIAL_set_private_key_method(cred.get(),
                                                 &g_async_private_key_method)) {
        return nullptr;
      }
    } else {
      if (!SSL_CREDENTIAL_set1_private_key(cred.get(), pkey.get())) {
        return nullptr;
      }
    }
  }

  if (!cred_config.signing_prefs.empty() &&
      !SSL_CREDENTIAL_set1_signing_algorithm_prefs(
          cred.get(), cred_config.signing_prefs.data(),
          cred_config.signing_prefs.size())) {
    return nullptr;
  }

  if (!cred_config.delegated_credential.empty()) {
    bssl::UniquePtr<CRYPTO_BUFFER> buf(
        CRYPTO_BUFFER_new(cred_config.delegated_credential.data(),
                          cred_config.delegated_credential.size(), nullptr));
    if (buf == nullptr ||
        !SSL_CREDENTIAL_set1_delegated_credential(cred.get(), buf.get())) {
      return nullptr;
    }
  }

  if (!cred_config.ocsp_response.empty()) {
    bssl::UniquePtr<CRYPTO_BUFFER> buf(
        CRYPTO_BUFFER_new(cred_config.ocsp_response.data(),
                          cred_config.ocsp_response.size(), nullptr));
    if (buf == nullptr ||
        !SSL_CREDENTIAL_set1_ocsp_response(cred.get(), buf.get())) {
      return nullptr;
    }
  }

  if (!cred_config.signed_cert_timestamps.empty()) {
    bssl::UniquePtr<CRYPTO_BUFFER> buf(
        CRYPTO_BUFFER_new(cred_config.signed_cert_timestamps.data(),
                          cred_config.signed_cert_timestamps.size(), nullptr));
    if (buf == nullptr || !SSL_CREDENTIAL_set1_signed_cert_timestamp_list(
                              cred.get(), buf.get())) {
      return nullptr;
    }
  }

  if (cred_config.must_match_issuer) {
    SSL_CREDENTIAL_set_must_match_issuer(cred.get(), 1);
  }

  if (!cred_config.trust_anchor_id.empty()) {
    if (!SSL_CREDENTIAL_set1_trust_anchor_id(
            cred.get(), cred_config.trust_anchor_id.data(),
            cred_config.trust_anchor_id.size())) {
      return nullptr;
    }
  }

  if (!SetCredentialInfo(cred.get(), std::move(info))) {
    return nullptr;
  }

  return cred;
}

static bool GetCertificate(SSL *ssl, bssl::UniquePtr<X509> *out_x509,
                           bssl::UniquePtr<STACK_OF(X509)> *out_chain,
                           bssl::UniquePtr<EVP_PKEY> *out_pkey) {
  const TestConfig *config = GetTestConfig(ssl);

  if (!config->signing_prefs.empty()) {
    if (!SSL_set_signing_algorithm_prefs(ssl, config->signing_prefs.data(),
                                         config->signing_prefs.size())) {
      return false;
    }
  }

  if (!config->key_file.empty()) {
    *out_pkey = LoadPrivateKey(config->key_file.c_str());
    if (!*out_pkey) {
      return false;
    }
  }
  if (!config->cert_file.empty() &&
      !LoadCertificate(out_x509, out_chain, config->cert_file.c_str())) {
    return false;
  }
  if (!config->ocsp_response.empty() && !config->set_ocsp_in_callback &&
      !SSL_set_ocsp_response(ssl, (const uint8_t *)config->ocsp_response.data(),
                             config->ocsp_response.size())) {
    return false;
  }

  for (size_t i = 0; i < config->credentials.size(); i++) {
    bssl::UniquePtr<SSL_CREDENTIAL> cred = CredentialFromConfig(
        *config, config->credentials[i], static_cast<int>(i));
    if (cred == nullptr || !SSL_add1_credential(ssl, cred.get())) {
      return false;
    }
  }

  return true;
}

static bool HexDecode(std::string *out, const std::string &in) {
  if ((in.size() & 1) != 0) {
    return false;
  }

  auto buf = std::make_unique<uint8_t[]>(in.size() / 2);
  for (size_t i = 0; i < in.size() / 2; i++) {
    uint8_t high, low;
    if (!OPENSSL_fromxdigit(&high, in[i * 2]) ||
        !OPENSSL_fromxdigit(&low, in[i * 2 + 1])) {
      return false;
    }
    buf[i] = (high << 4) | low;
  }

  out->assign(reinterpret_cast<const char *>(buf.get()), in.size() / 2);
  return true;
}

static std::vector<std::string> SplitParts(const std::string &in,
                                           const char delim) {
  std::vector<std::string> ret;
  size_t start = 0;

  for (size_t i = 0; i < in.size(); i++) {
    if (in[i] == delim) {
      ret.push_back(in.substr(start, i - start));
      start = i + 1;
    }
  }

  ret.push_back(in.substr(start, std::string::npos));
  return ret;
}

static std::vector<std::string> DecodeHexStrings(
    const std::string &hex_strings) {
  std::vector<std::string> ret;
  const std::vector<std::string> parts = SplitParts(hex_strings, ',');

  for (const auto &part : parts) {
    std::string binary;
    if (!HexDecode(&binary, part)) {
      fprintf(stderr, "Bad hex string: %s.\n", part.c_str());
      return ret;
    }

    ret.push_back(binary);
  }

  return ret;
}

static bssl::UniquePtr<STACK_OF(X509_NAME)> DecodeHexX509Names(
    const std::string &hex_names) {
  const std::vector<std::string> der_names = DecodeHexStrings(hex_names);
  bssl::UniquePtr<STACK_OF(X509_NAME)> ret(sk_X509_NAME_new_null());
  if (!ret) {
    return nullptr;
  }

  for (const auto &der_name : der_names) {
    const uint8_t *const data =
        reinterpret_cast<const uint8_t *>(der_name.data());
    const uint8_t *derp = data;
    bssl::UniquePtr<X509_NAME> name(
        d2i_X509_NAME(nullptr, &derp, der_name.size()));
    if (!name || derp != data + der_name.size()) {
      fprintf(stderr, "Failed to parse X509_NAME.\n");
      return nullptr;
    }

    if (!bssl::PushToStack(ret.get(), std::move(name))) {
      return nullptr;
    }
  }

  return ret;
}

static bool CheckPeerVerifyPrefs(SSL *ssl) {
  const TestConfig *config = GetTestConfig(ssl);
  if (!config->expect_peer_verify_prefs.empty()) {
    const uint16_t *peer_sigalgs;
    size_t num_peer_sigalgs =
        SSL_get0_peer_verify_algorithms(ssl, &peer_sigalgs);
    if (config->expect_peer_verify_prefs.size() != num_peer_sigalgs) {
      fprintf(stderr,
              "peer verify preferences length mismatch (got %zu, wanted %zu)\n",
              num_peer_sigalgs, config->expect_peer_verify_prefs.size());
      return false;
    }
    for (size_t i = 0; i < num_peer_sigalgs; i++) {
      if (peer_sigalgs[i] != config->expect_peer_verify_prefs[i]) {
        fprintf(stderr,
                "peer verify preference %zu mismatch (got %04x, wanted %04x\n",
                i, peer_sigalgs[i], config->expect_peer_verify_prefs[i]);
        return false;
      }
    }
  }
  return true;
}

static bool CheckCertificateRequest(SSL *ssl) {
  const TestConfig *config = GetTestConfig(ssl);

  if (!CheckPeerVerifyPrefs(ssl)) {
    return false;
  }

  if (!config->expect_certificate_types.empty()) {
    const uint8_t *certificate_types;
    size_t certificate_types_len =
        SSL_get0_certificate_types(ssl, &certificate_types);
    if (bssl::Span(config->expect_certificate_types) !=
        bssl::Span(certificate_types, certificate_types_len)) {
      fprintf(stderr, "certificate types mismatch.\n");
      return false;
    }
  }

  if (!config->expect_client_ca_list.empty()) {
    bssl::UniquePtr<STACK_OF(X509_NAME)> expected =
        DecodeHexX509Names(config->expect_client_ca_list);
    const size_t num_expected = sk_X509_NAME_num(expected.get());

    const STACK_OF(X509_NAME) *received = SSL_get_client_CA_list(ssl);
    const size_t num_received = sk_X509_NAME_num(received);

    if (num_received != num_expected) {
      fprintf(stderr, "expected %zu names in CertificateRequest but got %zu.\n",
              num_expected, num_received);
      return false;
    }

    for (size_t i = 0; i < num_received; i++) {
      if (X509_NAME_cmp(sk_X509_NAME_value(received, i),
                        sk_X509_NAME_value(expected.get(), i)) != 0) {
        fprintf(stderr, "names in CertificateRequest differ at index #%zu.\n",
                i);
        return false;
      }
    }

    const STACK_OF(CRYPTO_BUFFER) *buffers = SSL_get0_server_requested_CAs(ssl);
    if (sk_CRYPTO_BUFFER_num(buffers) != num_received) {
      fprintf(stderr,
              "Mismatch between SSL_get_server_requested_CAs and "
              "SSL_get_client_CA_list.\n");
      return false;
    }
  }

  return true;
}

static int ClientCertCallback(SSL *ssl, X509 **out_x509, EVP_PKEY **out_pkey) {
  if (!CheckCertificateRequest(ssl)) {
    return -1;
  }

  if (GetTestConfig(ssl)->async && !GetTestState(ssl)->cert_ready) {
    return -1;
  }

  bssl::UniquePtr<X509> x509;
  bssl::UniquePtr<STACK_OF(X509)> chain;
  bssl::UniquePtr<EVP_PKEY> pkey;
  if (!GetCertificate(ssl, &x509, &chain, &pkey)) {
    return -1;
  }

  // Return zero for no certificate.
  if (!x509) {
    return 0;
  }

  // Chains and asynchronous private keys are not supported with client_cert_cb.
  *out_x509 = x509.release();
  *out_pkey = pkey.release();
  return 1;
}

static bool InstallCertificate(SSL *ssl) {
  bssl::UniquePtr<X509> x509;
  bssl::UniquePtr<STACK_OF(X509)> chain;
  bssl::UniquePtr<EVP_PKEY> pkey;
  if (!GetCertificate(ssl, &x509, &chain, &pkey)) {
    return false;
  }

  if (pkey) {
    TestState *test_state = GetTestState(ssl);
    const TestConfig *config = GetTestConfig(ssl);
    if (config->async || config->handshake_hints) {
      // Install a custom private key if testing asynchronous callbacks, or if
      // testing handshake hints. In the handshake hints case, we wish to check
      // that hints only mismatch when allowed.
      test_state->private_key = std::move(pkey);
      SSL_set_private_key_method(ssl, &g_async_private_key_method);
    } else if (!SSL_use_PrivateKey(ssl, pkey.get())) {
      return false;
    }
  }

  if (x509 && !SSL_use_certificate(ssl, x509.get())) {
    return false;
  }

  if (sk_X509_num(chain.get()) > 0 && !SSL_set1_chain(ssl, chain.get())) {
    return false;
  }

  return true;
}

static enum ssl_select_cert_result_t SelectCertificateCallback(
    const SSL_CLIENT_HELLO *client_hello) {
  SSL *ssl = client_hello->ssl;
  const TestConfig *config = GetTestConfig(ssl);
  TestState *test_state = GetTestState(ssl);
  test_state->early_callback_called = true;

  // Invoke the rewind before we sanity check SNI because we will
  // end up calling the select_cert_cb twice with two different SNIs.
  if (SSL_ech_accepted(ssl) && config->fail_early_callback_ech_rewind) {
    return ssl_select_cert_disable_ech;
  }

  const char *server_name = SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name);

  if (config->expect_no_server_name && server_name != nullptr) {
    fprintf(stderr, "Expected no server name but got %s.\n", server_name);
    return ssl_select_cert_error;
  }

  if (!config->expect_server_name.empty()) {
    if (server_name == nullptr ||
        std::string(server_name) != config->expect_server_name) {
      fprintf(stderr,
              "Server name mismatch in early callback (got %s; want %s).\n",
              server_name, config->expect_server_name.c_str());
      return ssl_select_cert_error;
    }
  }

  if (config->fail_early_callback) {
    return ssl_select_cert_error;
  }

  // Simulate some asynchronous work in the early callback.
  if ((config->use_early_callback || test_state->get_handshake_hints_cb) &&
      config->async && !test_state->early_callback_ready) {
    return ssl_select_cert_retry;
  }

  if (test_state->get_handshake_hints_cb &&
      !test_state->get_handshake_hints_cb(client_hello)) {
    return ssl_select_cert_error;
  }

  if (config->use_early_callback && !InstallCertificate(ssl)) {
    return ssl_select_cert_error;
  }

  return ssl_select_cert_success;
}

static int SetQuicReadSecret(SSL *ssl, enum ssl_encryption_level_t level,
                             const SSL_CIPHER *cipher, const uint8_t *secret,
                             size_t secret_len) {
  MockQuicTransport *quic_transport = GetTestState(ssl)->quic_transport.get();
  if (quic_transport == nullptr) {
    fprintf(stderr, "No QUIC transport.\n");
    return 0;
  }
  return quic_transport->SetReadSecret(level, cipher, secret, secret_len);
}

static int SetQuicWriteSecret(SSL *ssl, enum ssl_encryption_level_t level,
                              const SSL_CIPHER *cipher, const uint8_t *secret,
                              size_t secret_len) {
  MockQuicTransport *quic_transport = GetTestState(ssl)->quic_transport.get();
  if (quic_transport == nullptr) {
    fprintf(stderr, "No QUIC transport.\n");
    return 0;
  }
  return quic_transport->SetWriteSecret(level, cipher, secret, secret_len);
}

static int AddQuicHandshakeData(SSL *ssl, enum ssl_encryption_level_t level,
                                const uint8_t *data, size_t len) {
  MockQuicTransport *quic_transport = GetTestState(ssl)->quic_transport.get();
  if (quic_transport == nullptr) {
    fprintf(stderr, "No QUIC transport.\n");
    return 0;
  }
  return quic_transport->WriteHandshakeData(level, data, len);
}

static int FlushQuicFlight(SSL *ssl) {
  MockQuicTransport *quic_transport = GetTestState(ssl)->quic_transport.get();
  if (quic_transport == nullptr) {
    fprintf(stderr, "No QUIC transport.\n");
    return 0;
  }
  return quic_transport->Flush();
}

static int SendQuicAlert(SSL *ssl, enum ssl_encryption_level_t level,
                         uint8_t alert) {
  MockQuicTransport *quic_transport = GetTestState(ssl)->quic_transport.get();
  if (quic_transport == nullptr) {
    fprintf(stderr, "No QUIC transport.\n");
    return 0;
  }
  return quic_transport->SendAlert(level, alert);
}

static const SSL_QUIC_METHOD g_quic_method = {
    SetQuicReadSecret, SetQuicWriteSecret, AddQuicHandshakeData,
    FlushQuicFlight,   SendQuicAlert,
};

static bool MaybeInstallCertCompressionAlg(
    const TestConfig *config, SSL_CTX *ssl_ctx, uint16_t alg,
    ssl_cert_compression_func_t compress,
    ssl_cert_decompression_func_t decompress) {
  if (!config->install_cert_compression_algs &&
      config->install_one_cert_compression_alg != alg) {
    return true;
  }
  return SSL_CTX_add_cert_compression_alg(ssl_ctx, alg, compress, decompress);
}

bssl::UniquePtr<SSL_CTX> TestConfig::SetupCtx(SSL_CTX *old_ctx) const {
  bssl::UniquePtr<SSL_CTX> ssl_ctx(
      SSL_CTX_new(is_dtls ? DTLS_method() : TLS_method()));
  if (!ssl_ctx) {
    return nullptr;
  }

  SSL_CTX_set0_buffer_pool(ssl_ctx.get(), BufferPool());

  std::string cipher_list = "ALL:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256";
  if (!cipher.empty()) {
    cipher_list = cipher;
    SSL_CTX_set_options(ssl_ctx.get(), SSL_OP_CIPHER_SERVER_PREFERENCE);
  }
  if (!SSL_CTX_set_strict_cipher_list(ssl_ctx.get(), cipher_list.c_str())) {
    return nullptr;
  }

  if (async && is_server) {
    // Disable the internal session cache. To test asynchronous session lookup,
    // we use an external session cache.
    SSL_CTX_set_session_cache_mode(
        ssl_ctx.get(), SSL_SESS_CACHE_BOTH | SSL_SESS_CACHE_NO_INTERNAL);
    SSL_CTX_sess_set_get_cb(ssl_ctx.get(), GetSessionCallback);
  } else {
    SSL_CTX_set_session_cache_mode(ssl_ctx.get(), SSL_SESS_CACHE_BOTH);
  }

  SSL_CTX_set_select_certificate_cb(ssl_ctx.get(), SelectCertificateCallback);

  if (use_old_client_cert_callback) {
    SSL_CTX_set_client_cert_cb(ssl_ctx.get(), ClientCertCallback);
  }

  SSL_CTX_set_next_protos_advertised_cb(ssl_ctx.get(),
                                        NextProtosAdvertisedCallback, nullptr);
  if (!select_next_proto.empty() || select_empty_next_proto) {
    SSL_CTX_set_next_proto_select_cb(ssl_ctx.get(), NextProtoSelectCallback,
                                     nullptr);
  }

  if (!select_alpn.empty() || decline_alpn || reject_alpn ||
      select_empty_alpn) {
    SSL_CTX_set_alpn_select_cb(ssl_ctx.get(), AlpnSelectCallback, nullptr);
  }

  SSL_CTX_set_current_time_cb(ssl_ctx.get(), CurrentTimeCallback);

  SSL_CTX_set_info_callback(ssl_ctx.get(), InfoCallback);
  SSL_CTX_sess_set_new_cb(ssl_ctx.get(), NewSessionCallback);

  if (use_ticket_aead_callback) {
    SSL_CTX_set_ticket_aead_method(ssl_ctx.get(), &g_async_ticket_aead_method);
  } else if (use_ticket_callback || handshake_hints) {
    // If using handshake hints, always enable some ticket callback, so we can
    // check that hints only mismatch when allowed. The ticket callback also
    // uses a constant key, which simplifies the test.
    SSL_CTX_set_tlsext_ticket_key_cb(ssl_ctx.get(), TicketKeyCallback);
  }

  if (!use_custom_verify_callback) {
    SSL_CTX_set_cert_verify_callback(ssl_ctx.get(), CertVerifyCallback,
                                     nullptr);
  }

  if (!signed_cert_timestamps.empty() &&
      !SSL_CTX_set_signed_cert_timestamp_list(
          ssl_ctx.get(), (const uint8_t *)signed_cert_timestamps.data(),
          signed_cert_timestamps.size())) {
    return nullptr;
  }

  if (!use_client_ca_list.empty()) {
    if (use_client_ca_list == "<NULL>") {
      SSL_CTX_set_client_CA_list(ssl_ctx.get(), nullptr);
    } else if (use_client_ca_list == "<EMPTY>") {
      bssl::UniquePtr<STACK_OF(X509_NAME)> names;
      SSL_CTX_set_client_CA_list(ssl_ctx.get(), names.release());
    } else {
      bssl::UniquePtr<STACK_OF(X509_NAME)> names =
          DecodeHexX509Names(use_client_ca_list);
      SSL_CTX_set_client_CA_list(ssl_ctx.get(), names.release());
    }
  }

  if (enable_grease) {
    SSL_CTX_set_grease_enabled(ssl_ctx.get(), 1);
  }

  if (permute_extensions) {
    SSL_CTX_set_permute_extensions(ssl_ctx.get(), 1);
  }

  SSL_CTX_set_tlsext_servername_callback(ssl_ctx.get(), ServerNameCallback);

  if (enable_early_data) {
    SSL_CTX_set_early_data_enabled(ssl_ctx.get(), 1);
  }

  if (allow_unknown_alpn_protos) {
    SSL_CTX_set_allow_unknown_alpn_protos(ssl_ctx.get(), 1);
  }

  if (!verify_prefs.empty()) {
    if (!SSL_CTX_set_verify_algorithm_prefs(ssl_ctx.get(), verify_prefs.data(),
                                            verify_prefs.size())) {
      return nullptr;
    }
  }

  SSL_CTX_set_msg_callback(ssl_ctx.get(), MessageCallback);

  if (allow_false_start_without_alpn) {
    SSL_CTX_set_false_start_allowed_without_alpn(ssl_ctx.get(), 1);
  }

  if (use_ocsp_callback) {
    SSL_CTX_set_tlsext_status_cb(ssl_ctx.get(), LegacyOCSPCallback);
  }

  if (resumption_across_names_enabled) {
    SSL_CTX_set_resumption_across_names_enabled(ssl_ctx.get(), 1);
  }

  if (old_ctx) {
    uint8_t keys[48];
    if (!SSL_CTX_get_tlsext_ticket_keys(old_ctx, &keys, sizeof(keys)) ||
        !SSL_CTX_set_tlsext_ticket_keys(ssl_ctx.get(), keys, sizeof(keys))) {
      return nullptr;
    }
    CopySessions(ssl_ctx.get(), old_ctx);
  } else if (!ticket_key.empty() &&
             !SSL_CTX_set_tlsext_ticket_keys(ssl_ctx.get(), ticket_key.data(),
                                             ticket_key.size())) {
    return nullptr;
  }

  // These mock compression algorithms match the corresponding ones in
  // |addCertCompressionTests|.
  if (!MaybeInstallCertCompressionAlg(
          this, ssl_ctx.get(), 0xff02,
          [](SSL *ssl, CBB *out, const uint8_t *in, size_t in_len) -> int {
            if (!CBB_add_u8(out, 1) || !CBB_add_u8(out, 2) ||
                !CBB_add_u8(out, 3) || !CBB_add_u8(out, 4) ||
                !CBB_add_bytes(out, in, in_len)) {
              return 0;
            }
            return 1;
          },
          [](SSL *ssl, CRYPTO_BUFFER **out, size_t uncompressed_len,
             const uint8_t *in, size_t in_len) -> int {
            if (in_len < 4 || in[0] != 1 || in[1] != 2 || in[2] != 3 ||
                in[3] != 4 || uncompressed_len != in_len - 4) {
              return 0;
            }
            const bssl::Span<const uint8_t> uncompressed(in + 4, in_len - 4);
            *out = CRYPTO_BUFFER_new(uncompressed.data(), uncompressed.size(),
                                     nullptr);
            return *out != nullptr;
          }) ||
      !MaybeInstallCertCompressionAlg(
          this, ssl_ctx.get(), 0xff01,
          [](SSL *ssl, CBB *out, const uint8_t *in, size_t in_len) -> int {
            if (in_len < 2 || in[0] != 0 || in[1] != 0) {
              return 0;
            }
            return CBB_add_bytes(out, in + 2, in_len - 2);
          },
          [](SSL *ssl, CRYPTO_BUFFER **out, size_t uncompressed_len,
             const uint8_t *in, size_t in_len) -> int {
            if (uncompressed_len != 2 + in_len) {
              return 0;
            }
            auto buf = std::make_unique<uint8_t[]>(2 + in_len);
            buf[0] = 0;
            buf[1] = 0;
            OPENSSL_memcpy(&buf[2], in, in_len);
            *out = CRYPTO_BUFFER_new(buf.get(), 2 + in_len, nullptr);
            return *out != nullptr;
          }) ||
      !MaybeInstallCertCompressionAlg(
          this, ssl_ctx.get(), 0xff03,
          [](SSL *ssl, CBB *out, const uint8_t *in, size_t in_len) -> int {
            uint8_t byte;
            return RAND_bytes(&byte, 1) &&   //
                   CBB_add_u8(out, byte) &&  //
                   CBB_add_bytes(out, in, in_len);
          },
          [](SSL *ssl, CRYPTO_BUFFER **out, size_t uncompressed_len,
             const uint8_t *in, size_t in_len) -> int {
            if (uncompressed_len + 1 != in_len) {
              return 0;
            }
            *out = CRYPTO_BUFFER_new(in + 1, in_len - 1, nullptr);
            return *out != nullptr;
          })) {
    fprintf(stderr, "SSL_CTX_add_cert_compression_alg failed.\n");
    abort();
  }

  if (server_preference) {
    SSL_CTX_set_options(ssl_ctx.get(), SSL_OP_CIPHER_SERVER_PREFERENCE);
  }

  if (is_quic) {
    SSL_CTX_set_quic_method(ssl_ctx.get(), &g_quic_method);
  }

  return ssl_ctx;
}

static int DDoSCallback(const SSL_CLIENT_HELLO *client_hello) {
  const TestConfig *config = GetTestConfig(client_hello->ssl);
  return config->fail_ddos_callback ? 0 : 1;
}

static unsigned PskClientCallback(SSL *ssl, const char *hint,
                                  char *out_identity, unsigned max_identity_len,
                                  uint8_t *out_psk, unsigned max_psk_len) {
  const TestConfig *config = GetTestConfig(ssl);

  if (config->psk_identity.empty()) {
    if (hint != nullptr) {
      fprintf(stderr, "Server PSK hint was non-null.\n");
      return 0;
    }
  } else if (hint == nullptr ||
             strcmp(hint, config->psk_identity.c_str()) != 0) {
    fprintf(stderr, "Server PSK hint did not match.\n");
    return 0;
  }

  // Account for the trailing '\0' for the identity.
  if (config->psk_identity.size() >= max_identity_len ||
      config->psk.size() > max_psk_len) {
    fprintf(stderr, "PSK buffers too small.\n");
    return 0;
  }

  OPENSSL_strlcpy(out_identity, config->psk_identity.c_str(), max_identity_len);
  OPENSSL_memcpy(out_psk, config->psk.data(), config->psk.size());
  return static_cast<unsigned>(config->psk.size());
}

static unsigned PskServerCallback(SSL *ssl, const char *identity,
                                  uint8_t *out_psk, unsigned max_psk_len) {
  const TestConfig *config = GetTestConfig(ssl);

  if (strcmp(identity, config->psk_identity.c_str()) != 0) {
    fprintf(stderr, "Client PSK identity did not match.\n");
    return 0;
  }

  if (config->psk.size() > max_psk_len) {
    fprintf(stderr, "PSK buffers too small.\n");
    return 0;
  }

  OPENSSL_memcpy(out_psk, config->psk.data(), config->psk.size());
  return static_cast<unsigned>(config->psk.size());
}

static ssl_verify_result_t CustomVerifyCallback(SSL *ssl, uint8_t *out_alert) {
  const TestConfig *config = GetTestConfig(ssl);
  if (!CheckVerifyCallback(ssl)) {
    return ssl_verify_invalid;
  }

  if (config->async && !GetTestState(ssl)->custom_verify_ready) {
    return ssl_verify_retry;
  }

  GetTestState(ssl)->cert_verified = true;
  if (config->verify_fail) {
    return ssl_verify_invalid;
  }

  return ssl_verify_ok;
}

static int CertCallback(SSL *ssl, void *arg) {
  const TestConfig *config = GetTestConfig(ssl);

  // Check the peer certificate metadata is as expected.
  if ((!SSL_is_server(ssl) && !CheckCertificateRequest(ssl)) ||
      !CheckPeerVerifyPrefs(ssl)) {
    return -1;
  }

  if (config->fail_cert_callback) {
    return 0;
  }

  // The certificate will be installed via other means.
  if (!config->async || config->use_early_callback) {
    return 1;
  }

  if (!GetTestState(ssl)->cert_ready) {
    return -1;
  }
  if (!InstallCertificate(ssl)) {
    return 0;
  }
  return 1;
}

bssl::UniquePtr<SSL> TestConfig::NewSSL(
    SSL_CTX *ssl_ctx, SSL_SESSION *session,
    std::unique_ptr<TestState> test_state) const {
  bssl::UniquePtr<SSL> ssl(SSL_new(ssl_ctx));
  if (!ssl) {
    return nullptr;
  }

  if (!SetTestConfig(ssl.get(), this)) {
    return nullptr;
  }
  if (test_state != nullptr) {
    if (!SetTestState(ssl.get(), std::move(test_state))) {
      return nullptr;
    }
  }

  if (fallback_scsv && !SSL_set_mode(ssl.get(), SSL_MODE_SEND_FALLBACK_SCSV)) {
    return nullptr;
  }
  // Install the certificate synchronously if nothing else will handle it.
  if (!use_early_callback && !use_old_client_cert_callback && !async &&
      !InstallCertificate(ssl.get())) {
    return nullptr;
  }
  if (!use_old_client_cert_callback) {
    SSL_set_cert_cb(ssl.get(), CertCallback, nullptr);
  }
  int mode = SSL_VERIFY_NONE;
  if (require_any_client_certificate) {
    mode = SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT;
  }
  if (verify_peer) {
    mode = SSL_VERIFY_PEER;
  }
  if (use_custom_verify_callback) {
    SSL_set_custom_verify(ssl.get(), mode, CustomVerifyCallback);
  } else if (mode != SSL_VERIFY_NONE) {
    SSL_set_verify(ssl.get(), mode, nullptr);
  }
  if (false_start) {
    SSL_set_mode(ssl.get(), SSL_MODE_ENABLE_FALSE_START);
  }
  if (cbc_record_splitting) {
    SSL_set_mode(ssl.get(), SSL_MODE_CBC_RECORD_SPLITTING);
  }
  if (partial_write) {
    SSL_set_mode(ssl.get(), SSL_MODE_ENABLE_PARTIAL_WRITE);
  }
  if (reverify_on_resume) {
    SSL_CTX_set_reverify_on_resume(ssl_ctx, 1);
  }
  if (ignore_rsa_key_usage) {
    SSL_set_enforce_rsa_key_usage(ssl.get(), 0);
  }
  if (no_tls13) {
    SSL_set_options(ssl.get(), SSL_OP_NO_TLSv1_3);
  }
  if (no_tls12) {
    SSL_set_options(ssl.get(), SSL_OP_NO_TLSv1_2);
  }
  if (no_tls11) {
    SSL_set_options(ssl.get(), SSL_OP_NO_TLSv1_1);
  }
  if (no_tls1) {
    SSL_set_options(ssl.get(), SSL_OP_NO_TLSv1);
  }
  if (no_ticket) {
    SSL_set_options(ssl.get(), SSL_OP_NO_TICKET);
  }
  if (!expect_channel_id.empty() || enable_channel_id) {
    SSL_set_tls_channel_id_enabled(ssl.get(), 1);
  }
  if (enable_ech_grease) {
    SSL_set_enable_ech_grease(ssl.get(), 1);
  }
  if (static_cast<int>(fips_202205) + static_cast<int>(wpa_202304) +
          static_cast<int>(cnsa_202407) >
      1) {
    fprintf(stderr, "Multiple policy options given\n");
    return nullptr;
  }
  if (fips_202205 && !SSL_set_compliance_policy(
                         ssl.get(), ssl_compliance_policy_fips_202205)) {
    fprintf(stderr, "SSL_set_compliance_policy failed\n");
    return nullptr;
  }
  if (wpa_202304 && !SSL_set_compliance_policy(
                        ssl.get(), ssl_compliance_policy_wpa3_192_202304)) {
    fprintf(stderr, "SSL_set_compliance_policy failed\n");
    return nullptr;
  }
  if (cnsa_202407 && !SSL_set_compliance_policy(
                         ssl.get(), ssl_compliance_policy_cnsa_202407)) {
    fprintf(stderr, "SSL_set_compliance_policy failed\n");
    return nullptr;
  }
  if (!ech_config_list.empty() &&
      !SSL_set1_ech_config_list(ssl.get(), ech_config_list.data(),
                                ech_config_list.size())) {
    return nullptr;
  }
  if (ech_server_configs.size() != ech_server_keys.size() ||
      ech_server_configs.size() != ech_is_retry_config.size()) {
    fprintf(stderr,
            "-ech-server-config, -ech-server-key, and -ech-is-retry-config "
            "flags must match.\n");
    return nullptr;
  }
  if (!ech_server_configs.empty()) {
    bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
    if (!keys) {
      return nullptr;
    }
    for (size_t i = 0; i < ech_server_configs.size(); i++) {
      bssl::Span<const uint8_t> ech_config = ech_server_configs[i];
      bssl::Span<const uint8_t> ech_private_key = ech_server_keys[i];
      const int is_retry_config = ech_is_retry_config[i];
      bssl::ScopedEVP_HPKE_KEY key;
      if (!EVP_HPKE_KEY_init(key.get(), EVP_hpke_x25519_hkdf_sha256(),
                             ech_private_key.data(), ech_private_key.size()) ||
          !SSL_ECH_KEYS_add(keys.get(), is_retry_config, ech_config.data(),
                            ech_config.size(), key.get())) {
        return nullptr;
      }
    }
    if (!SSL_CTX_set1_ech_keys(ssl_ctx, keys.get())) {
      return nullptr;
    }
  }
  if (!send_channel_id.empty()) {
    bssl::UniquePtr<EVP_PKEY> pkey = LoadPrivateKey(send_channel_id);
    if (!pkey || !SSL_set1_tls_channel_id(ssl.get(), pkey.get())) {
      return nullptr;
    }
  }
  if (!host_name.empty() &&
      !SSL_set_tlsext_host_name(ssl.get(), host_name.c_str())) {
    return nullptr;
  }
  if (!advertise_alpn.empty() &&
      SSL_set_alpn_protos(
          ssl.get(), reinterpret_cast<const uint8_t *>(advertise_alpn.data()),
          advertise_alpn.size()) != 0) {
    return nullptr;
  }
  if (!defer_alps) {
    for (const auto &pair : application_settings) {
      if (!SSL_add_application_settings(
              ssl.get(), reinterpret_cast<const uint8_t *>(pair.first.data()),
              pair.first.size(),
              reinterpret_cast<const uint8_t *>(pair.second.data()),
              pair.second.size())) {
        return nullptr;
      }
    }
  }
  if (!psk.empty()) {
    SSL_set_psk_client_callback(ssl.get(), PskClientCallback);
    SSL_set_psk_server_callback(ssl.get(), PskServerCallback);
  }
  if (!psk_identity.empty() &&
      !SSL_use_psk_identity_hint(ssl.get(), psk_identity.c_str())) {
    return nullptr;
  }
  if (!srtp_profiles.empty() &&
      !SSL_set_srtp_profiles(ssl.get(), srtp_profiles.c_str())) {
    return nullptr;
  }
  if (requested_trust_anchors.has_value() &&
      !SSL_set1_requested_trust_anchors(ssl.get(),
                                        requested_trust_anchors->data(),
                                        requested_trust_anchors->size())) {
    return nullptr;
  }
  if (enable_ocsp_stapling) {
    SSL_enable_ocsp_stapling(ssl.get());
  }
  if (enable_signed_cert_timestamps) {
    SSL_enable_signed_cert_timestamps(ssl.get());
  }
  // (D)TLS 1.0 and 1.1 are disabled by default, but the runner expects them to
  // be enabled.
  // TODO(davidben): Update the tests to explicitly enable the versions they
  // need.
  if (!SSL_set_min_proto_version(
          ssl.get(), SSL_is_dtls(ssl.get()) ? DTLS1_VERSION : TLS1_VERSION)) {
    return nullptr;
  }
  if (min_version != 0 && !SSL_set_min_proto_version(ssl.get(), min_version)) {
    return nullptr;
  }
  // TODO(crbug.com/42290594): Remove this once DTLS 1.3 is enabled by default.
  if (is_dtls && max_version == 0 &&
      !SSL_set_max_proto_version(ssl.get(), DTLS1_3_VERSION)) {
    return nullptr;
  }
  if (max_version != 0 && !SSL_set_max_proto_version(ssl.get(), max_version)) {
    return nullptr;
  }
  if (mtu != 0) {
    SSL_set_options(ssl.get(), SSL_OP_NO_QUERY_MTU);
    SSL_set_mtu(ssl.get(), mtu);
  }
  if (install_ddos_callback) {
    SSL_CTX_set_dos_protection_cb(ssl_ctx, DDoSCallback);
  }
  SSL_set_shed_handshake_config(ssl.get(), true);
  if (renegotiate_once) {
    SSL_set_renegotiate_mode(ssl.get(), ssl_renegotiate_once);
  }
  if (renegotiate_freely || forbid_renegotiation_after_handshake) {
    // |forbid_renegotiation_after_handshake| will disable renegotiation later.
    SSL_set_renegotiate_mode(ssl.get(), ssl_renegotiate_freely);
  }
  if (renegotiate_ignore) {
    SSL_set_renegotiate_mode(ssl.get(), ssl_renegotiate_ignore);
  }
  if (renegotiate_explicit) {
    SSL_set_renegotiate_mode(ssl.get(), ssl_renegotiate_explicit);
  }
  if (!check_close_notify) {
    SSL_set_quiet_shutdown(ssl.get(), 1);
  }
  if (!curves.empty() &&
      !SSL_set1_group_ids(ssl.get(), curves.data(), curves.size())) {
    return nullptr;
  }
  if (key_shares.has_value() &&
      !SSL_set1_client_key_shares(ssl.get(), key_shares->data(),
                                  key_shares->size())) {
    return nullptr;
  }
  if (!server_supported_groups_hint.empty() &&
      !SSL_set1_server_supported_groups_hint(
          ssl.get(), server_supported_groups_hint.data(),
          server_supported_groups_hint.size())) {
    return nullptr;
  }
  if (initial_timeout_duration_ms > 0) {
    DTLSv1_set_initial_timeout_duration(ssl.get(), initial_timeout_duration_ms);
  }
  if (max_cert_list > 0) {
    SSL_set_max_cert_list(ssl.get(), max_cert_list);
  }
  if (retain_only_sha256_client_cert) {
    SSL_set_retain_only_sha256_of_client_certs(ssl.get(), 1);
  }
  if (max_send_fragment > 0) {
    SSL_set_max_send_fragment(ssl.get(), max_send_fragment);
  }
  // Using new ALPS codepoint as default, only explicitly set when it uses the
  // old ALPS codepoint.
  if (alps_use_new_codepoint == 0) {
    SSL_set_alps_use_new_codepoint(ssl.get(), 0);
  }
  if (quic_use_legacy_codepoint != -1) {
    SSL_set_quic_use_legacy_codepoint(ssl.get(), quic_use_legacy_codepoint);
  }
  if (!quic_transport_params.empty()) {
    if (!SSL_set_quic_transport_params(ssl.get(), quic_transport_params.data(),
                                       quic_transport_params.size())) {
      return nullptr;
    }
  }
  if (jdk11_workaround) {
    SSL_set_jdk11_workaround(ssl.get(), 1);
  }

  if (session != nullptr) {
    if (!is_server) {
      if (SSL_set_session(ssl.get(), session) != 1) {
        return nullptr;
      }
    } else if (async) {
      // The internal session cache is disabled, so install the session
      // manually.
      SSL_SESSION_up_ref(session);
      GetTestState(ssl.get())->pending_session.reset(session);
    }
  }

  if (!quic_early_data_context.empty() &&
      !SSL_set_quic_early_data_context(
          ssl.get(),
          reinterpret_cast<const uint8_t *>(quic_early_data_context.data()),
          quic_early_data_context.size())) {
    return nullptr;
  }

  return ssl;
}
