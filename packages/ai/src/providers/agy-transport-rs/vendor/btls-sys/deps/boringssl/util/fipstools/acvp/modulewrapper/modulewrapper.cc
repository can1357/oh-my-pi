// Copyright 2019 The BoringSSL Authors
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

#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include <assert.h>
#include <limits.h>
#include <string.h>
#include <unistd.h>
#include <cstdarg>

#include <openssl/aead.h>
#include <openssl/aes.h>
#include <openssl/bn.h>
#include <openssl/bytestring.h>
#include <openssl/cipher.h>
#include <openssl/cmac.h>
#include <openssl/ctrdrbg.h>
#include <openssl/dh.h>
#include <openssl/digest.h>
#include <openssl/ec.h>
#include <openssl/ec_key.h>
#include <openssl/ecdh.h>
#include <openssl/ecdsa.h>
#include <openssl/err.h>
#include <openssl/hkdf.h>
#include <openssl/hmac.h>
#include <openssl/obj.h>
#include <openssl/rsa.h>
#include <openssl/sha.h>
#include <openssl/span.h>

#include "../../../../crypto/fipsmodule/bcm_interface.h"
#include "../../../../crypto/fipsmodule/ec/internal.h"
#include "../../../../crypto/fipsmodule/rand/internal.h"
#include "../../../../crypto/fipsmodule/tls/internal.h"
#include "modulewrapper.h"


