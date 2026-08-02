import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { type Context, Hono } from 'hono'
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from './utils'
import { isRecord } from './utils/narrow'
import {
	clientIdAlreadyApproved,
	parseRedirectApproval,
	renderApprovalDialog,
} from './workers-oauth-utils'

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>()

app.get('/authorize', async (c) => {
	// parseAuthRequest rejects an unregistered client, a redirect URI that doesn't match
	// the registration, and dangerous redirect schemes. It signals all of these by throwing,
	// so without this catch they surface as a bare 500 that tells the client nothing.
	//
	// The caller is still unauthenticated here, so it gets a fixed message and the provider's
	// own text goes to the log instead. Those messages are static strings today, but relaying
	// a dependency's error verbatim only stays safe until a release adds detail to one.
	let oauthReqInfo: AuthRequest
	try {
		oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
	} catch (error) {
		console.warn(
			'parseAuthRequest rejected the request:',
			error instanceof Error ? error.message : String(error)
		)
		return c.text('Invalid authorization request', 400)
	}

	const { clientId } = oauthReqInfo
	if (!clientId) {
		return c.text('Invalid request', 400)
	}

	if (
		await clientIdAlreadyApproved(c.req.raw, oauthReqInfo.clientId, c.env.COOKIE_ENCRYPTION_KEY)
	) {
		return redirectToGoogle(c, oauthReqInfo)
	}

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		server: {
			name: 'Momentum Zendesk MCP',
			description: 'Secure access to Zendesk APIs through Model Context Protocol.',
		},
		state: { oauthReqInfo },
	})
})

app.post('/authorize', async (c) => {
	const { state, headers } = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY)
	if (!state.oauthReqInfo) {
		return c.text('Invalid request', 400)
	}

	return redirectToGoogle(c, state.oauthReqInfo, headers)
})

