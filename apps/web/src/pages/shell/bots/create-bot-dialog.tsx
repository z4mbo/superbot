import { Trans, useLingui } from "@lingui/react/macro";
import { BOT_NAME_MAX_LENGTH } from "@rakazo/contracts";
import { botMarkShapeFor, newBotLook } from "@rakazo/core";
import { botInks } from "@rakazo/ui-tokens";
import {
  BotAvatar,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@rakazo/ui-web";
import { XIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useSave } from "../../../lib/query/query";
import type { RpcClient } from "../../../lib/query/rpc";
import { errorText } from "../../../lib/query/user-error";
import type { BotPickedLook } from "./bot-look-picker";
import { BotLookPicker, PICKER_INKS } from "./bot-look-picker";

export interface CreateBotDialogInput {
  name: string;
  /** The picked ink's colour, for surfaces that only read a bot's colour. */
  color: string;
  /** Reserve the preview's identity through creation and retries. */
  id?: string;
  /** The body and ink picked here, saved as the new bot's look. */
  lookShape: string;
  lookColor: string;
}

/** A new bot starts on one of the everyday bodies, in any ink but black. */
function startingLook(): { id: string; look: BotPickedLook } {
  const { id } = newBotLook();
  const inks = PICKER_INKS.filter((ink) => ink !== "neutral");
  const ink = inks[Math.floor(Math.random() * inks.length)] ?? "blue";
  return { id, look: { shape: botMarkShapeFor(id), ink } };
}

/** Mounted only while open; the parent unmounts it from `onCancel` or after `onCreate`. */
export function CreateBotDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: CreateBotDialogInput, client: RpcClient) => Promise<void>;
}) {
  const { t } = useLingui();
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [{ id, look: initial }] = useState(startingLook);
  const [look, setLook] = useState(initial);
  // Creating the bot closes this dialog, so a success keeps it held.
  const save = useSave({ save: onCreate, closesScreen: true });
  const submitting = save.pending;
  const error = save.error ? errorText(save.error, t`Could not create bot`) : null;
  const trimmed = name.trim();

  function create() {
    if (!trimmed || submitting) return;
    save.run({
      name: trimmed,
      color: botInks[look.ink],
      id,
      lookShape: look.shape,
      lookColor: look.ink,
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onCancel();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        initialFocus={nameRef}
        className="flex max-h-[calc(100dvh-2rem)] w-[440px] flex-col gap-0 overflow-hidden rounded-[14px] border border-border bg-popover p-0 ring-0 sm:max-w-[440px]"
        data-testid="create-bot-dialog"
      >
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <DialogHeader className="border-b border-border p-4">
            <DialogTitle className="text-body leading-5.5 font-semibold tracking-tight">
              <Trans>Create New Bot</Trans>
            </DialogTitle>
          </DialogHeader>
          <DialogClose
            disabled={submitting}
            render={
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-2.5 right-2.5 rounded-full text-muted-foreground"
              />
            }
          >
            <XIcon className="size-3.5" />
            <span className="sr-only">
              <Trans>Close dialog</Trans>
            </span>
          </DialogClose>
          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
            <span className="flex self-center">
              <BotAvatar
                color={botInks[look.ink]}
                identity={id}
                size={96}
                lookShape={look.shape}
                lookColor={look.ink}
              />
            </span>
            <Input
              ref={nameRef}
              size="lg"
              aria-label={t`Bot name`}
              placeholder={t`Name your Bot`}
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              disabled={submitting}
              onChange={(event) => setName(event.target.value)}
              className="my-1 rounded-sm border-border px-2.5 text-center text-body-sm focus-visible:border-border focus-visible:ring-0 md:text-body-sm dark:bg-transparent"
            />
            <BotLookPicker look={look} disabled={submitting} onChange={setLook} />
            {error ? (
              <p
                role="alert"
                data-testid="create-bot-error"
                className="text-body-sm text-destructive"
              >
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter className="mx-0 mb-0 flex-row justify-end gap-2 rounded-none border-t border-border bg-transparent py-3 pr-3 pl-4">
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={onCancel}
              className="rounded-full px-3 font-normal inset-ring-[0.5px] inset-ring-foreground/15"
            >
              <Trans>Cancel</Trans>
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || submitting}
              className="rounded-full px-3 font-normal disabled:bg-primary-disabled disabled:text-foreground/30 disabled:opacity-100"
            >
              {submitting ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
