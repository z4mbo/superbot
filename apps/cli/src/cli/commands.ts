/** The command line the `superbot` command accepts: commands, their arguments and options. */

export type OptionSpec = {
  long: string;
  /** The value's name in help; a flag without one takes no value. */
  value?: string;
  help?: string;
  env?: string;
  /** Another option this one needs, by long name. */
  requires?: string;
  /** Another option this one cannot be used with, by long name. */
  conflicts?: string;
};

export type ArgSpec = { name: string; required: boolean; variadic?: boolean; help?: string };

export type CommandSpec = {
  name: string;
  about: string;
  args: ArgSpec[];
  options: OptionSpec[];
  subcommands?: CommandSpec[];
  /** Whether a subcommand must be given. */
  subcommandRequired?: boolean;
};

/** Options every command accepts, before or after its name. */
export const GLOBAL_OPTIONS: OptionSpec[] = [
  { long: "server", value: "SERVER", env: "SUPERBOT_SERVER" },
  { long: "space", value: "SPACE", help: "Select a space by name", env: "SUPERBOT_SPACE" },
  { long: "json", help: "Print JSON instead of text" },
];

const conversationOptions: OptionSpec[] = [
  { long: "new-conversation", conflicts: "conversation" },
  { long: "conversation", value: "THREAD_ID" },
];

export const ROOT: CommandSpec = {
  name: "superbot",
  about: "Chat with your Superbot agents",
  args: [{ name: "AGENT", required: false, help: "Open a chat by agent name" }],
  options: [],
  subcommands: [
    {
      name: "server",
      about: "Show the current server or save a default for the app and both commands",
      args: [{ name: "URL", required: false }],
      options: [],
    },
    { name: "signup", about: "Create an account on the selected server", args: [], options: [] },
    {
      name: "login",
      about: "Sign in and save the session on this device",
      args: [],
      options: [
        { long: "email", value: "EMAIL" },
        { long: "code", help: "Sign in with a one-time email code" },
        {
          long: "password-stdin",
          help: "Read the password from standard input",
          requires: "email",
          conflicts: "code",
        },
      ],
    },
    {
      name: "logout",
      about: "Revoke and remove the saved session for this server",
      args: [],
      options: [],
    },
    { name: "whoami", about: "Show the signed-in account on this server", args: [], options: [] },
    { name: "list", about: "List available spaces and agents", args: [], options: [] },
    {
      name: "send",
      about: "Send one message and print the reply as it streams",
      args: [
        { name: "AGENT", required: true },
        {
          name: "MESSAGE",
          required: false,
          variadic: true,
          help: "The message; read from standard input when left out",
        },
      ],
      options: conversationOptions,
    },
    {
      name: "threads",
      about: "List an agent's conversations or print one",
      args: [],
      options: [],
      subcommandRequired: true,
      subcommands: [
        {
          name: "list",
          about: "List an agent's conversations",
          args: [{ name: "AGENT", required: true }],
          options: [],
        },
        {
          name: "show",
          about: "Print the latest messages of an agent's conversation",
          args: [
            { name: "AGENT", required: true },
            {
              name: "THREAD_ID",
              required: false,
              help: "A conversation ID from the list; the first conversation when left out",
            },
          ],
          options: [],
        },
      ],
    },
    {
      name: "approvals",
      about: "List the approvals waiting on you, or answer one",
      args: [],
      options: [],
      subcommands: [
        {
          name: "allow",
          about: "Allow the action once",
          args: [{ name: "ID", required: true }],
          options: [],
        },
        {
          name: "deny",
          about: "Deny the action",
          args: [{ name: "ID", required: true }],
          options: [],
        },
      ],
    },
    { name: "tui", about: "Open the full-screen chat", args: [], options: [] },
    {
      name: "workspaces",
      about: "Create, join, and manage workspaces",
      args: [],
      options: [],
      subcommandRequired: true,
      subcommands: [
        { name: "list", about: "List the workspaces on this account", args: [], options: [] },
        {
          name: "create",
          about: "Create a workspace with you as its only member",
          args: [{ name: "NAME", required: true }],
          options: [],
        },
        {
          name: "invite",
          about: "Create a single-use invite link for the selected workspace",
          args: [],
          options: [],
        },
        {
          name: "join",
          about: "Join the workspace in a Superbot invite link",
          args: [{ name: "LINK", required: true }],
          options: [],
        },
        {
          name: "members",
          about: "List the members and roles in the selected workspace",
          args: [],
          options: [],
        },
        { name: "leave", about: "Leave the selected shared workspace", args: [], options: [] },
      ],
    },
    {
      name: "import-bots",
      about: "Import agent names from a local JSON file into the selected Space",
      args: [{ name: "FILE", required: true }],
      options: [{ long: "dry-run" }],
    },
    {
      name: "chat",
      about: "Open a chat with any agent, including agents named after commands",
      args: [{ name: "AGENT", required: true }],
      options: conversationOptions,
    },
  ],
};
