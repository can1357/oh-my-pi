// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/bio.h>
#include <openssl/dh.h>
#include <openssl/dsa.h>
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/pkcs7.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>

static RSA *pkey_get_rsa(EVP_PKEY *key, RSA **rsa);
static DSA *pkey_get_dsa(EVP_PKEY *key, DSA **dsa);
static EC_KEY *pkey_get_eckey(EVP_PKEY *key, EC_KEY **eckey);

IMPLEMENT_PEM_rw(X509_REQ, X509_REQ, PEM_STRING_X509_REQ, X509_REQ)

IMPLEMENT_PEM_write(X509_REQ_NEW, X509_REQ, PEM_STRING_X509_REQ_OLD, X509_REQ)
IMPLEMENT_PEM_rw(X509_CRL, X509_CRL, PEM_STRING_X509_CRL, X509_CRL)
IMPLEMENT_PEM_rw(PKCS7, PKCS7, PEM_STRING_PKCS7, PKCS7)

// We treat RSA or DSA private keys as a special case. For private keys we
// read in an EVP_PKEY structure with PEM_read_bio_PrivateKey() and extract
// the relevant private key: this means can handle "traditional" and PKCS#8
// formats transparently.
static RSA *pkey_get_rsa(EVP_PKEY *key, RSA **rsa) {
  if (!key) {
    return nullptr;
  }
  if (EVP_PKEY_id(key) != EVP_PKEY_RSA) {
    // Don't accept RSA-PSS keys in this function.
    OPENSSL_PUT_ERROR(EVP, EVP_R_EXPECTING_AN_RSA_KEY);
    return nullptr;
  }
  RSA *rtmp = EVP_PKEY_get1_RSA(key);
  if (!rtmp) {
    return nullptr;
  }
  if (rsa) {
    RSA_free(*rsa);
    *rsa = rtmp;
  }
  return rtmp;
}

RSA *PEM_read_bio_RSAPrivateKey(BIO *bp, RSA **rsa, pem_password_cb *cb,
                                void *u) {
  bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_bio_PrivateKey(bp, nullptr, cb, u));
  return pkey_get_rsa(pkey.get(), rsa);
}

RSA *PEM_read_RSAPrivateKey(FILE *fp, RSA **rsa, pem_password_cb *cb, void *u) {
  bssl::UniquePtr<EVP_PKEY> pkey(PEM_read_PrivateKey(fp, nullptr, cb, u));
  return pkey_get_rsa(pkey.get(), rsa);
}

IMPLEMENT_PEM_write_cb_const(RSAPrivateKey, RSA, PEM_STRING_RSA, RSAPrivateKey)


IMPLEMENT_PEM_rw_const(RSAPublicKey, RSA, PEM_STRING_RSA_PUBLIC, RSAPublicKey)
IMPLEMENT_PEM_rw(RSA_PUBKEY, RSA, PEM_STRING_PUBLIC, RSA_PUBKEY)
#ifndef OPENSSL_NO_DSA
static DSA *pkey_get_dsa(EVP_PKEY *key, DSA **dsa) {
  DSA *dtmp;
  if (!key) {
    return nullptr;
  }
  dtmp = EVP_PKEY_get1_DSA(key);
  EVP_PKEY_free(key);
  if (!dtmp) {
    return nullptr;
  }
  if (dsa) {
    DSA_free(*dsa);
    *dsa = dtmp;
  }
  return dtmp;
}

DSA *PEM_read_bio_DSAPrivateKey(BIO *bp, DSA **dsa, pem_password_cb *cb,
                                void *u) {
  EVP_PKEY *pktmp;
  pktmp = PEM_read_bio_PrivateKey(bp, nullptr, cb, u);
  return pkey_get_dsa(pktmp, dsa);  // will free pktmp
}

IMPLEMENT_PEM_write_cb_const(DSAPrivateKey, DSA, PEM_STRING_DSA, DSAPrivateKey)

IMPLEMENT_PEM_rw(DSA_PUBKEY, DSA, PEM_STRING_PUBLIC, DSA_PUBKEY)
DSA *PEM_read_DSAPrivateKey(FILE *fp, DSA **dsa, pem_password_cb *cb, void *u) {
  EVP_PKEY *pktmp;
  pktmp = PEM_read_PrivateKey(fp, nullptr, cb, u);
  return pkey_get_dsa(pktmp, dsa);  // will free pktmp
}

IMPLEMENT_PEM_rw_const(DSAparams, DSA, PEM_STRING_DSAPARAMS, DSAparams)
#endif
static EC_KEY *pkey_get_eckey(EVP_PKEY *key, EC_KEY **eckey) {
  EC_KEY *dtmp;
  if (!key) {
    return nullptr;
  }
  dtmp = EVP_PKEY_get1_EC_KEY(key);
  EVP_PKEY_free(key);
  if (!dtmp) {
    return nullptr;
  }
  if (eckey) {
    EC_KEY_free(*eckey);
    *eckey = dtmp;
  }
  return dtmp;
}

EC_KEY *PEM_read_bio_ECPrivateKey(BIO *bp, EC_KEY **key, pem_password_cb *cb,
                                  void *u) {
  EVP_PKEY *pktmp;
  pktmp = PEM_read_bio_PrivateKey(bp, nullptr, cb, u);
  return pkey_get_eckey(pktmp, key);  // will free pktmp
}

IMPLEMENT_PEM_write_cb(ECPrivateKey, EC_KEY, PEM_STRING_ECPRIVATEKEY,
                       ECPrivateKey)

IMPLEMENT_PEM_rw(EC_PUBKEY, EC_KEY, PEM_STRING_PUBLIC, EC_PUBKEY)
EC_KEY *PEM_read_ECPrivateKey(FILE *fp, EC_KEY **eckey, pem_password_cb *cb,
                              void *u) {
  EVP_PKEY *pktmp;
  pktmp = PEM_read_PrivateKey(fp, nullptr, cb, u);
  return pkey_get_eckey(pktmp, eckey);  // will free pktmp
}


IMPLEMENT_PEM_rw_const(DHparams, DH, PEM_STRING_DHPARAMS, DHparams)

IMPLEMENT_PEM_rw(PUBKEY, EVP_PKEY, PEM_STRING_PUBLIC, PUBKEY)
