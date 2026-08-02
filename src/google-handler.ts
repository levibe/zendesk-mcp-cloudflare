import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { type Context, Hono } from 'hono'
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from './utils'
import { isRecord } from './utils/narrow'
import {
	clientIdAlreadyApproved,
	parseRedirectApproval,
	renderApprovalDialog,
} from './workers-oauth-utils'

/**
 * What to write to the log about a thrown value, whatever it turned out to be.
 *
 * Every route here catches something it cannot answer and logs the reason while telling the
 * caller a fixed sentence, so this expression appeared five times. Once is better for an
 * ordinary reason — one place to change if the wording moves — and for one that is specific to
 * this file: the `String` arm is unreachable from most of those catches, since `atob`,
 * `JSON.parse` and `btoa` all throw real `Error`s. Written inline it was five branch pairs of
 * which only one could ever be exercised, so coverage on this file measured the reachability of
 * a ternary rather than whether the guards around it were tested.
 */
const reasonFor = (error: unknown): string =>
	error instanceof Error ? error.message : String(error)

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
		console.warn('parseAuthRequest rejected the request:', reasonFor(error))
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
	// Guarded for the same reason as the two catches in /callback, and this is the one a caller
	// reaches most cheaply of the three: no Google sign-in, no valid cookie, nothing. A form body
	// whose `state` is absent, is not a string, is not base64 JSON, or decodes without a
	// `clientId` makes `parseRedirectApproval` throw, and an unhandled throw is answered by Hono
	// as a bare 500.
	//
	// Not only forged input lands here, and the 400 is a deliberate simplification rather than a
	// claim. `parseRedirectApproval` calls `importKey`, which throws when COOKIE_ENCRYPTION_KEY
	// is missing — a misconfigured deployment, reported to the caller as their mistake. The log
	// line carries the real reason, so nothing is lost, but do not read this catch as proof that
	// a 400 from this route means the request was bad.
	//
	// Worth knowing when reading coverage on this file: it reports every statement here as
	// covered, because the tests replace `parseRedirectApproval` with a stub that resolves. A
	// green number is not evidence this route is guarded — the test that proves it is the one
	// making that stub reject.
	let approval: Awaited<ReturnType<typeof parseRedirectApproval>>
	try {
		approval = await parseRedirectApproval(c.req.raw, c.env.COOKIE_ENCRYPTION_KEY)
	} catch (error) {
		console.warn('parseRedirectApproval rejected the request:', reasonFor(error))
		return c.text('Invalid request', 400)
	}

	const { state, headers } = approval
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
	// `btoa` refuses any code point above U+00FF, and this is the one place a caller's own text
	// reaches it. On POST /authorize the object below comes straight out of the form body, and
	// nothing upstream inspects it beyond requiring a truthy `clientId`.
	//
	// It slips past every check in front of it, which is why it is worth naming rather than
	// leaving to be rediscovered. A JSON `Ā` escape is pure ASCII on the wire, so the
	// caller's own base64 is valid and `decodeState` parses it into a string holding a real
	// U+0100. The approval cookie carries only the clientId, so keeping that ASCII and putting
	// the character in any other field clears that too. Then this line throws, and an uncaught
	// throw here is a bare 500 anyone can produce with one form field and no sign-in at all.
	//
	// Caught at the mint site rather than fixed at the root, deliberately. Making the encoding
	// UTF-8 safe is the better answer, but this `btoa` is one half of a pair — what it writes is
	// read back in /callback, and `renderApprovalDialog` and `parseRedirectApproval` are a second
	// pair in the vendored file — so the two halves have to move together or a state minted
	// before the change stops decoding after it. That is worth doing on its own, not in passing.
	let state: string
	try {
		state = btoa(JSON.stringify(oauthReqInfo))
	} catch (error) {
		console.warn('The authorization request could not be encoded as state:', reasonFor(error))
		return c.text('Invalid request', 400)
	}

	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				clientId: c.env.GOOGLE_CLIENT_ID,
				hostedDomain: c.env.HOSTED_DOMAIN,
				redirectUri: new URL('/callback', c.req.raw.url).href,
				scope: 'email profile',
				state,
				upstreamUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
			}),
		},
		status: 302,
	})
}

/**
 * Exchanges Google's code for an access token, completes the authorization, and redirects the
 * client back to its own callback. What goes into `props` is encrypted into the access token
 * and is what a tool can later read through `getMcpAuthContext()` — see `Props` in ../utils.
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
		console.warn('Callback state could not be decoded:', reasonFor(error))
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
	// What is checked above is `clientId` and nothing else, and the rest of this object is forged
	// input all the way to `completeAuthorization`. Do not read the cast as a claim that the
	// shape has been established — several of its fields are read on the way there, `scope` two
	// lines below and `redirectUri`, `responseType`, `resource`, `state`, `codeChallenge` and
	// `codeChallengeMethod` inside the provider.
	//
	// The last two are the ones worth knowing about, because they are the PKCE binding and the
	// provider copies them onto the grant without checking. A forged state omitting
	// `codeChallenge` therefore mints a grant with no PKCE on it. That is not exploitable on its
	// own here — the redirect URI still has to be one the client registered, so the code goes
	// back to the real client — but it is the sharpest illustration of how much of this object
	// is load-bearing and how little of it anything has checked by this point.
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
	// redirect URI is not one that client registered. Those three checks are the ones that
	// matter and they hold — there is no open redirect here — but the provider signals all of
	// them by throwing, and nothing upstream catches it, so an unhandled throw is answered by
	// Hono as a bare 500. The barrier to producing one at will was a Google sign-in and nothing
	// more. A fixed 400 is the honest answer to a state we accepted only as far as its clientId,
	// and the real reason goes to the log where the caller cannot read it.
	//
	// Do not add `scope` to the list of things the provider refuses. `options.scope.join(' ')`
	// runs only on the implicit-grant branch, and every client here uses `responseType: 'code'`,
	// where scope is written onto the grant unexamined and an absent one simply drops the key.
	//
	// The same caveat as the catch on POST /authorize: this is not only forged input. The
	// provider reads and writes KV throughout, so an outage answers 400 here and shows up as a
	// 4xx spike rather than a 5xx one. The reason reaches the log either way.
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
		// Error rather than warn, and the only catch in this file at that level. Adding it is what
		// took a provider outage from an uncaught 500 to a 400, so anything alerting on 5xx went
		// quiet at the same moment; the level is what is left to notice one by.
		//
		// The two catches on /authorize stay at warn deliberately, even though they absorb
		// infrastructure failures too. Both are reachable by anyone with no sign-in at all, so
		// raising them would let a stream of forged requests bury the outages this is meant to
		// surface. Reaching here costs a completed Google sign-in, which bounds that.
		console.error('completeAuthorization rejected the request:', reasonFor(error))
		return c.text('Invalid authorization request', 400)
	}

	return Response.redirect(redirectTo)
})

export { app as GoogleHandler }
