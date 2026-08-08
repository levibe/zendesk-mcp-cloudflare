import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			'no-unused-vars': 'off',
			// TypeScript already catches undefined references, and the rule cannot see
			// the Workers globals this codebase runs against.
			'no-undef': 'off',
			// A leading underscore marks something as deliberately unused, which is how
			// this codebase already flags parked helpers and ignored callback arguments.
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
					caughtErrorsIgnorePattern: '^_',
				},
			],
			// Held at error so an unexamined `any` cannot land silently — while this warned,
			// validate passed with any number of them in the tree, which is how 66 accumulated
			// unnoticed before #8. A new `any` needs its own argued-for exemption.
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/explicit-module-boundary-types': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'no-console': 'off',
			'prefer-const': 'error',
		},
	},
	{
		files: ['src/**/*.ts'],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
		},
	},
	{
		// `withErrorHandling` turns a handler's result into an MCP response, and `registerTools`
		// applies it to every handler already — so a second call inside a handler can only be the
		// mistake #28 was about. It encodes the inner response as the text of the outer one, and
		// `isError` goes with it, so a write Zendesk rejected reads back as a successful call.
		// Nothing about that looks wrong until a write fails, which is how it came to be true of
		// every write handler in the tree at once. A worded confirmation is what those handlers
		// actually wanted, and it travels as the fifth argument to `createTool`.
		//
		// The bare specifiers sit beside the path glob because a subpath import of the package
		// would slip past `**/error-handling`. Tests stay exempt: nothing there ships.
		files: ['src/**/*.ts'],
		ignores: ['src/**/*.test.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/error-handling', '@levibe/mcp-worker', '@levibe/mcp-worker/*'],
							importNames: ['withErrorHandling'],
							message:
								'registerTools wraps every handler in withErrorHandling already. Wrapping again encodes the response as text and drops its isError, reporting a failed write as a success — return the client result and pass a successMessage to createTool instead.',
						},
					],
				},
			],
		},
	},
	// Must stay last so it switches off every formatting rule enabled above and
	// leaves oxfmt as the only thing with an opinion about layout. Only the package
	// name still says "prettier" — what it does is disable ESLint's formatting rules,
	// which is what you want behind any external formatter.
	prettier,
	{
		ignores: [
			'dist/**',
			'node_modules/**',
			'coverage/**',
			'.wrangler/**',
			'*.js',
			'*.mjs',
			'*.cjs',
			'*.d.ts',
		],
	}
)
