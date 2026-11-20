import { useLingui } from "@lingui/react/macro";
import { useMemo, useState } from "react";
import { currentApiBase, rpc } from "../api/api";
import { computerBootErrorDetail, errorText } from "../api/user-error";
import type { ComputerStatus, ScreenLink } from "./computer";
import {
  COMPUTER_LIFECYCLE_TIMEOUT_MS,
  isTrustedScreenDocument,
  readScreenUrl,
  SCREEN_URL_OPEN_ATTEMPTS,
} from "./computer";
import { createComputerRefresh } from "./computer-refresh";

/** A bot's computer status and screen link, kept fresh, and the boot that starts it. */
export function useComputerBoot(botId: string | undefined) {
  const { t } = useLingui();
  const [computer, setComputer] = useState<ComputerStatus | null>(null);
  const [screen, setScreen] = useState<ScreenLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readyBotId, setReadyBotId] = useState<string | null>(null);
  const [bootingCount, setBootingCount] = useState(0);
  const booting = bootingCount > 0;
  const [bootFailed, setBootFailed] = useState(false);

  const refreshController = useMemo(
    () =>
      createComputerRefresh({
        readStatus: () => rpc("computer/status", { botId: botId ?? "" }),
        readScreen: (attempts) =>
          readScreenUrl(
            async () => {
              const apiBase = currentApiBase();
              const link = await rpc("computer/screenUrl", {
                botId: botId ?? "",
                nativeSession: true,
              });
              if (apiBase !== currentApiBase()) return { url: null };
              return link.screenSession && !isTrustedScreenDocument(link.url, apiBase)
                ? { url: link.url }
                : link;
            },
            { attempts },
          ),
        onStatus: (status) => {
          setComputer(status);
          // Another client may have started it since this one failed.
          if (status.state === "running") setBootFailed(false);
        },
        onScreen: setScreen,
        onReady: () => setReadyBotId(botId ?? null),
        onInitialError: (err) => setError(errorText(err)),
      }),
    [botId],
  );

  async function bootComputer({
    takeControl,
    showProgress,
    force = false,
  }: {
    takeControl: boolean;
    showProgress: boolean;
    force?: boolean;
  }) {
    if (!botId || !refreshController.isActive()) return false;
    const action = refreshController.beginAction();
    const needsBoot = force || computer?.state !== "running" || !screen;
    let starting = needsBoot;
    const showBooting = showProgress && needsBoot;
    if (showBooting) {
      setBootingCount((count) => count + 1);
      setError(null);
    }
    setBootFailed(false);
    try {
      if (needsBoot) {
        const answered = await rpc(
          "computer/boot",
          { botId },
          { timeoutMs: COMPUTER_LIFECYCLE_TIMEOUT_MS },
        ).then(
          () => true,
          (err: unknown) => {
            // The server keeps booting after the client stops waiting; the status poll takes over.
            if (err instanceof Error && err.name === "TimeoutError") return false;
            throw err;
          },
        );
        if (!answered) return false;
      }
      starting = false;
      if (!action.isActive()) return false;
      if (takeControl) {
        await rpc("computer/takeover", { botId }).catch(async (err: unknown) => {
          if (!(err instanceof Error && err.name === "TimeoutError")) throw err;
          // The server may have granted control after the app stopped waiting: ask what it holds.
          const status = await rpc("computer/status", { botId });
          if (!status.controlLeaseId) throw err;
        });
      }
      if (!action.isActive()) return false;
      await action.refresh({ screenAttempts: SCREEN_URL_OPEN_ATTEMPTS });
      if (!action.isActive()) return false;
      setError(null);
      return true;
    } catch (err) {
      if (!action.isActive()) return false;
      setError(
        starting
          ? computerBootErrorDetail(err)
          : err instanceof Error && err.name === "TimeoutError"
            ? t`Request timed out`
            : errorText(err, t`Could not open computer`),
      );
      setBootFailed(starting);
      throw err;
    } finally {
      if (action.isActive() && showBooting) setBootingCount((count) => count - 1);
      action.finish();
    }
  }

  return {
    computer,
    setComputer,
    screen,
    setScreen,
    error,
    setError,
    readyBotId,
    setReadyBotId,
    booting,
    setBootingCount,
    bootFailed,
    setBootFailed,
    refreshController,
    bootComputer,
  };
}
