import tsParser from '@typescript-eslint/parser'
import tsPlugin from '@typescript-eslint/eslint-plugin'

export default [
	{
		files: ['src/**/*.{js,ts,mjs,cjs}'],
		languageOptions: {
			ecmaVersion: 'latest',
			sourceType: 'module',
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.json'
			},
			globals: {
				console: 'readonly',
				process: 'readonly',
				Buffer: 'readonly',
				__dirname: 'readonly',
				__filename: 'readonly',
				module: 'readonly',
				require: 'readonly',
				global: 'readonly',
				globalThis: 'readonly'
			}
		},
		plugins: {
			'@typescript-eslint': tsPlugin
		},
		rules: {
			// Your custom rules
			'indent': ['error', 'tab'],
			'semi': ['error', 'never'],
			'no-extra-semi': 'error',
			'no-tabs': 'off',
			'no-mixed-spaces-and-tabs': 'error',
			
			// TypeScript-specific rules
			'@typescript-eslint/no-unused-vars': 'error',
			
			// Standard-style rules
			'no-undef': 'off', // TypeScript handles this
			'quotes': ['error', 'single'],
			'space-before-function-paren': ['error', 'always'],
			'keyword-spacing': 'error',
			'space-infix-ops': 'error',
			'comma-spacing': 'error',
			'brace-style': ['error', '1tbs', { allowSingleLine: true }],
			'curly': ['error', 'multi-line'],
			'dot-notation': 'error',
			'eqeqeq': ['error', 'always'],
			'new-cap': 'error',
			'no-array-constructor': 'error',
			'no-console': 'off',
			'no-new-object': 'error',
			'no-trailing-spaces': 'error',
			'object-curly-spacing': ['error', 'always'],
			'spaced-comment': ['error', 'always']
		}
	}
] 