namespace bssl {
namespace acvp {

#if defined(OPENSSL_TRUSTY)
#include <trusty_log.h>
#define LOG_ERROR(...) TLOGE(__VA_ARGS__)
#define TLOG_TAG "modulewrapper"
#else
#define LOG_ERROR(...) fprintf(stderr, __VA_ARGS__)
#endif  // OPENSSL_TRUSTY

static bool GetConfig(const Span<const uint8_t> args[],
                      ReplyCallback write_reply) {
  static constexpr char kConfig[] =
      R"([
      {
        "algorithm": "acvptool",
        "features": ["batch"]
      },
      {
        "algorithm": "SHA2-224",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      },
      {
        "algorithm": "SHA2-256",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      },
      {
        "algorithm": "SHA2-384",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      },
      {
        "algorithm": "SHA2-512",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      },
      {
        "algorithm": "SHA2-512/256",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      },
      {
        "algorithm": "SHA-1",
        "revision": "1.0",
        "messageLength": [{
          "min": 0, "max": 65528, "increment": 8
        }]
      },
      {
        "algorithm": "ACVP-AES-ECB",
        "revision": "1.0",
        "direction": ["encrypt", "decrypt"],
        "keyLen": [128, 192, 256]
      },
      {
        "algorithm": "ACVP-AES-CTR",
        "revision": "1.0",
        "direction": ["encrypt", "decrypt"],
        "keyLen": [128, 192, 256],
        "payloadLen": [{
          "min": 8, "max": 128, "increment": 8
        }],
        "incrementalCounter": true,
        "overflowCounter": true,
        "performCounterTests": true
      },
      {
        "algorithm": "ACVP-AES-CBC",
        "revision": "1.0",
        "direction": ["encrypt", "decrypt"],
        "keyLen": [128, 192, 256]
      },
      {
        "algorithm": "ACVP-AES-GCM",
        "revision": "1.0",
        "direction": ["encrypt", "decrypt"],
        "keyLen": [128, 256],
        "payloadLen": [{
          "min": 0, "max": 65536, "increment": 8
        }],
        "aadLen": [{
          "min": 0, "max": 65536, "increment": 8
        }],
        "tagLen": [32, 64, 96, 104, 112, 120, 128],
        "ivLen": [96],
        "ivGen": "internal",
        "ivGenMode": "8.2.2"
      },
      {
        "algorithm": "ACVP-AES-GCM",
        "revision": "1.0",
        "direction": ["encrypt", "decrypt"],
        "keyLen": [128, 192, 256],
        "payloadLen": [{
          "min": 0, "max": 65536, "increment": 8
        }],
        "aadLen": [{
          "min": 0, "max": 65536, "increment": 8
        }],
        "tagLen": [32, 64, 96, 104, 112, 120, 128],
        "ivLen": [96],
        "ivGen": "external"
      },
      {
        "algorithm": "ACVP-AES-GMAC",
        "revision": "1.0",
        "direction": ["encrypt", "decrypt"],
        "keyLen": [128, 192, 256],
        "payloadLen": [{
          "min": 0, "max": 65536, "increment": 8
        }],
        "aadLen": [{
          "min": 0, "max": 65536, "increment": 8
        }],
        "tagLen": [32, 64, 96, 104, 112, 120, 128],
        "ivLen": [96],
        "ivGen": "external"
      },
      {
        "algorithm": "ACVP-AES-KW",
        "revision": "1.0",
        "direction": [
            "encrypt",
            "decrypt"
        ],
        "kwCipher": [
            "cipher"
        ],
        "keyLen": [
            128, 192, 256
        ],
        "payloadLen": [{"min": 128, "max": 4096, "increment": 64}]
      },
      {
        "algorithm": "ACVP-AES-KWP",
        "revision": "1.0",
        "direction": [
            "encrypt",
            "decrypt"
        ],
        "kwCipher": [
            "cipher"
        ],
        "keyLen": [
            128, 192, 256
        ],
        "payloadLen": [{"min": 8, "max": 4096, "increment": 8}]
      },
      {
        "algorithm": "ACVP-AES-CCM",
        "revision": "1.0",
        "direction": [
            "encrypt",
            "decrypt"
        ],
        "keyLen": [
            128
        ],
        "payloadLen": [{"min": 0, "max": 256, "increment": 8}],
        "ivLen": [104],
        "tagLen": [32, 64],
        "aadLen": [{"min": 0, "max": 524288, "increment": 8}]
      },
      {
        "algorithm": "HMAC-SHA-1",
        "revision": "1.0",
        "keyLen": [{
          "min": 8, "max": 524288, "increment": 8
        }],
        "macLen": [160]
      },
      {
        "algorithm": "HMAC-SHA2-224",
        "revision": "1.0",
        "keyLen": [{
          "min": 8, "max": 524288, "increment": 8
        }],
        "macLen": [224]
      },
      {
        "algorithm": "HMAC-SHA2-256",
        "revision": "1.0",
        "keyLen": [{
          "min": 8, "max": 524288, "increment": 8
        }],
        "macLen": [256]
      },
      {
        "algorithm": "HMAC-SHA2-384",
        "revision": "1.0",
        "keyLen": [{
          "min": 8, "max": 524288, "increment": 8
        }],
        "macLen": [384]
      },
      {
        "algorithm": "HMAC-SHA2-512",
        "revision": "1.0",
        "keyLen": [{
          "min": 8, "max": 524288, "increment": 8
        }],
        "macLen": [512]
      },
      {
        "algorithm": "HMAC-SHA2-512/256",
        "revision": "1.0",
        "keyLen": [{
          "min": 8, "max": 524288, "increment": 8
        }],
        "macLen": [256]
      },
      {
        "algorithm": "ctrDRBG",
        "revision": "1.0",
        "predResistanceEnabled": [false],
        "reseedImplemented": true,
        "capabilities": [{
          "mode": "AES-256",
          "derFuncEnabled": true,
          "entropyInputLen": [{"min": 256, "max": 512, "increment": 16}],
          "nonceLen": [128],
          "persoStringLen": [{"min": 0, "max": 384, "increment": 16}],
          "additionalInputLen": [
            {"min": 0, "max": 384, "increment": 16}
          ],
          "returnedBitsLen": 2048
        }, {
          "mode": "AES-256",
          "derFuncEnabled": false,
          "entropyInputLen": [384],
          "nonceLen": [0],
          "persoStringLen": [{"min": 0, "max": 384, "increment": 16}],
          "additionalInputLen": [
            {"min": 0, "max": 384, "increment": 16}
          ],
          "returnedBitsLen": 2048
        }]
      },
      {
        "algorithm": "ECDSA",
        "mode": "keyGen",
        "revision": "FIPS186-5",
        "curve": [
          "P-224",
          "P-256",
          "P-384",
          "P-521"
        ],
        "secretGenerationMode": [
          "testing candidates"
        ]
      },
      {
        "algorithm": "ECDSA",
        "mode": "keyVer",
        "revision": "FIPS186-5",
        "curve": [
          "P-224",
          "P-256",
          "P-384",
          "P-521"
        ]
      },
      {
        "algorithm": "ECDSA",
        "mode": "sigGen",
        "revision": "FIPS186-5",
        "capabilities": [{
          "curve": [
            "P-224",
            "P-256",
            "P-384",
            "P-521"
          ],
          "hashAlg": [
            "SHA2-224",
            "SHA2-256",
            "SHA2-384",
            "SHA2-512",
            "SHA2-512/256"
          ]
        }]
      },
      {
        "algorithm": "ECDSA",
        "mode": "sigVer",
        "revision": "FIPS186-5",
        "capabilities": [{
          "curve": [
            "P-224",
            "P-256",
            "P-384",
            "P-521"
          ],
          "hashAlg": [
            "SHA2-224",
            "SHA2-256",
            "SHA2-384",
            "SHA2-512",
            "SHA2-512/256"
          ]
        }]
      },
      {
        "algorithm": "RSA",
        "mode": "keyGen",
        "revision": "FIPS186-5",
        "infoGeneratedByServer": true,
        "pubExpMode": "fixed",
        "fixedPubExp": "010001",
        "keyFormat": "standard",
        "capabilities": [{
          "randPQ": "probable",
          "properties": [{
            "modulo": 2048,
            "primeTest": [
              "2powSecStr"
            ]
          },{
            "modulo": 3072,
            "primeTest": [
              "2powSecStr"
            ]
          },{
            "modulo": 4096,
            "primeTest": [
              "2powSecStr"
            ]
          }]
        }]
      },
      {
        "algorithm": "RSA",
        "mode": "sigGen",
        "revision": "FIPS186-5",
        "capabilities": [{
          "sigType": "pkcs1v1.5",
          "properties": [{
            "modulo": 2048,
            "hashPair": [{
              "hashAlg": "SHA2-224"
            }, {
              "hashAlg": "SHA2-256"
            }, {
              "hashAlg": "SHA2-384"
            }, {
              "hashAlg": "SHA2-512"
            }]
          }]
        },{
          "sigType": "pkcs1v1.5",
          "properties": [{
            "modulo": 3072,
            "hashPair": [{
              "hashAlg": "SHA2-224"
            }, {
              "hashAlg": "SHA2-256"
            }, {
              "hashAlg": "SHA2-384"
            }, {
              "hashAlg": "SHA2-512"
            }]
          }]
        },{
          "sigType": "pkcs1v1.5",
          "properties": [{
            "modulo": 4096,
            "hashPair": [{
              "hashAlg": "SHA2-224"
            }, {
              "hashAlg": "SHA2-256"
            }, {
              "hashAlg": "SHA2-384"
            }, {
              "hashAlg": "SHA2-512"
            }]
          }]
        },{
          "sigType": "pss",
          "properties": [{
            "maskFunction": ["mgf1"],
            "modulo": 2048,
            "hashPair": [{
              "hashAlg": "SHA2-224",
              "saltLen": 28
            }, {
              "hashAlg": "SHA2-256",
              "saltLen": 32
            }, {
              "hashAlg": "SHA2-384",
              "saltLen": 48
            }, {
              "hashAlg": "SHA2-512",
              "saltLen": 64
            }, {
              "hashAlg": "SHA2-512/256",
              "saltLen": 32
            }]
          }]
        },{
          "sigType": "pss",
          "properties": [{
            "maskFunction": ["mgf1"],
            "modulo": 3072,
            "hashPair": [{
              "hashAlg": "SHA2-224",
              "saltLen": 28
            }, {
              "hashAlg": "SHA2-256",
              "saltLen": 32
            }, {
              "hashAlg": "SHA2-384",
              "saltLen": 48
            }, {
              "hashAlg": "SHA2-512",
              "saltLen": 64
            }, {
              "hashAlg": "SHA2-512/256",
              "saltLen": 32
            }]
          }]
        },{
          "sigType": "pss",
          "properties": [{
            "maskFunction": ["mgf1"],
            "modulo": 4096,
            "hashPair": [{
              "hashAlg": "SHA2-224",
              "saltLen": 28
            }, {
              "hashAlg": "SHA2-256",
              "saltLen": 32
            }, {
              "hashAlg": "SHA2-384",
              "saltLen": 48
            }, {
              "hashAlg": "SHA2-512",
              "saltLen": 64
            }, {
              "hashAlg": "SHA2-512/256",
              "saltLen": 32
            }]
          }]
        }]
      },
      {
        "algorithm": "RSA",
        "mode": "sigVer",
        "revision": "FIPS186-5",
        "pubExpMode": "fixed",
        "fixedPubExp": "010001",
        "capabilities": [{
          "sigType": "pkcs1v1.5",
          "properties": [{
            "modulo": 2048,
            "hashPair": [{
              "hashAlg": "SHA2-224"
            }, {
              "hashAlg": "SHA2-256"
            }, {
              "hashAlg": "SHA2-384"
            }, {
              "hashAlg": "SHA2-512"
            }]
          }]
        },{
          "sigType": "pkcs1v1.5",
          "properties": [{
            "modulo": 3072,
            "hashPair": [{
              "hashAlg": "SHA2-224"
            }, {
              "hashAlg": "SHA2-256"
            }, {
              "hashAlg": "SHA2-384"
            }, {
              "hashAlg": "SHA2-512"
            }]
          }]
        },{
          "sigType": "pkcs1v1.5",
          "properties": [{
            "modulo": 4096,
            "hashPair": [{
              "hashAlg": "SHA2-224"
            }, {
              "hashAlg": "SHA2-256"
            }, {
              "hashAlg": "SHA2-384"
            }, {
              "hashAlg": "SHA2-512"
            }]
          }]
        },{
          "sigType": "pss",
          "properties": [{
            "maskFunction": ["mgf1"],
            "modulo": 2048,
            "hashPair": [{
              "hashAlg": "SHA2-224",
              "saltLen": 28
            }, {
              "hashAlg": "SHA2-256",
              "saltLen": 32
            }, {
              "hashAlg": "SHA2-384",
              "saltLen": 48
            }, {
              "hashAlg": "SHA2-512",
              "saltLen": 64
            }, {
              "hashAlg": "SHA2-512/256",
              "saltLen": 32
            }]
          }]
        },{
          "sigType": "pss",
          "properties": [{
            "maskFunction": ["mgf1"],
            "modulo": 3072,
            "hashPair": [{
              "hashAlg": "SHA2-224",
              "saltLen": 28
            }, {
              "hashAlg": "SHA2-256",
              "saltLen": 32
            }, {
              "hashAlg": "SHA2-384",
              "saltLen": 48
            }, {
              "hashAlg": "SHA2-512",
              "saltLen": 64
            }, {
              "hashAlg": "SHA2-512/256",
              "saltLen": 32
            }]
          }]
        },{
          "sigType": "pss",
          "properties": [{
            "maskFunction": ["mgf1"],
            "modulo": 4096,
            "hashPair": [{
              "hashAlg": "SHA2-224",
              "saltLen": 28
            }, {
              "hashAlg": "SHA2-256",
              "saltLen": 32
            }, {
              "hashAlg": "SHA2-384",
              "saltLen": 48
            }, {
              "hashAlg": "SHA2-512",
              "saltLen": 64
            }, {
              "hashAlg": "SHA2-512/256",
              "saltLen": 32
            }]
          }]
        }]
      },
      {
        "algorithm": "CMAC-AES",
        "acvptoolTestOnly": true,
        "revision": "1.0",
        "capabilities": [{
          "direction": ["gen", "ver"],
          "msgLen": [{
            "min": 0,
            "max": 524288,
            "increment": 8
          }],
          "keyLen": [128, 256],
          "macLen": [128]
        }]
      },
      {
        "algorithm": "KAS-ECC-SSC",
        "revision": "Sp800-56Ar3",
        "scheme": {
          "ephemeralUnified": {
            "kasRole": [
              "initiator",
              "responder"
            ]
          },
          "staticUnified": {
            "kasRole": [
              "initiator",
              "responder"
            ]
          }
        },
        "domainParameterGenerationMethods": [
          "P-224",
          "P-256",
          "P-384",
          "P-521"
        ]
      },
      {
        "algorithm": "KAS-FFC-SSC",
        "revision": "Sp800-56Ar3",
        "scheme": {
          "dhEphem": {
            "kasRole": [
              "initiator"
            ]
          }
        },
        "domainParameterGenerationMethods": [
          "FB",
          "FC"
        ]
      },
      {
        "algorithm": "KDA",
        "mode": "HKDF",
        "revision": "Sp800-56Cr1",
        "fixedInfoPattern": "uPartyInfo||vPartyInfo",
        "encoding": [
          "concatenation"
        ],
        "hmacAlg": [
          "SHA2-224",
          "SHA2-256",
          "SHA2-384",
          "SHA2-512",
          "SHA2-512/256"
        ],
        "macSaltMethods": [
          "default",
          "random"
        ],
        "l": 2048,
        "z": [
          {
            "min": 224,
            "max": 65336,
            "increment": 8
          }
        ]
      },
      {
        "algorithm": "TLS-v1.2",
        "mode": "KDF",
        "revision": "RFC7627",
        "hashAlg": [
          "SHA2-256",
          "SHA2-384",
          "SHA2-512"
        ]
      },
      {
        "algorithm": "TLS-v1.3",
        "mode": "KDF",
        "revision": "RFC8446",
        "hmacAlg": [
          "SHA2-256",
          "SHA2-384"
        ],
        "runningMode": [
          "DHE",
          "PSK",
          "PSK-DHE"
        ]
      },
      {
        "algorithm": "ML-DSA",
        "mode": "keyGen",
        "revision": "FIPS204",
        "parameterSets": [
          "ML-DSA-44",
          "ML-DSA-65",
          "ML-DSA-87"
        ]
      },
      {
        "algorithm": "ML-DSA",
        "mode": "sigGen",
        "revision": "FIPS204",
        "signatureInterfaces": ["internal"],
        "deterministic": [
          true,
          false
        ],
        "externalMu": [
          false
        ],
        "capabilities": [{
          "parameterSets": [
            "ML-DSA-44",
            "ML-DSA-65",
            "ML-DSA-87"
          ],
          "messageLength": [{
            "min": 8,
            "max": 65536,
            "increment": 8
          }]
        }]
      },
      {
        "algorithm": "ML-DSA",
        "mode": "sigVer",
        "revision": "FIPS204",
        "signatureInterfaces": ["internal"],
        "capabilities": [{
          "messageLength": [{
            "min": 8,
            "max": 65536,
            "increment": 8
          }],
          "parameterSets": [
            "ML-DSA-44",
            "ML-DSA-65",
            "ML-DSA-87"
          ]
        }]
      },
      {
        "algorithm": "ML-KEM",
        "mode": "keyGen",
        "revision": "FIPS203",
        "parameterSets": [
          "ML-KEM-768",
          "ML-KEM-1024"
        ]
      },
      {
        "algorithm": "ML-KEM",
        "mode": "encapDecap",
        "revision": "FIPS203",
        "parameterSets": [
          "ML-KEM-768",
          "ML-KEM-1024"
        ],
        "functions": [
          "encapsulation",
          "decapsulation"
        ]
      },
      {
        "algorithm": "SLH-DSA",
        "mode": "keyGen",
        "revision": "FIPS205",
        "parameterSets": [
          "SLH-DSA-SHA2-128s"
        ]
      },
      {
        "algorithm": "SLH-DSA",
        "mode": "sigGen",
        "revision": "FIPS205",
        "deterministic": [
          true,
          false
        ],
        "signatureInterfaces": [ "internal" ],
        "capabilities": [
          {
            "parameterSets": [
              "SLH-DSA-SHA2-128s"
            ],
            "messageLength": [
              {
                "min": 8,
                "max": 65536,
                "increment": 8
              }
            ]
          }
        ]
      },
      {
        "algorithm": "SLH-DSA",
        "mode": "sigVer",
        "revision": "FIPS205",
        "signatureInterfaces": [ "internal" ],
        "deterministic": [
          true,
          false
        ],
        "capabilities": [
          {
            "parameterSets": [
              "SLH-DSA-SHA2-128s"
            ],
            "messageLength": [
              {
                "min": 8,
                "max": 65536,
                "increment": 8
              }
            ]
          }
        ]
      }
    ])";
  return write_reply({bssl::StringAsBytes(kConfig)});
}

static bool Flush(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  fprintf(
      stderr,
      "modulewrapper code processed a `flush` command but this must be handled "
      "at a higher-level. See the example in main.cc in BoringSSL\n");
  abort();
}

template <uint8_t *(*OneShotHash)(const uint8_t *, size_t, uint8_t *),
          size_t DigestLength>
static bool Hash(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  uint8_t digest[DigestLength];
  OneShotHash(args[0].data(), args[0].size(), digest);
  return write_reply({MakeConstSpan(digest)});
}

template <uint8_t *(*OneShotHash)(const uint8_t *, size_t, uint8_t *),
          size_t DigestLength>
static bool HashMCT(const Span<const uint8_t> args[],
                    ReplyCallback write_reply) {
  if (args[0].size() != DigestLength) {
    return false;
  }

  uint8_t buf[DigestLength * 3];
  memcpy(buf, args[0].data(), DigestLength);
  memcpy(buf + DigestLength, args[0].data(), DigestLength);
  memcpy(buf + 2 * DigestLength, args[0].data(), DigestLength);

  for (size_t i = 0; i < 1000; i++) {
    uint8_t digest[DigestLength];
    OneShotHash(buf, sizeof(buf), digest);
    memmove(buf, buf + DigestLength, DigestLength * 2);
    memcpy(buf + DigestLength * 2, digest, DigestLength);
  }

  return write_reply({Span(buf).subspan(2 * DigestLength, DigestLength)});
}

