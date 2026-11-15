// Copyright 2025 The BoringSSL Authors
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

//go:build gcs

package main

import (
	"context"
	"flag"
	"io"
	"log"
	neturl "net/url"
	"time"

	"cloud.google.com/go/storage"
	"google.golang.org/api/iterator"
)

var uploadGCSDirectory = flag.String("gcs", "", "GCS path to folder where result files to be uploaded are")

// Uploads results directory from GCS.
// Similar to uploadResultsDirectory().
func uploadResultsFromGCS(gcsBucket string, config *Config, sessionTokensCacheDir string) {
	u, err := neturl.Parse(gcsBucket)
	if err != nil {
		log.Fatal(err)
	}
	bucket := u.Host
	folder := trimLeadingSlash(addTrailingSlash(u.Path))
	sessionID, err := getLastDigitDir(folder)
	if err != nil {
		log.Fatal(err)
	}

	ctx := context.Background()
	client, err := storage.NewClient(ctx)
	if err != nil {
		log.Fatalf("Failed to create client: %v", err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(ctx, time.Second*10)
	defer cancel()

	// Access bucket and identify all objects.
	// Objects include the folder.
	it := client.Bucket(bucket).Objects(ctx, &storage.Query{
		Prefix:    folder,
		Delimiter: "/",
	})

	var results []nistUploadResult
	// Go through each object (noting GCS stores objects, not files)
	for {
		attrs, err := it.Next()
		if err == iterator.Done {
			break
		} else if err != nil {
			log.Fatalf("Unable to read bucket: %s", err)
		}
		rc, err := client.Bucket(bucket).Object(attrs.Name).NewReader(ctx)
		if err != nil {
			log.Fatalf("unable to open object from bucket %q, object %q: %v", bucket, attrs.Name, err)
			return
		}
		defer rc.Close()
		content, err := io.ReadAll(rc)
		if err != nil {
			log.Fatalf("unable to read contents of object %q: %v", attrs.Name, err)
		}
		if len(content) == 0 {
			log.Printf("object (gs://%s/%s) is a \"folder\" or empty.", bucket, attrs.Name)
			continue
		}

		results = processResultContent(results, content, sessionID, attrs.Name)
	}

	uploadResults(results, sessionID, config, sessionTokensCacheDir)
}

func handleGCSFlag(config *Config, sessionTokensCacheDir string) bool {
	if len(*uploadGCSDirectory) > 0 {
		uploadResultsFromGCS(*uploadGCSDirectory, config, sessionTokensCacheDir)
		return true
	}
	return false
}
