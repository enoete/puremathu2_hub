# Pure Math Unit 2 — course hub

The hub students land on for Pure Mathematics Unit 2. Same pipeline as the Computer Science hubs,
different course, different visual identity.

```
JSONBin ─► GitHub Action ─► fetches each topic URL ─► data/content.json ─► index.html
 (URLs)     (holds the key)   (reads og: + lesson: meta)  (committed, public)  (plain fetch, no key)
```

`scripts/sync.mjs` does the fetching and scraping — identical across every CFBC course, since the
lesson manifest contract is shared. `.github/workflows/sync.yml` runs it every six hours,
on push, and on manual dispatch. Secrets are `JSONBIN_KEY` and `JSONBIN_BIN_ID`; the repo variable
`JSONBIN_KEY_TYPE` switches between `master` and `access` header names.

Anything set explicitly in the bin (`title`, `blurb`, `tags`, `accent`) overrides what was scraped.
If a page is unreachable the previous metadata is kept rather than blanked.

`admin.html` is a local-only bin editor and is in `.gitignore` — it never gets published. Open it from
your own machine to load, edit and save the bin contents directly.

After pushing a topic page, refresh the hub's card by running:

```bash
gh workflow run "Sync course content" --repo enoete/puremathu2_hub
```