static uint32_t GetIterations(const Span<const uint8_t> iterations_bytes) {
  uint32_t iterations;
  if (iterations_bytes.size() != sizeof(iterations)) {
    LOG_ERROR(
        "Expected %u-byte input for number of iterations, but found %u "
        "bytes.\n",
        static_cast<unsigned>(sizeof(iterations)),
        static_cast<unsigned>(iterations_bytes.size()));
    abort();
  }

  memcpy(&iterations, iterations_bytes.data(), sizeof(iterations));
  if (iterations == 0 || iterations == UINT32_MAX) {
    LOG_ERROR("Invalid number of iterations: %x.\n",
              static_cast<unsigned>(iterations));
    abort();
  }

  return iterations;
}

template <int (*SetKey)(const uint8_t *key, unsigned bits, AES_KEY *out),
          void (*Block)(const uint8_t *in, uint8_t *out, const AES_KEY *key)>
static bool AES(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  AES_KEY key;
  if (SetKey(args[0].data(), args[0].size() * 8, &key) != 0) {
    return false;
  }
  if (args[1].size() % AES_BLOCK_SIZE != 0) {
    return false;
  }
  std::vector<uint8_t> result(args[1].begin(), args[1].end());
  const uint32_t iterations = GetIterations(args[2]);

  std::vector<uint8_t> prev_result;
  for (uint32_t j = 0; j < iterations; j++) {
    if (j == iterations - 1) {
      prev_result = result;
    }

    for (size_t i = 0; i < args[1].size(); i += AES_BLOCK_SIZE) {
      Block(result.data() + i, result.data() + i, &key);
    }
  }

  return write_reply(
      {Span<const uint8_t>(result), Span<const uint8_t>(prev_result)});
}

template <int (*SetKey)(const uint8_t *key, unsigned bits, AES_KEY *out),
          int Direction>
static bool AES_CBC(const Span<const uint8_t> args[],
                    ReplyCallback write_reply) {
  AES_KEY key;
  if (SetKey(args[0].data(), args[0].size() * 8, &key) != 0) {
    return false;
  }
  if (args[1].size() % AES_BLOCK_SIZE != 0 || args[1].empty() ||
      args[2].size() != AES_BLOCK_SIZE) {
    return false;
  }
  std::vector<uint8_t> input(args[1].begin(), args[1].end());
  std::vector<uint8_t> iv(args[2].begin(), args[2].end());
  const uint32_t iterations = GetIterations(args[3]);

  std::vector<uint8_t> result(input.size());
  std::vector<uint8_t> prev_result, prev_input;

  for (uint32_t j = 0; j < iterations; j++) {
    prev_result = result;
    if (j > 0) {
      if (Direction == AES_ENCRYPT) {
        iv = result;
      } else {
        iv = prev_input;
      }
    }

    // AES_cbc_encrypt will mutate the given IV, but we need it later.
    uint8_t iv_copy[AES_BLOCK_SIZE];
    memcpy(iv_copy, iv.data(), sizeof(iv_copy));
    AES_cbc_encrypt(input.data(), result.data(), input.size(), &key, iv_copy,
                    Direction);

    if (Direction == AES_DECRYPT) {
      prev_input = input;
    }

    if (j == 0) {
      input = iv;
    } else {
      input = prev_result;
    }
  }

  return write_reply(
      {Span<const uint8_t>(result), Span<const uint8_t>(prev_result)});
}

static bool AES_CTR(const Span<const uint8_t> args[],
                    ReplyCallback write_reply) {
  static const uint32_t kOneIteration = 1;
  if (args[3].size() != sizeof(kOneIteration) ||
      memcmp(args[3].data(), &kOneIteration, sizeof(kOneIteration))) {
    LOG_ERROR("Only a single iteration supported with AES-CTR\n");
    return false;
  }

  AES_KEY key;
  if (AES_set_encrypt_key(args[0].data(), args[0].size() * 8, &key) != 0) {
    return false;
  }
  if (args[2].size() != AES_BLOCK_SIZE) {
    return false;
  }
  uint8_t iv[AES_BLOCK_SIZE];
  memcpy(iv, args[2].data(), AES_BLOCK_SIZE);
  if (GetIterations(args[3]) != 1) {
    LOG_ERROR("Multiple iterations of AES-CTR is not supported.\n");
    return false;
  }

  std::vector<uint8_t> out;
  out.resize(args[1].size());
  unsigned num = 0;
  uint8_t ecount_buf[AES_BLOCK_SIZE];
  AES_ctr128_encrypt(args[1].data(), out.data(), args[1].size(), &key, iv,
                     ecount_buf, &num);
  return write_reply({Span<const uint8_t>(out)});
}

static bool AESGCMSetup(EVP_AEAD_CTX *ctx, Span<const uint8_t> tag_len_span,
                        Span<const uint8_t> key) {
  if (tag_len_span.size() != sizeof(uint32_t)) {
    LOG_ERROR("Tag size value is %u bytes, not an uint32_t\n",
              static_cast<unsigned>(tag_len_span.size()));
    return false;
  }
  const uint32_t tag_len_32 = CRYPTO_load_u32_le(tag_len_span.data());

  const EVP_AEAD *aead;
  switch (key.size()) {
    case 16:
      aead = EVP_aead_aes_128_gcm();
      break;
    case 24:
      aead = EVP_aead_aes_192_gcm();
      break;
    case 32:
      aead = EVP_aead_aes_256_gcm();
      break;
    default:
      LOG_ERROR("Bad AES-GCM key length %u\n",
                static_cast<unsigned>(key.size()));
      return false;
  }

  if (!EVP_AEAD_CTX_init(ctx, aead, key.data(), key.size(), tag_len_32,
                         nullptr)) {
    LOG_ERROR("Failed to setup AES-GCM with tag length %u\n",
              static_cast<unsigned>(tag_len_32));
    return false;
  }

  return true;
}

static bool AESGCMRandNonceSetup(EVP_AEAD_CTX *ctx,
                                 Span<const uint8_t> tag_len_span,
                                 Span<const uint8_t> key) {
  if (tag_len_span.size() != sizeof(uint32_t)) {
    LOG_ERROR("Tag size value is %u bytes, not an uint32_t\n",
              static_cast<unsigned>(tag_len_span.size()));
    return false;
  }
  const uint32_t tag_len_32 = CRYPTO_load_u32_le(tag_len_span.data());

  const EVP_AEAD *aead;
  switch (key.size()) {
    case 16:
      aead = EVP_aead_aes_128_gcm_randnonce();
      break;
    case 32:
      aead = EVP_aead_aes_256_gcm_randnonce();
      break;
    default:
      LOG_ERROR("Bad AES-GCM key length %u\n",
                static_cast<unsigned>(key.size()));
      return false;
  }

  constexpr size_t kNonceLength = 12;
  if (!EVP_AEAD_CTX_init(ctx, aead, key.data(), key.size(),
                         tag_len_32 + kNonceLength, nullptr)) {
    LOG_ERROR("Failed to setup AES-GCM with tag length %u\n",
              static_cast<unsigned>(tag_len_32));
    return false;
  }

  return true;
}

static bool AESCCMSetup(EVP_AEAD_CTX *ctx, Span<const uint8_t> tag_len_span,
                        Span<const uint8_t> key) {
  uint32_t tag_len_32;
  if (tag_len_span.size() != sizeof(tag_len_32)) {
    LOG_ERROR("Tag size value is %u bytes, not an uint32_t\n",
              static_cast<unsigned>(tag_len_span.size()));
    return false;
  }
  memcpy(&tag_len_32, tag_len_span.data(), sizeof(tag_len_32));
  const EVP_AEAD *aead;
  switch (tag_len_32) {
    case 4:
      aead = EVP_aead_aes_128_ccm_bluetooth();
      break;

    case 8:
      aead = EVP_aead_aes_128_ccm_bluetooth_8();
      break;

    default:
      LOG_ERROR(
          "AES-CCM only supports 4- and 8-byte tags, but %u was requested\n",
          static_cast<unsigned>(tag_len_32));
      return false;
  }

  if (key.size() != 16) {
    LOG_ERROR("AES-CCM only supports 128-bit keys, but %u bits were given\n",
              static_cast<unsigned>(key.size() * 8));
    return false;
  }

  if (!EVP_AEAD_CTX_init(ctx, aead, key.data(), key.size(), tag_len_32,
                         nullptr)) {
    LOG_ERROR("Failed to setup AES-CCM with tag length %u\n",
              static_cast<unsigned>(tag_len_32));
    return false;
  }

  return true;
}

template <bool (*SetupFunc)(EVP_AEAD_CTX *ctx, Span<const uint8_t> tag_len_span,
                            Span<const uint8_t> key)>
static bool AEADSeal(const Span<const uint8_t> args[],
                     ReplyCallback write_reply) {
  Span<const uint8_t> tag_len_span = args[0];
  Span<const uint8_t> key = args[1];
  Span<const uint8_t> plaintext = args[2];
  Span<const uint8_t> nonce = args[3];
  Span<const uint8_t> ad = args[4];

  bssl::ScopedEVP_AEAD_CTX ctx;
  if (!SetupFunc(ctx.get(), tag_len_span, key)) {
    return false;
  }

  if (EVP_AEAD_MAX_OVERHEAD + plaintext.size() < EVP_AEAD_MAX_OVERHEAD) {
    return false;
  }
  std::vector<uint8_t> out(EVP_AEAD_MAX_OVERHEAD + plaintext.size());

  size_t out_len;
  if (!EVP_AEAD_CTX_seal(ctx.get(), out.data(), &out_len, out.size(),
                         nonce.data(), nonce.size(), plaintext.data(),
                         plaintext.size(), ad.data(), ad.size())) {
    return false;
  }

  out.resize(out_len);
  return write_reply({Span<const uint8_t>(out)});
}

template <bool (*SetupFunc)(EVP_AEAD_CTX *ctx, Span<const uint8_t> tag_len_span,
                            Span<const uint8_t> key)>
static bool AEADOpen(const Span<const uint8_t> args[],
                     ReplyCallback write_reply) {
  Span<const uint8_t> tag_len_span = args[0];
  Span<const uint8_t> key = args[1];
  Span<const uint8_t> ciphertext = args[2];
  Span<const uint8_t> nonce = args[3];
  Span<const uint8_t> ad = args[4];

  bssl::ScopedEVP_AEAD_CTX ctx;
  if (!SetupFunc(ctx.get(), tag_len_span, key)) {
    return false;
  }

  std::vector<uint8_t> out(ciphertext.size());
  size_t out_len;
  uint8_t success_flag[1] = {0};

  if (!EVP_AEAD_CTX_open(ctx.get(), out.data(), &out_len, out.size(),
                         nonce.data(), nonce.size(), ciphertext.data(),
                         ciphertext.size(), ad.data(), ad.size())) {
    return write_reply(
        {Span<const uint8_t>(success_flag), Span<const uint8_t>()});
  }

  out.resize(out_len);
  success_flag[0] = 1;
  return write_reply(
      {Span<const uint8_t>(success_flag), Span<const uint8_t>(out)});
}

