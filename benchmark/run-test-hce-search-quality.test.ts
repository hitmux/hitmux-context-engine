import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    assertBenchmarkPreflightAllowsRun,
    auditFreshness,
    auditProjectsForPlan,
    classifyFailure,
    clearCompletedProjectIndex,
    ensureProjectIndex,
    getUnscorableBenchmarkCases,
    getAuditRefreshNeededRecords,
    readTemporaryIndexes,
    resultNeedsAuditRefresh,
    type RecordedTopResult,
    rewriteResultWithAudit,
    scoreTopResults,
} from "./run-test-hce-search-quality.ts";

function topResult(overrides: Partial<RecordedTopResult>): RecordedTopResult {
    return {
        rank: 1,
        path: "src/noise.ts",
        score: 1,
        lineRange: "1-1",
        matched: "none",
        symbolHits: [],
        hasSymbolHit: false,
        anchorHits: [],
        ...overrides,
    };
}

test("scoreTopResults dedupes chunk-heavy files before ranking", () => {
    const scoring = scoreTopResults(
        {
            id: "case-1",
            question: "q",
            expected: {
                primaryPaths: ["src/target.ts"],
            },
        },
        [
            topResult({ rank: 1, path: "src/noise-a.ts", score: 10 }),
            topResult({ rank: 2, path: "src/noise-a.ts", score: 9, lineRange: "2-2" }),
            topResult({ rank: 3, path: "src/noise-a.ts", score: 8, lineRange: "3-3" }),
            topResult({ rank: 4, path: "src/target.ts", score: 7, lineRange: "4-4", matched: "primary" }),
        ]
    );

    assert.equal(scoring.firstPrimaryRank, 2);
    assert.equal(scoring.suggestedScore, 4);
});

test("scoreTopResults does not treat empty symbol expectations as automatic symbol hits", () => {
    const scoring = scoreTopResults(
        {
            id: "case-2",
            question: "q",
            expected: {
                primaryPaths: ["src/primary.ts"],
                acceptablePaths: ["src/acceptable.ts"],
                primarySymbols: [],
            },
        },
        [
            topResult({ rank: 1, path: "src/acceptable.ts", score: 10, matched: "acceptable", hasSymbolHit: true }),
            topResult({ rank: 2, path: "src/noise.ts", score: 9, lineRange: "2-2", hasSymbolHit: true }),
        ]
    );

    assert.equal(scoring.firstAcceptableSymbolRank, null);
    assert.equal(scoring.suggestedScore, 3);
});

test("scoreTopResults keeps primary files in top 20 above non-hit results", () => {
    const topResults: RecordedTopResult[] = Array.from({ length: 13 }, (_, index) => ({
        ...topResult({}),
        rank: index + 1,
        path: `src/noise-${index}.ts`,
        score: 20 - index,
    }));
    topResults.push(topResult({
        rank: 14,
        path: "src/primary.ts",
        score: 1,
        lineRange: "14-14",
        matched: "primary" as const,
    }));

    const scoring = scoreTopResults(
        {
            id: "case-3",
            question: "q",
            expected: {
                primaryPaths: ["src/primary.ts"],
            },
        },
        topResults
    );

    assert.equal(scoring.firstPrimaryRank, 14);
    assert.equal(scoring.suggestedScore, 2);
});

test("auditFreshness reports missing expected paths and stale result paths", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-audit-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "exists.ts"), "export const exists = true;\n");

    const freshness = auditFreshness(
        projectRoot,
        {
            id: "case-4",
            question: "q",
            expected: {
                primaryPaths: ["src/exists.ts"],
                acceptablePaths: ["src/missing.ts"],
            },
        },
        [
            topResult({ rank: 1, path: "src/exists.ts", matched: "primary" }),
            topResult({ rank: 2, path: "src/deleted.ts", score: 0.5 }),
        ]
    );

    assert.deepEqual(freshness.missingExpectedPaths, ["src/missing.ts"]);
    assert.deepEqual(freshness.missingPrimaryPaths, []);
    assert.deepEqual(freshness.missingAcceptablePaths, ["src/missing.ts"]);
    assert.deepEqual(freshness.staleResultPaths, ["src/deleted.ts"]);
    assert.equal(freshness.scorable, true);
});