async function redirectToGoogle(
	c: Context,
	oauthReqInfo: AuthRequest,
	headers: Record<string, string> = {}
) {
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				clientId: c.env.GOOGLE_CLIENT_ID,
				hostedDomain: c.env.HOSTED_DOMAIN,
				redirectUri: new URL('/callback', c.req.raw.url).href,
				scope: 'email profile',
				state: btoa(JSON.stringify(oauthReqInfo)),
				upstreamUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			}),
		},
		status: 302,
	})
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from Google after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 */
app.get('/callback', async (c) => {
	// The `state` here is `btoa(JSON.stringify(oauthReqInfo))` — see redirectToGoogle above. It
	// is neither signed nor encrypted, so it carries the authorization request across the Google
	// round trip but does not do the job the OAuth `state` parameter exists to do: nothing binds
	// it to the browser session that started the flow, no nonce and no cookie, so anyone can mint
	// one that satisfies every check below. That is the shape of an authorization-code injection.
	// An attacker starts a flow of their own, then hands the victim a callback URL that binds the
	// attacker's Google identity to the victim's MCP client session.
	//
	// What that is worth today is nothing, and the reason is worth writing down rather than
	// leaving to be re-derived. Every Zendesk request goes out under one shared service account
	// read from `env`, and nothing reads the `Props` this callback puts on the token — the comment
	// at the bottom of src/utils.ts says exactly that. The signed-in identity therefore grants no
	// differential access at all, so an attacker who wins this reaches only what they already had.
	//
	// #20 is the event that changes the answer, because it makes identity decide which tools a
	// caller may use. On the day that lands, binding someone else's session to your Google account
	// stops being a curiosity and becomes a privilege escalation, and this state has to be bound to
	// the session that minted it first. Read the paragraph above as a fact with an expiry date
	// rather than as a reason this is fine.
	//
	// Everything below arrived through the user's browser and none of it can be assumed
	// well-formed. `state` may be absent, `atob` throws on anything outside the base64 alphabet,
	// and `JSON.parse` throws on anything that is not JSON — on a public, unauthenticated endpoint
	// all three used to be a bare 500 that anyone could produce at will. Handled the way GET
	// /authorize handles parseAuthRequest above, and for the same reason: the real cause goes to
	// the log, and the unauthenticated caller gets one fixed message that does not tell it which
	// step it managed to break.
	const encodedState = c.req.query('state')
	if (!encodedState) {
		return c.text('Invalid state', 400)
	}

	let decodedState: unknown
	try {
		decodedState = JSON.parse(atob(encodedState))
	} catch (error) {
		console.warn(
			'Callback state could not be decoded:',
			error instanceof Error ? error.message : String(error)
		)
		return c.text('Invalid state', 400)
	}

	// Narrow before reading a property off it. `JSON.parse` returns whatever the JSON said, which
	// includes `null` and bare scalars, so reading `.clientId` straight off the result would let
	// a state of `btoa('null')` throw the same unhandled TypeError in through a different door.
	// The clientId check is the one that was already here; it just needs something to stand on.
	if (
		!isRecord(decodedState) ||
		typeof decodedState.clientId !== 'string' ||
		!decodedState.clientId
	) {
		return c.text('Invalid state', 400)
	}

	// The step through `unknown` is required rather than lazy: `AuthRequest` is an interface, so
	// it carries no implicit index signature and TypeScript will not convert the narrowed record
	// to it directly.
	//
	// What is checked above is `clientId` and nothing else, and the rest of this object is
	// forged input all the way to `completeAuthorization`. Two of its fields are read on the way
	// there — `scope` below, and `redirectUri` inside the provider — so do not read the cast as
	// a claim that the shape has been established. The provider is what validates the rest, and
	// the call is wrapped for exactly that reason: it validates by throwing.
	const oauthReqInfo = decodedState as unknown as AuthRequest

	// Exchange the code for an access token
	const code = c.req.query('code')
	if (!code) {
		return c.text('Missing code', 400)
	}

	const [accessToken, googleErrResponse] = await fetchUpstreamAuthToken({
		clientId: c.env.GOOGLE_CLIENT_ID,
		clientSecret: c.env.GOOGLE_CLIENT_SECRET,
		code,
		grantType: 'authorization_code',
		redirectUri: new URL('/callback', c.req.url).href,
		upstreamUrl: 'https://accounts.google.com/o/oauth2/token',
	})
	if (googleErrResponse) {
		return googleErrResponse
	}

	// Fetch the user info from Google
	const userResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
		headers: {
			Authorization: `Bearer ${accessToken}`,
		},
	})
	if (!userResponse.ok) {
		return c.text(`Failed to fetch user info: ${await userResponse.text()}`, 500)
	}

	const { id, name, email } = (await userResponse.json()) as {
		id: string
		name: string
		email: string
	}

	// Enforce domain restriction if HOSTED_DOMAIN is set.
	//
	// Both sides are lowercased before comparing. A domain is case-insensitive by definition,
	// and the local part is not, but neither is compared here — the suffix being matched starts
	// at the `@`, so lowercasing the whole address cannot make two different mailboxes look
	// alike. Google normally hands back a lowercase `email`, so this is not a bug anyone was
	// hitting; it is an access control that should not depend on a habit of the identity
	// provider's, since the failure it would produce is a refusal that looks arbitrary.
	//
	// Keep the `@`. Matching the bare domain would admit `ada@notexample.com` against a hosted
	// domain of `example.com`, and there is a test pinning exactly that.
	const hostedDomain = c.env.HOSTED_DOMAIN?.toLowerCase()
	if (hostedDomain && !email.toLowerCase().endsWith(`@${hostedDomain}`)) {
		return c.text(`Access restricted to ${c.env.HOSTED_DOMAIN} domain users only`, 403)
	}

	// Return back to the MCP client a new token.
	//
	// Wrapped for the same reason the state decode above is, and it is the last place a forged
	// state can still reach. This object is validated here and nowhere earlier: the provider
	// throws when `redirectUri` is missing, when the client is not registered, and when the
	// redirect URI is not one that client registered. Those checks are the ones that matter and
	// they hold — there is no open redirect here — but the provider signals all of them by
	// throwing, and nothing upstream catches it, so an unhandled throw is answered by Hono as a
	// bare 500. `scope` is the same story from the other direction: it is read straight off the
	// forged object below, and the provider joins it without checking, so a state omitting it
	// raises a TypeError rather than a refusal.
	//
	// So the barrier to producing a 500 at will was a Google sign-in and nothing more. A fixed
	// 400 is the honest answer to a state we accepted only as far as its clientId, and the real
	// reason goes to the log where the caller cannot read it.
	let redirectTo: string
	try {
		;({ redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
			metadata: {
				label: name,
			},
			props: {
				accessToken,
				email,
				name,
			} as Props,
			request: oauthReqInfo,
			scope: oauthReqInfo.scope,
			userId: id,
		}))
	} catch (error) {
		console.warn(
			'completeAuthorization rejected the request:',
			error instanceof Error ? error.message : String(error)
		)
		return c.text('Invalid authorization request', 400)
	}

	return Response.redirect(redirectTo)
})

export { app as GoogleHandler }