static bool AESPaddedKeyWrapSetup(AES_KEY *out, bool decrypt,
                                  Span<const uint8_t> key) {
  if ((decrypt ? AES_set_decrypt_key : AES_set_encrypt_key)(
          key.data(), key.size() * 8, out) != 0) {
    LOG_ERROR("Invalid AES key length for AES-KW(P): %u\n",
              static_cast<unsigned>(key.size()));
    return false;
  }
  return true;
}

static bool AESKeyWrapSetup(AES_KEY *out, bool decrypt, Span<const uint8_t> key,
                            Span<const uint8_t> input) {
  if (!AESPaddedKeyWrapSetup(out, decrypt, key)) {
    return false;
  }

  if (input.size() % 8) {
    LOG_ERROR("Invalid AES-KW input length: %u\n",
              static_cast<unsigned>(input.size()));
    return false;
  }

  return true;
}

static bool AESKeyWrapSeal(const Span<const uint8_t> args[],
                           ReplyCallback write_reply) {
  Span<const uint8_t> key = args[1];
  Span<const uint8_t> plaintext = args[2];

  AES_KEY aes;
  if (!AESKeyWrapSetup(&aes, /*decrypt=*/false, key, plaintext) ||
      plaintext.size() > INT_MAX - 8) {
    return false;
  }

  std::vector<uint8_t> out(plaintext.size() + 8);
  if (AES_wrap_key(&aes, /*iv=*/nullptr, out.data(), plaintext.data(),
                   plaintext.size()) != static_cast<int>(out.size())) {
    LOG_ERROR("AES-KW failed\n");
    return false;
  }

  return write_reply({Span<const uint8_t>(out)});
}

static bool AESKeyWrapOpen(const Span<const uint8_t> args[],
                           ReplyCallback write_reply) {
  Span<const uint8_t> key = args[1];
  Span<const uint8_t> ciphertext = args[2];

  AES_KEY aes;
  if (!AESKeyWrapSetup(&aes, /*decrypt=*/true, key, ciphertext) ||
      ciphertext.size() < 8 || ciphertext.size() > INT_MAX) {
    return false;
  }

  std::vector<uint8_t> out(ciphertext.size() - 8);
  uint8_t success_flag[1] = {0};
  if (AES_unwrap_key(&aes, /*iv=*/nullptr, out.data(), ciphertext.data(),
                     ciphertext.size()) != static_cast<int>(out.size())) {
    return write_reply(
        {Span<const uint8_t>(success_flag), Span<const uint8_t>()});
  }

  success_flag[0] = 1;
  return write_reply(
      {Span<const uint8_t>(success_flag), Span<const uint8_t>(out)});
}

static bool AESPaddedKeyWrapSeal(const Span<const uint8_t> args[],
                                 ReplyCallback write_reply) {
  Span<const uint8_t> key = args[1];
  Span<const uint8_t> plaintext = args[2];

  AES_KEY aes;
  if (!AESPaddedKeyWrapSetup(&aes, /*decrypt=*/false, key) ||
      plaintext.size() + 15 < 15) {
    return false;
  }

  std::vector<uint8_t> out(plaintext.size() + 15);
  size_t out_len;
  if (!AES_wrap_key_padded(&aes, out.data(), &out_len, out.size(),
                           plaintext.data(), plaintext.size())) {
    LOG_ERROR("AES-KWP failed\n");
    return false;
  }

  out.resize(out_len);
  return write_reply({Span<const uint8_t>(out)});
}

static bool AESPaddedKeyWrapOpen(const Span<const uint8_t> args[],
                                 ReplyCallback write_reply) {
  Span<const uint8_t> key = args[1];
  Span<const uint8_t> ciphertext = args[2];

  AES_KEY aes;
  if (!AESPaddedKeyWrapSetup(&aes, /*decrypt=*/true, key) ||
      ciphertext.size() % 8) {
    return false;
  }

  std::vector<uint8_t> out(ciphertext.size());
  size_t out_len;
  uint8_t success_flag[1] = {0};
  if (!AES_unwrap_key_padded(&aes, out.data(), &out_len, out.size(),
                             ciphertext.data(), ciphertext.size())) {
    return write_reply(
        {Span<const uint8_t>(success_flag), Span<const uint8_t>()});
  }

  success_flag[0] = 1;
  out.resize(out_len);
  return write_reply(
      {Span<const uint8_t>(success_flag), Span<const uint8_t>(out)});
}

template <bool Encrypt>
static bool TDES(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  const EVP_CIPHER *cipher = EVP_des_ede3();

  if (args[0].size() != 24) {
    LOG_ERROR("Bad key length %u for 3DES.\n",
              static_cast<unsigned>(args[0].size()));
    return false;
  }
  bssl::ScopedEVP_CIPHER_CTX ctx;
  if (!EVP_CipherInit_ex(ctx.get(), cipher, nullptr, args[0].data(), nullptr,
                         Encrypt ? 1 : 0) ||
      !EVP_CIPHER_CTX_set_padding(ctx.get(), 0)) {
    return false;
  }

  if (args[1].size() % 8) {
    LOG_ERROR("Bad input length %u for 3DES.\n",
              static_cast<unsigned>(args[1].size()));
    return false;
  }
  std::vector<uint8_t> result(args[1].begin(), args[1].end());

  const uint32_t iterations = GetIterations(args[2]);
  std::vector<uint8_t> prev_result, prev_prev_result;

  for (uint32_t j = 0; j < iterations; j++) {
    if (j == iterations - 1) {
      prev_result = result;
    } else if (iterations >= 2 && j == iterations - 2) {
      prev_prev_result = result;
    }

    int out_len;
    if (!EVP_CipherUpdate(ctx.get(), result.data(), &out_len, result.data(),
                          result.size()) ||
        out_len != static_cast<int>(result.size())) {
      return false;
    }
  }

  return write_reply({Span<const uint8_t>(result),
                      Span<const uint8_t>(prev_result),
                      Span<const uint8_t>(prev_prev_result)});
}

template <bool Encrypt>
static bool TDES_CBC(const Span<const uint8_t> args[],
                     ReplyCallback write_reply) {
  const EVP_CIPHER *cipher = EVP_des_ede3_cbc();

  if (args[0].size() != 24) {
    LOG_ERROR("Bad key length %u for 3DES.\n",
              static_cast<unsigned>(args[0].size()));
    return false;
  }

  if (args[1].size() % 8 || args[1].size() == 0) {
    LOG_ERROR("Bad input length %u for 3DES.\n",
              static_cast<unsigned>(args[1].size()));
    return false;
  }
  std::vector<uint8_t> input(args[1].begin(), args[1].end());

  if (args[2].size() != EVP_CIPHER_iv_length(cipher)) {
    LOG_ERROR("Bad IV length %u for 3DES.\n",
              static_cast<unsigned>(args[2].size()));
    return false;
  }
  std::vector<uint8_t> iv(args[2].begin(), args[2].end());
  const uint32_t iterations = GetIterations(args[3]);

  std::vector<uint8_t> result(input.size());
  std::vector<uint8_t> prev_result, prev_prev_result;
  bssl::ScopedEVP_CIPHER_CTX ctx;
  if (!EVP_CipherInit_ex(ctx.get(), cipher, nullptr, args[0].data(), iv.data(),
                         Encrypt ? 1 : 0) ||
      !EVP_CIPHER_CTX_set_padding(ctx.get(), 0)) {
    return false;
  }

  for (uint32_t j = 0; j < iterations; j++) {
    prev_prev_result = prev_result;
    prev_result = result;

    int out_len, out_len2;
    if (!EVP_CipherInit_ex(ctx.get(), nullptr, nullptr, nullptr, iv.data(),
                           -1) ||
        !EVP_CipherUpdate(ctx.get(), result.data(), &out_len, input.data(),
                          input.size()) ||
        !EVP_CipherFinal_ex(ctx.get(), result.data() + out_len, &out_len2) ||
        (out_len + out_len2) != static_cast<int>(result.size())) {
      return false;
    }

    if (Encrypt) {
      if (j == 0) {
        input = iv;
      } else {
        input = prev_result;
      }
      iv = result;
    } else {
      iv = input;
      input = result;
    }
  }

  return write_reply({Span<const uint8_t>(result),
                      Span<const uint8_t>(prev_result),
                      Span<const uint8_t>(prev_prev_result)});
}

template <const EVP_MD *HashFunc()>
static bool HMAC(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  const EVP_MD *const md = HashFunc();
  uint8_t digest[EVP_MAX_MD_SIZE];
  unsigned digest_len;
  if (::HMAC(md, args[1].data(), args[1].size(), args[0].data(), args[0].size(),
             digest, &digest_len) == nullptr) {
    return false;
  }
  return write_reply({Span<const uint8_t>(digest, digest_len)});
}

template <const EVP_MD *HashFunc()>
static bool HKDF(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  const EVP_MD *const md = HashFunc();
  const auto key = args[0];
  const auto salt = args[1];
  const auto info = args[2];
  const auto out_len_bytes = args[3];

  if (out_len_bytes.size() != sizeof(uint32_t)) {
    return false;
  }
  const uint32_t out_len = CRYPTO_load_u32_le(out_len_bytes.data());
  if (out_len > (1 << 24)) {
    return false;
  }

  std::vector<uint8_t> out(out_len);
  if (!::HKDF(out.data(), out_len, md, key.data(), key.size(), salt.data(),
              salt.size(), info.data(), info.size())) {
    return false;
  }
  return write_reply({out});
}

template <const EVP_MD *HashFunc()>
static bool HKDFExtract(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  const EVP_MD *const md = HashFunc();
  const auto secret = args[0];
  const auto salt = args[1];

  std::vector<uint8_t> out(EVP_MD_size(md));
  size_t out_len;
  if (!HKDF_extract(out.data(), &out_len, md, secret.data(), secret.size(),
                    salt.data(), salt.size())) {
    return false;
  }
  assert(out_len == out.size());
  return write_reply({out});
}

template <const EVP_MD *HashFunc()>
static bool HKDFExpandLabel(const Span<const uint8_t> args[],
                            ReplyCallback write_reply) {
  const EVP_MD *const md = HashFunc();
  const auto out_len_bytes = args[0];
  const auto secret = args[1];
  const auto label = args[2];
  const auto hash = args[3];

  if (out_len_bytes.size() != sizeof(uint32_t)) {
    return false;
  }
  const uint32_t out_len = CRYPTO_load_u32_le(out_len_bytes.data());
  if (out_len > (1 << 24)) {
    return false;
  }

  std::vector<uint8_t> out(out_len);
  if (!CRYPTO_tls13_hkdf_expand_label(out.data(), out_len, md, secret.data(),
                                      secret.size(), label.data(), label.size(),
                                      hash.data(), hash.size())) {
    return false;
  }
  return write_reply({out});
}

