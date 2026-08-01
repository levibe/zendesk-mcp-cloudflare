import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Tests sit next to the code they cover, so `pnpm run lint` and `tsc --noEmit`
		// already reach them without either one needing a second path to look at.
		include: ['src/**/*.test.ts'],
		// Undo spies and stubbed globals between tests here rather than leaving each file to
		// remember an afterEach. Both matter to this suite: it stubs `fetch` to keep the
		// client off the network, and silences the console.warn and console.error that the
		// retry and search paths emit. Timers are still each file's own to restore, since
		// vitest has no equivalent switch for them.
		restoreMocks: true,
		unstubGlobals: true,
		coverage: {
			provider: 'v8',
			// text and html are for reading locally. The text table is a summary, not the
			// whole picture: it omits files that are at 100% on all four metrics, so a
			// directory can print a middling percentage with its finished files nowhere in
			// the listing. `coverage.skipFull` does not switch that off — it reads the same
			// either way in 4.1.10. The html report has every file, so open that before
			// concluding something is uncovered.
			//
			// The two json reporters exist for CI rather than for people. The reporting
			// action requires json-summary for the totals, and reads json for the per-file
			// detail it puts in the pull request comment.
			reporter: ['text', 'html', 'json-summary', 'json'],
			// Write the reports even when the run fails. A failing suite is exactly when the
			// comment on the pull request has something to say, and without this the run
			// goes red having produced nothing to explain itself.
			reportOnFailure: true,
			// Report on all of src/, not just the files a test happened to import. Without
			// this, a module nobody tests is absent from the table rather than sitting in it
			// at 0% — which reads as "nothing to see here" for exactly the files that need
			// looking at. The number is meant to show where the holes are, so the untested
			// tools and the vendored OAuth code have to be in the denominator.
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts'],
		},
	},
})
