export interface ArticlePasswordConfig {
	encrypted?: boolean;
	password?: string;
	passwordEnv?: string;
}

const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Resolve an encrypted post password without exposing it to browser code.
 * Environment-backed passwords are recommended for repositories visible to readers.
 */
export function resolveArticlePassword(
	config: ArticlePasswordConfig,
	slug: string,
	environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
	if (!config.encrypted) return undefined;

	const inlinePassword = config.password ?? "";
	const environmentName = config.passwordEnv ?? "";
	if ((inlinePassword.length === 0) === (environmentName.length === 0)) {
		throw new Error(
			`Encrypted post "${slug}" must set exactly one of password or passwordEnv`,
		);
	}

	if (inlinePassword.length > 0) return inlinePassword;
	if (
		!ENVIRONMENT_NAME_PATTERN.test(environmentName) ||
		environmentName.startsWith("PUBLIC_")
	) {
		throw new Error(
			`Encrypted post "${slug}" uses an invalid private passwordEnv name`,
		);
	}

	const password = environment[environmentName];
	if (!password) {
		throw new Error(
			`Encrypted post "${slug}" requires the ${environmentName} environment variable`,
		);
	}
	return password;
}