template <bool WithReseed>
static bool DRBG(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  const auto out_len_bytes = args[0];
  const auto entropy = args[1];
  const auto personalisation = args[2];

  Span<const uint8_t> reseed_additional_data, reseed_entropy, additional_data1,
      additional_data2, nonce;
  if (!WithReseed) {
    additional_data1 = args[3];
    additional_data2 = args[4];
    nonce = args[5];
  } else {
    reseed_additional_data = args[3];
    reseed_entropy = args[4];
    additional_data1 = args[5];
    additional_data2 = args[6];
    nonce = args[7];
  }

  uint32_t out_len;
  if (out_len_bytes.size() != sizeof(out_len) ||
      entropy.size() < CTR_DRBG_MIN_ENTROPY_LEN ||
      entropy.size() > CTR_DRBG_MAX_ENTROPY_LEN ||
      (!reseed_entropy.empty() &&
       (reseed_entropy.size() < CTR_DRBG_MIN_ENTROPY_LEN ||
        reseed_entropy.size() > CTR_DRBG_MAX_ENTROPY_LEN)) ||
      (nonce.size() != CTR_DRBG_NONCE_LEN && nonce.size() != 0)) {
    return false;
  }
  memcpy(&out_len, out_len_bytes.data(), sizeof(out_len));
  if (out_len > (1 << 24)) {
    return false;
  }
  std::vector<uint8_t> out(out_len);

  CTR_DRBG_STATE drbg;
  if (!CTR_DRBG_init(&drbg, /*df=*/nonce.size() != 0, entropy.data(),
                     entropy.size(), nonce.empty() ? nullptr : nonce.data(),
                     personalisation.data(), personalisation.size()) ||
      (!reseed_entropy.empty() &&
       !CTR_DRBG_reseed_ex(&drbg, reseed_entropy.data(), reseed_entropy.size(),
                           reseed_additional_data.data(),
                           reseed_additional_data.size())) ||
      !CTR_DRBG_generate(&drbg, out.data(), out_len, additional_data1.data(),
                         additional_data1.size()) ||
      !CTR_DRBG_generate(&drbg, out.data(), out_len, additional_data2.data(),
                         additional_data2.size())) {
    return false;
  }

  return write_reply({Span<const uint8_t>(out)});
}

static bool StringEq(Span<const uint8_t> a, const char *b) {
  const size_t len = strlen(b);
  return a.size() == len && memcmp(a.data(), b, len) == 0;
}

static bssl::UniquePtr<EC_KEY> ECKeyFromName(Span<const uint8_t> name) {
  int nid;
  if (StringEq(name, "P-224")) {
    nid = NID_secp224r1;
  } else if (StringEq(name, "P-256")) {
    nid = NID_X9_62_prime256v1;
  } else if (StringEq(name, "P-384")) {
    nid = NID_secp384r1;
  } else if (StringEq(name, "P-521")) {
    nid = NID_secp521r1;
  } else {
    return nullptr;
  }

  return bssl::UniquePtr<EC_KEY>(EC_KEY_new_by_curve_name(nid));
}

static std::vector<uint8_t> BIGNUMBytes(const BIGNUM *bn) {
  const size_t len = BN_num_bytes(bn);
  std::vector<uint8_t> ret(len);
  BN_bn2bin(bn, ret.data());
  return ret;
}

static std::pair<std::vector<uint8_t>, std::vector<uint8_t>> GetPublicKeyBytes(
    const EC_KEY *key) {
  bssl::UniquePtr<BIGNUM> x(BN_new());
  bssl::UniquePtr<BIGNUM> y(BN_new());
  if (!EC_POINT_get_affine_coordinates_GFp(EC_KEY_get0_group(key),
                                           EC_KEY_get0_public_key(key), x.get(),
                                           y.get(), /*ctx=*/nullptr)) {
    abort();
  }

  std::vector<uint8_t> x_bytes = BIGNUMBytes(x.get());
  std::vector<uint8_t> y_bytes = BIGNUMBytes(y.get());

  return std::make_pair(std::move(x_bytes), std::move(y_bytes));
}

static bool ECDSAKeyGen(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  bssl::UniquePtr<EC_KEY> key = ECKeyFromName(args[0]);
  if (!key || !EC_KEY_generate_key_fips(key.get())) {
    return false;
  }

  const auto pub_key = GetPublicKeyBytes(key.get());
  std::vector<uint8_t> d_bytes =
      BIGNUMBytes(EC_KEY_get0_private_key(key.get()));

  return write_reply({Span<const uint8_t>(d_bytes),
                      Span<const uint8_t>(pub_key.first),
                      Span<const uint8_t>(pub_key.second)});
}

static bssl::UniquePtr<BIGNUM> BytesToBIGNUM(Span<const uint8_t> bytes) {
  bssl::UniquePtr<BIGNUM> bn(BN_new());
  BN_bin2bn(bytes.data(), bytes.size(), bn.get());
  return bn;
}

static bool ECDSAKeyVer(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  bssl::UniquePtr<EC_KEY> key = ECKeyFromName(args[0]);
  if (!key) {
    return false;
  }

  bssl::UniquePtr<BIGNUM> x(BytesToBIGNUM(args[1]));
  bssl::UniquePtr<BIGNUM> y(BytesToBIGNUM(args[2]));

  uint8_t reply[1];
  if (!EC_KEY_set_public_key_affine_coordinates(key.get(), x.get(), y.get()) ||
      !EC_KEY_check_fips(key.get())) {
    reply[0] = 0;
  } else {
    reply[0] = 1;
  }

  return write_reply({Span<const uint8_t>(reply)});
}

static const EVP_MD *HashFromName(Span<const uint8_t> name) {
  if (StringEq(name, "SHA-1")) {
    return EVP_sha1();
  } else if (StringEq(name, "SHA2-224")) {
    return EVP_sha224();
  } else if (StringEq(name, "SHA2-256")) {
    return EVP_sha256();
  } else if (StringEq(name, "SHA2-384")) {
    return EVP_sha384();
  } else if (StringEq(name, "SHA2-512")) {
    return EVP_sha512();
  } else if (StringEq(name, "SHA2-512/256")) {
    return EVP_sha512_256();
  } else {
    return nullptr;
  }
}

static bool ECDSASigGen(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  bssl::UniquePtr<EC_KEY> key = ECKeyFromName(args[0]);
  bssl::UniquePtr<BIGNUM> d = BytesToBIGNUM(args[1]);
  const EVP_MD *hash = HashFromName(args[2]);
  uint8_t digest[EVP_MAX_MD_SIZE];
  unsigned digest_len;
  if (!key || !hash ||
      !EVP_Digest(args[3].data(), args[3].size(), digest, &digest_len, hash,
                  /*impl=*/nullptr) ||
      !EC_KEY_set_private_key(key.get(), d.get())) {
    return false;
  }

  bssl::UniquePtr<ECDSA_SIG> sig(ECDSA_do_sign(digest, digest_len, key.get()));
  if (!sig) {
    return false;
  }

  std::vector<uint8_t> r_bytes(BIGNUMBytes(sig->r));
  std::vector<uint8_t> s_bytes(BIGNUMBytes(sig->s));

  return write_reply(
      {Span<const uint8_t>(r_bytes), Span<const uint8_t>(s_bytes)});
}

static bool ECDSASigVer(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  bssl::UniquePtr<EC_KEY> key = ECKeyFromName(args[0]);
  const EVP_MD *hash = HashFromName(args[1]);
  auto msg = args[2];
  bssl::UniquePtr<BIGNUM> x(BytesToBIGNUM(args[3]));
  bssl::UniquePtr<BIGNUM> y(BytesToBIGNUM(args[4]));
  bssl::UniquePtr<BIGNUM> r(BytesToBIGNUM(args[5]));
  bssl::UniquePtr<BIGNUM> s(BytesToBIGNUM(args[6]));
  ECDSA_SIG sig;
  sig.r = r.get();
  sig.s = s.get();

  uint8_t digest[EVP_MAX_MD_SIZE];
  unsigned digest_len;
  if (!key || !hash ||
      !EVP_Digest(msg.data(), msg.size(), digest, &digest_len, hash,
                  /*impl=*/nullptr)) {
    return false;
  }

  uint8_t reply[1];
  if (!EC_KEY_set_public_key_affine_coordinates(key.get(), x.get(), y.get()) ||
      !EC_KEY_check_fips(key.get()) ||
      !ECDSA_do_verify(digest, digest_len, &sig, key.get())) {
    reply[0] = 0;
  } else {
    reply[0] = 1;
  }

  return write_reply({Span<const uint8_t>(reply)});
}

static bool CMAC_AES(const Span<const uint8_t> args[],
                     ReplyCallback write_reply) {
  uint8_t mac[16];
  if (!AES_CMAC(mac, args[1].data(), args[1].size(), args[2].data(),
                args[2].size())) {
    return false;
  }

  uint32_t mac_len;
  if (args[0].size() != sizeof(mac_len)) {
    return false;
  }
  memcpy(&mac_len, args[0].data(), sizeof(mac_len));
  if (mac_len != sizeof(mac)) {
    return false;
  }

  return write_reply({Span<const uint8_t>(mac, sizeof(mac))});
}

static bool CMAC_AESVerify(const Span<const uint8_t> args[],
                           ReplyCallback write_reply) {
  // This function is just for testing since libcrypto doesn't do the
  // verification itself. The regcap doesn't advertise "ver" support.
  uint8_t mac[16];
  if (!AES_CMAC(mac, args[0].data(), args[0].size(), args[1].data(),
                args[1].size()) ||
      args[2].size() > sizeof(mac)) {
    return false;
  }

  const uint8_t ok = (OPENSSL_memcmp(mac, args[2].data(), args[2].size()) == 0);
  return write_reply({Span<const uint8_t>(&ok, sizeof(ok))});
}

static std::map<unsigned, bssl::UniquePtr<RSA>> &CachedRSAKeys() {
  static std::map<unsigned, bssl::UniquePtr<RSA>> keys;
  return keys;
}

static RSA *GetRSAKey(unsigned bits) {
  auto it = CachedRSAKeys().find(bits);
  if (it != CachedRSAKeys().end()) {
    return it->second.get();
  }

  bssl::UniquePtr<RSA> key(RSA_new());
  if (!RSA_generate_key_fips(key.get(), bits, nullptr)) {
    abort();
  }

  RSA *const ret = key.get();
  CachedRSAKeys().emplace(static_cast<unsigned>(bits), std::move(key));

  return ret;
}

