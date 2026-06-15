import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    Context,
    MilvusVectorDatabase,
    type SymbolTraceEvidence,
    type SymbolTraceResult
} from "@hitmux/hitmux-context-engine-core";
import { createMcpConfig } from "../../packages/mcp/src/config.js";
import { createEmbeddingInstance } from "../../packages/mcp/src/embedding.js";

type ExpectedRole = "implementation" | "test" | "docs" | "config" | "barrel" | "entrypoint" | "generated";

interface BenchmarkCase {
    id: string;
    query: string;
    expected: Array<{
        path: string;
        role: ExpectedRole;
    }>;
    manualLabel: string;
}

interface BenchmarkFixture {
    name: string;
    codebasePath: string;
    manualBaseline?: unknown;
    cases: BenchmarkCase[];
}

interface SearchResult {
    content: string;
    relativePath: string;
    startLine: number;
    endLine: number;
    language: string;
    score: number;
}

interface CaseReport {
    id: string;
    query: string;
    manualLabel: string;
    expected: BenchmarkCase["expected"];
    firstExpectedRank: number | null;
    expectedImplementationTop3: boolean;
    expectedImplementationTop5: boolean;
    expectedImplementationTop5OrTraceEvidence: boolean;
    firstResultRole: ExpectedRole;
    testFirst: boolean;
    barrelFirst: boolean;
    relatedTestsPresent: boolean;
    traceEvidence: TraceEvidenceReport;
    topResults: Array<{
        rank: number;
        path: string;
        role: ExpectedRole;
        score: number;
        lineRange: string;
    }>;
}

interface TraceEvidenceReport {
    status: "direct_top5_hit" | "covered_by_trace" | "not_covered" | "not_applicable" | "disabled";
    expectedImplementationCovered: boolean;
    coveredExpectedPaths: string[];
    checkedTopResults: number;
    traces: TraceEvidenceItem[];
}

interface TraceEvidenceItem {
    resultRank: number;
    resultPath: string;
    symbol: string;
    coveredExpectedPaths: string[];
    evidenceChain: TraceEvidenceChainStep[];
    ownerDefinitions: string[];
    entryReferences: string[];
    callChain: string[];
    moduleLinks: string[];
    relatedTests: string[];
    truncated: boolean;
    warnings: string[];
}

interface TraceEvidenceChainStep {
    kind: "entry_result" | "import" | "export" | "owner_definition" | "call" | "reference";
    path: string;
    line?: number;
    lineRange?: string;
    symbol?: string;
    targetPath?: string;
    detail?: string;
    rank?: number;
}

