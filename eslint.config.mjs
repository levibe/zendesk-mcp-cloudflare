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
