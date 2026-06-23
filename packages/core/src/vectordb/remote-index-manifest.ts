import * as crypto from 'crypto';
import { VectorDocument } from './types';

export const REMOTE_INDEX_MANIFEST_COLLECTION = 'hitmux_index_manifests';
export const REMOTE_INDEX_MANIFEST_VERSION = 1;

export type RemoteIndexManifestStatus = 'completed' | 'limit_reached';

export interface RemoteIndexManifest {
    manifestVersion: number;
    codebasePath: string;
    collectionName: string;
    status: RemoteIndexManifestStatus;
    indexedFiles: number;
    totalChunks: number;
    schemaVersion: number;
    metadataVersion: number;
    generation: number;
    updatedAt: string;
}

export function getRemoteIndexManifestKey(collectionName: string, codebasePath: string): string {
    const digest = crypto
        .createHash('sha256')
        .update(`${collectionName}\0${codebasePath}`)
        .digest('hex');
    return `${collectionName}/${digest}.json`;
}

export function getRemoteIndexManifestDocumentId(collectionName: string, codebasePath: string): string {
    const digest = crypto
        .createHash('sha256')
        .update(`${collectionName}\0${codebasePath}`)
        .digest('hex');
    return `manifest_${digest}`;
}

export function createRemoteIndexManifestDocument(manifest: RemoteIndexManifest): VectorDocument {
    const content = JSON.stringify(manifest);
    return {
        id: getRemoteIndexManifestDocumentId(manifest.collectionName, manifest.codebasePath),
        vector: [0],
        content,
        relativePath: getRemoteIndexManifestKey(manifest.collectionName, manifest.codebasePath),
        startLine: 1,
        endLine: 1,
        fileExtension: '.manifest',
        metadata: {
            manifestType: 'hitmuxIndexStatus',
            manifestVersion: manifest.manifestVersion,
            codebasePath: manifest.codebasePath,
            collectionName: manifest.collectionName,
            updatedAt: manifest.updatedAt,
        },
    };
}

export function parseRemoteIndexManifestRow(row: Record<string, any>): RemoteIndexManifest | null {
    const rawContent = row.content;
    if (typeof rawContent !== 'string' || rawContent.length === 0) {
        return null;
    }

    try {
        const parsed = JSON.parse(rawContent) as Partial<RemoteIndexManifest>;
        if (
            parsed.manifestVersion !== REMOTE_INDEX_MANIFEST_VERSION ||
            typeof parsed.codebasePath !== 'string' ||
            typeof parsed.collectionName !== 'string' ||
            (parsed.status !== 'completed' && parsed.status !== 'limit_reached') ||
            typeof parsed.indexedFiles !== 'number' ||
            typeof parsed.totalChunks !== 'number' ||
            typeof parsed.schemaVersion !== 'number' ||
            typeof parsed.metadataVersion !== 'number' ||
            typeof parsed.generation !== 'number' ||
            typeof parsed.updatedAt !== 'string'
        ) {
            return null;
        }

        return parsed as RemoteIndexManifest;
    } catch {
        return null;
    }
}
