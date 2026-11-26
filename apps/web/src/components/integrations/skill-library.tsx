import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import type { AgentSkillLibraryEntry } from "@rakazo/contracts";
import { parseSkillMd } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ChevronLeft } from "lucide-react";
import { useSave, useSpaceQueries } from "../../lib/query/query";
import { errorDetails } from "../../lib/query/user-error";
import { ErrorNotice } from "../ErrorNotice";
import { PluginLogo } from "./plugin-marketplace";

/** A first-party skill from Browse: what it does, its steps, and adding it as the user's own skill. */
export function LibrarySkillDetail({
  skill,
  added,
  onBack,
}: {
  skill: AgentSkillLibraryEntry;
  /** The user already has a skill by this name in this space. */
  added: boolean;
  onBack: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const add = useSave({
    save: (_, rpc) => rpc.agentSkills.create({ content: skill.content }),
    stale: [queries.agentSkills.key()],
  });
  const parsed = parseSkillMd(skill.content);
  const steps = "error" in parsed ? skill.content : parsed.body;
  return (
    <div data-testid="library-skill-detail" className="max-w-2xl space-y-6">
      <div className="flex items-start gap-4">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="mt-3.5 -ms-2 text-muted-foreground"
          aria-label={t`Back`}
          onClick={onBack}
        >
          <ChevronLeft />
        </Button>
        <PluginLogo name={skill.name} large />
        <div className="min-w-0 flex-1 pt-1">
          <h2 className="truncate text-heading2 font-semibold text-foreground">{skill.name}</h2>
          <p className="text-body text-muted-foreground">{skill.description}</p>
        </div>
        <div className="shrink-0 pt-2">
          {added ? (
            <Button variant="secondary" disabled>
              <Trans>Added</Trans>
            </Button>
          ) : (
            <Button disabled={add.pending} onClick={() => add.run()}>
              {add.pending ? <Trans>Adding…</Trans> : <Trans>Add skill</Trans>}
            </Button>
          )}
        </div>
      </div>
      {add.error ? <ErrorNotice error={errorDetails(add.error, t`Could not add skill`)} /> : null}
      <div className="rounded-xl border border-border/60 bg-background px-4 py-3 text-body">
        <ChatMarkdown>{steps}</ChatMarkdown>
      </div>
    </div>
  );
}
