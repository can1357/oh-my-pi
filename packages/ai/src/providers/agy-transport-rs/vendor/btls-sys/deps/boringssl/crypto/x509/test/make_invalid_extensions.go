// Copyright 2020 The BoringSSL Authors
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

// make_invalid_extensions.go generates a number of certificate chains with
// invalid extension encodings.
package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"time"
)

type extension struct {
	// The name of the extension, in a form suitable for including in a
	// filename.
	name string
	// The extension's OID.
	oid []int
}

var extensions = []extension{
	{name: "authority_key_identifier", oid: []int{2, 5, 29, 35}},
	{name: "basic_constraints", oid: []int{2, 5, 29, 19}},
	{name: "ext_key_usage", oid: []int{2, 5, 29, 37}},
	{name: "key_usage", oid: []int{2, 5, 29, 15}},
	{name: "name_constraints", oid: []int{2, 5, 29, 30}},
	{name: "subject_alt_name", oid: []int{2, 5, 29, 17}},
	{name: "subject_key_identifier", oid: []int{2, 5, 29, 14}},
}

var leafKey, intermediateKey, rootKey *ecdsa.PrivateKey

func init() {
	leafKey = mustParseECDSAKey(leafKeyPEM)
	intermediateKey = mustParseECDSAKey(intermediateKeyPEM)
	rootKey = mustParseECDSAKey(rootKeyPEM)
}

type templateAndKey struct {
	template x509.Certificate
	key      *ecdsa.PrivateKey
}

func mustGenerateCertificate(path string, subject, issuer *templateAndKey) []byte {
	cert, err := x509.CreateCertificate(rand.Reader, &subject.template, &issuer.template, &subject.key.PublicKey, issuer.key)
	if err != nil {
		panic(err)
	}
	file, err := os.Create(path)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	err = pem.Encode(file, &pem.Block{Type: "CERTIFICATE", Bytes: cert})
	if err != nil {
		panic(err)
	}
	return cert
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

	root := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(1),
			Subject:               pkix.Name{CommonName: "Invalid Extensions Root"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  true,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("root"),
		},
		key: rootKey,
	}
	intermediate := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(2),
			Subject:               pkix.Name{CommonName: "Invalid Extensions Intermediate"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  true,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("intermediate"),
		},
		key: intermediateKey,
	}
	leaf := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(3),
			Subject:               pkix.Name{CommonName: "www.example.com"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  false,
			ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			DNSNames:              []string{"www.example.com"},
			SubjectKeyId:          []byte("leaf"),
			PermittedDNSDomains:   []string{"www.example.com"},
		},
		key: leafKey,
	}

	// Generate a valid certificate chain from the templates.
	mustGenerateCertificate("invalid_extension_root.pem", &root, &root)
	mustGenerateCertificate("invalid_extension_intermediate.pem", &intermediate, &root)
	leafDER := mustGenerateCertificate("invalid_extension_leaf.pem", &leaf, &intermediate)

	leafCert, err := x509.ParseCertificate(leafDER)
	if err != nil {
		panic(err)
	}

	// Make copies of the certificates with invalid extensions. These copies may
	// be substituted into the valid chain.
	for _, ext := range extensions {
		invalidExtension := []pkix.Extension{{Id: ext.oid, Value: []byte("INVALID")}}

		rootInvalid := root
		rootInvalid.template.ExtraExtensions = invalidExtension
		mustGenerateCertificate(fmt.Sprintf("invalid_extension_root_%s.pem", ext.name), &rootInvalid, &rootInvalid)

		intermediateInvalid := intermediate
		intermediateInvalid.template.ExtraExtensions = invalidExtension
		mustGenerateCertificate(fmt.Sprintf("invalid_extension_intermediate_%s.pem", ext.name), &intermediateInvalid, &root)

		leafInvalid := leaf
		leafInvalid.template.ExtraExtensions = invalidExtension
		mustGenerateCertificate(fmt.Sprintf("invalid_extension_leaf_%s.pem", ext.name), &leafInvalid, &intermediate)

		// Additionally generate a copy of the leaf certificate with extra data in
		// the extension.
		var trailingDataExtension []pkix.Extension
		for _, leafExt := range leafCert.Extensions {
			if leafExt.Id.Equal(ext.oid) {
				newValue := make([]byte, len(leafExt.Value)+1)
				copy(newValue, leafExt.Value)
				trailingDataExtension = append(trailingDataExtension, pkix.Extension{Id: ext.oid, Critical: leafExt.Critical, Value: newValue})
			}
		}
		if len(trailingDataExtension) != 1 {
			panic(fmt.Sprintf("could not find sample extension %s", ext.name))
		}

		leafTrailingData := leaf
		leafTrailingData.template.ExtraExtensions = trailingDataExtension
		mustGenerateCertificate(fmt.Sprintf("trailing_data_leaf_%s.pem", ext.name), &leafTrailingData, &intermediate)
	}
}

const leafKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoPUXNXuH9mgiS/nk
024SYxryxMa3CyGJldiHymLxSquhRANCAASRKti8VW2Rkma+Kt9jQkMNitlCs0l5
w8u3SSwm7HZREvmcBCJBjVIREacRqI0umhzR2V5NLzBBP9yPD/A+Ch5X
-----END PRIVATE KEY-----`

const intermediateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWHKCKgY058ahE3t6
vpxVQgzlycgCVMogwjK0y3XMNfWhRANCAATiOnyojN4xS5C8gJ/PHL5cOEsMbsoE
Y6KT9xRQSh8lEL4d1Vb36kqUgkpqedEImo0Og4Owk6VWVVR/m4Lk+yUw
-----END PRIVATE KEY-----`

const rootKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBwND/eHytW0I417J
Hr+qcPlp5N1jM3ACXys57bPujg+hRANCAAQmdqXYl1GvY7y3jcTTK6MVXIQr44Tq
ChRYI6IeV9tIB6jIsOY+Qol1bk8x/7A5FGOnUWFVLEAPEPSJwPndjolt
-----END PRIVATE KEY-----`

func mustParseECDSAKey(in string) *ecdsa.PrivateKey {
	keyBlock, _ := pem.Decode([]byte(in))
	if keyBlock == nil || keyBlock.Type != "PRIVATE KEY" {
		panic("could not decode private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		panic(err)
	}
	return key.(*ecdsa.PrivateKey)
}
