import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot, ComputerMode, ModelCatalogEntry, ThinkingLevel } from "@rakazo/contracts";
import { BOT_LABEL_MAX_LENGTH, BOT_NAME_MAX_LENGTH, isBuiltinToolName } from "@rakazo/contracts";
import { botModelState, modelOptionKey } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, MoreHorizontal, Settings, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { BotEmailAddressField } from "../../../components/BotEmailAddressField";
import { ComputerHomeVersions } from "../../../components/computers/ComputerHomeVersions";
import { ErrorBoundary, SectionLoadFailed } from "../../../components/ErrorBoundary";
import { PagesList } from "../../../components/pages/PagesList";
import { botProfilePatch } from "../../../lib/bots/bot-profile-patch";
import { lazyComponent } from "../../../lib/platform/preload-recovery";
import { useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { RoutineList } from "../../routines/RoutineList";
import { sidePanelHeaderStyle } from "../resizable-side-panel";
import { AvatarStudioPopover } from "./avatar-studio-popover";
import { BotPanelActivity } from "./bot-panel-activity";
import { BotPanelLibrary } from "./bot-panel-library";
import { BotPanelVoiceChat } from "./bot-panel-voice-chat";
import { BotProfilePage, profileTabClass } from "./bot-profile-page";
import {
  DescriptionGroup,
  ModelRow,
  SettingsCard,
  SwitchRow,
  ToolsGroup,
  VoiceRow,
} from "./bot-settings-sections";
import type { BotSpace } from "./bot-share";
import { InstructionSettings } from "./instruction-settings";

const ScratchpadSection = lazyComponent(() =>
  import("../../space/ScratchpadSection").then((module) => module.ScratchpadSection),
);

const KnowledgeSection = lazyComponent(() =>
  import("../../space/KnowledgeSection").then((module) => module.KnowledgeSection),
);

/** The fields saved together as soon as one changes, in the order their saved snapshot keeps them. */
function advancedValues(bot: Bot) {
  return [
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
    bot.thinkingLevel ?? "",
    bot.computerMode,
    bot.autoSpeak,
    bot.voiceId ?? "",
  ] as const;
}

/**
 * The panel itself (`settings`, the name a saved panel keeps), its settings behind the gear
 * (`manage`), or one of its whole lists.
 */
export type BotPanelView = "settings" | "manage" | "routines" | "pages";

type BotPanelTab = "activity" | "library";

/**
 * A bot's panel: its avatar and name over two tabs, Activity (routines coming up, its computer)
 * and Library (its pages and files). The gear opens its settings.
 */
export function BotSettings({
  bot,
  view = "settings",
  onViewChange,
  onClose,
  computer,
  routines,
  onSave,
  onExport,
  onClear,
  focusModel = 0,
  space,
  access,
  onOpenConnections,
  onOpenVault,
  onOpenSkills,
}: {
  bot: Bot;
  view?: BotPanelView;
  onViewChange?: (view: BotPanelView) => void;
  onClose?: () => void;
  computer?: ReactNode;
  routines?: Omit<ComponentProps<typeof RoutineList>, "preview">;
  focusModel?: number;
  /** The Space the bot belongs to: its people can use the bot. */
  space?: BotSpace;
  /** The Private or Shared pill for the profile. */
  access?: ReactNode;
  onOpenConnections?: () => void;
  onOpenVault?: () => void;
  onOpenSkills?: () => void;
  onSave: (patch: {
    name?: string;
    label?: string;
    description?: string;
    instructions?: string;
    color?: string;
    lookShape?: string | null;
    lookColor?: string | null;
    notifyOnFinish?: boolean;
    computerMode?: ComputerMode;
    autoSpeak?: boolean;
    fleetManagement?: boolean;
    crossSpaceCommunication?: boolean;
    dailyCheckIns?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    disabledBuiltinTools?: string[];
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const modelRef = useRef<HTMLDivElement>(null);
  // A model deep link opens the settings, then focuses the model once they show: a control
  // inside a hidden view cannot take focus.
  const modelFocusPending = useRef(false);
  useEffect(() => {
    if (!focusModel) return;
    modelFocusPending.current = true;
    if (view !== "manage") onViewChange?.("manage");
  }, [focusModel]);
  const [tab, setTab] = useState<BotPanelTab>("activity");
  // Closing the profile goes back to the panel when the gear there opened it, else to the chat.
  const openedFromPanel = useRef(false);
  useEffect(() => {
    if (view !== "manage") openedFromPanel.current = false;
  }, [view]);
  const [name, setName] = useState(bot.name);
  const savedNameRef = useRef(bot.name);
  const [label, setLabel] = useState(bot.label ?? "");
  const savedLabelRef = useRef(bot.label ?? "");
  const [description, setDescription] = useState(bot.description);
  // A roster refresh can skip replacing bots while a reorder is in flight, so
  // this prop keeps the description from when the panel opened. Later saves
  // compare against the description last saved here; otherwise a model or
  // voice change treats that stale text as an edit and overwrites instructions.
  const savedDescriptionRef = useRef(bot.description ?? "");
  const [color, setColor] = useState(bot.color);
  const [look, setLook] = useState(() => ({
    lookShape: bot.lookShape ?? null,
    lookColor: bot.lookColor ?? null,
  }));
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const acceptedAutomatic = useRef({
    color: bot.color,
    notifyOnFinish: bot.notifyOnFinish ?? true,
  });
  const automaticRevision = useRef({ color: 0, notifyOnFinish: 0 });
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [crossSpaceCommunication, setCrossSpaceCommunication] = useState(
    bot.crossSpaceCommunication ?? true,
  );
  useEffect(
    () => setCrossSpaceCommunication(bot.crossSpaceCommunication ?? true),
    [bot.crossSpaceCommunication],
  );
  const [dailyCheckIns, setDailyCheckIns] = useState(bot.dailyCheckIns ?? true);
  useEffect(() => setDailyCheckIns(bot.dailyCheckIns ?? true), [bot.dailyCheckIns]);
  const [fleetManagement, setFleetManagement] = useState(bot.fleetManagement);
  useEffect(() => setFleetManagement(bot.fleetManagement), [bot.fleetManagement]);
  // A setting this panel no longer offers still shows while the bot has it changed from the
  // default, so it can be put back. Decided once, so the row stays to undo a change.
  const changedNow = {
    readAloud: bot.autoSpeak || Boolean(bot.voiceId),
    dailyCheckIns: bot.dailyCheckIns === false,
    crossSpaceCommunication: bot.crossSpaceCommunication === false,
    fleetManagement: !bot.fleetManagement,
    tools: (bot.disabledBuiltinTools ?? []).length > 0,
  };
  // Once shown, a row stays, so newer bot data can reveal one but never hide one mid-edit.
  const [changedBefore, setChangedBefore] = useState(changedNow);
  const changed = {
    readAloud: changedBefore.readAloud || changedNow.readAloud,
    dailyCheckIns: changedBefore.dailyCheckIns || changedNow.dailyCheckIns,
    crossSpaceCommunication:
      changedBefore.crossSpaceCommunication || changedNow.crossSpaceCommunication,
    fleetManagement: changedBefore.fleetManagement || changedNow.fleetManagement,
    tools: changedBefore.tools || changedNow.tools,
  };
  if (
    Object.entries(changed).some(([key, on]) => on !== changedBefore[key as keyof typeof changed])
  )
    setChangedBefore(changed);
  const settingsOpen = view === "manage";
  useEffect(() => {
    if (!settingsOpen || !modelFocusPending.current) return;
    modelFocusPending.current = false;
    modelRef.current?.scrollIntoView?.({ block: "nearest" });
    modelRef.current?.querySelector<HTMLElement>('[id$="-model"]')?.focus();
  }, [settingsOpen, focusModel]);
  const [claimingEmail, setClaimingEmail] = useState(false);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<string[]>(
    bot.disabledBuiltinTools ?? [],
  );
  // The list on screen is updated before the save returns. This stays on the
  // last list the server accepted so a rejection can undo that preview.
  const persistedDisabledToolsRef = useRef(disabledBuiltinTools);
  const serverDisabledToolsRef = useRef(disabledBuiltinTools);
  const pendingSavesRef = useRef(0);
  useEffect(() => {
    const next = bot.disabledBuiltinTools ?? [];
    if (serverDisabledToolsRef.current === next) return;
    serverDisabledToolsRef.current = next;
    persistedDisabledToolsRef.current = next;
    if (pendingSavesRef.current === 0) setDisabledBuiltinTools(next);
  }, [bot.disabledBuiltinTools]);
  // Shared with the model and voice settings, so a revisit paints at once and refreshes behind.
  const queries = useSpaceQueries();
  const refresh = { refetchOnMount: "always" } as const;
  const voices = useQuery({ ...queries.voice.voices.queryOptions({ input: {} }), ...refresh }).data;
  const credentialsQuery = useQuery({ ...queries.models.credentials.queryOptions(), ...refresh });
  const catalogQuery = useQuery({ ...queries.models.list.queryOptions(), ...refresh });
  const meQuery = useQuery({ ...queries.me.queryOptions(), ...refresh });
  const credentials = credentialsQuery.data ?? NO_CREDENTIALS;
  const catalog = catalogQuery.data ?? NO_CATALOG;
  const me = meQuery.data ?? null;
  // A failed catalog load must not clear an existing thinkingLevel override on save.
  const modelMetaReady =
    credentialsQuery.data !== undefined &&
    catalogQuery.data !== undefined &&
    meQuery.data !== undefined;
  const [saving, setSaving] = useState(false);
  const [savedAdvanced, setSavedAdvanced] = useState(() => JSON.stringify(advancedValues(bot)));
  const advancedSnapshot = JSON.stringify([
    modelKey,
    thinkingLevel,
    computerMode,
    autoSpeak,
    voiceId,
  ]);
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const executeSaveRef = useRef<
    (
      patchOverrides?: {
        name?: string;
        label?: string;
        description?: string;
        color?: string;
        notifyOnFinish?: boolean;
        fleetManagement?: boolean;
        crossSpaceCommunication?: boolean;
        dailyCheckIns?: boolean;
        disabledBuiltinTools?: string[];
        baseDisabledBuiltinTools?: string[];
      },
      revisions?: { color: number; notifyOnFinish: number },
    ) => Promise<void>
  >(async () => undefined);
  // The panel can open on a cached bot. When a newer copy arrives, every field not edited since
  // follows it, so a later save does not send the cached values back over it. A copy that is not
  // newer (a roster read from before a save) is ignored.
  const shownBotRef = useRef(bot);
  useEffect(() => {
    if (bot.updatedAt <= shownBotRef.current.updatedAt) return;
    shownBotRef.current = bot;
    if (name.trim() === savedNameRef.current.trim()) setName(bot.name);
    savedNameRef.current = bot.name;
    if (label === savedLabelRef.current) setLabel(bot.label ?? "");
    savedLabelRef.current = bot.label ?? "";
    if (description.trim() === savedDescriptionRef.current) setDescription(bot.description);
    savedDescriptionRef.current = bot.description ?? "";
    const accepted = acceptedAutomatic.current;
    const nextNotify = bot.notifyOnFinish ?? true;
    if (color === accepted.color) setColor(bot.color);
    if (notifyOnFinish === accepted.notifyOnFinish) setNotifyOnFinish(nextNotify);
    acceptedAutomatic.current = {
      color: bot.color,
      notifyOnFinish: nextNotify,
    };
    const saved = JSON.parse(savedAdvanced) as unknown[];
    const next = advancedValues(bot);
    if (modelKey === saved[0]) setModelKey(next[0]);
    if (thinkingLevel === saved[1]) setThinkingLevel(next[1]);
    if (computerMode === saved[2]) setComputerMode(next[2]);
    if (autoSpeak === saved[3]) setAutoSpeak(next[3]);
    if (voiceId === saved[4]) setVoiceId(next[4]);
    setSavedAdvanced(JSON.stringify(next));
  }, [bot]);

  const {
    selectedModel,
    selectedModelKey,
    choices: modelChoices,
    thinkingLevels: thinkingOptions,
    defaultThinkingLevel,
  } = botModelState({ credentials, catalog, me, modelKey, spaceDefaultLabel: t`Space default` });

  async function executeSave(
    patchOverrides?: {
      name?: string;
      label?: string;
      description?: string;
      color?: string;
      notifyOnFinish?: boolean;
      fleetManagement?: boolean;
      crossSpaceCommunication?: boolean;
      dailyCheckIns?: boolean;
      disabledBuiltinTools?: string[];
      baseDisabledBuiltinTools?: string[];
    },
    revisions?: { color: number; notifyOnFinish: number },
  ) {
    try {
      setSaving(true);
      setError(null);
      if (patchOverrides?.crossSpaceCommunication !== undefined) {
        await onSave({ crossSpaceCommunication: patchOverrides.crossSpaceCommunication });
        return;
      }
      if (patchOverrides?.dailyCheckIns !== undefined) {
        await onSave({ dailyCheckIns: patchOverrides.dailyCheckIns });
        return;
      }
      if (patchOverrides?.fleetManagement !== undefined) {
        await onSave({ fleetManagement: patchOverrides.fleetManagement });
        return;
      }
      if (patchOverrides?.label !== undefined) {
        await onSave({ label: patchOverrides.label });
        savedLabelRef.current = patchOverrides.label;
        return;
      }
      const selected = selectedModel;
      const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
      const nextDescription = (
        patchOverrides?.description !== undefined ? patchOverrides.description : description
      ).trim();
      const nextColor = patchOverrides?.color !== undefined ? patchOverrides.color : color;
      const nextNotify =
        patchOverrides?.notifyOnFinish !== undefined
          ? patchOverrides.notifyOnFinish
          : notifyOnFinish;

      if (nextName) setName(nextName);
      setDescription(nextDescription);
      const patch = {
        ...(nextName && nextName !== savedNameRef.current.trim() ? { name: nextName } : {}),
        // Keep untouched profile fields off the wire.
        ...botProfilePatch(savedDescriptionRef.current, nextDescription),
        // Unchanged color stays off the wire so a legacy named value cannot fail a name save.
        ...(nextColor !== acceptedAutomatic.current.color ? { color: nextColor } : {}),
        notifyOnFinish: nextNotify,
        computerMode,
        autoSpeak,
        voiceId: voiceId || null,
        modelProvider: selected?.provider ?? null,
        modelId: selected?.modelId ?? null,
        ...(modelMetaReady &&
        (thinkingOptions.length > 0 ||
          (selected?.provider ?? null) !== bot.modelProvider ||
          (selected?.modelId ?? null) !== bot.modelId)
          ? {
              thinkingLevel: thinkingOptions.length
                ? ((thinkingLevel || null) as ThinkingLevel | null)
                : null,
            }
          : {}),
      };
      const requestedTools = patchOverrides?.disabledBuiltinTools;
      const baseTools = patchOverrides?.baseDisabledBuiltinTools ?? [];
      // Preserve this edit's additions/removals against any refreshed server list.
      // Retry if a refresh arrives while the request is in flight.
      for (;;) {
        const serverTools = serverDisabledToolsRef.current;
        const nextTools =
          requestedTools === undefined
            ? undefined
            : [
                ...persistedDisabledToolsRef.current.filter(
                  (name) => !baseTools.includes(name) || requestedTools.includes(name),
                ),
                ...requestedTools.filter(
                  (name) =>
                    !baseTools.includes(name) && !persistedDisabledToolsRef.current.includes(name),
                ),
              ];
        // Unrelated saves omit the list, preserving changes from other sessions.
        await onSave({
          ...patch,
          ...(nextTools !== undefined ? { disabledBuiltinTools: nextTools } : {}),
        });
        if (nextTools === undefined) break;
        if (
          serverTools !== serverDisabledToolsRef.current &&
          !sameStringList(nextTools, serverDisabledToolsRef.current)
        )
          continue;
        persistedDisabledToolsRef.current = nextTools;
        break;
      }
      acceptedAutomatic.current = {
        color: nextColor,
        notifyOnFinish: nextNotify,
      };
      if (nextName) savedNameRef.current = nextName;
      savedDescriptionRef.current = nextDescription;
      setSavedAdvanced(JSON.stringify([modelKey, thinkingLevel, computerMode, autoSpeak, voiceId]));
    } catch (err) {
      if (
        patchOverrides?.color !== undefined &&
        revisions?.color === automaticRevision.current.color
      )
        setColor(acceptedAutomatic.current.color);
      if (
        patchOverrides?.notifyOnFinish !== undefined &&
        revisions?.notifyOnFinish === automaticRevision.current.notifyOnFinish
      )
        setNotifyOnFinish(acceptedAutomatic.current.notifyOnFinish);
      if (patchOverrides?.crossSpaceCommunication !== undefined)
        setCrossSpaceCommunication(!patchOverrides.crossSpaceCommunication);
      if (patchOverrides?.dailyCheckIns !== undefined)
        setDailyCheckIns(!patchOverrides.dailyCheckIns);
      if (patchOverrides?.fleetManagement !== undefined)
        setFleetManagement(!patchOverrides.fleetManagement);
      // A refused model, computer or voice change goes back to what the server still holds.
      if (!patchOverrides) {
        const saved = JSON.parse(savedAdvanced) as ReturnType<typeof advancedValues>;
        setModelKey(saved[0]);
        setThinkingLevel(saved[1]);
        setComputerMode(saved[2]);
        setAutoSpeak(saved[3]);
        setVoiceId(saved[4]);
      }
      setError(errorText(err, t`Could not save`));
    } finally {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) {
        setDisabledBuiltinTools([...persistedDisabledToolsRef.current]);
      }
      setSaving(pendingSavesRef.current > 0);
    }
  }
  executeSaveRef.current = executeSave;

  function disableBuiltinTool(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!isBuiltinToolName(name)) return;
    setError(null);
    if (disabledBuiltinTools.includes(name)) return;
    const next = [...disabledBuiltinTools, name];
    setDisabledBuiltinTools(next);
    void enqueueSave({ disabledBuiltinTools: next });
  }

  function enqueueSave(patchOverrides?: {
    name?: string;
    label?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
    fleetManagement?: boolean;
    crossSpaceCommunication?: boolean;
    dailyCheckIns?: boolean;
    disabledBuiltinTools?: string[];
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    pendingSavesRef.current += 1;
    if (patchOverrides?.color !== undefined) automaticRevision.current.color += 1;
    if (patchOverrides?.notifyOnFinish !== undefined) automaticRevision.current.notifyOnFinish += 1;
    const revisions = { ...automaticRevision.current };
    const queuedPatch =
      patchOverrides?.disabledBuiltinTools === undefined
        ? patchOverrides
        : {
            ...patchOverrides,
            baseDisabledBuiltinTools: [...persistedDisabledToolsRef.current],
          };
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => executeSaveRef.current(queuedPatch, revisions));
    return saveQueueRef.current;
  }

  // The model, thinking level, computer and voice save as soon as one of them changes.
  useEffect(() => {
    if (advancedSnapshot !== savedAdvanced) void enqueueSave();
  }, [advancedSnapshot]);

  const email = useQuery(queries.bots.emailAddress.queryOptions({ input: { botId: bot.id } })).data;
  const closeButton = (
    <Button
      variant="floating"
      size="icon-lg"
      className="text-muted-foreground"
      aria-label={t`Close panel`}
      onClick={onClose}
    >
      <X className="size-4.5" strokeWidth={1.75} />
    </Button>
  );
  const backButton = (
    <Button
      variant="ghost"
      size="icon-lg"
      className="text-muted-foreground"
      aria-label={t`Back`}
      onClick={() => onViewChange?.("settings")}
    >
      <ChevronLeft className="size-4.5 rtl:rotate-180" strokeWidth={1.75} />
    </Button>
  );
  const tabClass = profileTabClass;

  return (
    <div data-testid="bot-settings">
      {view === "routines" || view === "pages" ? (
        <div className="mb-4 flex items-center justify-between" style={sidePanelHeaderStyle}>
          {backButton}
          <div className="text-body-lg font-medium text-foreground">
            {view === "routines" ? <Trans>Routines</Trans> : <Trans>Pages</Trans>}
          </div>
          {closeButton}
        </div>
      ) : null}
      {view === "routines" && routines ? <RoutineList {...routines} /> : null}
      {view === "pages" ? <PagesList botId={bot.id} /> : null}
      {/* Both stay mounted so drafts and the open tab survive a visit to a whole list. */}
      <div hidden={view !== "settings"}>
        <div className="mb-5 flex items-center justify-between" style={sidePanelHeaderStyle}>
          <Button
            variant="floating"
            size="icon-lg"
            className="text-muted-foreground"
            aria-label={t`Bot settings`}
            data-testid="bot-settings-open"
            onClick={() => {
              openedFromPanel.current = true;
              onViewChange?.("manage");
            }}
          >
            <Settings className="size-4.5" strokeWidth={1.75} />
          </Button>
          {closeButton}
        </div>
        <div
          data-testid="bot-profile-header"
          className="flex flex-col items-center gap-3 pb-5 text-center"
        >
          <AvatarStudioPopover
            value={color}
            identity={bot.id}
            status={bot.status}
            look={look}
            onLookChange={(next) => {
              setLook(next);
              void onSave(next);
            }}
            onChange={(newColor) => {
              setColor(newColor);
              void enqueueSave({ color: newColor });
            }}
          />
          <div
            className="min-w-0 max-w-full break-words px-2 text-heading3 font-medium text-foreground"
            dir="auto"
          >
            {name}
          </div>
        </div>
        <Tabs value={tab} onValueChange={(value) => setTab(value as BotPanelTab)} className="gap-0">
          <TabsList className="mx-auto mb-5 gap-1 bg-transparent p-0 group-data-horizontal/tabs:h-auto">
            <TabsTrigger value="activity" className={tabClass}>
              <Trans>Activity</Trans>
            </TabsTrigger>
            <TabsTrigger value="library" className={tabClass}>
              <Trans>Library</Trans>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="activity">
            <BotPanelActivity
              routines={routines}
              onOpenRoutines={() => onViewChange?.("routines")}
              computer={computer}
            >
              <BotPanelVoiceChat bot={bot} voiceId={voiceId} onVoiceIdChange={setVoiceId} />
              <ErrorBoundary fallback={<SectionLoadFailed />}>
                <Suspense fallback={null}>
                  <ScratchpadSection botId={bot.id} />
                </Suspense>
              </ErrorBoundary>
            </BotPanelActivity>
          </TabsContent>
          <TabsContent value="library">
            <BotPanelLibrary
              bot={{ id: bot.id, name }}
              onOpenPages={() => onViewChange?.("pages")}
            />
          </TabsContent>
        </Tabs>
      </div>
      <div hidden={view !== "manage"} data-testid="bot-settings-advanced">
        <BotProfilePage
          botId={bot.id}
          avatar={
            <AvatarStudioPopover
              value={color}
              identity={bot.id}
              status={bot.status}
              look={look}
              onLookChange={(next) => {
                setLook(next);
                void onSave(next);
              }}
              onChange={(newColor) => {
                setColor(newColor);
                void enqueueSave({ color: newColor });
              }}
            />
          }
          nameField={
            <InlineProfileField
              label={t`Name`}
              editLabel={t`Edit name`}
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              className="text-heading1 font-normal"
              onCommit={(value) => {
                if (!value.trim()) return;
                setName(value.trim());
                void enqueueSave({ name: value });
              }}
            />
          }
          labelField={
            <InlineProfileField
              label={t`Label`}
              editLabel={t`Edit label`}
              placeholder={t`Add label`}
              value={label}
              maxLength={BOT_LABEL_MAX_LENGTH}
              className="text-body-sm text-muted-foreground"
              onCommit={(value) => {
                setLabel(value.trim());
                void enqueueSave({ label: value.trim() });
              }}
            />
          }
          email={
            email && (email.address || claimingEmail) ? (
              <div data-testid="bot-email" className="mt-2 w-full max-w-sm text-left">
                <BotEmailAddressField
                  bot={{ id: bot.id, name }}
                  domain={email.domain}
                  address={email.address}
                />
              </div>
            ) : null
          }
          shared={space?.shared}
          spaceName={space?.name}
          access={access}
          actions={
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="floating"
                    size="icon-lg"
                    className="app-no-drag text-muted-foreground"
                    aria-label={t`More actions`}
                  />
                }
              >
                <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {email && !email.address && !claimingEmail ? (
                  <DropdownMenuItem onClick={() => setClaimingEmail(true)}>
                    <Trans>Get an email address</Trans>
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={() => {
                    setError(null);
                    onExport().catch((err: unknown) => setError(errorText(err)));
                  }}
                >
                  <Trans>Export</Trans>
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onClear}>
                  <Trans>Clear conversation</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
          onClose={() => (openedFromPanel.current ? onViewChange?.("settings") : onClose?.())}
          onOpenConnections={onOpenConnections}
          onOpenVault={onOpenVault}
          onOpenSkills={onOpenSkills}
          general={
            <>
              {error ? <p className="px-3 text-body-sm text-destructive">{error}</p> : null}
              <SettingsCard>
                <ModelRow
                  ids={ids}
                  containerRef={modelRef}
                  choices={modelChoices}
                  value={selectedModelKey}
                  onModelChange={(key) => {
                    setModelKey(key);
                    setThinkingLevel("");
                  }}
                  thinkingOptions={thinkingOptions}
                  thinkingLevel={thinkingLevel}
                  defaultThinkingLevel={defaultThinkingLevel}
                  onThinkingLevelChange={setThinkingLevel}
                />
                <SwitchRow
                  id={`${ids}-notify-finish`}
                  label={<Trans>Notifications</Trans>}
                  checked={notifyOnFinish}
                  onChange={(checked) => {
                    setNotifyOnFinish(checked);
                    void enqueueSave({ notifyOnFinish: checked });
                  }}
                />
                <SwitchRow
                  id={`${ids}-own-computer`}
                  label={<Trans>Own computer</Trans>}
                  checked={computerMode === "dedicated"}
                  disabled={saving}
                  onChange={(checked) => setComputerMode(checked ? "dedicated" : "team")}
                />
                {/* Read only once the settings show: listing versions reads object storage. */}
                {settingsOpen ? <ComputerHomeVersions botId={bot.id} /> : null}
                {changed.readAloud ? (
                  <SwitchRow
                    id={`${ids}-auto-speak`}
                    label={<Trans>Read replies aloud</Trans>}
                    checked={autoSpeak}
                    onChange={setAutoSpeak}
                  />
                ) : null}
                {changed.readAloud && voices?.length ? (
                  <VoiceRow
                    ids={ids}
                    voices={voices}
                    voiceId={voiceId}
                    onVoiceIdChange={setVoiceId}
                  />
                ) : null}
                {changed.dailyCheckIns ? (
                  <SwitchRow
                    id={`${ids}-daily-check-ins`}
                    label={<Trans>Daily check-ins on unfinished work</Trans>}
                    checked={dailyCheckIns}
                    disabled={saving}
                    onChange={(checked) => {
                      setDailyCheckIns(checked);
                      void enqueueSave({ dailyCheckIns: checked });
                    }}
                  />
                ) : null}
                {changed.crossSpaceCommunication ? (
                  <SwitchRow
                    id={`${ids}-cross-space`}
                    label={<Trans>Allow cross-space bot communication</Trans>}
                    checked={crossSpaceCommunication}
                    disabled={saving}
                    onChange={(checked) => {
                      setCrossSpaceCommunication(checked);
                      void enqueueSave({ crossSpaceCommunication: checked });
                    }}
                  />
                ) : null}
                {changed.fleetManagement ? (
                  <SwitchRow
                    id={`${ids}-fleet-management`}
                    label={<Trans>Manage other bots</Trans>}
                    checked={fleetManagement}
                    disabled={saving}
                    onChange={(checked) => {
                      setFleetManagement(checked);
                      void enqueueSave({ fleetManagement: checked });
                    }}
                  />
                ) : null}
              </SettingsCard>
              <InstructionSettings key={bot.id} bot={bot} />
              <DescriptionGroup
                ids={ids}
                description={description}
                onDescriptionChange={setDescription}
                onCommit={() => void enqueueSave()}
              />
              {changed.tools ? (
                <ToolsGroup
                  ids={ids}
                  disabledBuiltinTools={disabledBuiltinTools}
                  onDisable={disableBuiltinTool}
                  onEnable={(toolName) => {
                    const next = disabledBuiltinTools.filter((entry) => entry !== toolName);
                    setDisabledBuiltinTools(next);
                    void enqueueSave({ disabledBuiltinTools: next });
                  }}
                />
              ) : null}
            </>
          }
          knowledge={
            <ErrorBoundary fallback={<SectionLoadFailed />}>
              <Suspense fallback={null}>
                <KnowledgeSection botId={bot.id} />
              </Suspense>
            </ErrorBoundary>
          }
        />
      </div>
      {error && view === "settings" ? (
        <p className="mt-2 text-body-sm text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

const NO_CREDENTIALS: never[] = [];
const NO_CATALOG: ModelCatalogEntry[] = [];

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function InlineProfileField({
  label,
  editLabel,
  placeholder,
  value,
  maxLength,
  className,
  onCommit,
}: {
  label: string;
  editLabel: string;
  /** Shown while the value is empty. */
  placeholder?: string;
  value: string;
  maxLength: number;
  className: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  function commit() {
    if (cancelled.current) return;
    setEditing(false);
    if (draft.trim() !== value.trim()) onCommit(draft);
  }
  return editing ? (
    <Input
      autoFocus
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      maxLength={maxLength}
      className={`h-auto border-transparent bg-transparent p-0 text-start shadow-none ${className}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Escape") event.stopPropagation();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          cancelled.current = true;
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      type="button"
      aria-label={editLabel}
      className={`-mx-2 min-w-0 max-w-full cursor-text break-words rounded px-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      onClick={() => {
        cancelled.current = false;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value || placeholder}
    </button>
  );
}
