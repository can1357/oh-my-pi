import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { removeWithRetries } from "../../utils/src/temp";
import { withEnv } from "./helpers";

const EMPTY_AWS_ENV = {
	AWS_ACCESS_KEY_ID: undefined,
	AWS_SECRET_ACCESS_KEY: undefined,
	AWS_BEARER_TOKEN_BEDROCK: undefined,
	AWS_BEDROCK_SKIP_AUTH: undefined,
	AWS_PROFILE: undefined,
	AWS_SDK_LOAD_CONFIG: undefined,
	AWS_WEB_IDENTITY_TOKEN_FILE: undefined,
	AWS_ROLE_ARN: undefined,
	AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: undefined,
	AWS_CONTAINER_CREDENTIALS_FULL_URI: undefined,
	AWS_EXECUTION_ENV: undefined,
	AWS_EC2_METADATA_SERVICE_ENDPOINT: undefined,
};

describe("AWS provider availability", () => {
	test("recognizes the Bedrock auth bypass without AWS credentials", async () => {
		await withEnv(
			{
				...EMPTY_AWS_ENV,
				AWS_BEDROCK_SKIP_AUTH: "1",
				AWS_SHARED_CREDENTIALS_FILE: "/missing/aws-credentials",
				AWS_CONFIG_FILE: "/missing/aws-config",
				AWS_EC2_METADATA_DISABLED: "true",
			},
			async () => {
				expect(getEnvApiKey("amazon-bedrock")).toBeDefined();
				expect(getEnvApiKey("bedrock-mantle")).toBeUndefined();
			},
		);
	});

	test("recognizes the default shared credentials file", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			await Bun.write(credentialsPath, "[default]\naws_access_key_id = test\naws_secret_access_key = test-secret\n");
			await withEnv(
				{
					...EMPTY_AWS_ENV,
					AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
					AWS_CONFIG_FILE: path.join(tmp, "missing-config"),
					AWS_EC2_METADATA_DISABLED: "true",
				},
				async () => expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("ignores profile files without a usable credential mechanism", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-empty-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			const configPath = path.join(tmp, "config");
			await Promise.all([
				Bun.write(credentialsPath, "[default]\naws_access_key_id = incomplete\n"),
				Bun.write(configPath, "[default]\nregion = us-east-1\n"),
			]);
			await withEnv(
				{
					...EMPTY_AWS_ENV,
					AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
					AWS_CONFIG_FILE: configPath,
					AWS_EC2_METADATA_DISABLED: "true",
				},
				async () => expect(getEnvApiKey("bedrock-mantle")).toBeUndefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("loads implicit default config profiles only when AWS_SDK_LOAD_CONFIG is enabled", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-load-config-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			const configPath = path.join(tmp, "config");
			await Promise.all([
				Bun.write(credentialsPath, ""),
				Bun.write(configPath, "[default]\ncredential_process = /bin/credential-helper\n"),
			]);
			const env = {
				...EMPTY_AWS_ENV,
				AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
				AWS_CONFIG_FILE: configPath,
				AWS_EC2_METADATA_DISABLED: "true",
			};
			await withEnv(env, async () => expect(getEnvApiKey("bedrock-mantle")).toBeUndefined());
			await withEnv({ ...env, AWS_SDK_LOAD_CONFIG: "1" }, async () =>
				expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});
	test("recognizes a role_arn/source_profile role chain", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-chain-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			const configPath = path.join(tmp, "config");
			await Promise.all([
				Bun.write(credentialsPath, ""),
				Bun.write(
					configPath,
					`[profile irsa]\nrole_arn = arn:aws:iam::111122223333:role/workspace\n` +
						`web_identity_token_file = /var/run/secrets/token\n\n` +
						`[default]\nrole_arn = arn:aws:iam::111122223333:role/user\nsource_profile = irsa\n`,
				),
			]);
			await withEnv(
				{
					...EMPTY_AWS_ENV,
					AWS_PROFILE: "default",
					AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
					AWS_CONFIG_FILE: configPath,
					AWS_EC2_METADATA_DISABLED: "true",
				},
				async () => expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("ignores a role_arn profile with no resolvable base", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-orphan-role-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			const configPath = path.join(tmp, "config");
			await Promise.all([
				Bun.write(credentialsPath, ""),
				Bun.write(configPath, "[default]\nrole_arn = arn:aws:iam::111122223333:role/user\n"),
			]);
			await withEnv(
				{
					...EMPTY_AWS_ENV,
					AWS_PROFILE: "default",
					AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
					AWS_CONFIG_FILE: configPath,
					AWS_EC2_METADATA_DISABLED: "true",
				},
				async () => expect(getEnvApiKey("bedrock-mantle")).toBeUndefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("gates role profile credential_source by source readiness", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aws-registry-credential-source-"));
		try {
			const credentialsPath = path.join(tmp, "credentials");
			const configPath = path.join(tmp, "config");
			await Bun.write(credentialsPath, "");
			const baseEnv = {
				...EMPTY_AWS_ENV,
				AWS_PROFILE: "default",
				AWS_SHARED_CREDENTIALS_FILE: credentialsPath,
				AWS_CONFIG_FILE: configPath,
				AWS_EC2_METADATA_DISABLED: "true",
			};

			for (const credentialSource of ["Environment", "EcsContainer", "Ec2InstanceMetadata", "Unknown"]) {
				await Bun.write(
					configPath,
					`[default]\nrole_arn = arn:aws:iam::111122223333:role/user\ncredential_source = ${credentialSource}\n`,
				);
				await withEnv(baseEnv, async () => expect(getEnvApiKey("bedrock-mantle")).toBeUndefined());
			}

			await Bun.write(
				configPath,
				"[default]\nrole_arn = arn:aws:iam::111122223333:role/user\ncredential_source = Environment\n",
			);
			await withEnv(
				{ ...baseEnv, AWS_ACCESS_KEY_ID: "AKIAREADY", AWS_SECRET_ACCESS_KEY: "ready-secret" },
				async () => expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);

			await Bun.write(
				configPath,
				"[default]\nrole_arn = arn:aws:iam::111122223333:role/user\ncredential_source = EcsContainer\n",
			);
			await withEnv({ ...baseEnv, AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2/credentials/test" }, async () =>
				expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);

			await Bun.write(
				configPath,
				"[default]\nrole_arn = arn:aws:iam::111122223333:role/user\ncredential_source = Ec2InstanceMetadata\n",
			);
			await withEnv({ ...baseEnv, AWS_EC2_METADATA_DISABLED: "false" }, async () =>
				expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
			);
		} finally {
			await removeWithRetries(tmp);
		}
	});

	test("recognizes an explicitly configured EC2 metadata endpoint", async () => {
		await withEnv(
			{
				...EMPTY_AWS_ENV,
				AWS_SHARED_CREDENTIALS_FILE: "/missing/aws-credentials",
				AWS_CONFIG_FILE: "/missing/aws-config",
				AWS_EC2_METADATA_DISABLED: undefined,
				AWS_EC2_METADATA_SERVICE_ENDPOINT: "http://169.254.169.254",
			},
			async () => expect(getEnvApiKey("bedrock-mantle")).toBeDefined(),
		);
	});
});