interface BenchmarkReport {
    fixture: string;
    codebasePath: string;
    generatedAt: string;
    limit: number;
    threshold: number;
    traceEvidenceEnabled: boolean;
    summary: {
        totalCases: number;
        expectedImplementationTop3: number;
        expectedImplementationTop5: number;
        expectedImplementationTop5OrTraceEvidence: number;
        missingExpected: number;
        missingExpectedImplementationTop5CoveredByTraceEvidence: number;
        testFirstRate: number;
        barrelFirstRate: number;
        relatedTestsPresent: number;
    };
    cases: CaseReport[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES_PATH = path.join(SCRIPT_DIR, "cannonwar-cases.json");
const TRACE_EVIDENCE_RESULT_LIMIT = 8;
const TRACE_EVIDENCE_SYMBOL_LIMIT = 3;
const TRACE_EVIDENCE_MAX_FILES = 1000;
const TRACE_EVIDENCE_MAX_REFERENCES = 40;

function parseArgs(argv: string[]) {
    const options: {
        casesPath: string;
        codebasePath?: string;
        outPath?: string;
        limit: number;
        threshold: number;
        includeTraceEvidence: boolean;
    } = {
        casesPath: DEFAULT_CASES_PATH,
        limit: 20,
        threshold: 0.3,
        includeTraceEvidence: true,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];

        if (arg === "--") {
            continue;
        } else if (arg === "--cases" && next) {
            options.casesPath = path.resolve(next);
            index += 1;
        } else if (arg === "--codebase" && next) {
            options.codebasePath = path.resolve(next);
            index += 1;
        } else if (arg === "--out" && next) {
            options.outPath = path.resolve(next);
            index += 1;
        } else if (arg === "--limit" && next) {
            options.limit = parsePositiveInteger(next, "--limit");
            index += 1;
        } else if (arg === "--threshold" && next) {
            options.threshold = parseFiniteNumber(next, "--threshold");
            index += 1;
        } else if (arg === "--no-trace-evidence") {
            options.includeTraceEvidence = false;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown or incomplete argument: ${arg}`);
        }
    }

    return options;
}

function parsePositiveInteger(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }

    return parsed;
}

function parseFiniteNumber(value: string, name: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${name} must be a finite number`);
    }

    return parsed;
}

function printHelp(): void {
    console.log(`Usage:
  pnpm --dir packages/mcp exec tsx ../../evaluation/search-quality/run-cannonwar-search-quality.ts [options]

Options:
  --cases <path>       Fixture JSON path.
  --codebase <path>    Codebase path. Defaults to the fixture codebasePath.
  --limit <n>          Visible search result limit. Default: 20.
  --threshold <n>      Search threshold. Default: 0.3.
  --no-trace-evidence  Skip trace_symbol-based auxiliary evidence for top5 misses.
  --out <path>         Write JSON report to this path.
`);
}

function readFixture(casesPath: string): BenchmarkFixture {
    const raw = fs.readFileSync(casesPath, "utf8");
    const fixture = JSON.parse(raw) as BenchmarkFixture;

    if (!fixture.name || !Array.isArray(fixture.cases)) {
        throw new Error(`Invalid benchmark fixture: ${casesPath}`);
    }

    for (const benchmarkCase of fixture.cases) {
        if (!benchmarkCase.id || !benchmarkCase.query || !Array.isArray(benchmarkCase.expected)) {
            throw new Error(`Invalid benchmark case in ${casesPath}: ${JSON.stringify(benchmarkCase)}`);
        }
    }

    return fixture;
}

function inferResultRole(result: SearchResult): ExpectedRole {
    const normalizedPath = result.relativePath.replace(/\\/g, "/");
    const lowerPath = normalizedPath.toLowerCase();
    const fileName = lowerPath.split("/").pop() || "";
    const extension = path.posix.extname(fileName);

    if (
        lowerPath.includes("/dist/")
        || lowerPath.includes("/build/")
        || lowerPath.includes("/generated/")
        || lowerPath.includes("/__generated__/")
        || fileName.endsWith(".d.ts")
        || fileName.includes(".generated.")
    ) {
        return "generated";
    }

    if (
        lowerPath.includes("/__tests__/")
        || lowerPath.includes("/test/")
        || lowerPath.includes("/tests/")
        || lowerPath.includes("/spec/")
        || lowerPath.includes("/specs/")
        || fileName.includes(".test.")
        || fileName.includes(".spec.")
        || fileName.includes(".e2e.")
    ) {
        return "test";
    }

    if ([".md", ".markdown", ".mdx", ".rst", ".adoc", ".txt"].includes(extension) || lowerPath.includes("/docs/")) {
        return "docs";
    }

    if (
        [".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini"].includes(extension)
        || fileName.includes(".config.")
        || fileName.startsWith(".")
    ) {
        return "config";
    }

    if (fileName === "index.ts" || fileName === "index.js") {
        const content = result.content.trim();
        const exportOnly = content.length > 0
            && content.split(/\r?\n/).every((line) => {
                const trimmed = line.trim();
                return trimmed.length === 0
                    || trimmed.startsWith("export ")
                    || trimmed.startsWith("import ")
                    || trimmed.startsWith("//");
            });
        return exportOnly ? "barrel" : "entrypoint";
    }

    return "implementation";
}

async function summarizeCase(
    context: Context,
    codebasePath: string,
    benchmarkCase: BenchmarkCase,
    results: SearchResult[],
    includeTraceEvidence: boolean
): Promise<CaseReport> {
    const expectedPathSet = new Set(benchmarkCase.expected.map((item) => item.path));
    const implementationPathSet = new Set(
        benchmarkCase.expected
            .filter((item) => item.role === "implementation")
            .map((item) => item.path)
    );
    const firstExpectedIndex = results.findIndex((result) => expectedPathSet.has(result.relativePath));
    const firstImplementationIndex = results.findIndex((result) => implementationPathSet.has(result.relativePath));
    const topResult = results[0];
    const firstResultRole = topResult ? inferResultRole(topResult) : "implementation";
    const resultRoles = results.map(inferResultRole);
    const expectedImplementationTop3 = firstImplementationIndex >= 0 && firstImplementationIndex < 3;
    const expectedImplementationTop5 = firstImplementationIndex >= 0 && firstImplementationIndex < 5;
    const traceEvidence = await buildTraceEvidenceReport({
        context,
        codebasePath,
        results,
        implementationPathSet,
        expectedImplementationTop5,
        includeTraceEvidence,
    });

    return {
        id: benchmarkCase.id,
        query: benchmarkCase.query,
        manualLabel: benchmarkCase.manualLabel,
        expected: benchmarkCase.expected,
        firstExpectedRank: firstExpectedIndex >= 0 ? firstExpectedIndex + 1 : null,
        expectedImplementationTop3,
        expectedImplementationTop5,
        expectedImplementationTop5OrTraceEvidence: expectedImplementationTop5 || traceEvidence.expectedImplementationCovered,
        firstResultRole,
        testFirst: firstResultRole === "test",
        barrelFirst: firstResultRole === "barrel",
        relatedTestsPresent: resultRoles.includes("test"),
        traceEvidence,
        topResults: results.slice(0, 10).map((result, index) => ({
            rank: index + 1,
            path: result.relativePath,
            role: inferResultRole(result),
            score: result.score,
            lineRange: result.startLine > 0 && result.endLine > 0
                ? `${result.startLine}-${result.endLine}`
                : "unknown",
        })),
    };
}

async function buildTraceEvidenceReport({
    context,
    codebasePath,
    results,
    implementationPathSet,
    expectedImplementationTop5,
    includeTraceEvidence,
}: {
    context: Context;
    codebasePath: string;
    results: SearchResult[];
    implementationPathSet: Set<string>;
    expectedImplementationTop5: boolean;
    includeTraceEvidence: boolean;
}): Promise<TraceEvidenceReport> {
    if (implementationPathSet.size === 0) {
        return createTraceEvidenceReport("not_applicable", false, [], 0, []);
    }

    if (expectedImplementationTop5) {
        return createTraceEvidenceReport("direct_top5_hit", true, [...implementationPathSet], 0, []);
    }

    if (!includeTraceEvidence) {
        return createTraceEvidenceReport("disabled", false, [], 0, []);
    }

    const traces: TraceEvidenceItem[] = [];
    const coveredExpectedPaths = new Set<string>();
    const traceableResults = results
        .slice(0, TRACE_EVIDENCE_RESULT_LIMIT)
        .map((result, index) => ({ result, rank: index + 1 }))
        .filter(({ result }) => {
            const role = inferResultRole(result);
            return role === "implementation" || role === "entrypoint" || role === "barrel";
        });

    for (const { result, rank } of traceableResults) {
        const symbols = extractTraceSymbols(result.content).slice(0, TRACE_EVIDENCE_SYMBOL_LIMIT);
        for (const symbol of symbols) {
            try {
                const trace = await context.traceSymbol(codebasePath, symbol, {
                    startPath: result.relativePath,
                    startLine: hasValidLineRange(result) ? result.startLine : undefined,
                    endLine: hasValidLineRange(result) ? result.endLine : undefined,
                    maxFiles: TRACE_EVIDENCE_MAX_FILES,
                    maxReferences: TRACE_EVIDENCE_MAX_REFERENCES,
                    includeTests: true,
                });
                const item = createTraceEvidenceItem(rank, result, symbol, trace, implementationPathSet);
                for (const coveredPath of item.coveredExpectedPaths) {
                    coveredExpectedPaths.add(coveredPath);
                }
                traces.push(item);
            } catch (error) {
                traces.push({
                    resultRank: rank,
                    resultPath: result.relativePath,
                    symbol,
                    coveredExpectedPaths: [],
                    evidenceChain: [{
                        kind: "entry_result",
                        path: result.relativePath,
                        lineRange: formatResultLineRange(result),
                        rank,
                    }],
                    ownerDefinitions: [],
                    entryReferences: [],
                    callChain: [],
                    moduleLinks: [],
                    relatedTests: [],
                    truncated: false,
                    warnings: [`trace failed: ${error instanceof Error ? error.message : String(error)}`],
                });
            }
        }
    }

    const covered = coveredExpectedPaths.size > 0;
    return createTraceEvidenceReport(
        covered ? "covered_by_trace" : "not_covered",
        covered,
        [...coveredExpectedPaths],
        traceableResults.length,
        traces
    );
}

function createTraceEvidenceReport(
    status: TraceEvidenceReport["status"],
    expectedImplementationCovered: boolean,
    coveredExpectedPaths: string[],
    checkedTopResults: number,
    traces: TraceEvidenceItem[]
): TraceEvidenceReport {
    return {
        status,
        expectedImplementationCovered,
        coveredExpectedPaths,
        checkedTopResults,
        traces,
    };
}

function extractTraceSymbols(content: string): string[] {
    const symbols = new Set<string>();
    const addSymbol = (value: string | undefined) => {
        if (!value || !/^[A-Z][A-Za-z0-9_$]*$/.test(value) || isUnhelpfulTraceSymbol(value)) {
            return;
        }
        symbols.add(value);
    };

    const patterns = [
        /@delegate\s+([A-Z][A-Za-z0-9_$]*)\b/g,
        /\b(?:new|extends|implements)\s+([A-Z][A-Za-z0-9_$]*)\b/g,
        /:\s*([A-Z][A-Za-z0-9_$]*)\b/g,
        /\bas\s+([A-Z][A-Za-z0-9_$]*)\b/g,
        /\b(?:class|interface|type|enum)\s+([A-Z][A-Za-z0-9_$]*)\b/g,
    ];

    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            addSymbol(match[1]);
        }
    }

    for (const importMatch of content.matchAll(/\bimport\s*\{([^}]+)\}/g)) {
        for (const imported of importMatch[1].split(",")) {
            const name = imported.trim().split(/\s+as\s+/)[0]?.trim();
            addSymbol(name);
        }
    }

    for (const exportMatch of content.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
        for (const exported of exportMatch[1].split(",")) {
            const name = exported.trim().split(/\s+as\s+/)[0]?.trim();
            addSymbol(name);
        }
    }

    return [...symbols];
}

