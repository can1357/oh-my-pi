package subprocess

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
)

const MLDSARandomizerLength = 32

// Common top-level structure to parse mode
type mldsaTestVectorSet struct {
	Algorithm string `json:"algorithm"`
	Mode      string `json:"mode"`
	Revision  string `json:"revision"`
}

// Key generation specific structures
type mldsaKeyGenTestVectorSet struct {
	Algorithm string                 `json:"algorithm"`
	Mode      string                 `json:"mode"`
	Revision  string                 `json:"revision"`
	Groups    []mldsaKeyGenTestGroup `json:"testGroups"`
}

type mldsaKeyGenTestGroup struct {
	ID           uint64            `json:"tgId"`
	TestType     string            `json:"testType"`
	ParameterSet string            `json:"parameterSet"`
	Tests        []mldsaKeyGenTest `json:"tests"`
}

type mldsaKeyGenTest struct {
	ID   uint64 `json:"tcId"`
	Seed string `json:"seed"`
}

type mldsaKeyGenTestGroupResponse struct {
	ID    uint64                    `json:"tgId"`
	Tests []mldsaKeyGenTestResponse `json:"tests"`
}

type mldsaKeyGenTestResponse struct {
	ID         uint64 `json:"tcId"`
	PublicKey  string `json:"pk"`
	PrivateKey string `json:"sk"`
}

// Signature generation specific structures
type mldsaSigGenTestVectorSet struct {
	Algorithm string                 `json:"algorithm"`
	Mode      string                 `json:"mode"`
	Revision  string                 `json:"revision"`
	Groups    []mldsaSigGenTestGroup `json:"testGroups"`
}

type mldsaSigGenTestGroup struct {
	ID            uint64            `json:"tgId"`
	TestType      string            `json:"testType"`
	ParameterSet  string            `json:"parameterSet"`
	Deterministic bool              `json:"deterministic"`
	Tests         []mldsaSigGenTest `json:"tests"`
}

type mldsaSigGenTest struct {
	ID         uint64 `json:"tcId"`
	Message    string `json:"message"`
	PrivateKey string `json:"sk"`
	Randomizer string `json:"rnd"`
}

type mldsaSigGenTestGroupResponse struct {
	ID    uint64                    `json:"tgId"`
	Tests []mldsaSigGenTestResponse `json:"tests"`
}

type mldsaSigGenTestResponse struct {
	ID        uint64 `json:"tcId"`
	Signature string `json:"signature"`
}

// Signature verification specific structures
type mldsaSigVerTestVectorSet struct {
	Algorithm string                 `json:"algorithm"`
	Mode      string                 `json:"mode"`
	Revision  string                 `json:"revision"`
	Groups    []mldsaSigVerTestGroup `json:"testGroups"`
}

type mldsaSigVerTestGroup struct {
	ID           uint64            `json:"tgId"`
	TestType     string            `json:"testType"`
	ParameterSet string            `json:"parameterSet"`
	Tests        []mldsaSigVerTest `json:"tests"`
}

type mldsaSigVerTest struct {
	ID        uint64 `json:"tcId"`
	PublicKey string `json:"pk"`
	Message   string `json:"message"`
	Signature string `json:"signature"`
}

type mldsaSigVerTestGroupResponse struct {
	ID    uint64                    `json:"tgId"`
	Tests []mldsaSigVerTestResponse `json:"tests"`
}

type mldsaSigVerTestResponse struct {
	ID         uint64 `json:"tcId"`
	TestPassed bool   `json:"testPassed"`
}

type mldsa struct{}

func (m *mldsa) Process(vectorSet []byte, t Transactable) (any, error) {
	// First parse just the common fields to get the mode
	var common mldsaTestVectorSet
	if err := json.Unmarshal(vectorSet, &common); err != nil {
		return nil, fmt.Errorf("failed to unmarshal vector set: %v", err)
	}

	switch common.Mode {
	case "keyGen":
		return m.processKeyGen(vectorSet, t)
	case "sigGen":
		return m.processSigGen(vectorSet, t)
	case "sigVer":
		return m.processSigVer(vectorSet, t)
	default:
		return nil, fmt.Errorf("unsupported ML-DSA mode: %s", common.Mode)
	}
}

