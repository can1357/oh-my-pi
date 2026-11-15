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

#include <openssl/base.h>

#include <memory>

#include <openssl/err.h>
#include <openssl/hpke.h>
#include <openssl/rand.h>
#include <openssl/ssl.h>

#include "internal.h"
#include "transport_common.h"


static const struct argument kArguments[] = {
    {
        "-accept", kRequiredArgument,
        "The port of the server to bind on; eg 45102",
    },
    {
        "-cipher", kOptionalArgument,
        "An OpenSSL-style cipher suite string that configures the offered "
        "ciphers",
    },
    {
        "-curves", kOptionalArgument,
        "An OpenSSL-style ECDH curves list that configures the offered curves",
    },
    {
        "-max-version", kOptionalArgument,
        "The maximum acceptable protocol version",
    },
    {
        "-min-version", kOptionalArgument,
        "The minimum acceptable protocol version",
    },
    {
        "-key", kOptionalArgument,
        "PEM-encoded file containing the private key. A self-signed "
        "certificate is generated at runtime if this argument is not provided.",
    },
    {
        "-cert", kOptionalArgument,
        "PEM-encoded file containing the leaf certificate and optional "
        "certificate chain. This is taken from the -key argument if this "
        "argument is not provided.",
    },
    {
        "-ocsp-response", kOptionalArgument, "OCSP response file to send",
    },
    {
        "-ech-key",
        kOptionalArgument,
        "File containing the private key corresponding to the ECHConfig.",
    },
    {
        "-ech-config",
        kOptionalArgument,
        "File containing one ECHConfig.",
    },
    {
        "-loop", kBooleanArgument,
        "The server will continue accepting new sequential connections.",
    },
    {
        "-early-data", kBooleanArgument, "Allow early data",
    },
    {
        "-www", kBooleanArgument,
        "The server will print connection information in response to a "
        "HTTP GET request.",
    },
    {
        "-debug", kBooleanArgument,
        "Print debug information about the handshake",
    },
    {
        "-require-any-client-cert", kBooleanArgument,
        "The server will require a client certificate.",
    },
    {
        "-jdk11-workaround", kBooleanArgument,
        "Enable the JDK 11 workaround",
    },
    {
        "", kOptionalArgument, "",
    },
};

static bool LoadOCSPResponse(SSL_CTX *ctx, const char *filename) {
  ScopedFILE f(fopen(filename, "rb"));
  std::vector<uint8_t> data;
  if (f == nullptr ||
      !ReadAll(&data, f.get())) {
    fprintf(stderr, "Error reading %s.\n", filename);
    return false;
  }

  if (!SSL_CTX_set_ocsp_response(ctx, data.data(), data.size())) {
    return false;
  }

  return true;
}

static bssl::UniquePtr<EVP_PKEY> MakeKeyPairForSelfSignedCert() {
  bssl::UniquePtr<EC_KEY> ec_key(EC_KEY_new_by_curve_name(NID_X9_62_prime256v1));
  if (!ec_key || !EC_KEY_generate_key(ec_key.get())) {
    fprintf(stderr, "Failed to generate key pair.\n");
    return nullptr;
  }
  bssl::UniquePtr<EVP_PKEY> evp_pkey(EVP_PKEY_new());
  if (!evp_pkey || !EVP_PKEY_assign_EC_KEY(evp_pkey.get(), ec_key.release())) {
    fprintf(stderr, "Failed to assign key pair.\n");
    return nullptr;
  }
  return evp_pkey;
}

static bssl::UniquePtr<X509> MakeSelfSignedCert(EVP_PKEY *evp_pkey,
                                                const int valid_days) {
  uint64_t serial;
  bssl::UniquePtr<X509> x509(X509_new());
  if (!x509 ||  //
      !X509_set_version(x509.get(), X509_VERSION_3) ||
      !RAND_bytes(reinterpret_cast<uint8_t *>(&serial), sizeof(serial)) ||
      !ASN1_INTEGER_set_uint64(X509_get_serialNumber(x509.get()), serial) ||
      !X509_gmtime_adj(X509_get_notBefore(x509.get()), 0) ||
      !X509_gmtime_adj(X509_get_notAfter(x509.get()),
                       60 * 60 * 24 * valid_days)) {
    return nullptr;
  }

  X509_NAME *subject = X509_get_subject_name(x509.get());
  if (!X509_NAME_add_entry_by_txt(subject, "C", MBSTRING_ASC,
                                  reinterpret_cast<const uint8_t *>("US"), -1,
                                  -1, 0) ||
      !X509_NAME_add_entry_by_txt(
          subject, "O", MBSTRING_ASC,
          reinterpret_cast<const uint8_t *>("BoringSSL"), -1, -1, 0) ||
      !X509_set_issuer_name(x509.get(), subject)) {
    return nullptr;
  }

  // macOS requires an explicit EKU extension.
  bssl::UniquePtr<STACK_OF(ASN1_OBJECT)> ekus(sk_ASN1_OBJECT_new_null());
  if (!ekus ||
      !sk_ASN1_OBJECT_push(ekus.get(), OBJ_nid2obj(NID_server_auth)) ||
      !X509_add1_ext_i2d(x509.get(), NID_ext_key_usage, ekus.get(), /*crit=*/1,
                         /*flags=*/0)) {
    return nullptr;
  }

  if (!X509_set_pubkey(x509.get(), evp_pkey)) {
    fprintf(stderr, "Failed to set public key.\n");
    return nullptr;
  }
  if (!X509_sign(x509.get(), evp_pkey, EVP_sha256())) {
    fprintf(stderr, "Failed to sign certificate.\n");
    return nullptr;
  }
  return x509;
}

