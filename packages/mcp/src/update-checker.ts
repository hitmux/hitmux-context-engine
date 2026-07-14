export interface UpdateInfo {
    packageName: string;
    currentVersion: string;
    latestVersion: string;
}

export interface UpdateCheckerOptions {
    packageName: string;
    currentVersion: string;
    registryUrl?: string;
    timeoutMs?: number;
    fetch?: typeof fetch;
}

interface NpmPackageMetadata {
    "dist-tags"?: {
        latest?: string;
    };
}

interface ParsedVersion {
    core: number[];
    prerelease: string[] | null;
}

type UpdateCheckState =
    | { status: "pending" }
    | { status: "ready"; info: UpdateInfo | null }
    | { status: "failed" };

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 10_000;

export function compareVersions(a: string, b: string): number {
    const aVersion = parseVersion(a);
    const bVersion = parseVersion(b);

    for (
        let index = 0;
        index < Math.max(aVersion.core.length, bVersion.core.length);
        index += 1
    ) {
        const aPart = aVersion.core[index] ?? 0;
        const bPart = bVersion.core[index] ?? 0;

        if (aPart > bPart) {
            return 1;
        }

        if (aPart < bPart) {
            return -1;
        }
    }

    if (aVersion.prerelease === null && bVersion.prerelease === null) {
        return 0;
    }

    if (aVersion.prerelease === null) {
        return 1;
    }

    if (bVersion.prerelease === null) {
        return -1;
    }

    return comparePrereleaseVersions(aVersion.prerelease, bVersion.prerelease);
}

export function formatUpdateNotice(info: UpdateInfo): string {
    return `Update available: ${info.packageName} ${info.currentVersion} -> ${info.latestVersion}. Update the globally installed package that provides the hce command (for example, npm update -g @hitmux/hce) or use the latest npx package.`;
}

export class UpdateChecker {
    private state: UpdateCheckState = { status: "pending" };
    private noticeConsumed = false;

    constructor(private readonly options: UpdateCheckerOptions) {}

    start(): void {
        void this.checkForUpdate()
            .then((info) => {
                this.state = { status: "ready", info };
            })
            .catch(() => {
                this.state = { status: "failed" };
            });
    }

    consumeNotice(): string | null {
        if (this.noticeConsumed || this.state.status !== "ready" || !this.state.info) {
            return null;
        }

        this.noticeConsumed = true;
        return formatUpdateNotice(this.state.info);
    }

    private async checkForUpdate(): Promise<UpdateInfo | null> {
        const latestVersion = await fetchLatestVersion(this.options);
        if (compareVersions(latestVersion, this.options.currentVersion) <= 0) {
            return null;
        }

        return {
            packageName: this.options.packageName,
            currentVersion: this.options.currentVersion,
            latestVersion,
        };
    }
}

export async function fetchLatestVersion(
    options: UpdateCheckerOptions,
): Promise<string> {
    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const registryUrl = options.registryUrl ?? DEFAULT_REGISTRY_URL;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const metadataUrl = `${registryUrl.replace(/\/+$/, "")}/${encodeURIComponent(options.packageName)}`;
        const response = await fetchImpl(metadataUrl, {
            signal: controller.signal,
            headers: {
                accept: "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`npm registry returned HTTP ${response.status}`);
        }

        const metadata = (await response.json()) as NpmPackageMetadata;
        const latestVersion = metadata["dist-tags"]?.latest;
        if (!latestVersion) {
            throw new Error("npm registry response did not include dist-tags.latest");
        }

        return latestVersion;
    } finally {
        clearTimeout(timeout);
    }
}

function parseVersion(version: string): ParsedVersion {
    const normalized = version.trim().replace(/^v/i, "").split("+", 1)[0];
    const prereleaseSeparator = normalized.indexOf("-");
    const core =
        prereleaseSeparator === -1
            ? normalized
            : normalized.slice(0, prereleaseSeparator);
    const prerelease =
        prereleaseSeparator === -1
            ? null
            : normalized.slice(prereleaseSeparator + 1).split(".");

    return {
        core: core.split(".").map(parseVersionPart),
        prerelease: prerelease?.length ? prerelease : null,
    };
}

function parseVersionPart(part: string): number {
    if (!/^\d+$/.test(part)) {
        return 0;
    }

    return Number.parseInt(part, 10);
}

function comparePrereleaseVersions(a: string[], b: string[]): number {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const aPart = a[index];
        const bPart = b[index];

        if (aPart === undefined) {
            return -1;
        }

        if (bPart === undefined) {
            return 1;
        }

        const aIsNumeric = /^\d+$/.test(aPart);
        const bIsNumeric = /^\d+$/.test(bPart);
        if (aIsNumeric && bIsNumeric) {
            const numericComparison = Number.parseInt(aPart, 10) - Number.parseInt(bPart, 10);
            if (numericComparison !== 0) {
                return numericComparison > 0 ? 1 : -1;
            }
            continue;
        }

        if (aIsNumeric !== bIsNumeric) {
            return aIsNumeric ? -1 : 1;
        }

        if (aPart > bPart) {
            return 1;
        }

        if (aPart < bPart) {
            return -1;
        }
    }

    return 0;
}
