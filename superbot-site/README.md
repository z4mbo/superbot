# superbot-site

Owned by design. Static files, no build step.

| File                      | What it is                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DESKTOP-DESIGN.md`       | The GPUI desktop app spec: tokens, shell, chat, store, tool approvals, creator, review queue, multiplayer. GPUI work follows it. |
| `index.html`              | Landing page. Its product mock is HTML with invented data, never a screenshot.                                                   |
| `docs/`                   | Plugin developer docs: guide, manifest reference, review/install/grants, `superbot-plugin` commands, registry API.               |
| `assets/`                 | `site.css` (tokens mirror the spec's section 3), `site.js` (theme, copy buttons, docs nav), `logo.svg`.                          |
| `NOTICE.txt`, `licenses/` | Notices for the adapted OpenMausBot icon and tokens (Apache-2.0) and Lucide icons (ISC).                                         |

Preview: serve this folder with any static server on loopback, for example
`npx serve -l 5363 .`, and open `http://127.0.0.1:5363/`.

Rules: the status table on the landing page and section 0 of the spec change together,
whenever a capability changes state. Real screenshots stay outside the repository.
Nothing here is published until someone decides to.