static bool RSAKeyGen(const Span<const uint8_t> args[],
                      ReplyCallback write_reply) {
  uint32_t bits;
  if (args[0].size() != sizeof(bits)) {
    return false;
  }
  memcpy(&bits, args[0].data(), sizeof(bits));

  bssl::UniquePtr<RSA> key(RSA_new());
  if (!RSA_generate_key_fips(key.get(), bits, nullptr)) {
    LOG_ERROR("RSA_generate_key_fips failed for modulus length %u.\n", bits);
    return false;
  }

  const BIGNUM *n, *e, *d, *p, *q;
  RSA_get0_key(key.get(), &n, &e, &d);
  RSA_get0_factors(key.get(), &p, &q);

  if (!write_reply({BIGNUMBytes(e), BIGNUMBytes(p), BIGNUMBytes(q),
                    BIGNUMBytes(n), BIGNUMBytes(d)})) {
    return false;
  }

  CachedRSAKeys().emplace(static_cast<unsigned>(bits), std::move(key));
  return true;
}

template <const EVP_MD *(MDFunc)(), bool UsePSS>
static bool RSASigGen(const Span<const uint8_t> args[],
                      ReplyCallback write_reply) {
  uint32_t bits;
  if (args[0].size() != sizeof(bits)) {
    return false;
  }
  memcpy(&bits, args[0].data(), sizeof(bits));
  const Span<const uint8_t> msg = args[1];

  RSA *const key = GetRSAKey(bits);
  const EVP_MD *const md = MDFunc();
  uint8_t digest_buf[EVP_MAX_MD_SIZE];
  unsigned digest_len;
  if (!EVP_Digest(msg.data(), msg.size(), digest_buf, &digest_len, md, NULL)) {
    return false;
  }

  std::vector<uint8_t> sig(RSA_size(key));
  size_t sig_len;
  if (UsePSS) {
    if (!RSA_sign_pss_mgf1(key, &sig_len, sig.data(), sig.size(), digest_buf,
                           digest_len, md, md, RSA_PSS_SALTLEN_DIGEST)) {
      return false;
    }
  } else {
    unsigned sig_len_u;
    if (!RSA_sign(EVP_MD_type(md), digest_buf, digest_len, sig.data(),
                  &sig_len_u, key)) {
      return false;
    }
    sig_len = sig_len_u;
  }

  sig.resize(sig_len);

  return write_reply(
      {BIGNUMBytes(RSA_get0_n(key)), BIGNUMBytes(RSA_get0_e(key)), sig});
}

template <const EVP_MD *(MDFunc)(), bool UsePSS>
static bool RSASigVer(const Span<const uint8_t> args[],
                      ReplyCallback write_reply) {
  const Span<const uint8_t> n_bytes = args[0];
  const Span<const uint8_t> e_bytes = args[1];
  const Span<const uint8_t> msg = args[2];
  const Span<const uint8_t> sig = args[3];

  BIGNUM *n = BN_new();
  BIGNUM *e = BN_new();
  bssl::UniquePtr<RSA> key(RSA_new());
  if (!BN_bin2bn(n_bytes.data(), n_bytes.size(), n) ||
      !BN_bin2bn(e_bytes.data(), e_bytes.size(), e) ||
      !RSA_set0_key(key.get(), n, e, /*d=*/nullptr)) {
    return false;
  }

  const EVP_MD *const md = MDFunc();
  uint8_t digest_buf[EVP_MAX_MD_SIZE];
  unsigned digest_len;
  if (!EVP_Digest(msg.data(), msg.size(), digest_buf, &digest_len, md, NULL)) {
    return false;
  }

  uint8_t ok;
  if (UsePSS) {
    ok = RSA_verify_pss_mgf1(key.get(), digest_buf, digest_len, md, md,
                             RSA_PSS_SALTLEN_DIGEST, sig.data(), sig.size());
  } else {
    ok = RSA_verify(EVP_MD_type(md), digest_buf, digest_len, sig.data(),
                    sig.size(), key.get());
  }
  ERR_clear_error();

  return write_reply({Span<const uint8_t>(&ok, 1)});
}

template <const EVP_MD *(MDFunc)()>
static bool TLSKDF(const Span<const uint8_t> args[],
                   ReplyCallback write_reply) {
  const Span<const uint8_t> out_len_bytes = args[0];
  const Span<const uint8_t> secret = args[1];
  const std::string_view label = bssl::BytesAsStringView(args[2]);
  const Span<const uint8_t> seed1 = args[3];
  const Span<const uint8_t> seed2 = args[4];
  const EVP_MD *md = MDFunc();

  uint32_t out_len;
  if (out_len_bytes.size() != sizeof(out_len)) {
    return 0;
  }
  memcpy(&out_len, out_len_bytes.data(), sizeof(out_len));

  std::vector<uint8_t> out(size_t{out_len});
  if (!CRYPTO_tls1_prf(md, out.data(), out.size(), secret.data(), secret.size(),
                       label.data(), label.size(), seed1.data(), seed1.size(),
                       seed2.data(), seed2.size())) {
    return 0;
  }

  return write_reply({out});
}

template <int Nid>
static bool ECDH(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  bssl::UniquePtr<BIGNUM> their_x(BytesToBIGNUM(args[0]));
  bssl::UniquePtr<BIGNUM> their_y(BytesToBIGNUM(args[1]));
  const Span<const uint8_t> private_key = args[2];

  bssl::UniquePtr<EC_KEY> ec_key(EC_KEY_new_by_curve_name(Nid));
  bssl::UniquePtr<BN_CTX> ctx(BN_CTX_new());

  const EC_GROUP *const group = EC_KEY_get0_group(ec_key.get());
  bssl::UniquePtr<EC_POINT> their_point(EC_POINT_new(group));
  if (!EC_POINT_set_affine_coordinates_GFp(
          group, their_point.get(), their_x.get(), their_y.get(), ctx.get())) {
    LOG_ERROR("Invalid peer point for ECDH.\n");
    return false;
  }

  if (!private_key.empty()) {
    bssl::UniquePtr<BIGNUM> our_k(BytesToBIGNUM(private_key));
    if (!EC_KEY_set_private_key(ec_key.get(), our_k.get())) {
      LOG_ERROR("EC_KEY_set_private_key failed.\n");
      return false;
    }

    bssl::UniquePtr<EC_POINT> our_pub(EC_POINT_new(group));
    if (!EC_POINT_mul(group, our_pub.get(), our_k.get(), nullptr, nullptr,
                      ctx.get()) ||
        !EC_KEY_set_public_key(ec_key.get(), our_pub.get())) {
      LOG_ERROR("Calculating public key failed.\n");
      return false;
    }
  } else if (!EC_KEY_generate_key_fips(ec_key.get())) {
    LOG_ERROR("EC_KEY_generate_key_fips failed.\n");
    return false;
  }

  // The output buffer is one larger than |EC_MAX_BYTES| so that truncation
  // can be detected.
  std::vector<uint8_t> output(EC_MAX_BYTES + 1);
  const int out_len =
      ECDH_compute_key(output.data(), output.size(), their_point.get(),
                       ec_key.get(), /*kdf=*/nullptr);
  if (out_len < 0) {
    LOG_ERROR("ECDH_compute_key failed.\n");
    return false;
  } else if (static_cast<size_t>(out_len) == output.size()) {
    LOG_ERROR("ECDH_compute_key output may have been truncated.\n");
    return false;
  }
  output.resize(static_cast<size_t>(out_len));

  const EC_POINT *pub = EC_KEY_get0_public_key(ec_key.get());
  bssl::UniquePtr<BIGNUM> x(BN_new());
  bssl::UniquePtr<BIGNUM> y(BN_new());
  if (!EC_POINT_get_affine_coordinates_GFp(group, pub, x.get(), y.get(),
                                           ctx.get())) {
    LOG_ERROR("EC_POINT_get_affine_coordinates_GFp failed.\n");
    return false;
  }

  return write_reply({BIGNUMBytes(x.get()), BIGNUMBytes(y.get()), output});
}

static bool FFDH(const Span<const uint8_t> args[], ReplyCallback write_reply) {
  bssl::UniquePtr<BIGNUM> p(BytesToBIGNUM(args[0]));
  bssl::UniquePtr<BIGNUM> q(BytesToBIGNUM(args[1]));
  bssl::UniquePtr<BIGNUM> g(BytesToBIGNUM(args[2]));
  bssl::UniquePtr<BIGNUM> their_pub(BytesToBIGNUM(args[3]));
  const Span<const uint8_t> private_key_span = args[4];
  const Span<const uint8_t> public_key_span = args[5];

  bssl::UniquePtr<DH> dh(DH_new());
  if (!DH_set0_pqg(dh.get(), p.get(), q.get(), g.get())) {
    LOG_ERROR("DH_set0_pqg failed.\n");
    return 0;
  }

  // DH_set0_pqg took ownership of these values.
  p.release();
  q.release();
  g.release();

  if (!private_key_span.empty()) {
    bssl::UniquePtr<BIGNUM> private_key(BytesToBIGNUM(private_key_span));
    bssl::UniquePtr<BIGNUM> public_key(BytesToBIGNUM(public_key_span));

    if (!DH_set0_key(dh.get(), public_key.get(), private_key.get())) {
      LOG_ERROR("DH_set0_key failed.\n");
      return 0;
    }

    // DH_set0_key took ownership of these values.
    public_key.release();
    private_key.release();
  } else if (!DH_generate_key(dh.get())) {
    LOG_ERROR("DH_generate_key failed.\n");
    return false;
  }

  std::vector<uint8_t> z(DH_size(dh.get()));
  if (DH_compute_key_padded(z.data(), their_pub.get(), dh.get()) !=
      static_cast<int>(z.size())) {
    LOG_ERROR("DH_compute_key_hashed failed.\n");
    return false;
  }

  return write_reply({BIGNUMBytes(DH_get0_pub_key(dh.get())), z});
}

template <typename PrivateKey, size_t PublicKeyBytes,
          bcm_status (*KeyGen)(uint8_t *, PrivateKey *, const uint8_t *),
          bcm_status (*MarshalPrivateKey)(CBB *, const PrivateKey *)>
static bool MLDSAKeyGen(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  const Span<const uint8_t> seed = args[0];
  if (seed.size() != MLDSA_SEED_BYTES) {
    LOG_ERROR("Bad seed size.\n");
    return false;
  }

  auto priv = std::make_unique<PrivateKey>();
  uint8_t pub_key_bytes[PublicKeyBytes];
  if (KeyGen(pub_key_bytes, priv.get(), seed.data()) != bcm_status::approved) {
    LOG_ERROR("ML-DSA key gen failed.\n");
    return false;
  }

  ScopedCBB cbb;
  if (!CBB_init(cbb.get(), 1024) ||
      MarshalPrivateKey(cbb.get(), priv.get()) != bcm_status::approved ||
      !CBB_flush(cbb.get())) {
    LOG_ERROR("ML-DSA marshal failed.\n");
    return false;
  }

  return write_reply(
      {pub_key_bytes, Span(CBB_data(cbb.get()), CBB_len(cbb.get()))});
}