test("auditFreshness marks cases unscorable when all primary paths are missing", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-unscorable-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "fallback.ts"), "export function fallback() {}\n");

    const freshness = auditFreshness(
        projectRoot,
        {
            id: "case-4b",
            question: "q",
            expected: {
                primaryPaths: ["src/deleted.ts"],
                acceptablePaths: ["src/fallback.ts"],
            },
        },
        [topResult({ rank: 1, path: "src/fallback.ts", matched: "acceptable" })]
    );

    assert.deepEqual(freshness.missingPrimaryPaths, ["src/deleted.ts"]);
    assert.deepEqual(freshness.missingAcceptablePaths, []);
    assert.equal(freshness.scorable, false);
    assert.equal(freshness.scoreExclusionReason, "all_primary_paths_missing");
});

test("auditProjectsForPlan separates primary, acceptable, stale, and unscorable preflight findings", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-plan-audit-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "exists.ts"), "export const exists = true;\n");

    const projects = [{
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [
            {
                id: "case-a",
                question: "q",
                expected: {
                    primaryPaths: ["src/exists.ts"],
                    acceptablePaths: ["src/missing-acceptable.ts"],
                },
            },
            {
                id: "case-b",
                question: "q",
                expected: {
                    primaryPaths: ["src/missing-primary.ts"],
                },
            },
        ],
    }];
    const latest = new Map([
        ["project/case-a", {
            topResults: [topResult({ path: "src/deleted-result.ts" })],
        }],
    ]);

    const summary = auditProjectsForPlan(projects, latest);
    const projectSummary = summary.get("project");

    assert.ok(projectSummary);
    assert.equal(projectSummary.missingExpectedPathCount, 2);
    assert.equal(projectSummary.missingPrimaryPathCount, 1);
    assert.equal(projectSummary.missingAcceptablePathCount, 1);
    assert.equal(projectSummary.staleResultPathCount, 1);
    assert.deepEqual(projectSummary.missingPrimaryPaths, [{
        caseId: "case-b",
        paths: ["src/missing-primary.ts"],
    }]);
    assert.deepEqual(projectSummary.missingAcceptablePaths, [{
        caseId: "case-a",
        paths: ["src/missing-acceptable.ts"],
    }]);
    assert.deepEqual(projectSummary.staleResultPaths, [{
        caseId: "case-a",
        paths: ["src/deleted-result.ts"],
    }]);
    assert.deepEqual(getUnscorableBenchmarkCases(summary), [{
        project: "project",
        caseId: "case-b",
        missingPrimaryPaths: ["src/missing-primary.ts"],
    }]);
});

test("assertBenchmarkPreflightAllowsRun blocks only scorable=false cases", () => {
    const cleanSummary = new Map([["project", {
        missingExpectedPathCases: 1,
        missingExpectedPathCount: 1,
        missingPrimaryPathCases: 0,
        missingPrimaryPathCount: 0,
        missingAcceptablePathCases: 1,
        missingAcceptablePathCount: 1,
        staleResultPathCases: 1,
        staleResultPathCount: 1,
        unscorableCases: [],
        missingExpectedPaths: [{ caseId: "case-a", paths: ["src/missing-acceptable.ts"] }],
        missingPrimaryPaths: [],
        missingAcceptablePaths: [{ caseId: "case-a", paths: ["src/missing-acceptable.ts"] }],
        staleResultPaths: [{ caseId: "case-a", paths: ["src/deleted-result.ts"] }],
    }]]);
    assert.doesNotThrow(() => assertBenchmarkPreflightAllowsRun(cleanSummary));

    const failingSummary = new Map([["project", {
        ...cleanSummary.get("project")!,
        unscorableCases: [{ caseId: "case-b", missingPrimaryPaths: ["src/missing-primary.ts"] }],
    }]]);

    assert.throws(
        () => assertBenchmarkPreflightAllowsRun(failingSummary),
        /Benchmark preflight failed: 1 active case\(s\) are scorable=false/
    );
});

