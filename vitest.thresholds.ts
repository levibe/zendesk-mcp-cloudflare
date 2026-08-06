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
 * The registry, the transport, the OAuth handler and the worker factory carry
 * their thresholds in @levibe/mcp-worker, where the code moved. What remains
 * here is what this repo still decides, and which metrics each module pins:
 *
 * - The response reshapers are wholly covered, so they pin all four and any
 *   drop is a regression rather than a rounding artefact. The search response
 *   helper is the exception: it pins the other three at 100 and holds branches
 *   lower, because its reshaping has arms no fixture has reached yet.
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
	// With the transport gone to the package, the client is the constructor, the id check, and
	// the long tail of thin senders — and the #54 prototype walk drives every one of those
	// methods, which is what holds statements and functions at 100 structurally rather than by
	// effort. Branches sit lower for the constructor's config-or-env fallback arms; measured 90
	// at the split, but that is 19 of 21 arms, so a single new arm costs almost five points —
	// the floor sits one branch under the measurement, which is slack, not coverage given up.
	'src/zendesk-client.ts': { statements: 100, branches: 85, functions: 100, lines: 100 },
	'src/tools/help-center.ts': { branches: 85 },
}
