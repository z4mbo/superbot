# superbot-site

Owned by design. Static files, no build step.

| File                      | What it is                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DESKTOP-DESIGN.md`       | The desktop app design: tokens, shell, chat, store, tool approvals, creator, review queue, multiplayer. Desktop UI work follows it.                |
| `index.html`              | Landing page. Its product mock is HTML with invented data, never a screenshot.                                                                     |
| `docs/`                   | Plugin developer docs: overview, quickstart, local development, build guides, examples, reference and errors.                                      |
| `connect/`                | Hosted copy only: sends the browser to a server the visitor runs (`assets/connect.js`). A server does not serve it.                                |
| `assets/`                 | `base.css` (tokens mirror the spec's section 3), `site.css` (shared, docs, connect), `landing.css`, `site.js`, `connect.js`, `logo.svg`, `fonts/`. |
| `NOTICE.txt`, `licenses/` | Notices for the adapted OpenMausBot icon and tokens (Apache-2.0), Lucide icons (ISC) and Geist fonts (OFL-1.1).                                    |

Preview: serve this folder with any static server on loopback, for example
`npx serve -l 5363 .`, and open `http://127.0.0.1:5363/`.

Rules: the status table on the landing page and section 0 of the spec change together,
whenever a capability changes state. Real screenshots stay outside the repository.
The web app serves this folder at `/welcome/`. Keep every link relative, except `/app`,
`/sign-in` and `/sign-up`, and load nothing from another origin.

Hosted copy: `node scripts/build-superbot-site.mjs` writes `dist/superbot-landing/` (the files
above except `README.md` and `DESKTOP-DESIGN.md`, app links pointed at `connect/`, `vercel.json`,
`MANIFEST.txt`). `pnpm checks` tests it. No inline scripts or styles: the hosted policy blocks them.