template <typename PrivateKey, size_t SignatureBytes,
          bcm_status (*ParsePrivateKey)(PrivateKey *, CBS *),
          bcm_status (*SignInternal)(uint8_t *, const PrivateKey *,
                                     const uint8_t *, size_t, const uint8_t *,
                                     size_t, const uint8_t *, size_t,
                                     const uint8_t *)>
static bool MLDSASigGen(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  CBS cbs = args[0];
  auto priv = std::make_unique<PrivateKey>();
  if (ParsePrivateKey(priv.get(), &cbs) != bcm_status::approved) {
    LOG_ERROR("Failed to parse ML-DSA private key.\n");
    return false;
  }

  const Span<const uint8_t> msg = args[1];
  const Span<const uint8_t> randomizer = args[2];

  if (randomizer.size() != BCM_MLDSA_SIGNATURE_RANDOMIZER_BYTES) {
    LOG_ERROR("Bad randomizer size.\n");
    return false;
  }

  uint8_t signature[SignatureBytes];
  if (SignInternal(signature, priv.get(), msg.data(), msg.size(),
                   // It's not just an empty context, the context prefix
                   // is omitted too.
                   nullptr, 0, nullptr, 0,
                   randomizer.data()) != bcm_status::approved) {
    LOG_ERROR("ML-DSA signing failed.\n");
    return false;
  }

  return write_reply({signature});
}

template <typename PublicKey, size_t SignatureBytes,
          bcm_status (*ParsePublicKey)(PublicKey *, CBS *),
          bcm_status (*VerifyInternal)(const PublicKey *, const uint8_t *,
                                       const uint8_t *, size_t, const uint8_t *,
                                       size_t, const uint8_t *, size_t)>
static bool MLDSASigVer(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  const Span<const uint8_t> pub_key_bytes = args[0];
  const Span<const uint8_t> msg = args[1];
  const Span<const uint8_t> signature = args[2];

  CBS cbs = pub_key_bytes;
  auto pub = std::make_unique<PublicKey>();
  if (ParsePublicKey(pub.get(), &cbs) != bcm_status::approved) {
    LOG_ERROR("Failed to parse ML-DSA public key.\n");
    return false;
  }

  if (signature.size() != SignatureBytes) {
    LOG_ERROR("Bad signature size.\n");
    return false;
  }

  const uint8_t ok = bcm_success(
      VerifyInternal(pub.get(), signature.data(), msg.data(), msg.size(),
                     // It's not just an empty context, the context
                     // prefix is omitted too.
                     nullptr, 0, nullptr, 0));

  return write_reply({Span<const uint8_t>(&ok, sizeof(ok))});
}

template <typename PrivateKey, size_t PublicKeyBytes,
          bcm_infallible (*KeyGen)(uint8_t *, PrivateKey *, const uint8_t *),
          bcm_status (*MarshalPrivate)(CBB *, const PrivateKey *)>
static bool MLKEMKeyGen(const Span<const uint8_t> args[],
                        ReplyCallback write_reply) {
  const Span<const uint8_t> seed = args[0];
  if (seed.size() != MLKEM_SEED_BYTES) {
    LOG_ERROR("Bad seed size.\n");
    return false;
  }

  auto priv = std::make_unique<PrivateKey>();
  uint8_t pub_key_bytes[PublicKeyBytes];
  KeyGen(pub_key_bytes, priv.get(), seed.data());

  ScopedCBB cbb;
  if (!CBB_init(cbb.get(), BCM_MLKEM768_PRIVATE_KEY_BYTES) ||
      !bcm_success(MarshalPrivate(cbb.get(), priv.get()))) {
    LOG_ERROR("Failed to serialize private key.\n");
    return false;
  }

  return write_reply(
      {pub_key_bytes, Span(CBB_data(cbb.get()), CBB_len(cbb.get()))});
}

template <typename PublicKey, bcm_status (*ParsePublic)(PublicKey *, CBS *),
          size_t CiphertextBytes,
          bcm_infallible (*Encap)(uint8_t *, uint8_t *, const PublicKey *,
                                  const uint8_t *)>
static bool MLKEMEncap(const Span<const uint8_t> args[],
                       ReplyCallback write_reply) {
  const Span<const uint8_t> pub_key_bytes = args[0];
  const Span<const uint8_t> entropy = args[1];

  if (entropy.size() != BCM_MLKEM_ENCAP_ENTROPY) {
    LOG_ERROR("Bad entropy size.\n");
    return false;
  }

  auto pub = std::make_unique<PublicKey>();
  CBS cbs = pub_key_bytes;
  if (!bcm_success(ParsePublic(pub.get(), &cbs)) || CBS_len(&cbs) != 0) {
    LOG_ERROR("Failed to parse public key.\n");
    return false;
  }

  uint8_t ciphertext[CiphertextBytes];
  uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
  Encap(ciphertext, shared_secret, pub.get(), entropy.data());

  return write_reply({ciphertext, shared_secret});
}

template <typename PrivateKey, bcm_status (*ParsePrivate)(PrivateKey *, CBS *),
          bcm_status (*Decap)(uint8_t *, const uint8_t *, size_t,
                              const PrivateKey *)>
static bool MLKEMDecap(const Span<const uint8_t> args[],
                       ReplyCallback write_reply) {
  const Span<const uint8_t> priv_key_bytes = args[0];
  const Span<const uint8_t> ciphertext = args[1];

  auto priv = std::make_unique<PrivateKey>();
  CBS cbs = priv_key_bytes;
  if (!bcm_success(ParsePrivate(priv.get(), &cbs))) {
    LOG_ERROR("Failed to parse private key.\n");
    return false;
  }

  uint8_t shared_secret[MLKEM_SHARED_SECRET_BYTES];
  if (!bcm_success(Decap(shared_secret, ciphertext.data(), ciphertext.size(),
                         priv.get()))) {
    LOG_ERROR("ML-KEM decapsulation failed.\n");
    return false;
  }

  return write_reply({shared_secret});
}

static bool SLHDSAKeyGen(const Span<const uint8_t> args[],
                         ReplyCallback write_reply) {
  const Span<const uint8_t> seed = args[0];

  if (seed.size() != 3 * BCM_SLHDSA_SHA2_128S_N) {
    LOG_ERROR("Bad seed size.\n");
    return false;
  }

  uint8_t public_key[BCM_SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES];
  uint8_t private_key[BCM_SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES];
  BCM_slhdsa_sha2_128s_generate_key_from_seed(public_key, private_key,
                                              seed.data());

  return write_reply({private_key, public_key});
}

static bool SLHDSASigGen(const Span<const uint8_t> args[],
                         ReplyCallback write_reply) {
  const Span<const uint8_t> private_key = args[0];
  const Span<const uint8_t> msg = args[1];
  const Span<const uint8_t> entropy_span = args[2];

  if (private_key.size() != BCM_SLHDSA_SHA2_128S_PRIVATE_KEY_BYTES) {
    LOG_ERROR("Bad private key size.\n");
    return false;
  }

  uint8_t entropy[BCM_SLHDSA_SHA2_128S_N];
  if (!entropy_span.empty()) {
    if (entropy_span.size() != BCM_SLHDSA_SHA2_128S_N) {
      LOG_ERROR("Bad entropy size.\n");
      return false;
    }
    memcpy(entropy, entropy_span.data(), entropy_span.size());
  } else {
    memcpy(entropy, private_key.data() + 32, 16);
  }

  uint8_t signature[BCM_SLHDSA_SHA2_128S_SIGNATURE_BYTES];
  BCM_slhdsa_sha2_128s_sign_internal(signature, private_key.data(), nullptr,
                                     nullptr, 0, msg.data(), msg.size(),
                                     entropy);

  return write_reply({signature});
}

static bool SLHDSASigVer(const Span<const uint8_t> args[],
                         ReplyCallback write_reply) {
  const Span<const uint8_t> public_key = args[0];
  const Span<const uint8_t> msg = args[1];
  const Span<const uint8_t> signature = args[2];

  if (public_key.size() != BCM_SLHDSA_SHA2_128S_PUBLIC_KEY_BYTES) {
    LOG_ERROR("Bad public key size.\n");
    return false;
  }

  const int ok = bcm_success(BCM_slhdsa_sha2_128s_verify_internal(
      signature.data(), signature.size(), public_key.data(), nullptr, nullptr,
      0, msg.data(), msg.size()));

  const uint8_t ok_byte = ok ? 1 : 0;
  return write_reply({Span<const uint8_t>(&ok_byte, 1)});
}

