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
 * - The three utils and the OAuth handler are wholly covered, so they pin all
 *   four. Any drop is a regression rather than a rounding artefact.
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
	'src/utils/error-handling.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	'src/utils/search-response.ts': {
		statements: 100,
		branches: 85,
		functions: 100,
		lines: 100,
	},
	'src/utils/support-response.ts': {
		statements: 100,
		branches: 100,
		functions: 100,
		lines: 100,
	},
	// Raised from 85 with #54, which drives every method on the client rather than the handful
	// a test had reached by name. Measured 92 at the time.
	'src/zendesk-client.ts': { branches: 90 },
	'src/tools/help-center.ts': { branches: 75 },
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
