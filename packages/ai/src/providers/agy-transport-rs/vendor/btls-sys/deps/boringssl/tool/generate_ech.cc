// Copyright 2021 The BoringSSL Authors
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

#include <stdio.h>

#include <limits>
#include <vector>

#include <openssl/bytestring.h>
#include <openssl/hpke.h>
#include <openssl/span.h>
#include <openssl/ssl.h>

#include "internal.h"


static const struct argument kArguments[] = {
    {
        "-out-ech-config-list",
        kRequiredArgument,
        "The path where the ECHConfigList should be written.",
    },
    {
        "-out-ech-config",
        kRequiredArgument,
        "The path where the ECHConfig should be written.",
    },
    {
        "-out-private-key",
        kRequiredArgument,
        "The path where the private key should be written.",
    },
    {
        "-public-name",
        kRequiredArgument,
        "The public name for the new ECHConfig.",
    },
    {
        "-config-id",
        kRequiredArgument,
        "The config ID for the new ECHConfig, from 0 to 255. Config IDs may be "
        "reused, but should be unique among active configs on a server for "
        "performance.",
    },
    {
        "-max-name-length",
        kOptionalArgument,
        "The length of the longest name in the anonymity set, to guide client "
        "padding.",
    },
    {
        "",
        kOptionalArgument,
        "",
    },
};

bool GenerateECH(const std::vector<std::string> &args) {
  std::map<std::string, std::string> args_map;
  if (!ParseKeyValueArguments(&args_map, args, kArguments)) {
    PrintUsage(kArguments);
    return false;
  }

  unsigned config_id;
  if (!GetUnsigned(&config_id, "-config-id", 0, args_map) ||
      config_id > std::numeric_limits<uint8_t>::max()) {
    fprintf(stderr, "Error parsing -config-id argument\n");
    return false;
  }

  unsigned max_name_len = 0;
  if (args_map.count("-max-name-length") != 0 &&
      !GetUnsigned(&max_name_len, "-max-name-length", 0, args_map)) {
    fprintf(stderr, "Error parsing -max-name-length argument\n");
    return false;
  }

  bssl::ScopedEVP_HPKE_KEY key;
  uint8_t public_key[EVP_HPKE_MAX_PUBLIC_KEY_LENGTH];
  uint8_t private_key[EVP_HPKE_MAX_PRIVATE_KEY_LENGTH];
  size_t public_key_len, private_key_len;
  if (!EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()) ||
      !EVP_HPKE_KEY_public_key(key.get(), public_key, &public_key_len,
                               sizeof(public_key)) ||
      !EVP_HPKE_KEY_private_key(key.get(), private_key, &private_key_len,
                                sizeof(private_key))) {
    fprintf(stderr, "Failed to generate the HPKE keypair\n");
    return false;
  }

  uint8_t *ech_config;
  size_t ech_config_len;
  if (!SSL_marshal_ech_config(
          &ech_config, &ech_config_len, static_cast<uint8_t>(config_id),
          key.get(), args_map["-public-name"].c_str(), size_t{max_name_len})) {
    fprintf(stderr, "Failed to serialize the ECHConfigList\n");
    return false;
  }
  bssl::UniquePtr<uint8_t> free_ech_config(ech_config);

  bssl::ScopedCBB cbb;
  CBB body;
  if (!CBB_init(cbb.get(), ech_config_len + sizeof(uint16_t)) ||
      !CBB_add_u16_length_prefixed(cbb.get(), &body) ||
      !CBB_add_bytes(&body, ech_config, ech_config_len) ||
      !CBB_flush(cbb.get())) {
    fprintf(stderr, "Failed to serialize the ECHConfigList\n");
    return false;
  }
  if (!WriteToFile(args_map["-out-ech-config-list"],
                   bssl::Span(CBB_data(cbb.get()), CBB_len(cbb.get()))) ||
      !WriteToFile(args_map["-out-ech-config"],
                   bssl::Span(ech_config, ech_config_len)) ||
      !WriteToFile(args_map["-out-private-key"],
                   bssl::Span(private_key, private_key_len))) {
    fprintf(stderr, "Failed to write ECHConfig or private key to file\n");
    return false;
  }
  return true;
}
