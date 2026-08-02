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
 * - The three utils are wholly covered, so they pin all four. Any drop is a
 *   regression rather than a rounding artefact.
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
	'src/zendesk-client.ts': { branches: 85 },
	'src/tools/help-center.ts': { branches: 75 },
}