func (m *mldsa) processKeyGen(vectorSet []byte, t Transactable) (any, error) {
	var parsed mldsaKeyGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal keyGen vector set: %v", err)
	}

	var ret []mldsaKeyGenTestGroupResponse

	for _, group := range parsed.Groups {
		response := mldsaKeyGenTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "ML-DSA-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/keyGen"

		for _, test := range group.Tests {
			seed, err := hex.DecodeString(test.Seed)
			if err != nil {
				return nil, fmt.Errorf("failed to decode seed in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			result, err := t.Transact(cmdName, 2, seed)
			if err != nil {
				return nil, fmt.Errorf("key generation failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			response.Tests = append(response.Tests, mldsaKeyGenTestResponse{
				ID:         test.ID,
				PublicKey:  hex.EncodeToString(result[0]),
				PrivateKey: hex.EncodeToString(result[1]),
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}

func (m *mldsa) processSigGen(vectorSet []byte, t Transactable) (any, error) {
	var parsed mldsaSigGenTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sigGen vector set: %v", err)
	}

	var ret []mldsaSigGenTestGroupResponse

	for _, group := range parsed.Groups {
		response := mldsaSigGenTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "ML-DSA-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/sigGen"

		for _, test := range group.Tests {
			sk, err := hex.DecodeString(test.PrivateKey)
			if err != nil {
				return nil, fmt.Errorf("failed to decode private key in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			msg, err := hex.DecodeString(test.Message)
			if err != nil {
				return nil, fmt.Errorf("failed to decode message in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			var randomizer []byte
			if group.Deterministic {
				randomizer = make([]byte, MLDSARandomizerLength)
			} else {
				randomizer, err = hex.DecodeString(test.Randomizer)
				if err != nil || len(randomizer) != MLDSARandomizerLength {
					return nil, fmt.Errorf("failed to parse randomizer in test case %d/%d: %s", group.ID, test.ID, err)
				}
			}

			result, err := t.Transact(cmdName, 1, sk, msg, randomizer)
			if err != nil {
				return nil, fmt.Errorf("signature generation failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			response.Tests = append(response.Tests, mldsaSigGenTestResponse{
				ID:        test.ID,
				Signature: hex.EncodeToString(result[0]),
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}

func (m *mldsa) processSigVer(vectorSet []byte, t Transactable) (any, error) {
	var parsed mldsaSigVerTestVectorSet
	if err := json.Unmarshal(vectorSet, &parsed); err != nil {
		return nil, fmt.Errorf("failed to unmarshal sigVer vector set: %v", err)
	}

	var ret []mldsaSigVerTestGroupResponse

	for _, group := range parsed.Groups {
		response := mldsaSigVerTestGroupResponse{
			ID: group.ID,
		}

		if !strings.HasPrefix(group.ParameterSet, "ML-DSA-") {
			return nil, fmt.Errorf("invalid parameter set: %s", group.ParameterSet)
		}
		cmdName := group.ParameterSet + "/sigVer"

		for _, test := range group.Tests {
			pk, err := hex.DecodeString(test.PublicKey)
			if err != nil || len(pk) == 0 {
				return nil, fmt.Errorf("failed to decode public key in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			msg, err := hex.DecodeString(test.Message)
			if err != nil {
				return nil, fmt.Errorf("failed to decode message in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			sig, err := hex.DecodeString(test.Signature)
			if err != nil {
				return nil, fmt.Errorf("failed to decode signature in test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			result, err := t.Transact(cmdName, 1, pk, msg, sig)
			if err != nil {
				return nil, fmt.Errorf("signature verification failed for test case %d/%d: %s",
					group.ID, test.ID, err)
			}

			// Result is a single byte: 0 for false, non-zero for true
			testPassed := result[0][0] != 0
			response.Tests = append(response.Tests, mldsaSigVerTestResponse{
				ID:         test.ID,
				TestPassed: testPassed,
			})
		}

		ret = append(ret, response)
	}

	return ret, nil
}
