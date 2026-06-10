import * as path from 'path';
import * as fs from 'fs';

export type CodebaseIdentityMode = 'path' | 'gitRemote' | 'global' | 'custom';

export interface CodebaseIdentityOptions {
    mode?: CodebaseIdentityMode;
    customIdentity?: string;
    globalName?: string;
    gitRemoteName?: string;
}

export interface CodebaseIdentity {
    mode: CodebaseIdentityMode;
    value: string;
    readableName?: string;
}

export function normalizeCodebaseIdentityPath(codebasePath: string): string {
    if (/^[A-Za-z]:[\\/]/.test(codebasePath) || /^\\\\[^\\]+\\[^\\]+/.test(codebasePath) || /^\/\/[^/]+\/[^/]+/.test(codebasePath)) {
        return path.win32.resolve(codebasePath).replace(/\\/g, '/').toLowerCase();
    }

    const resolvedPath = path.resolve(codebasePath).replace(/\\/g, '/');

    if (process.platform === 'win32') {
        return resolvedPath.toLowerCase();
    }

    return resolvedPath;
}

export function resolveCodebaseIdentity(codebasePath: string, options: CodebaseIdentityOptions = {}): CodebaseIdentity {
    const customIdentity = getTrimmedValue(options.customIdentity);
    if (customIdentity) {
        return {
            mode: 'custom',
            value: `custom:${customIdentity}`,
            readableName: customIdentity
        };
    }

    const mode = options.mode || 'path';

    if (mode === 'global') {
        const globalName = getTrimmedValue(options.globalName) || 'default';
        return {
            mode,
            value: `global:${globalName}`,
            readableName: globalName
        };
    }

    if (mode === 'gitRemote') {
        const remoteName = getTrimmedValue(options.gitRemoteName) || 'origin';
        const remoteUrl = findGitRemoteUrl(codebasePath, remoteName);
        if (remoteUrl) {
            return {
                mode,
                value: `gitRemote:${normalizeGitRemoteUrl(remoteUrl)}`,
                readableName: remoteName
            };
        }
    }

    return {
        mode: 'path',
        value: `path:${normalizeCodebaseIdentityPath(codebasePath)}`
    };
}

function getTrimmedValue(value?: string): string | undefined {
    if (!value) {
        return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function findGitRemoteUrl(codebasePath: string, remoteName: string): string | undefined {
    let currentPath = path.resolve(codebasePath);

    while (true) {
        const gitPath = path.join(currentPath, '.git');
        const configPath = getGitConfigPath(gitPath);
        if (configPath) {
            const remoteUrl = readRemoteUrlFromConfig(configPath, remoteName);
            if (remoteUrl) {
                return remoteUrl;
            }
        }

        const parentPath = path.dirname(currentPath);
        if (parentPath === currentPath) {
            return undefined;
        }
        currentPath = parentPath;
    }
}

function getGitConfigPath(gitPath: string): string | undefined {
    try {
        const stat = fs.statSync(gitPath);
        if (stat.isDirectory()) {
            return path.join(gitPath, 'config');
        }
        if (stat.isFile()) {
            const gitFile = fs.readFileSync(gitPath, 'utf8');
            const match = gitFile.match(/^gitdir:\s*(.+)\s*$/m);
            if (match) {
                const gitDir = path.isAbsolute(match[1])
                    ? match[1]
                    : path.resolve(path.dirname(gitPath), match[1]);
                return path.join(gitDir, 'config');
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function readRemoteUrlFromConfig(configPath: string, remoteName: string): string | undefined {
    try {
        const config = fs.readFileSync(configPath, 'utf8');
        const lines = config.split(/\r?\n/);
        let inRemoteSection = false;

        for (const line of lines) {
            const sectionMatch = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/);
            if (sectionMatch) {
                inRemoteSection = sectionMatch[1] === remoteName;
                continue;
            }

            if (/^\s*\[/.test(line)) {
                inRemoteSection = false;
                continue;
            }

            if (inRemoteSection) {
                const urlMatch = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
                if (urlMatch) {
                    return urlMatch[1];
                }
            }
        }
    } catch {
        return undefined;
    }

    return undefined;
}

function normalizeGitRemoteUrl(remoteUrl: string): string {
    return remoteUrl.trim().replace(/\\/g, '/').replace(/\.git$/, '').toLowerCase();
}