test("ensureProjectIndex reuses existing indexes without marking them temporary", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-existing-index-"));
    const statePath = path.join(tempRoot, "state.json");
    const projectRoot = path.join(tempRoot, "project");
    fs.mkdirSync(projectRoot);
    let indexCalls = 0;

    const status = await ensureProjectIndex({
        semanticSearch: async () => [],
        getCollectionName: () => "collection_existing",
        hasIndex: async () => true,
        indexCodebase: async () => {
            indexCalls += 1;
            return { indexedFiles: 1, totalChunks: 1, status: "completed" };
        },
        clearIndex: async () => undefined,
    }, {
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [],
    }, statePath, "run-1");

    assert.deepEqual(status, {
        collectionName: "collection_existing",
        temporary: false,
        createdNow: false,
    });
    assert.equal(indexCalls, 0);
    assert.deepEqual(readTemporaryIndexes(statePath), []);
});

test("ensureProjectIndex records missing indexes as temporary benchmark indexes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-temporary-index-"));
    const statePath = path.join(tempRoot, "state.json");
    const projectRoot = path.join(tempRoot, "project");
    fs.mkdirSync(projectRoot);
    let indexCalls = 0;

    const status = await ensureProjectIndex({
        semanticSearch: async () => [],
        getCollectionName: () => "collection_temporary",
        hasIndex: async () => false,
        indexCodebase: async (_projectRoot, onProgress) => {
            indexCalls += 1;
            onProgress({ percentage: 100, phase: "done" });
            return { indexedFiles: 2, totalChunks: 3, status: "completed" };
        },
        clearIndex: async () => undefined,
    }, {
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [],
    }, statePath, "run-1");

    assert.deepEqual(status, {
        collectionName: "collection_temporary",
        temporary: true,
        createdNow: true,
    });
    assert.equal(indexCalls, 1);
    assert.deepEqual(readTemporaryIndexes(statePath).map((record) => ({
        project: record.project,
        projectRoot: record.projectRoot,
        collectionName: record.collectionName,
    })), [{
        project: "project",
        projectRoot,
        collectionName: "collection_temporary",
    }]);
});

test("clearCompletedProjectIndex keeps completed pre-existing indexes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-keep-existing-"));
    const projectRoot = path.join(tempRoot, "project");
    const resultsPath = path.join(tempRoot, "results.jsonl");
    const statePath = path.join(tempRoot, "state.json");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(resultsPath, `${JSON.stringify({ project: "project", caseId: "case-a", status: "completed" })}\n`);
    let clearCalls = 0;

    await clearCompletedProjectIndex({
        semanticSearch: async () => [],
        getCollectionName: () => "collection_existing",
        hasIndex: async () => true,
        indexCodebase: async () => ({ indexedFiles: 1, totalChunks: 1, status: "completed" }),
        clearIndex: async () => {
            clearCalls += 1;
        },
    }, resultsPath, statePath, "run-1", {
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [{ id: "case-a", question: "q", expected: { primaryPaths: ["src/a.ts"] } }],
    }, { keepIndex: false } as Parameters<typeof clearCompletedProjectIndex>[5], {
        collectionName: "collection_existing",
        temporary: false,
        createdNow: false,
    });

    assert.equal(clearCalls, 0);
    assert.deepEqual(readTemporaryIndexes(statePath), []);
});

test("clearCompletedProjectIndex clears completed temporary indexes and removes state records", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-clear-temporary-"));
    const projectRoot = path.join(tempRoot, "project");
    const resultsPath = path.join(tempRoot, "results.jsonl");
    const statePath = path.join(tempRoot, "state.json");
    fs.mkdirSync(projectRoot);
    fs.writeFileSync(resultsPath, `${JSON.stringify({ project: "project", caseId: "case-a", status: "completed" })}\n`);
    fs.writeFileSync(statePath, `${JSON.stringify({
        status: "running",
        temporaryIndexes: [{
            project: "project",
            projectRoot,
            collectionName: "collection_temporary",
            createdAt: "2026-06-20T00:00:00.000Z",
        }],
    })}\n`);
    const clearedRoots: string[] = [];

    await clearCompletedProjectIndex({
        semanticSearch: async () => [],
        getCollectionName: () => "collection_temporary",
        hasIndex: async () => true,
        indexCodebase: async () => ({ indexedFiles: 1, totalChunks: 1, status: "completed" }),
        clearIndex: async (targetRoot) => {
            clearedRoots.push(targetRoot);
        },
    }, resultsPath, statePath, "run-1", {
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [{ id: "case-a", question: "q", expected: { primaryPaths: ["src/a.ts"] } }],
    }, { keepIndex: false } as Parameters<typeof clearCompletedProjectIndex>[5], {
        collectionName: "collection_temporary",
        temporary: true,
        createdNow: true,
    });

    assert.deepEqual(clearedRoots, [projectRoot]);
    assert.deepEqual(readTemporaryIndexes(statePath), []);
});

