import { SemanticSearchResult } from '../types';
import { deduplicateSemanticSearchResults } from './result-dedupe';

function createResult(overrides: Partial<SemanticSearchResult>): SemanticSearchResult {
    return {
        content: '',
        relativePath: 'src/workers/payloadPacker.ts',
        startLine: 1,
        endLine: 1,
        language: 'typescript',
        score: 1,
        ...overrides,
    };
}

describe('deduplicateSemanticSearchResults', () => {
    it('continues checking kept results after replacing a duplicate', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: 'this.previousPayload = null;',
                startLine: 1,
                endLine: 10,
                score: 0.9,
            }),
            createResult({
                content: 'this.nextPayload = null;',
                startLine: 9,
                endLine: 18,
                score: 0.9,
            }),
            createResult({
                content: [
                    'export function packVisionSources(payload: WorkerPayload): PackedPayload {',
                    '    const sources = payload.sources.map(source => source.id).join(",");',
                    '    return { ...payload, packedSources: sources, packedAt: Date.now() };',
                    '}',
                ].join('\n'),
                startLine: 5,
                endLine: 14,
                score: 0.9,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            startLine: 5,
            endLine: 14,
        });
        expect(deduplicateSemanticSearchResults(deduped)).toHaveLength(1);
    });

    it('keeps adjacent small definitions with similar bodies when names differ', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    'export interface PackedVisionSources {',
                    '    buffer: Float32Array;',
                    '    count: number;',
                    '}',
                ].join('\n'),
                startLine: 7,
                endLine: 10,
                score: 0.99,
            }),
            createResult({
                content: [
                    'export interface PackedBuildingPositions {',
                    '    buffer: Float32Array;',
                    '    count: number;',
                    '}',
                ].join('\n'),
                startLine: 11,
                endLine: 14,
                score: 0.98,
            }),
        ]);

        expect(deduped).toHaveLength(2);
        expect(deduped.map(result => result.startLine)).toEqual([7, 11]);
    });

    it('does not classify plain call expressions as conflicting definitions', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    'loadPayload(workerPayload);',
                    'sendPayload(workerPayload);',
                    'flushPayload(workerPayload);',
                    'trackPayload(workerPayload);',
                ].join('\n'),
                startLine: 20,
                endLine: 23,
                score: 0.91,
            }),
            createResult({
                content: [
                    'sendPayload(workerPayload);',
                    'flushPayload(workerPayload);',
                    'trackPayload(workerPayload);',
                    'finalizePayload(workerPayload);',
                ].join('\n'),
                startLine: 21,
                endLine: 24,
                score: 0.92,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            startLine: 21,
            endLine: 24,
        });
    });

    it('deduplicates adjacent chunks when they carry the same definition context', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    'export class PayloadPacker {',
                    '    packVisionSources(payload: WorkerPayload): PackedPayload {',
                    '        const sources = payload.sources.map(source => source.id).join(",");',
                    '        return { ...payload, packedSources: sources };',
                    '    }',
                    '}',
                ].join('\n'),
                startLine: 20,
                endLine: 25,
                score: 0.97,
            }),
            createResult({
                content: [
                    'export class PayloadPacker {',
                    '    packVisionSources(payload: WorkerPayload): PackedPayload {',
                    '        const sources = payload.sources.map(source => source.id).join(",");',
                    '        return { ...payload, packedSources: sources };',
                    '    }',
                    '}',
                ].join('\n'),
                startLine: 26,
                endLine: 31,
                score: 0.99,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            startLine: 26,
            endLine: 31,
        });
    });

    it('deduplicates overlapping chunks when one definition set contains the other', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    'export interface TowerMeta {',
                    '    name: string;',
                    '}',
                    '',
                    'export class TowerRegistry {',
                    '    static register(name: string): void {}',
                    '}',
                ].join('\n'),
                startLine: 12,
                endLine: 53,
                score: 0.92,
            }),
            createResult({
                content: [
                    'export class TowerRegistry {',
                    '    static register(name: string): void {}',
                    '}',
                ].join('\n'),
                startLine: 18,
                endLine: 53,
                score: 0.95,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0].relativePath).toBe('src/workers/payloadPacker.ts');
    });

    it('does not treat indented local declarations as conflicting top-level definitions', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    'export function packVisionSources(payload: WorkerPayload): PackedPayload {',
                    '    const sources = payload.sources.map(source => source.id).join(",");',
                    '    const packedAt = Date.now();',
                    '    return { ...payload, packedSources: sources, packedAt };',
                    '}',
                ].join('\n'),
                startLine: 20,
                endLine: 26,
                score: 0.9,
            }),
            createResult({
                content: [
                    '    const sources = payload.sources.map(source => source.id).join(",");',
                    '    const packedAt = Date.now();',
                    '    return { ...payload, packedSources: sources, packedAt };',
                ].join('\n'),
                startLine: 21,
                endLine: 24,
                score: 1.2,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0].content).toMatch(/^export function packVisionSources/);
    });

    it('deduplicates shifted ranges for the same top-level definition with leading context', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    'import { TowerConfig } from "./config";',
                    '',
                    'export class TowerRegistry {',
                    '    static register(name: string, config: TowerConfig): void {}',
                    '    static get(name: string): TowerConfig | undefined { return undefined; }',
                    '}',
                ].join('\n'),
                relativePath: 'src/towers/towerRegistry.ts',
                startLine: 9,
                endLine: 53,
                score: 0.92,
            }),
            createResult({
                content: [
                    'export class TowerRegistry {',
                    '    static register(name: string, config: TowerConfig): void {}',
                    '    static get(name: string): TowerConfig | undefined { return undefined; }',
                    '}',
                ].join('\n'),
                relativePath: 'src/towers/towerRegistry.ts',
                startLine: 12,
                endLine: 53,
                score: 0.95,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            relativePath: 'src/towers/towerRegistry.ts',
            startLine: 12,
            endLine: 53,
        });
    });

    it('keeps adjacent methods with different names inside the same class', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    '    requestFogRebuild(payload: FogPayload): void {',
                    '        this._fogPendingPayload = payload;',
                    '        this._doFogRebuild(payload);',
                    '    }',
                ].join('\n'),
                relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                startLine: 112,
                endLine: 119,
                score: 0.99,
            }),
            createResult({
                content: [
                    '    requestTerritoryRebuild(payload: TerritoryPayload): void {',
                    '        this._territoryPendingMap.set(payload.playerId, payload);',
                    '        this._doTerritoryRebuild(payload);',
                    '    }',
                ].join('\n'),
                relativePath: 'src/workers/bridge/renderWorkerBridge.ts',
                startLine: 126,
                endLine: 132,
                score: 0.98,
            }),
        ]);

        expect(deduped).toHaveLength(2);
        expect(deduped.map(result => result.startLine)).toEqual([112, 126]);
    });

    it('keeps a complete definition over a higher-scoring body fragment', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    '        const sources = payload.sources.map(source => source.id).join(",");',
                    '        return { ...payload, packedSources: sources };',
                ].join('\n'),
                startLine: 22,
                endLine: 23,
                score: 25,
            }),
            createResult({
                content: [
                    'export function packVisionSources(payload: WorkerPayload): PackedPayload {',
                    '    const sources = payload.sources.map(source => source.id).join(",");',
                    '    return { ...payload, packedSources: sources };',
                    '}',
                ].join('\n'),
                startLine: 21,
                endLine: 24,
                score: 9,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            startLine: 21,
            endLine: 24,
            score: 9,
        });
        expect(deduped[0].content).toMatch(/^export function packVisionSources/);
    });

    it('keeps exact owner matches over higher-scoring duplicate fragments', () => {
        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: [
                    '    const packed = packVisionSources(payload);',
                    '    return packed;',
                ].join('\n'),
                startLine: 22,
                endLine: 23,
                score: 25,
                scoreReasons: ['reference_match'],
            }),
            createResult({
                content: [
                    'export function packVisionSources(payload: WorkerPayload): PackedPayload {',
                    '    const packed = packVisionSources(payload);',
                    '    return packed;',
                    '}',
                ].join('\n'),
                startLine: 21,
                endLine: 24,
                score: 9,
                scoreReasons: ['exact_symbol_definition'],
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            startLine: 21,
            endLine: 24,
            scoreReasons: ['exact_symbol_definition'],
        });
    });

    it('keeps the valid line range result over an unavailable duplicate with a higher score', () => {
        const sharedContent = [
            'export function packVisionSources(payload: WorkerPayload): PackedPayload {',
            '    const sources = payload.sources.map(source => source.id).join(",");',
            '    return { ...payload, packedSources: sources, packedAt: Date.now() };',
            '}',
        ].join('\n');

        const deduped = deduplicateSemanticSearchResults([
            createResult({
                content: sharedContent,
                startLine: 40,
                endLine: 43,
                score: 0.9,
            }),
            createResult({
                content: sharedContent,
                startLine: 0,
                endLine: 0,
                lineRangeUnavailable: true,
                score: 1.2,
            }),
        ]);

        expect(deduped).toHaveLength(1);
        expect(deduped[0]).toMatchObject({
            startLine: 40,
            endLine: 43,
        });
        expect(deduped[0].lineRangeUnavailable).toBeUndefined();
    });
});
