# Local evidence dashboard

Next.js and React provide a separate presentation layer. The core retains zero runtime dependencies. The button and dialog are adapted from shadcn/ui under MIT; the full notice is in SHADCN-LICENSE.txt. Radix handles focus trapping and dialog semantics, cmdk handles keyboard navigation, and Tailwind provides styling. Dependencies are locked in package-lock.json. No hosted service or analytics is configured.

```sh
cd apps/dashboard
npm ci --ignore-scripts
GENINVESTOR_HOME=/absolute/path/to/.geninvestor npm run dev
npm run typecheck
npm run build
```

The server reads a local SQLite ledger and local scan artifacts. A failed schema, source fingerprint or claim audit blocks the display. Clicking each numerical research line opens its exact linked fields, rights, retrieval time and hash. An empty workspace has no fabricated figures. Model notes remain in local replay records until independently reviewed; the UI displays deterministic audited evidence.

The default server binds to localhost. Keep it there: there is no authentication or multi-user authorization. Remote deployment is outside this local-only design.
