import { Trans, useLingui } from "@lingui/react/macro";
import type { NavLink } from "@rakazo/contracts";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import {
  Building2,
  Check,
  ChevronRight,
  Download,
  FolderOpen,
  Gauge,
  Grid2x2Plus,
  Link2,
  LogOut,
  Plus,
  ScrollText,
  Settings,
  UserPlus,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { useSidebarUpdate } from "../../../components/DesktopUpdates";
import { IconTooltip } from "../../../components/IconTooltip";
import type { Organization } from "../../../lib/spaces/organizations";

type Props = {
  name: string;
  initials: string | null;
  image?: string | null;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIntegrations: () => void;
  onSkills: () => void;
  links?: NavLink[];
  onLink?: (link: NavLink) => void;
  onArtifacts: () => void;
  onSettings: () => void;
  /** How much of the member's allowance is used; the Usage row shows only with one. */
  usage?: string | null;
  onUsage?: () => void;
  onInvite?: () => void;
  onWorkspaces?: () => void;
  onLogOut: () => void;
  signingOut: boolean;
  logOutError: string | null;
  organizations?: Organization[];
  activeOrganizationId?: string | null;
  onSwitchOrganization?: (organization: Organization) => void;
  onCreateOrganization?: () => void;
};

export function SidebarFooter({
  name,
  initials,
  image,
  email,
  open,
  onOpenChange,
  onIntegrations,
  onSkills,
  links = [],
  onLink,
  onArtifacts,
  onSettings,
  usage,
  onUsage,
  onInvite,
  onWorkspaces,
  onLogOut,
  signingOut,
  logOutError,
  organizations = [],
  activeOrganizationId,
  onSwitchOrganization,
  onCreateOrganization,
}: Props) {
  const { t } = useLingui();
  const update = useSidebarUpdate();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const avatarClass =
    "grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-body font-semibold text-secondary-foreground";
  const avatar =
    image && failedImage !== image ? (
      <img
        src={image}
        alt=""
        className="size-full object-cover"
        onError={() => setFailedImage(image)}
      />
    ) : (
      initials || <UserRound size={18} aria-hidden="true" />
    );
  const storeLabel = t`Store`;
  const settingsLabel = t`Settings`;
  return (
    <div
      data-testid="sidebar-footer"
      className="flex shrink-0 items-center justify-between gap-2 bg-transparent px-4 pt-2 pb-4"
    >
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger
          data-testid="user-menu-trigger"
          aria-label={t`Account menu for ${name}`}
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full text-start outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className={avatarClass}>{avatar}</span>
          <span className="truncate text-body font-medium">{name}</span>
        </PopoverTrigger>
        {open ? (
          <PopoverContent
            side="top"
            sideOffset={8}
            align="start"
            className="max-h-(--available-height) w-[295px] max-w-[calc(100vw-69px)] gap-0 overflow-y-auto p-1 *:shrink-0 data-closed:animate-none"
          >
            <div
              data-testid="account-menu-header"
              className="mb-1 min-w-0 border-b border-border px-2.5 py-2.5"
            >
              <p className="truncate text-body font-medium">{name}</p>
              {email && email !== name ? (
                <p className="truncate text-label text-muted-foreground">{email}</p>
              ) : null}
            </div>
            <OrganizationRow
              organizations={organizations}
              activeOrganizationId={activeOrganizationId}
              onSwitch={onSwitchOrganization}
              onCreate={onCreateOrganization}
            />
            {onWorkspaces ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onWorkspaces}
              >
                <UserRound className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Workspaces</Trans>
              </Button>
            ) : null}
            {usage ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onUsage}
              >
                <Gauge className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Usage</Trans>
                <span className="ms-auto text-body-sm tabular-nums text-muted-foreground">
                  {usage}
                </span>
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              aria-label={settingsLabel}
              onClick={onSettings}
            >
              <Settings className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Settings</Trans>
            </Button>

            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              onClick={onSkills}
            >
              <ScrollText className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Skills</Trans>
            </Button>
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              onClick={onArtifacts}
            >
              <FolderOpen className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Artifacts</Trans>
            </Button>
            {links.map((link) => (
              <Button
                key={link.id}
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={() => onLink?.(link)}
              >
                <Link2 className="text-muted-foreground" strokeWidth={1.75} />
                {link.label}
              </Button>
            ))}
            {onInvite ? (
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onInvite}
              >
                <UserPlus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>Invite friends</Trans>
              </Button>
            ) : null}
            <div className="my-1 border-t border-border" />
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
              disabled={signingOut}
              onClick={onLogOut}
            >
              <LogOut className="text-muted-foreground" strokeWidth={1.75} />
              <Trans>Log out</Trans>
            </Button>
            {logOutError ? (
              <p role="alert" className="px-2.5 pt-1 pb-2 text-body-sm text-destructive">
                {logOutError}
              </p>
            ) : null}
          </PopoverContent>
        ) : null}
      </Popover>
      {update.available ? (
        <IconTooltip label={t`Update available`}>
          <Button
            size="icon-lg"
            className="rounded-full"
            aria-label={t`Update available`}
            onClick={update.open}
          >
            <Download aria-hidden="true" />
          </Button>
        </IconTooltip>
      ) : null}
      <IconTooltip label={storeLabel}>
        <Button variant="floating" size="icon-lg" aria-label={storeLabel} onClick={onIntegrations}>
          <Grid2x2Plus size={16} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </IconTooltip>
    </div>
  );
}

/** The organization in use; its submenu switches to another or starts a new one. */
function OrganizationRow({
  organizations,
  activeOrganizationId,
  onSwitch,
  onCreate,
}: {
  organizations: Organization[];
  activeOrganizationId?: string | null;
  onSwitch?: (organization: Organization) => void;
  onCreate?: () => void;
}) {
  const active = organizations.find((organization) => organization.id === activeOrganizationId);
  if (!active) return null;
  return (
    <>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={100}
          data-testid="organization-menu-trigger"
          render={
            <Button
              variant="ghost"
              size="lg"
              className="w-full justify-start gap-2.5 font-normal"
            />
          }
        >
          <Building2 className="text-muted-foreground" strokeWidth={1.75} />
          <span className="min-w-0 truncate">{active.name}</span>
          <ChevronRight className="ms-auto text-muted-foreground" strokeWidth={1.75} />
        </PopoverTrigger>
        <PopoverContent
          side="right"
          align="start"
          sideOffset={4}
          className="max-h-(--available-height) w-60 gap-0 overflow-y-auto p-1 *:shrink-0"
        >
          {organizations.map((organization) => {
            const current = organization.id === active.id;
            return (
              <Button
                key={organization.id}
                variant="ghost"
                aria-current={current ? "true" : undefined}
                size="lg"
                className="w-full justify-between gap-2.5 font-normal"
                onClick={() => onSwitch?.(organization)}
              >
                <span className="min-w-0 truncate">{organization.name}</span>
                {current ? <Check aria-hidden="true" strokeWidth={1.75} /> : null}
              </Button>
            );
          })}
          {onCreate ? (
            <>
              <div className="my-1 border-t border-border" />
              <Button
                variant="ghost"
                size="lg"
                className="w-full justify-start gap-2.5 font-normal"
                onClick={onCreate}
              >
                <Plus className="text-muted-foreground" strokeWidth={1.75} />
                <Trans>New organization</Trans>
              </Button>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
      <div className="my-1 border-t border-border" />
    </>
  );
}
