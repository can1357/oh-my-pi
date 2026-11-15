// Copyright 2024 The BoringSSL Authors
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

//go:build tools

package gotools

// This file contains dependencies that should be carried in go.mod for the sake
// of single-file Go scripts. However, those scripts are ignored by go mod tidy,
// so we must redeclare them here to keep them from being deleted. See
// https://github.com/golang/go/issues/25922#issuecomment-413898264

import (
	// Used by util/fetch_ech_config_list.go
	_ "golang.org/x/net/dns/dnsmessage"
)
