import { createHmac } from "node:crypto";
import type { AppEnv } from "./env.js";
import type { RouterDeps } from "./router.js";

type RouterEnv = RouterDeps["env"];

/**
 * Every router setting the API reads under the same name. Listing them as required makes the
 * compiler reject a router env that forgets to pass one through, which the optional fields of
 * `RouterDeps["env"]` would otherwise accept silently.
 */
type PassedThrough = { [K in keyof RouterEnv & keyof AppEnv]-?: RouterEnv[K] };

/** The settings the API hands its router, read from the API's own env. */
export function routerEnv(env: AppEnv): RouterEnv & PassedThrough {
  return {
    inboundEmailDomain: env.inboundEmail?.domain,
    deploymentLabs: env.deploymentLabs,
    deploymentVoice: env.deploymentVoice,
    phoneCallsEnabled: env.phoneCallsEnabled,
    phoneCallRingSeconds: env.phoneCallRingSeconds,
    navLinks: env.navLinks,
    adminEmails: env.adminEmails,
    maxUploadSizeBytes: env.maxUploadSizeBytes,
    maxAttachmentsPerMessage: env.maxAttachmentsPerMessage,
    agentRuntime: env.agentRuntime,
    defaultProvider: env.defaultProvider,
    defaultModel: env.defaultModel,
    teamChatJudgeProvider: env.teamChatJudgeProvider,
    teamChatJudgeModel: env.teamChatJudgeModel,
    deploymentModelConfigured: env.deploymentModelConfigured,
    deploymentModelHostCredentials: env.deploymentModelHostCredentials,
    webOrigin: env.webOrigin,
    privacyPolicyUrl: env.privacyPolicyUrl,
    screenProxySecret: env.screenProxySecret,
    invitationRecipientKey: createHmac("sha256", env.authSecret)
      .update("organization-invitation-recipient")
      .digest("hex"),
    sandboxProvider: env.sandboxProvider,
    gitSha: env.gitSha,
    integrationsCatalogUrl: env.integrationsCatalogUrl,
    mcpAllowPrivateEndpoint: env.mcpAllowPrivateEndpoint,
    e2ePluginHosts: env.e2ePluginHosts,
    desktopHostChoiceEnabled: Boolean(env.desktopStackToken),
    computerSettingsEnabled: env.computerSettingsEnabled,
    mcpStdioEnabled: env.mcpStdioEnabled,
    mcpStdioAllowedCommands: env.mcpStdioAllowedCommands,
  };
}
