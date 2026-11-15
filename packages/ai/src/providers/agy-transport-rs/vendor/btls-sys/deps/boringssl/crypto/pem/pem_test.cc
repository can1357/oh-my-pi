// Copyright 2018 The BoringSSL Authors
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

#include <openssl/pem.h>

#include <functional>

#include <gtest/gtest.h>

#include <openssl/bio.h>
#include <openssl/cipher.h>
#include <openssl/err.h>
#include <openssl/rsa.h>

#include "../test/test_util.h"


namespace {

// Test that implausible ciphers, notably an IV-less RC4, aren't allowed in PEM.
// This is a regression test for https://github.com/openssl/openssl/issues/6347,
// though our fix differs from upstream.
TEST(PEMTest, NoRC4) {
  static const char kPEM[] =
      "-----BEGIN RSA PUBLIC KEY-----\n"
      "Proc-Type: 4,ENCRYPTED\n"
      "DEK-Info: RC4 -\n"
      "extra-info\n"
      "router-signature\n"
      "\n"
      "Z1w=\n"
      "-----END RSA PUBLIC KEY-----\n";
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(kPEM, sizeof(kPEM) - 1));
  ASSERT_TRUE(bio);
  bssl::UniquePtr<RSA> rsa(PEM_read_bio_RSAPublicKey(
      bio.get(), nullptr, nullptr, const_cast<char *>("password")));
  EXPECT_FALSE(rsa);
  EXPECT_TRUE(
      ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_UNSUPPORTED_ENCRYPTION));
}

static std::vector<uint8_t> DecodePEMBytes(const char *pem) {
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, -1));
  char *name, *header;
  uint8_t *data;
  long len;
  if (bio == nullptr ||  //
      !PEM_read_bio(bio.get(), &name, &header, &data, &len)) {
    return {};
  }
  bssl::UniquePtr<char> free_name(name), free_header(header);
  bssl::UniquePtr<uint8_t> free_data(data);
  return std::vector<uint8_t>(data, data + len);
}

TEST(PEMTest, DecryptPassword) {
  // A private key encrypted with the password "password", encrypted at the
  // PKCS#8 level.
  static const char kEncryptedPEM[] = R"(
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIHeMEkGCSqGSIb3DQEFDTA8MBsGCSqGSIb3DQEFDDAOBAjnhMUlb9deeQICCAAw
HQYJYIZIAWUDBAECBBAO8j5GA5VK8wjvNrzp/iVhBIGQyQKFfFKlFhxiDkFfyhUc
nPLr0eboQOz8eIaTW1Rblo/qDkQwNtONyfYn909SoIP7iU8UehcBG1UQe41WvQpu
yRKYQteoWSzFl+yzktL2Y/25K7Uc+f2NScjdonYMZ+9/m1HGmEzKO+Hz28cAsJL7
rH2gQ0lkxr1GtW77m2rfMKKuGYhpkgjWUbzJwP9v3iq+
-----END ENCRYPTED PRIVATE KEY-----
)";
  // The same key and password, but encrypted at the PEM level.
  static const char kEncryptedPEM2[] = R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C1123

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)";

  for (const char *pem : {kEncryptedPEM, kEncryptedPEM2}) {
    SCOPED_TRACE(pem);
    // Decrypt with the correct password.
    {
      bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, -1));
      ASSERT_TRUE(bio);
      bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_bio_PrivateKey(
          bio.get(), nullptr, nullptr, const_cast<char *>("password")));
      EXPECT_TRUE(pkey);
    }

    // Decrypt with the wrong password.
    {
      bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, -1));
      ASSERT_TRUE(bio);
      bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_bio_PrivateKey(
          bio.get(), nullptr, nullptr, const_cast<char *>("wrong")));
      EXPECT_FALSE(pkey);
      EXPECT_TRUE(
          ErrorEquals(ERR_peek_error(), ERR_LIB_CIPHER, CIPHER_R_BAD_DECRYPT));
      ERR_clear_error();
    }

    // If the caller did not pass in a password, we should not proceed to try to
    // decrypt.
    {
      bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, -1));
      ASSERT_TRUE(bio);
      bssl::UniquePtr<EVP_PKEY> pkey(
          PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr));
      EXPECT_FALSE(pkey);
      EXPECT_TRUE(
          ErrorEquals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_BAD_PASSWORD_READ));
      ERR_clear_error();
    }

    // If the password, with a NUL terminator, does not fit in the internal
    // buffer used by the PEM library, the PEM library should notice.
    {
      std::string too_long(PEM_BUFSIZE, 'a');
      bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, -1));
      ASSERT_TRUE(bio);
      bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_bio_PrivateKey(
          bio.get(), nullptr, nullptr, const_cast<char *>(too_long.c_str())));
      EXPECT_FALSE(pkey);
      EXPECT_TRUE(
          ErrorEquals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_BAD_PASSWORD_READ));
      ERR_clear_error();
    }
  }

  // |d2i_PKCS8PrivateKey_bio| should also be able to manage the password
  // callback correctly.
  std::vector<uint8_t> bytes = DecodePEMBytes(kEncryptedPEM);
  ASSERT_FALSE(bytes.empty());
  {
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(bytes.data(), bytes.size()));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<EVP_PKEY> pkey(d2i_PKCS8PrivateKey_bio(
        bio.get(), nullptr, nullptr, const_cast<char *>("password")));
    EXPECT_TRUE(pkey);
  }

  {
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(bytes.data(), bytes.size()));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<EVP_PKEY> pkey(
        d2i_PKCS8PrivateKey_bio(bio.get(), nullptr, nullptr, nullptr));
    EXPECT_FALSE(pkey);
    EXPECT_TRUE(
        ErrorEquals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_BAD_PASSWORD_READ));
    ERR_clear_error();
  }

  {
    std::string too_long(PEM_BUFSIZE, 'a');
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(bytes.data(), bytes.size()));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<EVP_PKEY> pkey(d2i_PKCS8PrivateKey_bio(
        bio.get(), nullptr, nullptr, const_cast<char *>(too_long.c_str())));
    EXPECT_FALSE(pkey);
    EXPECT_TRUE(
        ErrorEquals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_BAD_PASSWORD_READ));
    ERR_clear_error();
  }

  // A private key encrypted with the empty password, encrypted at the PKCS#8
  // level.
  static const char kEncryptedPEMEmpty[] = R"(
