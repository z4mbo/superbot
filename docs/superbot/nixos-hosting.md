# Host Superbot on NixOS

The NixOS module starts Docker and the Superbot Compose stack at boot. Tailscale Serve terminates HTTPS and forwards the whole origin to the loopback web port. Every Mac and Windows PC uses that same HTTPS URL and signs in with its own Superbot account. A Space owner grants membership separately.

## Package your checkout

If you already have a Superbot NixOS source archive, skip to the transfer step. To produce one from the current commit, run this in PowerShell in the Superbot checkout.

```powershell
$revision = git rev-parse --short=12 HEAD
if ($LASTEXITCODE) { throw 'Cannot locate HEAD' }
$archive = Join-Path $env:TEMP "Superbot-NixOS-$revision.tar.gz"
git archive --format=tar.gz --output=$archive HEAD
if ($LASTEXITCODE) { throw 'Cannot archive source tree' }
Get-FileHash -Algorithm SHA256 -LiteralPath $archive
```

Transfer the archive privately to the NixOS host. On that host, start a root shell with `sudo -i`. Set `archive` to the transferred file's absolute path and compare its SHA-256 digest with the original before extracting.

```sh
archive=/path/to/Superbot-NixOS-REVISION.tar.gz
sha256sum "$archive"
install -d -m 0755 /srv/superbot /srv/superbot/r1
tar --extract --gzip --file="$archive" --directory=/srv/superbot/r1 --no-same-owner
chmod -R go-w /srv/superbot/r1
ln -s /srv/superbot/r1 /srv/superbot/current
install -m 0644 /srv/superbot/r1/infra/superbot/nixos.nix /etc/nixos/superbot.nix
```

Add these entries to `/etc/nixos/configuration.nix`. Append `./superbot.nix` to the existing `imports` list. For a Git-backed flake, put the module alongside the machine configuration and add it to the flake's Git index so Nix can see it.

```nix
imports = [ ./superbot.nix ];
services.superbot.enable = true;
```

```sh
nix-instantiate --parse /etc/nixos/superbot.nix >/dev/null
nixos-rebuild dry-build
nixos-rebuild switch
tailscale up
tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'
```

Use a supported NixOS release whose Docker package includes Compose 2.24.4 or later and whose Node 24 package is at least 24.15. The DNS lookup above uses `jq`, available through `nix-shell -p jq` if needed. Enable MagicDNS and HTTPS certificates for the tailnet. Allow the intended devices or identities to reach TCP 443 on this host in your tailnet policy. Use a host that has HTTPS port 443 available for Serve. Keep the Docker socket and the service's loopback port private. See [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Initialize and start

Replace the example origin with the host's exact MagicDNS HTTPS origin. Keep the same port in both commands. On the first start, Compose builds the app from the staged source, starts Postgres, initializes application storage and runs migrations before admitting traffic to the API. Subsequent boots also run Compose `up --build` and can need registry access if the local build cache is cold.

```sh
superbot-host init --port 5173 --origin https://superbot.example-tailnet.ts.net
systemctl start superbot
superbot-host status
tailscale serve --bg http://127.0.0.1:5173
tailscale serve status
```

Serve saves its HTTPS configuration across daemon restarts and reboots. Check that its status shows a tailnet-only endpoint and the same origin saved by `init`. Open that URL on a connected Mac and Windows PC. Use it as the server address in the desktop app, the `superbot` command and all Space invites. If you already use another private HTTPS reverse proxy, set `services.superbot.tailscale.enable = false` and point that proxy at the same loopback port.

The generated credentials and origin live in `/var/lib/superbot/host.env`, owned by `root:root` with mode `0600`. Keep it out of your Nix expression, source snapshot and flake. The `init` command refuses to overwrite it. For an origin change, edit `WEB_ORIGIN` and `BETTER_AUTH_URL` together, then restart the service and reissue old invite links.

## Accounts and email

HTTPS initialization closes public signup. In a Bash root shell, run the following for each intended account. Enter passwords of at least 16 characters. This provisions a verified account and its Personal Space. Then invite that account to your shared Space from Space settings and send the single-use link privately.

```bash
read -r -p 'Account email: ' OWNER_EMAIL
read -r -s -p 'Account password: ' OWNER_PASSWORD
echo
export OWNER_EMAIL OWNER_PASSWORD
superbot-host account
unset OWNER_EMAIL OWNER_PASSWORD
```

