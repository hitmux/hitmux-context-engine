import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SearchCandidateManifestEntry } from "@hitmux/hitmux-context-engine-core";

const TOKEN_VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const SECRET_FILE_NAME = "search-continuation-secret";

export interface SearchContinuationPayload {
    version: number;
    expiresAt: number;
    codebasePath: string;
    query: string;
    optionsHash: string;
    collectionName: string;
    indexFingerprint: string;
    offset: number;
    pageSize: number;
    candidates: SearchCandidateManifestEntry[];
}

export function hashSearchOptions(options: unknown): string {
    return crypto.createHash("sha256").update(stableStringify(options)).digest("hex");
}

export function createSearchContinuationToken(
    payload: Omit<SearchContinuationPayload, "version" | "expiresAt"> & { expiresAt?: number },
): string {
    const normalized: SearchContinuationPayload = {
        ...payload,
        version: TOKEN_VERSION,
        expiresAt: payload.expiresAt ?? Date.now() + DEFAULT_TTL_MS,
    };
    const body = encodeBase64Url(JSON.stringify(normalized));
    const signature = encodeBase64Url(hmac(body));
    return `${body}.${signature}`;
}

export function verifySearchContinuationToken(token: string, now = Date.now()): SearchContinuationPayload {
    if (typeof token !== "string") {
        throw new Error("Invalid continuation token.");
    }
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) {
        throw new Error("Invalid continuation token.");
    }
    const expected = hmac(body);
    const actual = decodeBase64Url(signature);
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new Error("Invalid continuation token signature.");
    }
    let payload: unknown;
    try {
        payload = JSON.parse(decodeBase64Url(body).toString("utf8"));
    } catch {
        throw new Error("Invalid continuation token payload.");
    }
    if (!isPayload(payload)) {
        throw new Error("Invalid continuation token payload.");
    }
    if (payload.expiresAt <= now) {
        throw new Error("Continuation token has expired; please run the search again.");
    }
    return payload;
}

export function getSearchContinuationSecretPath(): string {
    return path.join(os.homedir(), ".hitmux-context-engine", SECRET_FILE_NAME);
}

function getSecret(): Buffer {
    const secretPath = getSearchContinuationSecretPath();
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    try {
        const handle = fs.openSync(secretPath, "wx", 0o600);
        try {
            fs.writeFileSync(handle, crypto.randomBytes(32));
        } finally {
            fs.closeSync(handle);
        }
    } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
            throw error;
        }
    }
    try {
        fs.chmodSync(secretPath, 0o600);
    } catch {
        // Best effort on platforms without POSIX mode bits.
    }
    return fs.readFileSync(secretPath);
}

function hmac(body: string): Buffer {
    return crypto.createHmac("sha256", getSecret()).update(body).digest();
}

function encodeBase64Url(value: string | Buffer): string {
    return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
    try {
        return Buffer.from(value, "base64url");
    } catch {
        throw new Error("Invalid continuation token encoding.");
    }
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

function isPayload(value: unknown): value is SearchContinuationPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<SearchContinuationPayload>;
    const offset = candidate.offset;
    const pageSize = candidate.pageSize;
    return candidate.version === TOKEN_VERSION
        && typeof candidate.expiresAt === "number"
        && typeof candidate.codebasePath === "string"
        && typeof candidate.query === "string"
        && typeof candidate.optionsHash === "string"
        && typeof candidate.collectionName === "string"
        && typeof candidate.indexFingerprint === "string"
        && typeof offset === "number" && Number.isInteger(offset) && offset >= 0
        && typeof pageSize === "number" && Number.isInteger(pageSize) && pageSize > 0
        && Array.isArray(candidate.candidates)
        && candidate.candidates.every(isCandidateEntry);
}

function isCandidateEntry(value: unknown): value is SearchCandidateManifestEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<SearchCandidateManifestEntry>;
    return typeof candidate.id === "string"
        && typeof candidate.relativePath === "string"
        && Number.isInteger(candidate.startLine)
        && Number.isInteger(candidate.endLine)
        && typeof candidate.contentFingerprint === "string"
        && Number.isInteger(candidate.rank)
        && typeof candidate.score === "number";
}
