# End-to-end tests

The Playwright specs arrive in Phase 2 and later. They run locally only, in a visible (headed) Chromium window, against a production build that `pnpm test:e2e` starts itself with `pnpm build && pnpm start` (see `playwright.config.ts`); they are not part of `pnpm test` and are never pointed at a deployment.