test("getAuditRefreshNeededRecords detects records whose embedded freshness is stale", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-stale-freshness-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "target.ts"), "export const target = true;\n");

    const projects = [{
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [{
            id: "case-a",
            question: "q",
            expected: {
                primaryPaths: ["src/target.ts"],
                acceptablePaths: ["src/missing-acceptable.ts"],
            },
        }],
    }];
    const latest = new Map([["project/case-a", {
        runId: "old",
        fixture: "fixture",
        project: "project",
        projectRoot,
        caseId: "case-a",
        question: "q",
        status: "completed" as const,
        startedAt: "2026-06-17T00:00:00.000Z",
        finishedAt: "2026-06-17T00:00:00.001Z",
        durationMs: 1,
        suggestedScore: 5,
        scoringReason: "old",
        firstPrimaryRank: 1,
        firstAcceptableRank: null,
        firstPrimarySymbolRank: null,
        firstAcceptableSymbolRank: null,
        symbolHitCount: 0,
        needsManualReview: false,
        scoreExcluded: false,
        freshness: {
            missingExpectedPaths: [],
            missingPrimaryPaths: [],
            missingAcceptablePaths: [],
            staleResultPaths: [],
            scorable: true,
        },
        failureTaxonomy: "expected_hit" as const,
        failureDiagnostics: [],
        failureReasons: [],
        queryAnchors: [],
        anchorCoverage: { extracted: [], recalled: [], missing: [] },
        topResults: [topResult({ path: "src/target.ts", matched: "primary" })],
        scoreVersion: "file-rank-v4",
    }]]);

    assert.deepEqual(getAuditRefreshNeededRecords(latest, projects), [{
        project: "project",
        caseId: "case-a",
    }]);
});

test("getAuditRefreshNeededRecords checks stale completed records even when other cases are pending", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-mixed-refresh-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "target.ts"), "export const target = true;\n");
    fs.writeFileSync(path.join(projectRoot, "src", "pending.ts"), "export const pending = true;\n");

    const projects = [{
        name: "project",
        root: projectRoot,
        projectRoot,
        projectRootExists: true,
        cases: [
            {
                id: "case-a",
                question: "q",
                expected: {
                    primaryPaths: ["src/target.ts"],
                },
            },
            {
                id: "case-b",
                question: "q",
                expected: {
                    primaryPaths: ["src/pending.ts"],
                },
            },
        ],
    }];
    const latest = new Map([["project/case-a", {
        runId: "old",
        fixture: "fixture",
        project: "project",
        projectRoot,
        caseId: "case-a",
        question: "q",
        status: "completed" as const,
        startedAt: "2026-06-17T00:00:00.000Z",
        finishedAt: "2026-06-17T00:00:00.001Z",
        durationMs: 1,
        suggestedScore: 5,
        scoringReason: "old",
        firstPrimaryRank: 1,
        firstAcceptableRank: null,
        firstPrimarySymbolRank: null,
        firstAcceptableSymbolRank: null,
        symbolHitCount: 0,
        needsManualReview: false,
        scoreExcluded: false,
        freshness: {
            missingExpectedPaths: [],
            staleResultPaths: [],
        },
        failureTaxonomy: "expected_hit" as const,
        failureDiagnostics: [],
        failureReasons: [],
        topResults: [topResult({ path: "src/target.ts", matched: "primary" })],
        scoreVersion: "file-rank-v2",
    }]]);

    assert.deepEqual(getAuditRefreshNeededRecords(latest, projects), [{
        project: "project",
        caseId: "case-a",
    }]);
});

