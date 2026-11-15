// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
// Copyright (c) 2002, Oracle and/or its affiliates. All rights reserved.
// Copyright 2005 Nokia. All rights reserved.
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

#ifndef OPENSSL_HEADER_TLS1_H
#define OPENSSL_HEADER_TLS1_H

#include <openssl/base.h>   // IWYU pragma: export

#ifdef __cplusplus
extern "C" {
#endif


#define TLS1_AD_END_OF_EARLY_DATA 1
#define TLS1_AD_DECRYPTION_FAILED 21
#define TLS1_AD_RECORD_OVERFLOW 22
#define TLS1_AD_UNKNOWN_CA 48
#define TLS1_AD_ACCESS_DENIED 49
#define TLS1_AD_DECODE_ERROR 50
#define TLS1_AD_DECRYPT_ERROR 51
#define TLS1_AD_EXPORT_RESTRICTION 60
#define TLS1_AD_PROTOCOL_VERSION 70
#define TLS1_AD_INSUFFICIENT_SECURITY 71
#define TLS1_AD_INTERNAL_ERROR 80
#define TLS1_AD_USER_CANCELLED 90
#define TLS1_AD_NO_RENEGOTIATION 100
#define TLS1_AD_MISSING_EXTENSION 109
#define TLS1_AD_UNSUPPORTED_EXTENSION 110
#define TLS1_AD_CERTIFICATE_UNOBTAINABLE 111
#define TLS1_AD_UNRECOGNIZED_NAME 112
#define TLS1_AD_BAD_CERTIFICATE_STATUS_RESPONSE 113
#define TLS1_AD_BAD_CERTIFICATE_HASH_VALUE 114
#define TLS1_AD_UNKNOWN_PSK_IDENTITY 115
#define TLS1_AD_CERTIFICATE_REQUIRED 116
#define TLS1_AD_NO_APPLICATION_PROTOCOL 120
#define TLS1_AD_ECH_REQUIRED 121  // draft-ietf-tls-esni-13

// ExtensionType values from RFC 6066
#define TLSEXT_TYPE_server_name 0
#define TLSEXT_TYPE_status_request 5

// ExtensionType values from RFC 4492
#define TLSEXT_TYPE_ec_point_formats 11

// ExtensionType values from RFC 5246
#define TLSEXT_TYPE_signature_algorithms 13

// ExtensionType value from RFC 5764
#define TLSEXT_TYPE_srtp 14

// ExtensionType value from RFC 7301
#define TLSEXT_TYPE_application_layer_protocol_negotiation 16

// ExtensionType value from RFC 7685
#define TLSEXT_TYPE_padding 21

// ExtensionType value from RFC 7627
#define TLSEXT_TYPE_extended_master_secret 23

// ExtensionType value from draft-ietf-quic-tls. Drafts 00 through 32 use
// 0xffa5 which is part of the Private Use section of the registry, and it
// collides with TLS-LTS and, based on scans, something else too (though this
// hasn't been a problem in practice since it's QUIC-only). Drafts 33 onward
// use the value 57 which was officially registered with IANA.
#define TLSEXT_TYPE_quic_transport_parameters_legacy 0xffa5

// ExtensionType value from RFC 9000
#define TLSEXT_TYPE_quic_transport_parameters 57

// TLSEXT_TYPE_quic_transport_parameters_standard is an alias for
// |TLSEXT_TYPE_quic_transport_parameters|. Use
// |TLSEXT_TYPE_quic_transport_parameters| instead.
#define TLSEXT_TYPE_quic_transport_parameters_standard \
  TLSEXT_TYPE_quic_transport_parameters

// ExtensionType value from RFC 8879
#define TLSEXT_TYPE_cert_compression 27

// ExtensionType value from RFC 4507
#define TLSEXT_TYPE_session_ticket 35

// ExtensionType values from RFC 8446
#define TLSEXT_TYPE_supported_groups 10
#define TLSEXT_TYPE_pre_shared_key 41
#define TLSEXT_TYPE_early_data 42
#define TLSEXT_TYPE_supported_versions 43
#define TLSEXT_TYPE_cookie 44
#define TLSEXT_TYPE_psk_key_exchange_modes 45
#define TLSEXT_TYPE_certificate_authorities 47
#define TLSEXT_TYPE_signature_algorithms_cert 50
#define TLSEXT_TYPE_key_share 51

// ExtensionType value from RFC 5746
#define TLSEXT_TYPE_renegotiate 0xff01

// ExtensionType value from RFC 9345
#define TLSEXT_TYPE_delegated_credential 34

// ExtensionType value from draft-vvv-tls-alps. This is not an IANA defined
// extension number.
#define TLSEXT_TYPE_application_settings_old 17513
#define TLSEXT_TYPE_application_settings 17613

// ExtensionType values from draft-ietf-tls-esni-13. This is not an IANA defined
// extension number.
#define TLSEXT_TYPE_encrypted_client_hello 0xfe0d
#define TLSEXT_TYPE_ech_outer_extensions 0xfd00

// ExtensionType values from draft-bmw-tls-pake13. This is not an IANA defined
// extension number.
#define TLSEXT_TYPE_pake 0x8a3b

// ExtensionType value from RFC 6962
#define TLSEXT_TYPE_certificate_timestamp 18

// This is not an IANA defined extension number
#define TLSEXT_TYPE_next_proto_neg 13172

// This is not an IANA defined extension number
#define TLSEXT_TYPE_channel_id 30032

// This is not an IANA defined extension number
// TODO(crbug.com/398275713): Replace with the final codepoint once
// standardization completes.
#define TLSEXT_TYPE_trust_anchors 0xca34

// ExtensionType value from draft-ietf-tls-tlsflags.
#define TLSEXT_TYPE_tls_flags 62

// status request value from RFC 3546
#define TLSEXT_STATUSTYPE_nothing (-1)
#define TLSEXT_STATUSTYPE_ocsp 1

// ECPointFormat values from RFC 4492
#define TLSEXT_ECPOINTFORMAT_uncompressed 0
#define TLSEXT_ECPOINTFORMAT_ansiX962_compressed_prime 1

// Signature and hash algorithms from RFC 5246

#define TLSEXT_signature_anonymous 0
#define TLSEXT_signature_rsa 1
#define TLSEXT_signature_dsa 2
#define TLSEXT_signature_ecdsa 3

#define TLSEXT_hash_none 0
#define TLSEXT_hash_md5 1
#define TLSEXT_hash_sha1 2
#define TLSEXT_hash_sha224 3
#define TLSEXT_hash_sha256 4
#define TLSEXT_hash_sha384 5
#define TLSEXT_hash_sha512 6

// From https://www.rfc-editor.org/rfc/rfc8879.html#section-3
#define TLSEXT_cert_compression_zlib 1
#define TLSEXT_cert_compression_brotli 2

#define TLSEXT_MAXLEN_host_name 255

// The following constants are equal to TLS cipher suite values, OR-d with
// 0x03000000. This is part of OpenSSL's SSL 2.0 legacy. SSL 2.0 has long since
// been removed from BoringSSL.
// TODO(davidben): Define these in terms of |SSL_CIPHER_*| constants. The
// challenge is that existing code expects them to be defined in tls1.h, so we
// must first merge tls1.h into ssl.h.
#define TLS1_CK_PSK_WITH_AES_128_CBC_SHA 0x0300008C
#define TLS1_CK_PSK_WITH_AES_256_CBC_SHA 0x0300008D
#define TLS1_CK_ECDHE_PSK_WITH_AES_128_CBC_SHA 0x0300C035
#define TLS1_CK_ECDHE_PSK_WITH_AES_256_CBC_SHA 0x0300C036
#define TLS1_CK_RSA_WITH_AES_128_SHA 0x0300002F
#define TLS1_CK_RSA_WITH_AES_256_SHA 0x03000035
#define TLS1_CK_RSA_WITH_AES_128_GCM_SHA256 0x0300009C
#define TLS1_CK_RSA_WITH_AES_256_GCM_SHA384 0x0300009D
#define TLS1_CK_ECDHE_ECDSA_WITH_AES_128_CBC_SHA 0x0300C009
#define TLS1_CK_ECDHE_ECDSA_WITH_AES_256_CBC_SHA 0x0300C00A
#define TLS1_CK_ECDHE_RSA_WITH_AES_128_CBC_SHA 0x0300C013
#define TLS1_CK_ECDHE_RSA_WITH_AES_256_CBC_SHA 0x0300C014
#define TLS1_CK_ECDHE_RSA_WITH_AES_128_CBC_SHA256 0x0300C027
#define TLS1_CK_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 0x0300C02B
#define TLS1_CK_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 0x0300C02C
#define TLS1_CK_ECDHE_RSA_WITH_AES_128_GCM_SHA256 0x0300C02F
#define TLS1_CK_ECDHE_RSA_WITH_AES_256_GCM_SHA384 0x0300C030
#define TLS1_CK_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256 0x0300CCA8
#define TLS1_CK_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256 0x0300CCA9
#define TLS1_CK_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256 0x0300CCAC
#define TLS1_3_CK_AES_128_GCM_SHA256 0x03001301
#define TLS1_3_CK_AES_256_GCM_SHA384 0x03001302
#define TLS1_3_CK_CHACHA20_POLY1305_SHA256 0x03001303

// The following constants are legacy aliases of |TLS1_3_CK_*|.
// TODO(davidben): Migrate callers to the new name and remove these.
#define TLS1_CK_AES_128_GCM_SHA256 TLS1_3_CK_AES_128_GCM_SHA256
#define TLS1_CK_AES_256_GCM_SHA384 TLS1_3_CK_AES_256_GCM_SHA384
#define TLS1_CK_CHACHA20_POLY1305_SHA256 TLS1_3_CK_CHACHA20_POLY1305_SHA256

// The following constants are the OpenSSL names (see |SSL_CIPHER_get_name|) for
// various TLS ciphers. Prefer the standard name, returned from
// |SSL_CIPHER_standard_name| and supported by |SSL_CTX_set_cipher_list|.
#define TLS1_TXT_PSK_WITH_AES_128_CBC_SHA "PSK-AES128-CBC-SHA"
#define TLS1_TXT_PSK_WITH_AES_256_CBC_SHA "PSK-AES256-CBC-SHA"
#define TLS1_TXT_ECDHE_PSK_WITH_AES_128_CBC_SHA "ECDHE-PSK-AES128-CBC-SHA"
#define TLS1_TXT_ECDHE_PSK_WITH_AES_256_CBC_SHA "ECDHE-PSK-AES256-CBC-SHA"
#define TLS1_TXT_RSA_WITH_AES_128_SHA "AES128-SHA"
#define TLS1_TXT_RSA_WITH_AES_256_SHA "AES256-SHA"
#define TLS1_TXT_RSA_WITH_AES_128_GCM_SHA256 "AES128-GCM-SHA256"
#define TLS1_TXT_RSA_WITH_AES_256_GCM_SHA384 "AES256-GCM-SHA384"
#define TLS1_TXT_ECDHE_ECDSA_WITH_AES_128_CBC_SHA "ECDHE-ECDSA-AES128-SHA"
#define TLS1_TXT_ECDHE_ECDSA_WITH_AES_256_CBC_SHA "ECDHE-ECDSA-AES256-SHA"
#define TLS1_TXT_ECDHE_RSA_WITH_AES_128_CBC_SHA "ECDHE-RSA-AES128-SHA"
#define TLS1_TXT_ECDHE_RSA_WITH_AES_256_CBC_SHA "ECDHE-RSA-AES256-SHA"
#define TLS1_TXT_ECDHE_RSA_WITH_AES_128_CBC_SHA256 "ECDHE-RSA-AES128-SHA256"
#define TLS1_TXT_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 \
  "ECDHE-ECDSA-AES128-GCM-SHA256"
#define TLS1_TXT_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384 \
  "ECDHE-ECDSA-AES256-GCM-SHA384"
#define TLS1_TXT_ECDHE_RSA_WITH_AES_128_GCM_SHA256 "ECDHE-RSA-AES128-GCM-SHA256"
#define TLS1_TXT_ECDHE_RSA_WITH_AES_256_GCM_SHA384 "ECDHE-RSA-AES256-GCM-SHA384"
#define TLS1_TXT_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256 \
  "ECDHE-RSA-CHACHA20-POLY1305"
#define TLS1_TXT_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256 \
  "ECDHE-ECDSA-CHACHA20-POLY1305"
#define TLS1_TXT_ECDHE_PSK_WITH_CHACHA20_POLY1305_SHA256 \
  "ECDHE-PSK-CHACHA20-POLY1305"
#define TLS1_3_RFC_AES_128_GCM_SHA256 "TLS_AES_128_GCM_SHA256"
#define TLS1_3_RFC_AES_256_GCM_SHA384 "TLS_AES_256_GCM_SHA384"
#define TLS1_3_RFC_CHACHA20_POLY1305_SHA256 "TLS_CHACHA20_POLY1305_SHA256"

#define TLS_CT_RSA_SIGN 1
#define TLS_CT_DSS_SIGN 2
#define TLS_CT_RSA_FIXED_DH 3
#define TLS_CT_DSS_FIXED_DH 4
#define TLS_CT_ECDSA_SIGN 64
#define TLS_CT_RSA_FIXED_ECDH 65
#define TLS_CT_ECDSA_FIXED_ECDH 66


#ifdef __cplusplus
}  // extern C
#endif

#endif  // OPENSSL_HEADER_TLS1_H
