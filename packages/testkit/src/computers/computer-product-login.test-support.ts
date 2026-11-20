import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { expect, vi } from "vitest";

export const LOGIN_ORIGIN = "https://127.0.0.1:8767";

const loginServer = `import hashlib
import html
import ssl
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def reply(self, page):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(page.encode())
    def do_GET(self):
        self.reply('<title>Fixture sign-in</title><form method="post">'
                   '<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">'
                   '<button>Sign in</button></form>')
    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length'])).decode()
        password = parse_qs(body).get('password', [''])[0]
        Path('login-receipt.txt').write_text(hashlib.sha256(password.encode()).hexdigest())
        self.reply('<title>Signed in</title><p>Echo: ' + html.escape(password) + '</p>')

server = HTTPServer(('127.0.0.1', 8767), Handler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain('fixture-site.pem', 'fixture-site-key.pem')
server.socket = tls.wrap_socket(server.socket, server_side=True)
server.serve_forever()
`;

// Chromium on Linux reads this user's NSS DB. Register just the ephemeral fixture CA.
// The image already ships NSS for Chromium, so the fixture needs no packages or network.
const trustFixtureCa = `from ctypes import CDLL, c_char_p, c_int, c_uint, c_ulong, c_void_p
from pathlib import Path

nss = CDLL('libnss3.so')
smime = CDLL('libsmime3.so')
def function(library, name, result, *args):
    fn = getattr(library, name)
    fn.restype, fn.argtypes = result, args
    return fn

db = Path.home() / '.pki' / 'nssdb'
db.mkdir(parents=True, exist_ok=True)
assert function(nss, 'NSS_InitReadWrite', c_int, c_char_p)(('sql:' + str(db)).encode()) == 0
pem = Path('fixture-ca.pem').read_bytes()
cert = function(smime, 'CERT_DecodeCertFromPackage', c_void_p, c_char_p, c_int)(pem, len(pem))
slot = function(nss, 'PK11_GetInternalKeySlot', c_void_p)()
assert cert and slot
if function(nss, 'PK11_NeedUserInit', c_int, c_void_p)(slot):
    assert function(nss, 'PK11_InitPin', c_int, c_void_p, c_char_p, c_char_p)(slot, None, b'') == 0
assert function(nss, 'PK11_ImportCert', c_int, c_void_p, c_void_p, c_ulong, c_char_p, c_int)(slot, cert, 0, b'Computer product fixture CA', 0) == 0
trust = (c_uint * 3)()
assert function(nss, 'CERT_DecodeTrustString', c_int, c_void_p, c_char_p)(trust, b'C,,') == 0
cert_db = function(nss, 'CERT_GetDefaultCertDB', c_void_p)()
assert function(nss, 'CERT_ChangeCertTrust', c_int, c_void_p, c_void_p, c_void_p)(cert_db, cert, trust) == 0
`;

export async function installLoginFixture(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
) {
  for (const [path, source] of [
    ["login-server.py", loginServer],
    ["trust-fixture-ca.py", trustFixtureCa],
    ["fixture-site.ext", "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n"],
  ] as const) {
    await sandbox.writeFile(computer, { path, content: new TextEncoder().encode(source) }, context);
  }
  await runFixtureCommand(
    sandbox,
    computer,
    context,
    [
      "umask 077",
      "openssl req -x509 -newkey rsa:2048 -nodes -subj '/CN=Computer fixture CA' -days 1 -addext basicConstraints=critical,CA:TRUE -keyout fixture-ca-key.pem -out fixture-ca.pem",
      "openssl req -new -newkey rsa:2048 -nodes -subj /CN=127.0.0.1 -keyout fixture-site-key.pem -out fixture-site.csr",
      "openssl x509 -req -in fixture-site.csr -CA fixture-ca.pem -CAkey fixture-ca-key.pem -days 1 -extfile fixture-site.ext -out fixture-site.pem",
      "rm fixture-ca-key.pem",
      "python3 trust-fixture-ca.py",
      "setsid -f python3 login-server.py > login-server.log 2>&1 < /dev/null",
    ].join(" && "),
  );
  await vi.waitFor(
    () =>
      runFixtureCommand(
        sandbox,
        computer,
        context,
        `curl --fail --silent --show-error --cacert fixture-ca.pem ${LOGIN_ORIGIN}/`,
      ),
    { timeout: 10_000 },
  );
}

export async function runFixtureCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  command: string,
) {
  let code: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(computer, { argv: ["bash", "-c", command] }, context)) {
    if (event.type === "exit") code = event.code;
    if (event.type === "stderr") stderr += event.data;
  }
  expect(code, stderr).toBe(0);
}
