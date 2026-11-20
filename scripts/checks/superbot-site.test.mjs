// The hosted copy of superbot-site/: the connect page's address check, its destination, and the
// payload scripts/build-superbot-site.mjs writes. Offline; builds into a temporary folder.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { destination, serverOrigin } from "../../superbot-site/assets/connect.js";
import { buildSite, PUBLIC_FILES, SERVER_FILES, SITE } from "../build-superbot-site.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(path.join(tmpdir(), "superbot-site-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

test("the connect page accepts server addresses as the URL parser reads them", () => {
  const accepted = [
    ["https://superbot.example.com", "https://superbot.example.com"],
    ["https://superbot.example.com:8443", "https://superbot.example.com:8443"],
    ["https://superbot.example.com:443", "https://superbot.example.com"],
    ["https://superbot.example.com/app/chat?x=1#top", "https://superbot.example.com"],
    ["superbot.example.ts.net", "https://superbot.example.ts.net"],
    ["superbot.example.ts.net:8443", "https://superbot.example.ts.net:8443"],
    ["superbot.example.ts.net/sign-in", "https://superbot.example.ts.net"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    ["bücher.example", "https://xn--bcher-kva.example"],
    ["https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["[2001:db8::1]", "https://[2001:db8::1]"],
    ["superbot.example.com.", "https://superbot.example.com"],
    ["HTTPS://Superbot.Example.COM", "https://superbot.example.com"],
    ["  superbot.example.com \n", "https://superbot.example.com"],
    ["//superbot.example.com", "https://superbot.example.com"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:3000/app", "http://127.0.0.1:3000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["HTTP://LOCALHOST", "http://localhost"],
    ["http://localhost.:5173", "http://localhost:5173"],
  ];
  for (const [input, origin] of accepted) {
    assert.deepEqual(serverOrigin(input), { ok: true, origin }, JSON.stringify(input));
  }
});

test("the connect page refuses addresses it cannot open safely", () => {
  const refused = [
    ["", "empty"],
    ["   ", "empty"],
    [undefined, "empty"],
    ["http://superbot.example.com", "http"],
    ["http://superbot.example.ts.net:8080", "http"],
    ["http://192.168.1.10", "http"],
    ["https://user:pass@superbot.example.com", "credentials"],
    ["https://user@superbot.example.com", "credentials"],
    ["user@superbot.example.com", "credentials"],
    ["user:pass@superbot.example.com", "credentials"],
    ["https://good.example@evil.example", "credentials"],
    ["https://@evil.example", "credentials"],
    ["javascript:alert(1)", "scheme"],
    ["JavaScript:alert(1)", "scheme"],
    ["data:text/html,<p>hi</p>", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["ftp://superbot.example.com", "scheme"],
    ["superbot://open", "scheme"],
    ["ws://superbot.example.com", "scheme"],
    ["https://evil.example\\@good.example", "invalid"],
    ["https:\\\\evil.example", "invalid"],
    ["https://superbot.example.com\\", "invalid"],
    ["https://super bot.example.com", "invalid"],
    ["superbot.example.com\tx", "invalid"],
    ["https://superbot.example.com\u0000", "invalid"],
    ["https://exa​mple.com", "invalid"],
    ["https://example.com‮", "invalid"],
    ["https://", "invalid"],
    ["https://.", "invalid"],
    ["https://:443", "invalid"],
    ["superbot.example.com:99999", "invalid"],
    ["https://a<b.example", "invalid"],
    ["%%%", "invalid"],
    ["???", "invalid"],
  ];
  for (const [input, reason] of refused) {
    assert.deepEqual(serverOrigin(input), { ok: false, reason }, JSON.stringify(input));
  }
});

test("the connect page opens only the three app paths", () => {
  const cases = [
    ["?next=app", "/app"],
    ["?next=sign-in", "/sign-in"],
    ["?next=sign-up", "/sign-up"],
    ["", "/app"],
    ["?next=", "/app"],
    ["?next=Sign-In", "/app"],
    ["?next=/sign-in", "/app"],
    ["?next=//evil.example", "/app"],
    ["?next=https://evil.example/app", "/app"],
    ["?next=javascript:alert(1)", "/app"],
    ["?next=__proto__", "/app"],
    ["?next=constructor", "/app"],
    ["?next=sign-in%00", "/app"],
    ["?server=evil.example&next=sign-up", "/sign-up"],
  ];
  for (const [search, path] of cases) assert.equal(destination(search), path, search);
});

test("the hosted copy serves what a server serves at /welcome/", () => {
  const text = readFileSync(path.join(root, "apps/web/server/welcome.ts"), "utf8");
  const list = /const publicFiles = \[([^\]]*)\];/.exec(text);
  assert.ok(list, "apps/web/server/welcome.ts no longer declares publicFiles; update this check");
  assert.deepEqual(
    [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]),
    SERVER_FILES,
  );
});

const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const toPosix = (file) => file.split(path.sep).join("/");
const siteFiles = () =>
  globSync("**/*", { cwd: SITE, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(path.relative(SITE, path.join(entry.parentPath, entry.name))))
    .sort();

test("the payload holds exactly the allowlisted files, with app links sent to connect", () => {
  const sourceBefore = new Map(siteFiles().map((file) => [file, sha(path.join(SITE, file))]));
  const out = path.join(scratch, "payload");
  const manifest = buildSite({ out });

  const allowlisted = new Set(
    PUBLIC_FILES.flatMap((pattern) => globSync(pattern, { cwd: SITE }).map(toPosix)),
  );
  const published = globSync("**/*", { cwd: out, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => toPosix(path.relative(out, path.join(entry.parentPath, entry.name))))
    .sort();
  assert.deepEqual(published, [...allowlisted, "MANIFEST.txt", "vercel.json"].sort());
  for (const internal of ["README.md", "DESKTOP-DESIGN.md"]) {
    assert.ok(!published.includes(internal), internal);
  }
  assert.ok(!published.some((file) => /(^|\/)\.|\.map$|\.md$/.test(file)));

  const lines = readFileSync(path.join(out, "MANIFEST.txt"), "utf8").trimEnd().split("\n");
  assert.deepEqual(
    lines,
    manifest.map(({ file }) => {
      const contents = readFileSync(path.join(out, file));
      return `${sha(path.join(out, file))}  ${contents.length}  ${file}`;
    }),
  );
  assert.deepEqual(
    manifest.map(({ file }) => file),
    published.filter((file) => file !== "MANIFEST.txt"),
  );

  const landing = readFileSync(path.join(out, "index.html"), "utf8");
  const hrefs = (html) => [...html.matchAll(/href="(\/[^"]*)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(hrefs(landing), [
    "/connect/?next=app",
    "/connect/?next=app",
    "/connect/?next=sign-in",
    "/connect/?next=sign-in",
    "/connect/?next=sign-up",
  ]);
  for (const page of globSync("docs/*.html", { cwd: out })) {
    assert.deepEqual(hrefs(readFileSync(path.join(out, page), "utf8")), ["/connect/?next=sign-in"]);
  }
  assert.deepEqual(hrefs(readFileSync(path.join(out, "connect/index.html"), "utf8")), []);

  // The tracked sources keep the routes a self-hosted server answers.
  assert.deepEqual(
    new Map(siteFiles().map((file) => [file, sha(path.join(SITE, file))])),
    sourceBefore,
  );
  assert.deepEqual(hrefs(readFileSync(path.join(SITE, "index.html"), "utf8")), [
    "/app",
    "/app",
    "/sign-in",
    "/sign-in",
    "/sign-up",
  ]);

  const config = JSON.parse(readFileSync(path.join(out, "vercel.json"), "utf8"));
  assert.deepEqual(Object.keys(config).sort(), [
    "cleanUrls",
    "framework",
    "headers",
    "redirects",
    "trailingSlash",
  ]);
  assert.equal(config.trailingSlash, true);
  for (const { source, destination } of config.redirects) {
    assert.match(destination, /^\/connect\/\?next=(app|sign-in|sign-up)$/, source);
  }
  // The host adds the trailing slash first and then matches a source exactly.
  const hosted = (pathname) => {
    const slashed = pathname.endsWith("/") ? pathname : `${pathname}/`;
    for (const { source, destination } of config.redirects) {
      assert.match(source, /^\/[a-z-]+\/(:path\(\.\*\))?$/, source);
      const pattern = source.replace(":path(.*)", ".*");
      if (new RegExp(`^${pattern}$`).test(slashed)) return destination;
    }
    return slashed;
  };
  for (const [pathname, lands] of [
    ["/sign-in", "/connect/?next=sign-in"],
    ["/sign-up", "/connect/?next=sign-up"],
    ["/app", "/connect/?next=app"],
    ["/app/", "/connect/?next=app"],
    ["/app/chat/123", "/connect/?next=app"],
    ["/app/chat/123/", "/connect/?next=app"],
    ["/connect", "/connect/"],
    ["/docs", "/docs/"],
    ["/application", "/application/"],
    ["/sign-in/extra", "/sign-in/extra/"],
  ]) {
    assert.equal(hosted(pathname), lands, pathname);
  }
  const headers = Object.fromEntries(
    config.headers[0].headers.map(({ key, value }) => [key, value]),
  );
  assert.equal(config.headers[0].source, "/(.*)");
  assert.equal(headers["Referrer-Policy"], "no-referrer");
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  const policy = headers["Content-Security-Policy"];
  for (const directive of [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self'",
    "connect-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ]) {
    assert.ok(policy.split("; ").includes(directive), directive);
  }
  assert.doesNotMatch(policy, /unsafe|https?:|\*/);
});

function fixture(name, files) {
  const source = path.join(scratch, name);
  const base = {
    "index.html": '<a href="docs/">Docs</a> <a class="btn" href="/sign-in">Sign in</a>',
    "NOTICE.txt": "Notices",
    "licenses/MIT.txt": "MIT",
    "docs/index.html": '<a href="../">Home</a>',
    "assets/site.css": 'body { background: url("logo.svg"); }',
    "connect/index.html": '<script type="module" src="../assets/connect.js"></script>',
  };
  for (const [file, contents] of Object.entries({ ...base, ...files })) {
    if (contents === null) continue;
    mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    writeFileSync(path.join(source, file), contents);
  }
  return () => buildSite({ source, out: path.join(scratch, `${name}-out`) });
}

test("the payload build refuses what must not be published", () => {
  assert.doesNotThrow(fixture("clean", {}));
  const refusals = [
    ["unknown-link", { "index.html": '<a href="/admin">Admin</a>' }, /\/admin/],
    ["unquoted-link", { "index.html": "<a href=/admin>Admin</a>" }, /\/admin/],
    ["protocol-relative", { "docs/index.html": '<a href="//evil.example/">x</a>' }, /evil/],
    [
      "remote-script",
      { "index.html": '<script src="https://cdn.example/x.js"></script>' },
      /another origin/,
    ],
    [
      "remote-style",
      { "index.html": '<link rel="stylesheet" href="https://cdn.example/x.css">' },
      /another origin/,
    ],
    ["inline-script", { "index.html": "<script>alert(1)</script>" }, /inline <script>/],
    ["inline-style", { "index.html": '<p style="color:red">x</p>' }, /inline style/],
    ["style-element", { "docs/index.html": "<style>p{}</style>" }, /<style>/],
    ["handler", { "index.html": '<img src="a.png" onerror="x()">' }, /onerror/],
    ["css-import", { "assets/site.css": '@import "x.css";' }, /@import/],
    [
      "css-remote",
      { "assets/site.css": "a { background: url(https://cdn.example/a.png) }" },
      /relative/,
    ],
    ["env-file", { "assets/production.env.txt": "TOKEN=placeholder" }, /must not be published/],
    ["missing-pattern", { "licenses/MIT.txt": null }, /licenses\/\*\.txt matches no file/],
  ];
  for (const [name, files, message] of refusals) {
    assert.throws(fixture(name, files), message, name);
  }
});

test("the payload rewrites app links in unquoted and single-quoted attributes", () => {
  fixture("app-links", {
    "index.html": "<A HREF = /sign-in>Sign in</A> <a title=\"Open >\" href='/app'>Open</a>",
  })();
  assert.equal(
    readFileSync(path.join(scratch, "app-links-out/index.html"), "utf8"),
    '<A HREF = "/connect/?next=sign-in">Sign in</A> <a title="Open >" href=\'/connect/?next=app\'>Open</a>',
  );
});

test("the payload build never writes inside the site", () => {
  assert.throws(() => buildSite({ out: SITE }), /outside the site/);
  assert.throws(() => buildSite({ out: root }), /outside the site/);
  assert.throws(() => buildSite({ out: path.join(SITE, "dist") }), /outside the site/);
});
