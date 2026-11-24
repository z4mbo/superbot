/**
 * Reads a product setting from the environment. `SUPERBOT_<name>` is the documented name; the
 * `RAKAZO_<name>` it replaced still works so existing installs and scripts keep their behavior.
 * An empty value counts as unset.
 */
export function brandEnv(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const current = env[`SUPERBOT_${name}`];
  if (current !== undefined && current !== "") return current;
  const legacy = env[`RAKAZO_${name}`];
  return legacy === "" ? undefined : legacy;
}