static constexpr struct {
  char name[kMaxNameLength + 1];
  uint8_t num_expected_args;
  bool (*handler)(const Span<const uint8_t> args[], ReplyCallback write_reply);
} kFunctions[] = {
    {"getConfig", 0, GetConfig},
    {"flush", 0, Flush},
    {"SHA-1", 1, Hash<SHA1, SHA_DIGEST_LENGTH>},
    {"SHA2-224", 1, Hash<SHA224, SHA224_DIGEST_LENGTH>},
    {"SHA2-256", 1, Hash<SHA256, SHA256_DIGEST_LENGTH>},
    {"SHA2-384", 1, Hash<SHA384, SHA384_DIGEST_LENGTH>},
    {"SHA2-512", 1, Hash<SHA512, SHA512_DIGEST_LENGTH>},
    {"SHA2-512/256", 1, Hash<SHA512_256, SHA512_256_DIGEST_LENGTH>},
    {"SHA-1/MCT", 1, HashMCT<SHA1, SHA_DIGEST_LENGTH>},
    {"SHA2-224/MCT", 1, HashMCT<SHA224, SHA224_DIGEST_LENGTH>},
    {"SHA2-256/MCT", 1, HashMCT<SHA256, SHA256_DIGEST_LENGTH>},
    {"SHA2-384/MCT", 1, HashMCT<SHA384, SHA384_DIGEST_LENGTH>},
    {"SHA2-512/MCT", 1, HashMCT<SHA512, SHA512_DIGEST_LENGTH>},
    {"SHA2-512/256/MCT", 1, HashMCT<SHA512_256, SHA512_256_DIGEST_LENGTH>},
    {"AES/encrypt", 3, AES<AES_set_encrypt_key, AES_encrypt>},
    {"AES/decrypt", 3, AES<AES_set_decrypt_key, AES_decrypt>},
    {"AES-CBC/encrypt", 4, AES_CBC<AES_set_encrypt_key, AES_ENCRYPT>},
    {"AES-CBC/decrypt", 4, AES_CBC<AES_set_decrypt_key, AES_DECRYPT>},
    {"AES-CTR/encrypt", 4, AES_CTR},
    {"AES-CTR/decrypt", 4, AES_CTR},
    {"AES-GCM/seal", 5, AEADSeal<AESGCMSetup>},
    {"AES-GCM/open", 5, AEADOpen<AESGCMSetup>},
    {"AES-GCM-randnonce/seal", 5, AEADSeal<AESGCMRandNonceSetup>},
    {"AES-GCM-randnonce/open", 5, AEADOpen<AESGCMRandNonceSetup>},
    {"AES-KW/seal", 5, AESKeyWrapSeal},
    {"AES-KW/open", 5, AESKeyWrapOpen},
    {"AES-KWP/seal", 5, AESPaddedKeyWrapSeal},
    {"AES-KWP/open", 5, AESPaddedKeyWrapOpen},
    {"AES-CCM/seal", 5, AEADSeal<AESCCMSetup>},
    {"AES-CCM/open", 5, AEADOpen<AESCCMSetup>},
    {"3DES-ECB/encrypt", 3, TDES<true>},
    {"3DES-ECB/decrypt", 3, TDES<false>},
    {"3DES-CBC/encrypt", 4, TDES_CBC<true>},
    {"3DES-CBC/decrypt", 4, TDES_CBC<false>},
    {"HKDF/SHA2-224", 4, HKDF<EVP_sha224>},
    {"HKDF/SHA2-256", 4, HKDF<EVP_sha256>},
    {"HKDF/SHA2-384", 4, HKDF<EVP_sha384>},
    {"HKDF/SHA2-512", 4, HKDF<EVP_sha512>},
    {"HKDF/SHA2-512/256", 4, HKDF<EVP_sha512_256>},
    {"HKDFExpandLabel/SHA2-256", 4, HKDFExpandLabel<EVP_sha256>},
    {"HKDFExpandLabel/SHA2-384", 4, HKDFExpandLabel<EVP_sha384>},
    {"HKDFExtract/SHA2-256", 2, HKDFExtract<EVP_sha256>},
    {"HKDFExtract/SHA2-384", 2, HKDFExtract<EVP_sha384>},
    {"HMAC-SHA-1", 2, HMAC<EVP_sha1>},
    {"HMAC-SHA2-224", 2, HMAC<EVP_sha224>},
    {"HMAC-SHA2-256", 2, HMAC<EVP_sha256>},
    {"HMAC-SHA2-384", 2, HMAC<EVP_sha384>},
    {"HMAC-SHA2-512", 2, HMAC<EVP_sha512>},
    {"HMAC-SHA2-512/256", 2, HMAC<EVP_sha512_256>},
    {"ctrDRBG/AES-256", 6, DRBG<false>},
    {"ctrDRBG-reseed/AES-256", 8, DRBG<true>},
    {"ECDSA/keyGen", 1, ECDSAKeyGen},
    {"ECDSA/keyVer", 3, ECDSAKeyVer},
    {"ECDSA/sigGen", 4, ECDSASigGen},
    {"ECDSA/sigVer", 7, ECDSASigVer},
    {"CMAC-AES", 3, CMAC_AES},
    {"CMAC-AES/verify", 3, CMAC_AESVerify},
    {"RSA/keyGen", 1, RSAKeyGen},
    {"RSA/sigGen/SHA2-224/pkcs1v1.5", 2, RSASigGen<EVP_sha224, false>},
    {"RSA/sigGen/SHA2-256/pkcs1v1.5", 2, RSASigGen<EVP_sha256, false>},
    {"RSA/sigGen/SHA2-384/pkcs1v1.5", 2, RSASigGen<EVP_sha384, false>},
    {"RSA/sigGen/SHA2-512/pkcs1v1.5", 2, RSASigGen<EVP_sha512, false>},
    {"RSA/sigGen/SHA-1/pkcs1v1.5", 2, RSASigGen<EVP_sha1, false>},
    {"RSA/sigGen/SHA2-224/pss", 2, RSASigGen<EVP_sha224, true>},
    {"RSA/sigGen/SHA2-256/pss", 2, RSASigGen<EVP_sha256, true>},
    {"RSA/sigGen/SHA2-384/pss", 2, RSASigGen<EVP_sha384, true>},
    {"RSA/sigGen/SHA2-512/pss", 2, RSASigGen<EVP_sha512, true>},
    {"RSA/sigGen/SHA2-512/256/pss", 2, RSASigGen<EVP_sha512_256, true>},
    {"RSA/sigGen/SHA-1/pss", 2, RSASigGen<EVP_sha1, true>},
    {"RSA/sigVer/SHA2-224/pkcs1v1.5", 4, RSASigVer<EVP_sha224, false>},
    {"RSA/sigVer/SHA2-256/pkcs1v1.5", 4, RSASigVer<EVP_sha256, false>},
    {"RSA/sigVer/SHA2-384/pkcs1v1.5", 4, RSASigVer<EVP_sha384, false>},
    {"RSA/sigVer/SHA2-512/pkcs1v1.5", 4, RSASigVer<EVP_sha512, false>},
    {"RSA/sigVer/SHA-1/pkcs1v1.5", 4, RSASigVer<EVP_sha1, false>},
    {"RSA/sigVer/SHA2-224/pss", 4, RSASigVer<EVP_sha224, true>},
    {"RSA/sigVer/SHA2-256/pss", 4, RSASigVer<EVP_sha256, true>},
    {"RSA/sigVer/SHA2-384/pss", 4, RSASigVer<EVP_sha384, true>},
    {"RSA/sigVer/SHA2-512/pss", 4, RSASigVer<EVP_sha512, true>},
    {"RSA/sigVer/SHA2-512/256/pss", 4, RSASigVer<EVP_sha512_256, true>},
    {"RSA/sigVer/SHA-1/pss", 4, RSASigVer<EVP_sha1, true>},
    {"TLSKDF/1.2/SHA2-256", 5, TLSKDF<EVP_sha256>},
    {"TLSKDF/1.2/SHA2-384", 5, TLSKDF<EVP_sha384>},
    {"TLSKDF/1.2/SHA2-512", 5, TLSKDF<EVP_sha512>},
    {"ECDH/P-224", 3, ECDH<NID_secp224r1>},
    {"ECDH/P-256", 3, ECDH<NID_X9_62_prime256v1>},
    {"ECDH/P-384", 3, ECDH<NID_secp384r1>},
    {"ECDH/P-521", 3, ECDH<NID_secp521r1>},
    {"FFDH", 6, FFDH},
    {"ML-DSA-44/keyGen", 1,
     MLDSAKeyGen<MLDSA44_private_key, MLDSA44_PUBLIC_KEY_BYTES,
                 BCM_mldsa44_generate_key_external_entropy_fips,
                 BCM_mldsa44_marshal_private_key>},
    {"ML-DSA-65/keyGen", 1,
     MLDSAKeyGen<MLDSA65_private_key, MLDSA65_PUBLIC_KEY_BYTES,
                 BCM_mldsa65_generate_key_external_entropy_fips,
                 BCM_mldsa65_marshal_private_key>},
    {"ML-DSA-87/keyGen", 1,
     MLDSAKeyGen<MLDSA87_private_key, MLDSA87_PUBLIC_KEY_BYTES,
                 BCM_mldsa87_generate_key_external_entropy_fips,
                 BCM_mldsa87_marshal_private_key>},
    {"ML-DSA-44/sigGen", 3,
     MLDSASigGen<MLDSA44_private_key, MLDSA44_SIGNATURE_BYTES,
                 BCM_mldsa44_parse_private_key, BCM_mldsa44_sign_internal>},
    {"ML-DSA-65/sigGen", 3,
     MLDSASigGen<MLDSA65_private_key, MLDSA65_SIGNATURE_BYTES,
                 BCM_mldsa65_parse_private_key, BCM_mldsa65_sign_internal>},
    {"ML-DSA-87/sigGen", 3,
     MLDSASigGen<MLDSA87_private_key, MLDSA87_SIGNATURE_BYTES,
                 BCM_mldsa87_parse_private_key, BCM_mldsa87_sign_internal>},
    {"ML-DSA-44/sigVer", 3,
     MLDSASigVer<MLDSA44_public_key, MLDSA44_SIGNATURE_BYTES,
                 BCM_mldsa44_parse_public_key, BCM_mldsa44_verify_internal>},
    {"ML-DSA-65/sigVer", 3,
     MLDSASigVer<MLDSA65_public_key, MLDSA65_SIGNATURE_BYTES,
                 BCM_mldsa65_parse_public_key, BCM_mldsa65_verify_internal>},
    {"ML-DSA-87/sigVer", 3,
     MLDSASigVer<MLDSA87_public_key, MLDSA87_SIGNATURE_BYTES,
                 BCM_mldsa87_parse_public_key, BCM_mldsa87_verify_internal>},
    {"ML-KEM-768/keyGen", 1,
     MLKEMKeyGen<MLKEM768_private_key, MLKEM768_PUBLIC_KEY_BYTES,
                 BCM_mlkem768_generate_key_external_seed,
                 BCM_mlkem768_marshal_private_key>},
    {"ML-KEM-1024/keyGen", 1,
     MLKEMKeyGen<MLKEM1024_private_key, MLKEM1024_PUBLIC_KEY_BYTES,
                 BCM_mlkem1024_generate_key_external_seed,
                 BCM_mlkem1024_marshal_private_key>},
    {"ML-KEM-768/encap", 2,
     MLKEMEncap<MLKEM768_public_key, BCM_mlkem768_parse_public_key,
                MLKEM768_CIPHERTEXT_BYTES,
                BCM_mlkem768_encap_external_entropy>},
    {"ML-KEM-1024/encap", 2,
     MLKEMEncap<MLKEM1024_public_key, BCM_mlkem1024_parse_public_key,
                MLKEM1024_CIPHERTEXT_BYTES,
                BCM_mlkem1024_encap_external_entropy>},
    {"ML-KEM-768/decap", 2,
     MLKEMDecap<MLKEM768_private_key, BCM_mlkem768_parse_private_key,
                BCM_mlkem768_decap>},
    {"ML-KEM-1024/decap", 2,
     MLKEMDecap<MLKEM1024_private_key, BCM_mlkem1024_parse_private_key,
                BCM_mlkem1024_decap>},
    {"SLH-DSA-SHA2-128s/keyGen", 1, SLHDSAKeyGen},
    {"SLH-DSA-SHA2-128s/sigGen", 3, SLHDSASigGen},
    {"SLH-DSA-SHA2-128s/sigVer", 3, SLHDSASigVer},
};

Handler FindHandler(Span<const Span<const uint8_t>> args) {
  auto algorithm = bssl::BytesAsStringView(args[0]);
  for (const auto &func : kFunctions) {
    if (algorithm == func.name) {
      if (args.size() - 1 != func.num_expected_args) {
        LOG_ERROR("\'%s\' operation received %zu arguments but expected %u.\n",
                  func.name, args.size() - 1, func.num_expected_args);
        return nullptr;
      }

      return func.handler;
    }
  }

  LOG_ERROR("Unknown operation: %s\n", std::string(algorithm).c_str());
  return nullptr;
}

}  // namespace acvp
}  // namespace bssl
