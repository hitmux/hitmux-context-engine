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

type UpdateCheckState =
    | { status: "pending" }
    | { status: "ready"; info: UpdateInfo | null }
    | { status: "failed" };

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 3000;

export function compareVersions(a: string, b: string): number {
    const aParts = parseVersion(a);
    const bParts = parseVersion(b);

    for (let index = 0; index < Math.max(aParts.length, bParts.length); index += 1) {
        const aPart = aParts[index] ?? 0;
        const bPart = bParts[index] ?? 0;

        if (aPart > bPart) {
            return 1;
        }

        if (aPart < bPart) {
            return -1;
        }
    }

    return 0;
}

export function formatUpdateNotice(info: UpdateInfo): string {
    return `Update available: ${info.packageName} ${info.currentVersion} -> ${info.latestVersion}. Run npm update -g ${info.packageName} or use the latest npx package.`;
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

function parseVersion(version: string): number[] {
    return version
        .replace(/^v/, "")
        .split("-", 1)[0]
        .split(".")
        .map((part) => Number.parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
}
