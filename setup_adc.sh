#!/bin/bash

echo "================================================================"
echo "   Google Cloud Model API & Gemini: ADC setup script"
echo "================================================================"

# --- Step 1: Locate or Install gcloud ---
# Check if gcloud is already in the PATH and get its SDK root
EXISTING_SDK_ROOT=$(gcloud info --format='value(installation.sdk_root)' 2>/dev/null || true)

if [ -n "$EXISTING_SDK_ROOT" ]; then
   SDK_PATH="$EXISTING_SDK_ROOT"
   GCLOUD_BIN="$SDK_PATH/bin/gcloud"
   echo "✅ gcloud CLI detected via PATH at: $GCLOUD_BIN"
else
   SDK_PATH="$HOME/google-cloud-sdk"
   GCLOUD_BIN="$SDK_PATH/bin/gcloud"

   if [ ! -f "$GCLOUD_BIN" ]; then
      echo "⬇️  gcloud CLI not found. Downloading..."
      curl -sSL https://sdk.cloud.google.com > /tmp/gcloud_install.sh
      bash /tmp/gcloud_install.sh --disable-prompts --install-dir="$HOME" || true
      rm /tmp/gcloud_install.sh
   else
      echo "✅ gcloud CLI found at: $GCLOUD_BIN"
   fi
fi

if [ ! -f "$GCLOUD_BIN" ]; then
   echo "❌ Critical Error: gcloud failed to install."
   exit 1
fi

# --- Step 3: Project Configuration ---
echo ""
echo "--- Project Setup ---"
echo "Enter your Google Cloud Project ID (NOT the name)."
read -p "Project ID: " PROJECT_ID

if [ -z "$PROJECT_ID" ]; then
   echo "❌ Project ID cannot be empty."
   exit 1
fi

# --- Step 4: Authentication ---
echo ""
echo "--- Authenticating ---"
echo "Authorizing Application Default Credentials (ADC)..."
"$GCLOUD_BIN" auth application-default login

echo ""
echo "Setting active gcloud account..."
ACCOUNT=$("$GCLOUD_BIN" auth list --filter=status:ACTIVE --format="value(account)")
if [ -n "$ACCOUNT" ]; then
  "$GCLOUD_BIN" config set account "$ACCOUNT"
  echo "✅ Active account set to $ACCOUNT"
else
  echo "⚠️ Could not determine active account from ADC login. You might be prompted to login again."
  echo "Logging in to CLI (Select your corporate certificate if prompted)..."
  "$GCLOUD_BIN" auth login --quiet
fi

# --- Step 5: Final Configuration ---
echo ""
echo "--- Finalizing Configuration ---"
"$GCLOUD_BIN" config set project "$PROJECT_ID"
"$GCLOUD_BIN" auth application-default set-quota-project "$PROJECT_ID"

# Try to enable the API 
echo "🔌 Ensuring Google Cloud Model API is enabled..."
"$GCLOUD_BIN" services enable aiplatform.googleapis.com || echo "⚠️  Could not enable API (you might need an admin to do this). Proceeding..."

# --- Step 6: Instant Verification ---
echo ""
echo "--- Verifying Access ---"
ACCESS_TOKEN=$("$GCLOUD_BIN" auth print-access-token)

if [ -z "$ACCESS_TOKEN" ]; then
   echo "❌ Authentication failed. No token received."
   exit 1
fi

# use curl to test the connection immediately
RESPONSE=$(curl -s -X POST \
   -H "Authorization: Bearer $ACCESS_TOKEN" \
   -H "Content-Type: application/json" \
   "https://aiplatform.googleapis.com/v1/projects/$PROJECT_ID/locations/global/publishers/google/models/gemini-2.5-flash:generateContent" \
   -d '{ "contents": [{ "role": "user", "parts": [{ "text": "Reply ONLY with the word SUCCESS" }] }] }')

# Check if the response contains "SUCCESS" (case insensitive)
if echo "$RESPONSE" | grep -q "SUCCESS"; then
   echo "🎉 SUCCESS! Your Model API access is fully working."
   echo "ADC Credentials stored at: $HOME/.config/gcloud/application_default_credentials.json"
else
   echo "⚠️  Authentication worked, but the API call failed."
   echo "Server Response: $RESPONSE"
fi