-----BEGIN ENCRYPTED PRIVATE KEY-----
MIH0MF8GCSqGSIb3DQEFDTBSMDEGCSqGSIb3DQEFDDAkBBAXiHC8iDcjzF0I+D2g
zJOcAgIIADAMBggqhkiG9w0CCQUAMB0GCWCGSAFlAwQBAgQQwupOMi8DtEWiuXt5
Odla9QSBkC37uJuG7HSCOyTVCEW76Kmf7GoH+Ou17bDAp6NGwm3KLxRfFoExki9g
hyLzdarBnhRbPqwMixhaQ2AtkpoSmjristGzZ9U7Y+TM3NnCA4+bu1TckdBn0g+Q
fvZI9eydS9buA0deGxCUytrMWrR3PxS1yoXBywMDJTom8u5hvvvkJ9WcNzUVRf0D
6z5NHHiXsQ==
-----END ENCRYPTED PRIVATE KEY-----
)";
  // THe same key and password, but encrypted at the PEM level.
  static const char kEncryptedPEMEmpty2[] = R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,A9505A7DD5C3B51D8AACED18F5758256

yfJKjep7Koj8hU/PtGC+NNXSNbItQ2zyeXDMVoazffraoDGMg6g1hFPPjg9reC+J
iQQIf9uACF27zi9fpWwbszszimrxl0u6n0ddBXizcK6xzkTvk3PZ67Vz1KYmotwC
XjgdgSEeixwKhDOuHKFdlFGP/7sw5GHlK3jPSpqi2gI=
-----END EC PRIVATE KEY-----
)";

  for (const char *pem : {kEncryptedPEMEmpty, kEncryptedPEMEmpty2}) {
    SCOPED_TRACE(pem);

    // The empty password should be correctly interpreted as a password.
    {
      bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, -1));
      ASSERT_TRUE(bio);
      bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_bio_PrivateKey(
          bio.get(), nullptr, nullptr, const_cast<char *>("")));
      EXPECT_TRUE(pkey);
    }
  }

  // |d2i_PKCS8PrivateKey_bio| should also be able to manage the password
  // callback correctly.
  bytes = DecodePEMBytes(kEncryptedPEMEmpty);
  {
    ASSERT_FALSE(bytes.empty());
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(bytes.data(), bytes.size()));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<EVP_PKEY> pkey(d2i_PKCS8PrivateKey_bio(
        bio.get(), nullptr, nullptr, const_cast<char *>("")));
    EXPECT_TRUE(pkey);
  }
}

