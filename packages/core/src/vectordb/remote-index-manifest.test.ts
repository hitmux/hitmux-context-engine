import {
    createRemoteIndexManifestDocument,
    REMOTE_INDEX_MANIFEST_VECTOR_DIMENSION,
} from './remote-index-manifest';

describe('remote index manifest documents', () => {
    it('uses a Milvus-compatible vector dimension', () => {
        const document = createRemoteIndexManifestDocument({
            manifestVersion: 1,
            codebasePath: '/repo',
            collectionName: 'code_chunks_repo',
            status: 'completed',
            indexedFiles: 1,
            totalChunks: 2,
            schemaVersion: 2,
            metadataVersion: 2,
            generation: 1,
            updatedAt: '2026-06-23T00:00:00.000Z',
        });

        expect(document.vector).toHaveLength(REMOTE_INDEX_MANIFEST_VECTOR_DIMENSION);
        expect(REMOTE_INDEX_MANIFEST_VECTOR_DIMENSION).toBeGreaterThanOrEqual(2);
    });
});