function isUnhelpfulTraceSymbol(symbol: string): boolean {
    return new Set([
        "Array",
        "Boolean",
        "Date",
        "Error",
        "Map",
        "Number",
        "Object",
        "Promise",
        "Record",
        "Set",
        "String",
        "WeakMap",
        "WeakSet",
    ]).has(symbol);
}

function hasValidLineRange(result: SearchResult): boolean {
    return Number.isInteger(result.startLine)
        && Number.isInteger(result.endLine)
        && result.startLine > 0
        && result.endLine >= result.startLine;
}

function createTraceEvidenceItem(
    resultRank: number,
    result: SearchResult,
    symbol: string,
    trace: SymbolTraceResult,
    implementationPathSet: Set<string>
): TraceEvidenceItem {
    const coveredExpectedPaths = findCoveredExpectedPaths(trace, implementationPathSet);

    return {
        resultRank,
        resultPath: result.relativePath,
        symbol,
        coveredExpectedPaths,
        evidenceChain: buildTraceEvidenceChain(resultRank, result, symbol, trace),
        ownerDefinitions: formatEvidenceLocations(trace.definitions),
        entryReferences: formatEvidenceLocations(trace.references),
        callChain: formatCallChain(trace.references),
        moduleLinks: formatModuleLinks([...trace.imports, ...trace.exports]),
        relatedTests: formatEvidenceLocations(trace.relatedTests),
        truncated: trace.truncated,
        warnings: trace.warnings.slice(0, 3),
    };
}