TEST(PEMTest, EncryptPassword) {
  static const char kKey[] = R"(
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBw8IcnrUoEqc3VnJ
TYlodwi1b8ldMHcO6NHJzgqLtGqhRANCAATmK2niv2Wfl74vHg2UikzVl2u3qR4N
Rvvdqakendy6WgHn1peoChj5w8SjHlbifINI2xYaHPUdfvGULUvPciLB
-----END PRIVATE KEY-----
)";
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(kKey, -1));
  ASSERT_TRUE(bio);
  bssl::UniquePtr<EVP_PKEY> pkey(
      PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr));
  EXPECT_TRUE(pkey);

  // There are many ways to encrypt a PEM blob with a password.
  struct PasswordMethod {
    const char *name;
    std::function<bool(BIO *, const char *)> func;
    bool is_callback;
  };
  const PasswordMethod kPasswordMethods[] = {
      {"PKCS#8 encryption, password from param",
       [&](BIO *out, const char *pass) -> bool {
         return PEM_write_bio_PrivateKey(
             out, pkey.get(), EVP_aes_128_cbc(),
             reinterpret_cast<const unsigned char *>(pass),
             pass == nullptr ? 0 : strlen(pass), nullptr, nullptr);
       },
       /*is_callback=*/false},
      {"PKCS#8 encryption, password from callback",
       [&](BIO *out, const char *pass) -> bool {
         return PEM_write_bio_PrivateKey(out, pkey.get(), EVP_aes_128_cbc(),
                                         nullptr, 0, nullptr,
                                         const_cast<char *>(pass));
       },
       /*is_callback=*/true},
      {"PEM-level encryption, password from param",
       [&](BIO *out, const char *pass) -> bool {
         return PEM_write_bio_ECPrivateKey(
             out, EVP_PKEY_get0_EC_KEY(pkey.get()), EVP_aes_128_cbc(), nullptr,
             0, nullptr, const_cast<char *>(pass));
       },
       /*is_callback=*/false},
      {"PKCS#8 encryption, password from callback",
       [&](BIO *out, const char *pass) -> bool {
         return PEM_write_bio_ECPrivateKey(
             out, EVP_PKEY_get0_EC_KEY(pkey.get()), EVP_aes_128_cbc(), nullptr,
             0, nullptr, const_cast<char *>(pass));
       },
       /*is_callback=*/true},
  };
  for (const auto &p : kPasswordMethods) {
    SCOPED_TRACE(p.name);

    // Encrypting the private key with a password should work.
    bio.reset(BIO_new(BIO_s_mem()));
    ASSERT_TRUE(bio);
    ASSERT_TRUE(p.func(bio.get(), "password"));

    // Check we can decrypt it.
    bssl::UniquePtr<EVP_PKEY> pkey2(PEM_read_bio_PrivateKey(
        bio.get(), nullptr, nullptr, const_cast<char *>("password")));
    ASSERT_TRUE(pkey2);

    // The empty string is a valid password.
    bio.reset(BIO_new(BIO_s_mem()));
    ASSERT_TRUE(bio);
    ASSERT_TRUE(p.func(bio.get(), ""));

    // Check we can decrypt it.
    pkey2.reset(PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr,
                                        const_cast<char *>("")));
    ASSERT_TRUE(pkey2);

    // Check error-handling when the password is specified via the callback.
    if (p.is_callback) {
      bio.reset(BIO_new(BIO_s_mem()));
      ASSERT_TRUE(bio);
      EXPECT_FALSE(p.func(bio.get(), nullptr));
      EXPECT_TRUE(ErrorEquals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_READ_KEY));
      ERR_clear_error();

      std::string too_long(PEM_BUFSIZE, 'a');
      bio.reset(BIO_new(BIO_s_mem()));
      ASSERT_TRUE(bio);
      EXPECT_FALSE(p.func(bio.get(), too_long.c_str()));
      EXPECT_TRUE(ErrorEquals(ERR_peek_error(), ERR_LIB_PEM, PEM_R_READ_KEY));
      ERR_clear_error();
    }
  }
}

TEST(PEMTest, BadHeaders) {
  const struct {
    const char *pem;
    int err_lib, err_reason;
  } kTests[] = {
      // Proc-Type must be the first header.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C1123
Proc-Type: 4,ENCRYPTED

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_NOT_PROC_TYPE},
      // Unsupported Proc-Type version.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 5,ENCRYPTED
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C1123

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_UNSUPPORTED_PROC_TYPE_VERSION},
      // Unsupported Proc-Type version.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 42,ENCRYPTED
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C1123

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_UNSUPPORTED_PROC_TYPE_VERSION},
      // Unsupported Proc-Type.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,MIC-ONLY
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C1123

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_NOT_ENCRYPTED},
      // Missing DEK-Info.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_NOT_DEK_INFO},
      // Unsupported cipher.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-127-CBC,B3B2988AECAE6EAB0D043105994C1123

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_UNSUPPORTED_ENCRYPTION},
      // IV is not hex.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C112Z

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_BAD_IV_CHARS},
      // Truncated IV.
      {
          R"(
-----BEGIN EC PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
DEK-Info: AES-128-CBC,B3B2988AECAE6EAB0D043105994C112

RK7DUIGDHWTFh2rpTX+dR88hUyC1PyDlIULiNCkuWFwHrJbc1gM6hMVOKmU196XC
iITrIKmilFm9CPD6Tpfk/NhI/QPxyJlk1geIkxpvUZ2FCeMuYI1To14oYOUKv14q
wr6JtaX2G+pOmwcSPymZC4u2TncAP7KHgS8UGcMw8CE=
-----END EC PRIVATE KEY-----
)",
          ERR_LIB_PEM, PEM_R_BAD_IV_CHARS},
  };
  for (const auto &t : kTests) {
    SCOPED_TRACE(t.pem);
    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(t.pem, -1));
    ASSERT_TRUE(bio);
    bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_bio_PrivateKey(
        bio.get(), nullptr, nullptr, const_cast<char *>("password")));
    EXPECT_FALSE(pkey);
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), t.err_lib, t.err_reason));
    ERR_clear_error();
  }
}

}  // namespace
