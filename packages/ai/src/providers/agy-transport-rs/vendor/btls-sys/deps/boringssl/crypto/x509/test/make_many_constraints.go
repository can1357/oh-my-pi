// Copyright 2017 The BoringSSL Authors
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

//go:build ignore

// make_many_constraints.go generates test certificates many_constraints.pem,
// many_names*.pem, and some_names*.pem for x509_test.cc
package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"time"
)

const privateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQC6C9qEGRIBQXV8
Lj29vVu+U+tyXzSSinWIumK5ijPhCm3DLnv4RayxkFwemtnkGRZ/o94ZnsXkBfU/
IlsYdkuq8wK9WI/ql3gwWjH+KARIhIQcSLGiJcLN6kGuG2nlRBKMcPgPiEq2B0yB
XFf4tG3CBbeae7+8G7uvOmv8NLyKj32neWpnUCTL5o2VwyPoxjLxT5gUR69v9XSV
Fj2irCZbsEedeKSb++LqyMhLfnRTzNv+ZHNh4izZHrktR25MvnT5QyBq32hx7AjZ
2/xo70OmH7w10a2DwsVjJNMdxTEmgyvU9M6CeYRPX1Ykfg+sXCTtkTVAlBDUviIq
Y95CKy25AgMBAAECggEAHPvvxRiqx2tNRFVn5QF1I4erbJwMcrADc5OmAcXYIz0e
sIOzaJBiQR9+Wn5BZ9nIuYXr+g3UQpvzAyz1CDCVxUIqsRj1AtUqMk4675+IW0vZ
0RY6Jkq/uJjANsGqk78xLJQE8VaIXSdx8c1THznsx4dgfT6+Ni4T5U6yuA33OZaw
4NdYZYtEkqNiqK6VYe4mAxxVh5qscihVVMGkBVqJNiiEotctm1lph8ow+7o8ggXO
W9xm+RHHPcH7Epx7hjkb/helANcYOK950W5/R+2zWV9R6kxo6R+/hfGFFmCvl4k5
+i8Y0IlEv3fze1E0Lwyf379i3C/cKcuaE5gwR54BAQKBgQDxlsNy9M37HgguglHt
8W+cuPNtxNjFCWIjNR9dSvdr1Oi28Z1AY+BBPSv6UBKnT5PpOFjqxfMY/j/zoKdI
aYX1phgeQHXcHrB1pS8yoaF/pTJSN2Yb8v9kl/Ch1yeYXaNVGmeBLkH9H6wIcUxD
Mas1i8VUzshzhcluCNGoJj9wUQKBgQDFJOoWncssfWCrsuDWEoeU71Zh3+bD96GF
s29CdIbHpcbxhWYjA9RM8yxbGPopexzoGcV1HX6j8E1s0xfYZJV23rxoM9Zj9l5D
mZAJQPxYXIdu3h4PslhZLd3p+DEHjbsLC/avk3M4iZim1FMPBJMswKSL23ysqXoY
/ynor+W06QKBgHYeu6M6NHgCYAe1ai+Hq4WaHFNgOohkJRqHv7USkVSkvb+s9LDl
5GChcx4pBmXNj8ko5rirXkerEEOjGgdaqMfJlOM9qyKb0rVCtYfw5RCPCcKPGZqy
vdJGQ74tf0uNBO34QgE0R8lmMevS0XHNGCPPGgV0MSfikvD82N15De1xAoGAbsZM
RsMJfAlDPZc4oPEuf/BwMHTYPTsy5map2MSTSzGKdQHJH1myfD6TqOiDALXtyzlX
63PUShfn2YNPvcbe+Tk00rR1/htcYk2yUpDSenAbpZ9ncth6rjmInURZgG4SMKXb
SlLnBljCjtN1jFW8wQPKMc/14SslsVAHY3ka8KkCgYB58QNT1YfH3jS62+mT2pXq
qLjLqvsD742VYnFoHR+HBOnN8ry0dda4lgwM106L5FgSg9DOZvASZ+QGFk+QVQv+
c77ASWpuhmBmamZCrwZXrq9Xc92RDPkKFqnP9MVv06hYKNp0moSdM8dIaM6uSows
/r/aDs4oudubz26o5GDKmA==
-----END PRIVATE KEY-----`

var privateKey *rsa.PrivateKey

func init() {
	in := []byte(privateKeyPEM)
	keyBlock, in := pem.Decode(in)
	if keyBlock == nil || keyBlock.Type != "PRIVATE KEY" {
		panic("could not decode private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		panic(err)
	}
	privateKey = key.(*rsa.PrivateKey)
}

func randOrDie(out []byte) {
	if _, err := rand.Reader.Read(out); err != nil {
		panic(err)
	}
}

func writePEM(path string, in []byte) {
	file, err := os.Create(path)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	err = pem.Encode(file, &pem.Block{Type: "CERTIFICATE", Bytes: in})
	if err != nil {
		panic(err)
	}
}

func main() {
	notBefore, err := time.Parse(time.RFC3339, "2000-01-01T00:00:00Z")
	if err != nil {
		panic(err)
	}
	notAfter, err := time.Parse(time.RFC3339, "2100-01-01T00:00:00Z")
	if err != nil {
		panic(err)
	}

	caTemplate := x509.Certificate{
		SerialNumber:          new(big.Int).SetInt64(1),
		Subject:               pkix.Name{CommonName: "CA"},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		BasicConstraintsValid: true,
		IsCA:                  true,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage:              x509.KeyUsageCertSign,
		SignatureAlgorithm:    x509.SHA256WithRSA,
	}
	for i := 0; i < 513; i++ {
		caTemplate.ExcludedDNSDomains = append(caTemplate.ExcludedDNSDomains, fmt.Sprintf("x%d.test", i))
	}
	for i := 0; i < 513; i++ {
		caTemplate.PermittedDNSDomains = append(caTemplate.PermittedDNSDomains, fmt.Sprintf("t%d.test", i))
	}
	caTemplate.PermittedDNSDomains = append(caTemplate.PermittedDNSDomains, ".test")
	caBytes, err := x509.CreateCertificate(rand.Reader, &caTemplate, &caTemplate, &privateKey.PublicKey, privateKey)
	if err != nil {
		panic(err)
	}
	writePEM("many_constraints.pem", caBytes)

	ca, err := x509.ParseCertificate(caBytes)
	if err != nil {
		panic(err)
	}

	leaves := []struct {
		path   string
		names  int
		emails int
	}{
		{"many_names1.pem", 513, 513},
		{"many_names2.pem", 1025, 0},
		{"many_names3.pem", 1, 1025},
		{"some_names1.pem", 256, 256},
		{"some_names2.pem", 513, 0},
		{"some_names3.pem", 1, 513},
	}
	for i, leaf := range leaves {
		leafTemplate := x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(int64(i + 2)),
			Subject:               pkix.Name{CommonName: "t0.test"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  false,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
			SignatureAlgorithm:    x509.SHA256WithRSA,
		}
		for i := 0; i < leaf.names; i++ {
			leafTemplate.DNSNames = append(leafTemplate.DNSNames, fmt.Sprintf("t%d.test", i))
		}
		for i := 0; i < leaf.emails; i++ {
			leafTemplate.Subject.ExtraNames = append(leafTemplate.Subject.ExtraNames, pkix.AttributeTypeAndValue{
				Type: []int{1, 2, 840, 113549, 1, 9, 1},
				Value: asn1.RawValue{
					Class:      asn1.ClassUniversal,
					Tag:        asn1.TagIA5String,
					IsCompound: false,
					Bytes:      []byte(fmt.Sprintf("t%d@test", i)),
				},
			})
		}
		leafBytes, err := x509.CreateCertificate(rand.Reader, &leafTemplate, ca, &privateKey.PublicKey, privateKey)
		if err != nil {
			panic(err)
		}

		writePEM(leaf.path, leafBytes)
	}
}