For email invites, edit `/var/lib/superbot/host.env` as root and replace `EMAIL_PROVIDER=none` with the following settings. Restart with `systemctl restart superbot`. To allow recipients to register, set `SIGNUPS_ENABLED=true` with an explicit `SIGNUP_ALLOWLIST`. See [account policies](../self-host-accounts.md).

```dotenv
EMAIL_PROVIDER=smtp
SMTP_URL=smtps://smtp-user:percent-encoded-password@smtp.example.com:465
EMAIL_FROM=superbot@example.com
```

To let a verified account review community plugins, add its email to `SUPERBOT_ADMIN_EMAILS` in the same private environment file and restart the service. This gives that account deployment-wide admin access. [Registry roles and permissions](plugin-contract.md)

The database migrations publish **Calorie diary** (`kcal-diary`) and **T3 Code inbox**
(`t3-code-inbox`) in the Store when their respective identifiers are available.
Existing publishers retain their identifiers and releases. Each member chooses
which apps to install in each Space and which parts to grant to individual bots.
Diary entries, coding requests and dispatch receipts are stored in PostgreSQL and
included in the database backup. The coding inbox can collect requests before a
member connects a T3 Code instance and chooses a project for the work.

The Store also offers direct service connections on a fresh host. Each member can
open the connection form before the operator configures a managed catalog.
[External app setup and provider requirements](hosting.md#connect-external-apps)

## Connect Mac and Windows

Install the `superbot` command on each device ([desktop and terminal tools](desktop.md)), connect both devices to the tailnet, then run the following in each terminal. Use the HTTPS origin reported by `tailscale serve status`. In the desktop app, choose **Existing instance** and enter the same origin. Sign in with the same Superbot account on both devices to open the same Spaces.

```sh
superbot server https://superbot.example-tailnet.ts.net
superbot login
superbot
```

To bring an existing list of bot names into the shared Space, run the import from **one** client. Replace the example Space and filename with yours. The preview lists existing and missing names. The second command creates the missing bots with server defaults. Both clients will then see them.

```sh
superbot --space "Shared Space" import-bots roster.json --dry-run
superbot --space "Shared Space" import-bots roster.json
```

## Back up and upgrade

Run these commands from a root shell. Stop the stack before taking a cold backup so Postgres and application files are captured together. The service allows up to 55 minutes for Compose to stop, including worker drain. Keep the backup on private encrypted storage. The volume names below assume the module's fixed Compose project name, `superbot`.

```sh
set -eu
umask 077
mkdir -p /var/backups
backup=$(mktemp -d /var/backups/superbot.XXXXXXXX)
systemctl stop superbot
running=$(docker ps -q --filter label=com.docker.compose.project=superbot)
test -z "$running"
install -m 0600 /var/lib/superbot/host.env "$backup/host.env"
readlink -f /srv/superbot/current > "$backup/source-path"
for volume in postgres pgdata appdata webassets; do
  docker volume inspect "superbot_$volume" >/dev/null
  docker run --rm --mount "type=volume,src=superbot_$volume,dst=/volume,readonly" \
    busybox:1 tar -C /volume -czf - . > "$backup/$volume.tar.gz"
  tar -tzf "$backup/$volume.tar.gz" >/dev/null
done
printf 'Backup saved in %s\n' "$backup"
```

Stage the new archive in a fresh root-owned directory, such as `/srv/superbot/r2`, using the same extraction commands. Keep the old release and its archive. With the service stopped, switch the source and start it with the same secret file and Compose project. If the module itself changed, also install its new copy and run `nixos-rebuild switch` after switching the source.

```sh
ln -s /srv/superbot/r2 /srv/superbot/current.next
mv -Tf /srv/superbot/current.next /srv/superbot/current
systemctl start superbot
superbot-host status
superbot-host logs
journalctl -u superbot -b --no-pager
```

For a standalone backup, restart without switching the source. Keep old archives and backups together so a recorded source path is recoverable. Keep Compose volumes when stopping the service and avoid `docker compose down -v` and volume pruning.

## Enable isolated agent computers

Upgrade using the cold backup and source-switch procedure above. Keep the existing Compose project and `host.env`. The NixOS service uses the opt-in from that file and needs no module change.

Restricted egress uses `INPUT` and `DOCKER-USER` rules scoped to the agent computer bridges. Review the IPv4 and IPv6 commands with `bash infra/compose/restrict-computer-egress.sh --print` on the staged Linux host. Keep Docker on its iptables firewall backend.

Set `services.superbot.computerFirewall.enable = true;` in the host's NixOS configuration. Copy the updated Superbot module to its import location and run `nixos-rebuild dry-build` followed by `nixos-rebuild switch` during the upgrade. The module installs `superbot-computer-egress.service`, orders it after Docker and before Superbot, and reapplies its rules on firewall reload and Docker restart. Check `systemctl status superbot-computer-egress.service` and run the isolated test below before enabling computers for the shared Space. Hosts that already manage equivalent rules can keep their existing configuration.

After the firewall rules are in place and the old stack is stopped, set `SUPERBOT_COMPUTERS_ENABLED=true` in `/var/lib/superbot/host.env`. Keep that file root-owned and mode `0600`, with the separate supervisor token generated by `init`. Switch the source as above, then run:

```sh
systemctl start superbot
superbot-host status
superbot-host egress
```

The egress report must say the host firewall rules were verified. A healthy Compose stack alone only confirms the supervisor is listening. Use the disposable check below for computer and screen tests.

For remote viewing, preserve the public `Host` and set `X-Forwarded-Proto` to `https` at the trusted HTTPS proxy. The screen handoff and WebSocket origin checks use the address the client opened. Each viewer opens **Watch** from its own signed-in session. Existing agents with computer use disabled can enable it individually from their **Computer** tab.

### Isolated computer readiness check

On a Linux Docker host with the rules already installed, run from the staged source with Node and Compose on the path. Use an unused loopback port. Leave the live stack and Tailscale Serve configuration alone.

```sh
set -eu
umask 077
fixture=$(mktemp -d)
project=superbot-computers-qa-$(date +%s)-$$
port=55783
node infra/superbot/host.mjs init --env "$fixture/host.env" --project "$project" --port "$port"
printf '%s\n' SUPERBOT_COMPUTERS_ENABLED=true >> "$fixture/host.env"
host() { node infra/superbot/host.mjs "$@" --env "$fixture/host.env" --project "$project"; }
host up
host status
host egress
```

Open `http://127.0.0.1:55783` locally or through an SSH loopback forward to that port. Sign up with a synthetic account and create two agents. Start each agent's **Computer**, wait for its desktop, and check that input works. Create a marker in one computer's home and check that the other cannot see it. Verify that each shows its own desktop after refresh. From a separate synthetic account with no Space membership, check that the first account's agent and screen cannot be opened. Check the sandbox containers with `docker inspect` using only the IDs of those two fixture computers. Each should have a different `rakazo-computer-*` network, no published ports, `Privileged=false`, all capabilities dropped and no socket mount. From one fixture desktop verify a public HTTPS page loads and connections to the Docker bridge gateway and cloud metadata address fail.

Stop both computers in the fixture UI and run `host down`. For complete fixture removal, identify the two fixture computers in Docker by their recorded IDs and remove only those stopped containers. Remove only networks belonging to those computers and volumes with the fixture's exact `com.docker.compose.project` label. Delete the disposable environment file. Never prune host-wide resources.

## Private rollback

On a dedicated Serve endpoint, run `tailscale serve --https=443 off` to take it offline during recovery. Stop the stack with `systemctl stop superbot`. If a failed startup left containers behind, run `superbot-host down` while the current source is still selected.

If the new release's database migrations support the old release, switch the symlink back using the same `ln -s` and `mv -Tf` commands, then start the service with the existing data. Otherwise restore the pre-upgrade backup with the matching source. This discards writes made since that backup. First save a separate cold backup of the current volumes. Set `backup` to the chosen pre-upgrade snapshot. Run the following only after checking the snapshot and selecting its recorded source.

```sh
set -eu
backup=/var/backups/superbot.REPLACE_ME
test "$(readlink -f /srv/superbot/current)" = "$(cat "$backup/source-path")"
for volume in postgres pgdata appdata webassets; do
  tar -tzf "$backup/$volume.tar.gz" >/dev/null
done
install -m 0600 "$backup/host.env" /var/lib/superbot/host.env
docker volume rm superbot_postgres superbot_pgdata superbot_appdata superbot_webassets
for volume in postgres pgdata appdata webassets; do
  docker volume create --label com.docker.compose.project=superbot \
    --label "com.docker.compose.volume=$volume" "superbot_$volume"
  docker run --rm -i --mount "type=volume,src=superbot_$volume,dst=/volume,volume-nocopy" \
    busybox:1 tar -C /volume -xpzf - < "$backup/$volume.tar.gz"
done
systemctl start superbot
superbot-host status
tailscale serve --bg http://127.0.0.1:5173
```
