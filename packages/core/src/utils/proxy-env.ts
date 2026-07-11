import { ProxyAgent, type Dispatcher } from 'undici';

const PROXY_ENV_KEYS = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'GRPC_PROXY',
    'NO_GRPC_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'grpc_proxy',
    'no_grpc_proxy',
] as const;

type ProxyEnvKey = typeof PROXY_ENV_KEYS[number];
export type ProxyEnvSnapshot = Partial<Record<ProxyEnvKey, string>>;

const originalProxyEnv = captureProxyEnvironment();

function captureProxyEnvironment(): ProxyEnvSnapshot {
    const snapshot: ProxyEnvSnapshot = {};
    for (const key of PROXY_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            snapshot[key] = value;
        }
    }
    return snapshot;
}

function applyProxyEnvironment(snapshot: ProxyEnvSnapshot): void {
    for (const key of PROXY_ENV_KEYS) {
        const value = snapshot[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

export function applySystemProxyPolicy(useSystemProxy: boolean): ProxyEnvSnapshot {
    const previous = captureProxyEnvironment();
    applyProxyEnvironment(useSystemProxy ? originalProxyEnv : {});
    return previous;
}

export function restoreProxyEnvironment(snapshot: ProxyEnvSnapshot): void {
    applyProxyEnvironment(snapshot);
}

export async function withSystemProxyPolicy<T>(useSystemProxy: boolean, operation: () => Promise<T>): Promise<T> {
    const previous = applySystemProxyPolicy(useSystemProxy);
    try {
        return await operation();
    } finally {
        restoreProxyEnvironment(previous);
    }
}

export function createSystemProxyDispatcher(targetUrl: string, useSystemProxy: boolean): Dispatcher | undefined {
    if (!useSystemProxy) {
        return undefined;
    }

    const proxyUrl = getSystemProxyUrl(targetUrl);
    return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

export async function closeProxyDispatcher(dispatcher: Dispatcher | undefined): Promise<void> {
    if (!dispatcher) {
        return;
    }

    await (dispatcher as { close?: () => Promise<void> | void }).close?.();
}

export function getSystemProxyUrl(targetUrl: string): string | undefined {
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(targetUrl);
    } catch {
        return undefined;
    }

    const proxyEnv = captureProxyEnvironment();
    const noProxy = getProxyEnvValue(proxyEnv, 'NO_PROXY', 'no_proxy');
    if (shouldBypassProxy(parsedUrl, noProxy)) {
        return undefined;
    }

    if (parsedUrl.protocol === 'https:') {
        return getProxyEnvValue(proxyEnv, 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy');
    }
    if (parsedUrl.protocol === 'http:') {
        return getProxyEnvValue(proxyEnv, 'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy');
    }

    return undefined;
}

function getProxyEnvValue(snapshot: ProxyEnvSnapshot, ...keys: ProxyEnvKey[]): string | undefined {
    for (const key of keys) {
        const value = snapshot[key]?.trim();
        if (value) {
            return value;
        }
    }

    return undefined;
}

function shouldBypassProxy(targetUrl: URL, noProxyValue: string | undefined): boolean {
    if (!noProxyValue) {
        return false;
    }

    const targetHost = targetUrl.hostname.toLowerCase();
    const targetPort = targetUrl.port;
    return noProxyValue
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean)
        .some(entry => noProxyEntryMatches(entry, targetHost, targetPort));
}

function noProxyEntryMatches(entry: string, targetHost: string, targetPort: string): boolean {
    if (entry === '*') {
        return true;
    }

    const parsedEntry = parseNoProxyEntry(entry);
    if (!parsedEntry.host) {
        return false;
    }
    if (parsedEntry.port && parsedEntry.port !== targetPort) {
        return false;
    }

    const pattern = parsedEntry.host.replace(/^\*/, '');
    if (pattern.startsWith('.')) {
        const suffix = pattern.slice(1);
        return targetHost === suffix || targetHost.endsWith(pattern);
    }

    return targetHost === pattern || targetHost.endsWith(`.${pattern}`);
}

function parseNoProxyEntry(entry: string): { host: string; port?: string } {
    try {
        if (entry.includes('://')) {
            const parsed = new URL(entry);
            return { host: parsed.hostname.toLowerCase(), port: parsed.port || undefined };
        }
    } catch {
        // Fall through to host[:port] parsing.
    }

    if (entry.startsWith('[')) {
        const closingBracket = entry.indexOf(']');
        if (closingBracket > 0) {
            const host = entry.slice(1, closingBracket);
            const port = entry[closingBracket + 1] === ':' ? entry.slice(closingBracket + 2) : undefined;
            return { host, port };
        }
    }

    const colonIndex = entry.lastIndexOf(':');
    if (colonIndex > -1 && entry.indexOf(':') === colonIndex) {
        return {
            host: entry.slice(0, colonIndex),
            port: entry.slice(colonIndex + 1) || undefined
        };
    }

    return { host: entry };
}
