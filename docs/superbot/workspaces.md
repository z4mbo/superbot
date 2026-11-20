# Personal and shared workspaces

Every account starts with its own **Personal** Space. Workspaces live on the selected Superbot server. Sign in with the same account on another device to reach the same Spaces. A device's selected Space can differ.

## Web

After creating an account, open **Workspaces** to use Personal, create a workspace, or paste an invite link. Existing accounts can find **Workspaces** in the account menu or open `/workspaces` on their server.

A new workspace starts with its creator as its only member. Open **People**, then **Invite** and **Copy invite link**. The recipient can sign in with an existing account, review the named workspace, and join. Open **People** again to review membership. Share an additional workspace to keep Personal private. The link grants access to the named Space only. Workspace setup and membership work before you connect a model.

## Desktop

A new account first chooses between **Create a workspace**, **Join with an invite**, and continuing in Personal. Before signing in, choose **Join with an invite link** and paste the link. A copied link fills in automatically. The link selects its server, and the invite opens after you sign in or create an account. Signed-in people use **Join with an invite…** from the Space menu. A new workspace opens on **People**, where its owner invites others. The desktop reopens the last Space each account used on each server.

## Terminal

```sh
superbot --server https://superbot.example.com login
superbot --server https://superbot.example.com workspaces create "Weekend plans"
superbot --server https://superbot.example.com workspaces invite --space "Weekend plans"
superbot workspaces join "<invite URL>"
superbot --server https://superbot.example.com workspaces list
superbot --server https://superbot.example.com workspaces members --space "Weekend plans"
superbot --server https://superbot.example.com workspaces leave --space "Weekend plans"
```

Join uses the server in the link and that server's saved session. Specify a workspace ID from the list when two Spaces have the same name. Members can see the Space roster. Invite creation and cancellation require Space-owner access. An invite can be claimed once within seven days. The person who claimed it can reopen it as long as they are still a member. After leaving, get a fresh link to rejoin.

## Self-hosted access

Share the HTTPS address configured as the deployment's web origin. Every participant must be able to reach it, for example by being on the same tailnet when the address is private. The tailnet provides network access. Superbot keeps workspace data on your chosen server and enforces membership there.
