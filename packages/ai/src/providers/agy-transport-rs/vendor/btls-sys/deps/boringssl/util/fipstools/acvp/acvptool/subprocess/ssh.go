package subprocess

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// The following structures reflect the JSON of KDF SSH tests. See
// https://pages.nist.gov/ACVP/draft-celi-acvp-kdf-ssh.html#name-test-vectors

type sshTestVectorSet struct {
	Algorithm string         `json:"algorithm"`
	Mode      string         `json:"mode"`
	Groups    []sshTestGroup `json:"testGroups"`
}

type sshTestGroup struct {
	ID       uint64 `json:"tgId"`
	TestType string `json:"testType"`
	HashAlg  string `json:"hashAlg"`
	Cipher   string `json:"cipher"`
	Tests    []struct {
		ID           uint64 `json:"tcId"`
		KHex         string `json:"k"`
		HHex         string `json:"h"`
		SessionIDHex string `json:"sessionID"`
	} `json:"tests"`
}

type sshTestGroupResponse struct {
	ID    uint64            `json:"tgId"`
	Tests []sshTestResponse `json:"tests"`
}

type sshTestResponse struct {
	ID                     uint64 `json:"tcId"`
	InitialIvClientHex     string `json:"initialIvClient"`
	InitialIvServerHex     string `json:"initialIvServer"`
	EncryptionKeyClientHex string `json:"encryptionKeyClient"`
	EncryptionKeyServerHex string `json:"encryptionKeyServer"`
	IntegrityKeyClientHex  string `json:"integrityKeyClient"`
	IntegrityKeyServerHex  string `json:"integrityKeyServer"`
}

type ssh struct {
}

func (s *ssh) Process(vectorSet []byte, m Transactable) (any, error) {
	var parsed sshTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, err
	}

	if parsed.Algorithm != "kdf-components" {
		return nil, fmt.Errorf("unexpected algorithm: %q", parsed.Algorithm)
	}
	if parsed.Mode != "ssh" {
		return nil, fmt.Errorf("unexpected mode: %q", parsed.Mode)
	}

	var ret []sshTestGroupResponse
	for _, group := range parsed.Groups {
		group := group

		// Only the AFT test type is specified for SSH:
		// https://pages.nist.gov/ACVP/draft-celi-acvp-kdf-ssh.html#name-test-types
		if group.TestType != "AFT" {
			return nil, fmt.Errorf("test group %d had unexpected test type: %q", group.ID, group.TestType)
		}

		response := sshTestGroupResponse{
			ID: group.ID,
		}

		for _, test := range group.Tests {
			test := test

			resp := sshTestResponse{
				ID: test.ID,
			}

			k, err := hex.DecodeString(test.KHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode K hex in test case %d/%d: %s", group.ID, test.ID, err)
			}
			h, err := hex.DecodeString(test.HHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode H hex in test case %d/%d: %s", group.ID, test.ID, err)
			}
			sessionID, err := hex.DecodeString(test.SessionIDHex)
			if err != nil {
				return nil, fmt.Errorf("failed to decode session ID hex in test case %d/%d: %s", group.ID, test.ID, err)
			}

			cmd := fmt.Sprintf("SSHKDF/%s/client", group.HashAlg)
			m.TransactAsync(cmd, 3, [][]byte{k, h, sessionID, []byte(group.Cipher)}, func(result [][]byte) error {
				resp.InitialIvClientHex = hex.EncodeToString(result[0])
				resp.EncryptionKeyClientHex = hex.EncodeToString(result[1])
				resp.IntegrityKeyClientHex = hex.EncodeToString(result[2])
				return nil
			})

			cmd = fmt.Sprintf("SSHKDF/%s/server", group.HashAlg)
			m.TransactAsync(cmd, 3, [][]byte{k, h, sessionID, []byte(group.Cipher)}, func(result [][]byte) error {
				resp.InitialIvServerHex = hex.EncodeToString(result[0])
				resp.EncryptionKeyServerHex = hex.EncodeToString(result[1])
				resp.IntegrityKeyServerHex = hex.EncodeToString(result[2])
				return nil
			})

			m.Barrier(func() {
				response.Tests = append(response.Tests, resp)
			})
		}

		m.Barrier(func() {
			ret = append(ret, response)
		})
	}

	if err := m.Flush(); err != nil {
		return nil, err
	}

	return ret, nil
}
