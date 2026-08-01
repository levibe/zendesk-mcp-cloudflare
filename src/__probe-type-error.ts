// Temporary: deliberately fails `tsc --noEmit` so CI's Type check step goes red
// before the tests run. Used to observe whether coverage-report still executes.
export const probe: number = 'this is not a number'
