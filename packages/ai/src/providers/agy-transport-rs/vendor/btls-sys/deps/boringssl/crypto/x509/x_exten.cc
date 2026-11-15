// Copyright 2000-2016 The OpenSSL Project Authors. All Rights Reserved.
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

#include <openssl/asn1.h>
#include <openssl/asn1t.h>
#include <openssl/cipher.h>
#include <openssl/x509.h>

#include "internal.h"


ASN1_SEQUENCE(X509_EXTENSION) = {
    ASN1_SIMPLE(X509_EXTENSION, object, ASN1_OBJECT),
    ASN1_OPT(X509_EXTENSION, critical, ASN1_BOOLEAN),
    ASN1_SIMPLE(X509_EXTENSION, value, ASN1_OCTET_STRING),
} ASN1_SEQUENCE_END(X509_EXTENSION)

ASN1_ITEM_TEMPLATE(X509_EXTENSIONS) =
    ASN1_EX_TEMPLATE_TYPE(ASN1_TFLG_SEQUENCE_OF, 0, Extension, X509_EXTENSION)
ASN1_ITEM_TEMPLATE_END(X509_EXTENSIONS)

IMPLEMENT_ASN1_FUNCTIONS_const(X509_EXTENSION)
IMPLEMENT_ASN1_ENCODE_FUNCTIONS_const_fname(X509_EXTENSIONS, X509_EXTENSIONS,
                                            X509_EXTENSIONS)
IMPLEMENT_ASN1_DUP_FUNCTION_const(X509_EXTENSION)