test("classifyFailure detects same-file saturation", () => {
    const benchmarkCase = {
        id: "case-5",
        question: "q",
        expected: {
            primaryPaths: ["src/target.ts"],
            primarySymbols: ["TargetSymbol"],
        },
    };
    const scoring = scoreTopResults(
        benchmarkCase,
        [
            topResult({ rank: 1, path: "src/noise.ts", score: 10 }),
            topResult({ rank: 2, path: "src/noise.ts", score: 9, lineRange: "2-2" }),
            topResult({ rank: 3, path: "src/noise.ts", score: 8, lineRange: "3-3" }),
            topResult({ rank: 4, path: "src/other.ts", score: 7, lineRange: "4-4" }),
            topResult({ rank: 5, path: "src/other.ts", score: 6, lineRange: "5-5" }),
            topResult({ rank: 6, path: "src/target.ts", score: 5, lineRange: "6-6", matched: "primary", symbolHits: ["TargetSymbol"], hasSymbolHit: true }),
        ]
    );

    const taxonomy = classifyFailure(
        scoring,
        { missingExpectedPaths: [], staleResultPaths: [] },
        benchmarkCase
    );

    assert.equal(taxonomy.failureTaxonomy, "expected_hit");
    assert.deepEqual(taxonomy.failureDiagnostics, ["same_file_saturation"]);
    assert.deepEqual(taxonomy.failureReasons, ["same_file_saturation"]);
});

test("classifyFailure detects recalled anchors that are ranked too low", () => {
    const benchmarkCase = {
        id: "case-5b",
        question: "q",
        expected: {
            primaryPaths: ["src/target.ts"],
            primarySymbols: ["TargetSymbol"],
        },
    };
    const topResults: RecordedTopResult[] = Array.from({ length: 8 }, (_, index) => topResult({
        rank: index + 1,
        path: `src/noise-${index}.ts`,
        score: 20 - index,
    }));
    topResults.push(topResult({
        rank: 9,
        path: "src/target.ts",
        score: 1,
        lineRange: "9-9",
        matched: "primary" as const,
        symbolHits: ["TargetSymbol"],
        hasSymbolHit: true,
    }));

    const scoring = scoreTopResults(benchmarkCase, topResults);
    const taxonomy = classifyFailure(
        scoring,
        { missingExpectedPaths: [], staleResultPaths: [] },
        benchmarkCase
    );

    assert.equal(taxonomy.failureTaxonomy, "expected_hit");
    assert.deepEqual(taxonomy.failureDiagnostics, ["anchor_recalled_but_reranked"]);
    assert.deepEqual(taxonomy.failureReasons, ["anchor_recalled_but_reranked"]);
});

test("rewriteResultWithAudit rescoring fills freshness and failure taxonomy on existing records", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-rescore-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "target.ts"), "export function TargetSymbol() {}\n");

    const rewritten = rewriteResultWithAudit(
        {
            runId: "old",
            fixture: "fixture",
            project: "project",
            projectRoot,
            caseId: "case-6",
            question: "q",
            status: "completed",
            startedAt: "2026-06-17T00:00:00.000Z",
            finishedAt: "2026-06-17T00:00:00.001Z",
            durationMs: 1,
            suggestedScore: 1,
            scoringReason: "old",
            firstPrimaryRank: null,
            firstAcceptableRank: null,
            firstPrimarySymbolRank: null,
            firstAcceptableSymbolRank: null,
            symbolHitCount: 0,
            needsManualReview: true,
            topResults: [
                topResult({ rank: 1, path: "src/deleted.ts" }),
                topResult({
                    rank: 2,
                    path: "src/target.ts",
                    score: 0.5,
                    matched: "primary",
                    symbolHits: ["TargetSymbol"],
                    hasSymbolHit: true,
                    anchorHits: ["FRONTEND_BASE_URL", "/v1/chat/completions"],
                }),
            ],
        },
        {
            projectRoot,
            benchmarkCase: {
                id: "case-6",
                question: "Where is FRONTEND_BASE_URL used for /v1/chat/completions?",
                expected: {
                    primaryPaths: ["src/target.ts"],
                    acceptablePaths: ["src/missing.ts"],
                    primarySymbols: ["TargetSymbol"],
                },
            },
        }
    );

    assert.equal(rewritten.suggestedScore, 5);
    assert.equal(rewritten.failureTaxonomy, "expected_hit");
    assert.deepEqual(rewritten.freshness.missingExpectedPaths, ["src/missing.ts"]);
    assert.deepEqual(rewritten.freshness.staleResultPaths, ["src/deleted.ts"]);
    assert.deepEqual(rewritten.failureDiagnostics, ["missing_expected_path", "stale_result_path"]);
    assert.deepEqual(rewritten.failureReasons, ["missing_expected_path", "stale_result_path"]);
    assert.deepEqual(rewritten.queryAnchors, ["FRONTEND_BASE_URL", "/v1/chat/completions"]);
    assert.deepEqual(rewritten.anchorCoverage.extracted, ["FRONTEND_BASE_URL", "/v1/chat/completions"]);
    assert.deepEqual(rewritten.anchorCoverage.recalled, ["FRONTEND_BASE_URL", "/v1/chat/completions"]);
    assert.deepEqual(rewritten.anchorCoverage.missing, []);
});