static void InfoCallback(const SSL *ssl, int type, int value) {
  switch (type) {
    case SSL_CB_HANDSHAKE_START:
      fprintf(stderr, "Handshake started.\n");
      break;
    case SSL_CB_HANDSHAKE_DONE:
      fprintf(stderr, "Handshake done.\n");
      break;
    case SSL_CB_ACCEPT_LOOP:
      fprintf(stderr, "Handshake progress: %s\n", SSL_state_string_long(ssl));
      break;
  }
}

static FILE *g_keylog_file = nullptr;

static void KeyLogCallback(const SSL *ssl, const char *line) {
  fprintf(g_keylog_file, "%s\n", line);
  fflush(g_keylog_file);
}

static bool HandleWWW(SSL *ssl) {
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_mem()));
  if (!bio) {
    fprintf(stderr, "Cannot create BIO for response\n");
    return false;
  }

  BIO_puts(bio.get(), "HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\n");
  PrintConnectionInfo(bio.get(), ssl);

  char request[4];
  size_t request_len = 0;
  while (request_len < sizeof(request)) {
    int ssl_ret =
        SSL_read(ssl, request + request_len, sizeof(request) - request_len);
    if (ssl_ret <= 0) {
      int ssl_err = SSL_get_error(ssl, ssl_ret);
      PrintSSLError(stderr, "Error while reading", ssl_err, ssl_ret);
      return false;
    }
    request_len += static_cast<size_t>(ssl_ret);
  }

  // Assume simple HTTP request, print status.
  if (memcmp(request, "GET ", 4) == 0) {
    const uint8_t *response;
    size_t response_len;
    if (BIO_mem_contents(bio.get(), &response, &response_len)) {
      SSL_write(ssl, response, response_len);
    }
  }
  return true;
}

