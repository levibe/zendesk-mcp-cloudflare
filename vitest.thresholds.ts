/**
 * Per-file coverage thresholds, deliberately kept out of `vitest.config.ts`.
 *
 * They live here because of how the reporting action on CI reads them. It does
 * not parse the config: it runs regexes over the raw file text, one per metric,
 * takes the first match anywhere in the file and presents it as a target for
 * the whole project. Glob keys mean nothing to it. With these entries in the
 * config, it read the first block below and captioned every overall metric with
 * a 100% target, marking all four red — the exact opposite of the intent, since
 * there is no global threshold here and deliberately so.
 *
 * Moved out, those regexes find nothing, the comment shows the percentages with
 * no target beside them, and Vitest enforces every entry below exactly as it did
 * before. Nothing is hidden: the gate is real, and CI goes red when it trips.
 *
 * Keep the numbers in this file rather than moving them back.
 *
 * Which metrics each module pins, and why:
 *
 * - Most of the utils and the OAuth handler are wholly covered, so they pin all
 *   four. Any drop is a regression rather than a rounding artefact. The search
 *   response helper is the exception: it pins the other three at 100 and holds
 *   branches lower, because its reshaping has arms no fixture has reached yet.
 * - The client and the hierarchy walk pin branches alone. Their statement counts
 *   are held down by a long tail of thin methods, so a floor there would move
 *   whenever a method was added rather than when a decision stopped being
 *   tested. Branches track the thing worth protecting.
 *
 * Every number is the measured value rounded down, with enough slack that
 * unrelated work does not trip it. They ratchet against erosion; they are not a
 * target to climb. Raise one when real coverage lands. Say so in the commit when
 * you lower one, because that is coverage being given up.
 */
export const coverageThresholds = {
	// The decode helper decides — try the bytes as UTF-8, fall back to the legacy format —
	// and the fallback is what keeps year-old approval cookies readable, so losing its test
	// would be losing the rollout guarantee, not a number.
	'src/utils/base64.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	'src/utils/error-handling.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	'src/utils/search-response.ts': {
		statements: 100,
		branches: 95,
		functions: 100,
		lines: 100,
	},
	'src/utils/support-response.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	// The two halves of the publication policy: what a config resolves to, and what a ceiling
	// publishes. Both are small and decide everything about which tools a client is offered,
	// so any drop here is a regression in the security boundary rather than a rounding
	// artefact.
	'src/utils/tool-ceilings.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	'src/utils/tool-registry.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	// The transport, split out of the client with #93 and carrying the branch coverage the old
	// { branches: 90 } on zendesk-client.ts was really protecting: the retry decisions, the
	// deadline arithmetic, the Retry-After handling. Measured 94 at the split; the uncovered
	// arms are the not-a-URL redirect Location, the non-Error rethrow, and the unreachable
	// throw ending the retry loop.
	'src/utils/http-client.ts': { branches: 90, functions: 100 },
	// With the transport gone, the client is the constructor, the id check, and the long tail
	// of thin senders — and the #54 prototype walk drives every one of those methods, which is
	// what holds statements and functions at 100 structurally rather than by effort. Branches
	// sit lower for the constructor's config-or-env fallback arms; measured 90 at the split.
	'src/zendesk-client.ts': { statements: 100, branches: 85, functions: 100, lines: 100 },
	'src/tools/help-center.ts': { branches: 85 },
	// From nothing at all, with the first tests this file has ever had — its three routes, the
	// Google exchange and the consent URL it builds.
	//
	// It pins 100 on branches, which it could not do while the "what did this throw" ternary was
	// written out at each of five catch sites: `atob`, `JSON.parse` and `btoa` all throw real
	// Errors, so four of those five pairs had an arm nothing could reach. Behind one `reasonFor`
	// helper there is a single pair, and the provider stub throwing a bare string covers it. Do
	// not read the 100 as every path being exercised — see the note on POST /authorize, where
	// the module mock makes coverage report a guarded and an unguarded route identically.
	'src/google-handler.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
}
