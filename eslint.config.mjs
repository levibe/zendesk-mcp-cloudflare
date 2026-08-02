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
			'@typescript-eslint/no-explicit-any': 'warn',
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
		// The exemptions are the file defining it, the one call site, and tests — tests because
		// that is where the double-wrapped shape is pinned, and nothing there ships.
		files: ['src/**/*.ts'],
		ignores: ['src/utils/error-handling.ts', 'src/utils/tool-registry.ts', 'src/**/*.test.ts'],
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/error-handling'],
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
	// leaves Prettier as the only thing with an opinion about layout.
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