function buildTraceEvidenceChain(
    resultRank: number,
    result: SearchResult,
    symbol: string,
    trace: SymbolTraceResult
): TraceEvidenceChainStep[] {
    const steps: TraceEvidenceChainStep[] = [{
        kind: "entry_result",
        path: result.relativePath,
        lineRange: formatResultLineRange(result),
        symbol,
        rank: resultRank,
    }];
    const seen = new Set<string>();
    const pushStep = (step: TraceEvidenceChainStep) => {
        const key = `${step.kind}:${step.path}:${step.line ?? ""}:${step.targetPath ?? ""}:${step.detail ?? ""}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        steps.push(step);
    };

    for (const entry of [...trace.imports, ...trace.exports]
        .filter((item) => item.resolvedPath)
        .slice(0, 3)) {
        pushStep({
            kind: entry.kind === "export" ? "export" : "import",
            path: entry.relativePath,
            line: entry.line,
            symbol,
            targetPath: entry.resolvedPath,
            detail: entry.moduleSpecifier,
        });
    }

    for (const entry of trace.definitions.slice(0, 1)) {
        pushStep({
            kind: "owner_definition",
            path: entry.relativePath,
            line: entry.line,
            symbol,
        });
    }

    const callReference = trace.references.find((entry) => entry.enclosingSymbol && entry.callTarget);
    if (callReference) {
        pushStep({
            kind: "call",
            path: callReference.relativePath,
            line: callReference.line,
            symbol,
            detail: `${callReference.enclosingSymbol} -> ${callReference.callTarget}`,
        });
    } else if (trace.references[0]) {
        pushStep({
            kind: "reference",
            path: trace.references[0].relativePath,
            line: trace.references[0].line,
            symbol,
        });
    }

    return steps;
}

function findCoveredExpectedPaths(trace: SymbolTraceResult, implementationPathSet: Set<string>): string[] {
    const covered = new Set<string>();
    const checkPath = (candidate: string | undefined, requireOwnerSymbol: boolean) => {
        if (!candidate) {
            return;
        }
        const normalized = normalizeReportPath(candidate);
        if (
            implementationPathSet.has(normalized)
            && (!requireOwnerSymbol || isOwnerSymbolForExpectedPath(trace.symbol, normalized))
        ) {
            covered.add(normalized);
        }
    };

    for (const entry of trace.definitions) {
        checkPath(entry.relativePath, true);
    }
    for (const entry of [...trace.imports, ...trace.exports]) {
        checkPath(entry.resolvedPath, true);
    }

    return [...covered];
}

function isOwnerSymbolForExpectedPath(symbol: string, expectedPath: string): boolean {
    const basename = path.posix.basename(expectedPath, path.posix.extname(expectedPath));
    const normalizedSymbol = normalizeIdentifierToken(symbol);
    const normalizedBasename = normalizeIdentifierToken(basename);

    return normalizedSymbol.length > 0
        && normalizedBasename.length > 0
        && (normalizedSymbol === normalizedBasename || normalizedBasename.includes(normalizedSymbol));
}

function normalizeIdentifierToken(value: string): string {
    return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function normalizeReportPath(value: string): string {
    return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function formatResultLineRange(result: SearchResult): string | undefined {
    return hasValidLineRange(result) ? `${result.startLine}-${result.endLine}` : undefined;
}

function formatEvidenceLocations(entries: SymbolTraceEvidence[]): string[] {
    return entries.slice(0, 3).map((entry) => `${entry.relativePath}:${entry.line}`);
}

function formatCallChain(entries: SymbolTraceEvidence[]): string[] {
    return entries
        .filter((entry) => entry.enclosingSymbol && entry.callTarget)
        .slice(0, 3)
        .map((entry) => `${entry.relativePath}:${entry.line} ${entry.enclosingSymbol} -> ${entry.callTarget}`);
}

function formatModuleLinks(entries: SymbolTraceEvidence[]): string[] {
    return entries
        .filter((entry) => entry.moduleSpecifier || entry.resolvedPath)
        .slice(0, 3)
        .map((entry) => {
            const resolved = entry.resolvedPath ? ` -> ${entry.resolvedPath}` : "";
            return `${entry.relativePath}:${entry.line}${resolved}`;
        });
}

function buildSummary(cases: CaseReport[]): BenchmarkReport["summary"] {
    const totalCases = cases.length;
    const expectedImplementationTop3 = cases.filter((item) => item.expectedImplementationTop3).length;
    const expectedImplementationTop5 = cases.filter((item) => item.expectedImplementationTop5).length;
    const expectedImplementationTop5OrTraceEvidence = cases.filter((item) => item.expectedImplementationTop5OrTraceEvidence).length;
    const missingExpected = cases.filter((item) => item.firstExpectedRank === null).length;
    const missingExpectedImplementationTop5CoveredByTraceEvidence = cases.filter((item) => (
        !item.expectedImplementationTop5 && item.traceEvidence.expectedImplementationCovered
    )).length;
    const testFirstCount = cases.filter((item) => item.testFirst).length;
    const barrelFirstCount = cases.filter((item) => item.barrelFirst).length;
    const relatedTestsPresent = cases.filter((item) => item.relatedTestsPresent).length;

    return {
        totalCases,
        expectedImplementationTop3,
        expectedImplementationTop5,
        expectedImplementationTop5OrTraceEvidence,
        missingExpected,
        missingExpectedImplementationTop5CoveredByTraceEvidence,
        testFirstRate: totalCases === 0 ? 0 : testFirstCount / totalCases,
        barrelFirstRate: totalCases === 0 ? 0 : barrelFirstCount / totalCases,
        relatedTestsPresent,
    };
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const fixture = readFixture(options.casesPath);
    const codebasePath = path.resolve(options.codebasePath ?? fixture.codebasePath);

    const config = createMcpConfig();
    const embedding = createEmbeddingInstance(config);
    const vectorDatabase = new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken }),
        useSystemProxy: config.databaseUseSystemProxy,
    });
    const context = new Context({
        embedding,
        vectorDatabase,
        collectionNameOverride: config.collectionNameOverride,
        collectionIdentity: {
            mode: config.codebaseIdentityMode,
            customIdentity: config.codebaseIdentity,
            globalName: config.globalCollectionName,
            gitRemoteName: config.gitRemoteName,
        },
    });

    const caseReports: CaseReport[] = [];
    for (const benchmarkCase of fixture.cases) {
        const results = await context.semanticSearch(codebasePath, benchmarkCase.query, options.limit, options.threshold);
        caseReports.push(await summarizeCase(
            context,
            codebasePath,
            benchmarkCase,
            results,
            options.includeTraceEvidence
        ));
    }

    const report: BenchmarkReport = {
        fixture: fixture.name,
        codebasePath,
        generatedAt: new Date().toISOString(),
        limit: options.limit,
        threshold: options.threshold,
        traceEvidenceEnabled: options.includeTraceEvidence,
        summary: buildSummary(caseReports),
        cases: caseReports,
    };

    const output = JSON.stringify(report, null, 2);
    if (options.outPath) {
        fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
        fs.writeFileSync(options.outPath, `${output}\n`, "utf8");
        console.log(`Wrote search-quality report to ${options.outPath}`);
    } else {
        console.log(output);
    }
}

main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
