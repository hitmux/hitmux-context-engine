import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    auditFreshness,
    classifyFailure,
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
    assert.equal(scoring.suggestedScore, 2);
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
    assert.deepEqual(freshness.staleResultPaths, ["src/deleted.ts"]);
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
