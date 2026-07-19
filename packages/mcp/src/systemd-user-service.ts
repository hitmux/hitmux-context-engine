import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

export const COLLECTION_REAPER_UNIT_NAME = "hce-collection-reaper.service";

export interface SystemdUserServiceOptions {
    homeDir?: string;
    configDir?: string;
    mkdirSync?: typeof fs.mkdirSync;
    writeFileSync?: typeof fs.writeFileSync;
    readFileSync?: typeof fs.readFileSync;
    runSystemctl?: (args: string[]) => { status: number | null; error?: Error; stderr?: string };
}

export interface InstallCollectionReaperServiceResult {
    path: string;
    changed: boolean;
}

export function getCollectionReaperUnitContent(): string {
    return `[Unit]
Description=Hitmux Context Engine collection lease reaper
After=default.target

[Service]
Type=simple
ExecStart=hce collection-reaper
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function installCollectionReaperUserService(
    options: SystemdUserServiceOptions = {},
): InstallCollectionReaperServiceResult {
    const configDir = options.configDir ?? path.join(options.homeDir ?? os.homedir(), ".config");
    const unitDir = path.join(configDir, "systemd", "user");
    const unitPath = path.join(unitDir, COLLECTION_REAPER_UNIT_NAME);
    const content = getCollectionReaperUnitContent();
    const mkdir = options.mkdirSync ?? fs.mkdirSync;
    const writeFile = options.writeFileSync ?? fs.writeFileSync;
    const readFile = options.readFileSync ?? fs.readFileSync;

    mkdir(unitDir, { recursive: true });
    let changed = true;
    try {
        changed = readFile(unitPath, "utf-8") !== content;
    } catch {
        // Unit has not been installed yet.
    }
    if (changed) {
        writeFile(unitPath, content, "utf-8");
    }

    const runSystemctl = options.runSystemctl ?? defaultRunSystemctl;
    runSystemctlOrThrow(runSystemctl, ["--user", "daemon-reload"]);
    runSystemctlOrThrow(runSystemctl, ["--user", "enable", "--now", COLLECTION_REAPER_UNIT_NAME]);
    return { path: unitPath, changed };
}

function defaultRunSystemctl(args: string[]): { status: number | null; error?: Error; stderr?: string } {
    const result = spawnSync("systemctl", args, {
        encoding: "utf-8",
        stdio: ["ignore", "ignore", "pipe"],
    });
    return {
        status: result.status,
        error: result.error,
        stderr: result.stderr || undefined,
    };
}

function runSystemctlOrThrow(
    runSystemctl: NonNullable<SystemdUserServiceOptions["runSystemctl"]>,
    args: string[],
): void {
    const result = runSystemctl(args);
    if (result.status === 0) {
        return;
    }
    const details = result.error?.message || result.stderr?.trim();
    throw new Error(`systemctl ${args.join(" ")} failed${details ? `: ${details}` : ""}`);
}
