// Hand-written companion to worker-configuration.d.ts. Do not regenerate this file.
//
// `wrangler types` only sees bindings declared in wrangler.jsonc plus whatever happens
// to sit in a developer's local .dev.vars. These values are secrets: they come from the
// Cloudflare dashboard in production, and .dev.vars is gitignored. So regenerating on a
// machine without that file silently drops every entry below, and `env.ZENDESK_SUBDOMAIN`
// quietly becomes an unchecked property access again.
//
// Declaring them here keeps the contract in version control and stable no matter who runs
// cf-typegen. These merge into the Env interface that worker-configuration.d.ts generates.
//
// Keep in sync with .dev.vars.example and the secrets set via `wrangler secret put`.

interface Env {
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;
	// Optional: when set, restricts Google sign-in to a single hosted domain
	HOSTED_DOMAIN?: string;
	ZENDESK_SUBDOMAIN: string;
	ZENDESK_EMAIL: string;
	ZENDESK_API_TOKEN: string;
}