bool Server(const std::vector<std::string> &args) {
  if (!InitSocketLibrary()) {
    return false;
  }

  std::map<std::string, std::string> args_map;

  if (!ParseKeyValueArguments(&args_map, args, kArguments)) {
    PrintUsage(kArguments);
    return false;
  }

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));

  const char *keylog_file = getenv("SSLKEYLOGFILE");
  if (keylog_file) {
    g_keylog_file = fopen(keylog_file, "a");
    if (g_keylog_file == nullptr) {
      perror("fopen");
      return false;
    }
    SSL_CTX_set_keylog_callback(ctx.get(), KeyLogCallback);
  }

  // Server authentication is required.
  if (args_map.count("-key") != 0) {
    std::string key = args_map["-key"];
    if (!SSL_CTX_use_PrivateKey_file(ctx.get(), key.c_str(),
                                     SSL_FILETYPE_PEM)) {
      fprintf(stderr, "Failed to load private key: %s\n", key.c_str());
      return false;
    }
    const std::string &cert =
        args_map.count("-cert") != 0 ? args_map["-cert"] : key;
    if (!SSL_CTX_use_certificate_chain_file(ctx.get(), cert.c_str())) {
      fprintf(stderr, "Failed to load cert chain: %s\n", cert.c_str());
      return false;
    }
  } else {
    bssl::UniquePtr<EVP_PKEY> evp_pkey = MakeKeyPairForSelfSignedCert();
    if (!evp_pkey) {
      return false;
    }
    bssl::UniquePtr<X509> cert =
        MakeSelfSignedCert(evp_pkey.get(), 365 /* valid_days */);
    if (!cert) {
      return false;
    }
    if (!SSL_CTX_use_PrivateKey(ctx.get(), evp_pkey.get())) {
      fprintf(stderr, "Failed to set private key.\n");
      return false;
    }
    if (!SSL_CTX_use_certificate(ctx.get(), cert.get())) {
      fprintf(stderr, "Failed to set certificate.\n");
      return false;
    }
  }

  if (args_map.count("-ech-key") + args_map.count("-ech-config") == 1) {
    fprintf(stderr,
            "-ech-config and -ech-key must be specified together.\n");
    return false;
  }

  if (args_map.count("-ech-key") != 0) {
    // Load the ECH private key.
    std::string ech_key_path = args_map["-ech-key"];
    ScopedFILE ech_key_file(fopen(ech_key_path.c_str(), "rb"));
    std::vector<uint8_t> ech_key;
    if (ech_key_file == nullptr ||
        !ReadAll(&ech_key, ech_key_file.get())) {
      fprintf(stderr, "Error reading %s\n", ech_key_path.c_str());
      return false;
    }

    // Load the ECHConfig.
    std::string ech_config_path = args_map["-ech-config"];
    ScopedFILE ech_config_file(fopen(ech_config_path.c_str(), "rb"));
    std::vector<uint8_t> ech_config;
    if (ech_config_file == nullptr ||
        !ReadAll(&ech_config, ech_config_file.get())) {
      fprintf(stderr, "Error reading %s\n", ech_config_path.c_str());
      return false;
    }

    bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
    bssl::ScopedEVP_HPKE_KEY key;
    if (!keys ||
        !EVP_HPKE_KEY_init(key.get(), EVP_hpke_x25519_hkdf_sha256(),
                           ech_key.data(), ech_key.size()) ||
        !SSL_ECH_KEYS_add(keys.get(),
                          /*is_retry_config=*/1, ech_config.data(),
                          ech_config.size(), key.get()) ||
        !SSL_CTX_set1_ech_keys(ctx.get(), keys.get())) {
      fprintf(stderr, "Error setting server's ECHConfig and private key\n");
      return false;
    }
  }

  if (args_map.count("-cipher") != 0 &&
      !SSL_CTX_set_strict_cipher_list(ctx.get(), args_map["-cipher"].c_str())) {
    fprintf(stderr, "Failed setting cipher list\n");
    return false;
  }

  if (args_map.count("-curves") != 0 &&
      !SSL_CTX_set1_curves_list(ctx.get(), args_map["-curves"].c_str())) {
    fprintf(stderr, "Failed setting curves list\n");
    return false;
  }

  uint16_t max_version = TLS1_3_VERSION;
  if (args_map.count("-max-version") != 0 &&
      !VersionFromString(&max_version, args_map["-max-version"])) {
    fprintf(stderr, "Unknown protocol version: '%s'\n",
            args_map["-max-version"].c_str());
    return false;
  }

  if (!SSL_CTX_set_max_proto_version(ctx.get(), max_version)) {
    return false;
  }

  if (args_map.count("-min-version") != 0) {
    uint16_t version;
    if (!VersionFromString(&version, args_map["-min-version"])) {
      fprintf(stderr, "Unknown protocol version: '%s'\n",
              args_map["-min-version"].c_str());
      return false;
    }
    if (!SSL_CTX_set_min_proto_version(ctx.get(), version)) {
      return false;
    }
  }

  if (args_map.count("-ocsp-response") != 0 &&
      !LoadOCSPResponse(ctx.get(), args_map["-ocsp-response"].c_str())) {
    fprintf(stderr, "Failed to load OCSP response: %s\n", args_map["-ocsp-response"].c_str());
    return false;
  }

  if (args_map.count("-early-data") != 0) {
    SSL_CTX_set_early_data_enabled(ctx.get(), 1);
  }

  if (args_map.count("-debug") != 0) {
    SSL_CTX_set_info_callback(ctx.get(), InfoCallback);
  }

  if (args_map.count("-require-any-client-cert") != 0) {
    SSL_CTX_set_verify(
        ctx.get(), SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT, nullptr);
    SSL_CTX_set_cert_verify_callback(
        ctx.get(), [](X509_STORE_CTX *store, void *arg) -> int { return 1; },
        nullptr);
  }

  Listener listener;
  if (!listener.Init(args_map["-accept"])) {
    return false;
  }

  bool result = true;
  do {
    int sock = -1;
    if (!listener.Accept(&sock)) {
      return false;
    }

    BIO *bio = BIO_new_socket(sock, BIO_CLOSE);
    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    SSL_set_bio(ssl.get(), bio, bio);

    if (args_map.count("-jdk11-workaround") != 0) {
      SSL_set_jdk11_workaround(ssl.get(), 1);
    }

    int ret = SSL_accept(ssl.get());
    if (ret != 1) {
      int ssl_err = SSL_get_error(ssl.get(), ret);
      PrintSSLError(stderr, "Error while connecting", ssl_err, ret);
      result = false;
      continue;
    }

    fprintf(stderr, "Connected.\n");
    bssl::UniquePtr<BIO> bio_stderr(BIO_new_fp(stderr, BIO_NOCLOSE));
    PrintConnectionInfo(bio_stderr.get(), ssl.get());

    if (args_map.count("-www") != 0) {
      result = HandleWWW(ssl.get());
    } else {
      result = TransferData(ssl.get(), sock);
    }
  } while (args_map.count("-loop") != 0);

  return result;
}
