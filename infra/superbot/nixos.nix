{ config, lib, pkgs, ... }:

let
  cfg = config.services.superbot;
  stateDir = "/var/lib/superbot";
  envFile = "${stateDir}/host.env";
  host = pkgs.writeShellApplication {
    name = "superbot-host";
    runtimeInputs = [ pkgs.coreutils pkgs.nodejs_24 config.virtualisation.docker.package ];
    text = ''
      if [[ $EUID != 0 ]]; then
        echo "Run superbot-host as root." >&2
        exit 1
      fi

      command="''${1:?Usage: superbot-host <init|up|status|logs|account|down> [--port PORT] [--origin URL]}"
      shift
      if [[ $command == init ]]; then
        install -d -m 0700 ${stateDir}
      elif [[ ! -f ${envFile} || -L ${envFile} || $(stat -c '%u:%g:%a' ${envFile}) != 0:0:600 ]]; then
        echo "${envFile} must be a regular file owned by root:root with mode 0600." >&2
        exit 1
      fi

      exec node ${lib.escapeShellArg "${cfg.sourceDirectory}/infra/superbot/host.mjs"} \
        "$command" --env ${envFile} --project superbot "$@"
    '';
  };
in
{
  options.services.superbot = {
    enable = lib.mkEnableOption "the Superbot Compose host";

    sourceDirectory = lib.mkOption {
      type = lib.types.strMatching "/.*";
      default = "/srv/superbot/current";
      description = "Absolute runtime path to the Superbot source used as the Docker build context.";
    };

    tailscale.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable the Tailscale daemon. Enroll the host and configure private Serve separately.";
    };
  };

  config = lib.mkIf cfg.enable {
    virtualisation.docker.enable = true;
    virtualisation.docker.enableOnBoot = true;
    services.tailscale.enable = lib.mkIf cfg.tailscale.enable true;
    environment.systemPackages = [ host ];

    systemd.services.superbot = {
      description = "Superbot Compose host";
      wantedBy = [ "multi-user.target" ];
      requires = [ "docker.service" ];
      wants = [ "network-online.target" ];
      after = [ "docker.service" "network-online.target" ];
      unitConfig.ConditionPathExists = envFile;

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "superbot";
        StateDirectoryMode = "0700";
        UMask = "0077";
        ExecStart = "${host}/bin/superbot-host up";
        ExecStop = "${host}/bin/superbot-host down";
        TimeoutStartSec = "infinity";
        TimeoutStopSec = "55min";
      };
    };
  };
}
