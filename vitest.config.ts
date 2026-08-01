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
	},
})