test("rewriteResultWithAudit excludes invalid fixture cases from scoring", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hce-benchmark-invalid-fixture-"));
    fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "src", "fallback.ts"), "export function fallback() {}\n");

    const rewritten = rewriteResultWithAudit(
        {
            runId: "old",
            fixture: "fixture",
            project: "project",
            projectRoot,
            caseId: "case-6b",
            question: "q",
            status: "completed",
            startedAt: "2026-06-17T00:00:00.000Z",
            finishedAt: "2026-06-17T00:00:00.001Z",
            durationMs: 1,
            suggestedScore: 5,
            scoringReason: "old",
            firstPrimaryRank: 1,
            firstAcceptableRank: null,
            firstPrimarySymbolRank: 1,
            firstAcceptableSymbolRank: null,
            symbolHitCount: 1,
            needsManualReview: false,
            topResults: [
                topResult({
                    rank: 1,
                    path: "src/fallback.ts",
                    matched: "acceptable",
                    symbolHits: ["FallbackSymbol"],
                    hasSymbolHit: true,
                }),
            ],
        },
        {
            projectRoot,
            benchmarkCase: {
                id: "case-6b",
                question: "Where is DeletedSymbol implemented?",
                expected: {
                    primaryPaths: ["src/deleted.ts"],
                    acceptablePaths: ["src/fallback.ts"],
                    primarySymbols: ["DeletedSymbol"],
                },
            },
        }
    );

    assert.equal(rewritten.failureTaxonomy, "invalid_fixture");
    assert.equal(rewritten.scoreExcluded, true);
    assert.equal(rewritten.scoreExclusionReason, "all_primary_paths_missing");
    assert.equal(rewritten.freshness.scorable, false);
});

test("resultNeedsAuditRefresh detects records missing anchor audit fields", () => {
    const legacyRecord = {
        runId: "old",
        fixture: "fixture",
        project: "project",
        projectRoot: "/repo",
        caseId: "case-7",
        question: "Where is FRONTEND_BASE_URL used?",
        status: "completed" as const,
        startedAt: "2026-06-17T00:00:00.000Z",
        finishedAt: "2026-06-17T00:00:00.001Z",
        durationMs: 1,
        suggestedScore: 1,
        scoringReason: "old",
        firstPrimaryRank: null,
        firstAcceptableRank: null,
        firstPrimarySymbolRank: null,
        firstAcceptableSymbolRank: null,
        symbolHitCount: 0,
        needsManualReview: true,
        freshness: { missingExpectedPaths: [], staleResultPaths: [] },
        failureTaxonomy: "search_miss" as const,
        failureDiagnostics: [],
        failureReasons: [],
        topResults: [topResult({ path: "src/target.ts" })],
        scoreVersion: "file-rank-v2",
    };

    assert.equal(resultNeedsAuditRefresh(legacyRecord as Parameters<typeof resultNeedsAuditRefresh>[0]), true);
});
