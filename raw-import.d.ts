// Vite's `?raw` suffix imports a file's text, and Vitest runs on Vite, so tests use it to
// read wrangler.jsonc without needing Node's fs types in a project typed for workerd. Only
// test files import this way; nothing bundled for the Worker does.
declare module '*?raw' {
	const content: string
	export default content
}
