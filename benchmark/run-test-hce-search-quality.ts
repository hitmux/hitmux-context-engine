import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CaseStatus = "completed" | "error" | "skipped";
type FailureTaxonomy =
    | "expected_hit"
    | "search_miss"
    | "empty_result"
    | "search_error";

type FailureDiagnostic =
    | "missing_expected_path"
    | "stale_result_path"
    | "same_file_saturation"
    | "anchor_not_recalled"
    | "anchor_recalled_but_reranked";

interface ExpectedAnswer {
    primaryPaths: string[];
    acceptablePaths?: string[];
    primarySymbols?: string[];
    evidence?: string;
}

interface BenchmarkCase {
    id: string;
    question: string;
    expected: ExpectedAnswer;
}

interface BenchmarkProject {
    name: string;
    root: string;
    cases: BenchmarkCase[];
}

interface ResolvedBenchmarkProject extends BenchmarkProject {
    projectRoot: string;
    projectRootExists: boolean;
}

interface BenchmarkFixture {
    name: string;
    workspaceRoot: string;
    projects: BenchmarkProject[];
}

interface SearchResultRecord {
    relativePath: string;
    score: number;
    content: string;
    startLine?: number;
    endLine?: number;
}

interface BenchmarkContext {
    semanticSearch(projectRoot: string, question: string, limit: number, threshold: number): Promise<SearchResultRecord[]>;
    getCollectionName(projectRoot: string): string;
    hasIndex(projectRoot: string): Promise<boolean>;
    indexCodebase(
        projectRoot: string,
        onProgress: (progress: { percentage: number; phase: string }) => void
    ): Promise<{ indexedFiles: number; totalChunks: number; status: string }>;
    clearIndex(projectRoot: string): Promise<void>;
}

interface CaseResult {
    runId: string;
    fixture: string;
    project: string;
    projectRoot: string;
    caseId: string;
    question: string;
    status: CaseStatus;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    suggestedScore: number;
    scoringReason: string;
    firstPrimaryRank: number | null;
    firstAcceptableRank: number | null;
    firstPrimarySymbolRank: number | null;
    firstAcceptableSymbolRank: number | null;
    symbolHitCount: number;
    needsManualReview: boolean;
    freshness: CaseFreshness;
    failureTaxonomy: FailureTaxonomy;
    failureDiagnostics: FailureDiagnostic[];
    failureReasons: FailureDiagnostic[];
    queryAnchors: string[];
    anchorCoverage: {
        extracted: string[];
        recalled: string[];
        missing: string[];
    };
    topResults: Array<{
        rank: number;
        path: string;
        score: number;
        lineRange: string;
        matched: "primary" | "acceptable" | "none";
        symbolHits: string[];
        hasSymbolHit: boolean;
        anchorHits: string[];
    }>;
    error?: string;
    scoreVersion?: string;
}

interface CaseFreshness {
    missingExpectedPaths: string[];
    staleResultPaths: string[];
}

interface ProjectFreshnessSummary {
    missingExpectedPathCases: number;
    missingExpectedPathCount: number;
    staleResultPathCases: number;
    staleResultPathCount: number;
    missingExpectedPaths: Array<{
        caseId: string;
        paths: string[];
    }>;
    staleResultPaths: Array<{
        caseId: string;
        paths: string[];
    }>;
}

type LegacyCaseResult = Omit<CaseResult, "freshness" | "failureTaxonomy" | "failureDiagnostics" | "failureReasons">
    & Partial<Pick<CaseResult, "freshness" | "failureTaxonomy" | "failureDiagnostics" | "failureReasons" | "queryAnchors" | "anchorCoverage">>;

interface CaseLookup {
    benchmarkCase: BenchmarkCase;
    projectRoot: string;
}

interface RunnerOptions {
    casesPath: string;
    outDir: string;
    workspaceRoot?: string;
    run: boolean;
    limit: number;
    threshold: number;
    projects: Set<string>;
    retryErrors: boolean;
    retryEmpty: boolean;
    rerunAll: boolean;
    keepIndex: boolean;
    rescoreExisting: boolean;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES_PATH = path.join(SCRIPT_DIR, "test-hce-cases.json");
const DEFAULT_OUT_DIR = path.join(SCRIPT_DIR, "results", "test-hce");
const BENCHMARK_EMBEDDING_RETRY_MAX_ELAPSED_MS = 180_000;
const SCORE_VERSION = "file-rank-v4";

function parseArgs(argv: string[]): RunnerOptions {
    const options: RunnerOptions = {
        casesPath: DEFAULT_CASES_PATH,
        outDir: DEFAULT_OUT_DIR,
        run: false,
        limit: 20,
        threshold: 0.3,
        projects: new Set(),
        retryErrors: false,
        retryEmpty: false,
        rerunAll: false,
        keepIndex: false,
        rescoreExisting: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];

        if (arg === "--run") {
            options.run = true;
        } else if (arg === "--plan") {
            options.run = false;
        } else if (arg === "--cases" && next) {
            options.casesPath = path.resolve(next);
            index += 1;
        } else if (arg === "--out-dir" && next) {
            options.outDir = path.resolve(next);
            index += 1;
        } else if (arg === "--workspace-root" && next) {
            options.workspaceRoot = path.resolve(next);
            index += 1;
        } else if (arg === "--project" && next) {
            options.projects.add(next);
            index += 1;
        } else if (arg === "--limit" && next) {
            options.limit = parsePositiveInteger(next, "--limit");
            index += 1;
        } else if (arg === "--threshold" && next) {
            options.threshold = parseFiniteNumber(next, "--threshold");
            index += 1;
        } else if (arg === "--retry-errors") {
            options.retryErrors = true;
        } else if (arg === "--retry-empty") {
            options.retryEmpty = true;
        } else if (arg === "--rerun-all") {
            options.rerunAll = true;
        } else if (arg === "--keep-index") {
            options.keepIndex = true;
        } else if (arg === "--rescore-existing") {
            options.rescoreExisting = true;
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        } else {
            throw new Error(`Unknown or incomplete argument: ${arg}`);
        }
    }

    return options;
}

function printHelp(): void {
    console.log(`Usage:
  pnpm --dir packages/mcp exec tsx ../../benchmark/run-test-hce-search-quality.ts --plan
  pnpm --dir packages/mcp exec tsx ../../benchmark/run-test-hce-search-quality.ts --run

Options:
  --cases <path>           Case fixture path. Default: benchmark/test-hce-cases.json
  --out-dir <path>         Output directory. Default: benchmark/results/test-hce
  --workspace-root <path>  Override fixture workspaceRoot.
  --project <name>         Run one project. Repeatable.
  --limit <n>              Search result limit. Default: 20
  --threshold <n>          Search threshold. Default: 0.3
  --retry-errors           Re-run cases that have previous error records.
  --retry-empty            Re-run cases whose latest record completed with an empty result.
  --rerun-all              Re-run all selected cases, appending fresh records.
  --keep-index             Keep each project index after its cases complete. Default clears completed project indexes.
  --rescore-existing       Re-score latest recorded results and rewrite report without rerunning benchmark.
  --plan                   Validate and print serial execution plan. Default.
  --run                    Execute serial benchmark with resume.
`);
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
    if (name === "--threshold" && (parsed < 0 || parsed > 1)) {
        throw new Error(`${name} must be between 0 and 1`);
    }
    return parsed;
}

function readFixture(casesPath: string): BenchmarkFixture {
    const parsed = JSON.parse(fs.readFileSync(casesPath, "utf8")) as BenchmarkFixture;
    if (!parsed.name || !parsed.workspaceRoot || !Array.isArray(parsed.projects)) {
        throw new Error(`Invalid benchmark fixture: ${casesPath}`);
    }
    return parsed;
}

function selectProjects(fixture: BenchmarkFixture, selectedProjects: Set<string>): BenchmarkProject[] {
    return fixture.projects.filter((project) =>
        selectedProjects.size === 0 || selectedProjects.has(project.name)
    );
}

function resolveWorkspaceRoot(fixture: BenchmarkFixture, options: RunnerOptions): string {
    return path.resolve(options.workspaceRoot ?? fixture.workspaceRoot);
}

function resolveProjectRoot(project: BenchmarkProject, fixture: BenchmarkFixture, workspaceRoot: string): string {
    if (!path.isAbsolute(project.root)) {
        return path.resolve(workspaceRoot, project.root);
    }

    const fixtureWorkspaceRoot = path.resolve(fixture.workspaceRoot);
    const absoluteProjectRoot = path.resolve(project.root);
    if (workspaceRoot !== fixtureWorkspaceRoot && isPathInside(absoluteProjectRoot, fixtureWorkspaceRoot)) {
        return path.resolve(workspaceRoot, path.relative(fixtureWorkspaceRoot, absoluteProjectRoot));
    }

    return absoluteProjectRoot;
}

function validateFixture(fixture: BenchmarkFixture, options: RunnerOptions): ResolvedBenchmarkProject[] {
    const workspaceRoot = resolveWorkspaceRoot(fixture, options);
    const selectedProjects = selectProjects(fixture, options.projects);

    if (selectedProjects.length === 0) {
        throw new Error("No projects selected.");
    }

    const seenCaseKeys = new Set<string>();
    const resolvedProjects: ResolvedBenchmarkProject[] = [];
    for (const project of selectedProjects) {
        const projectRoot = resolveProjectRoot(project, fixture, workspaceRoot);
        if (projectRoot === workspaceRoot) {
            throw new Error(`Project root must be a concrete project, not workspaceRoot: ${project.name} -> ${projectRoot}`);
        }
        if (!isPathInside(projectRoot, workspaceRoot)) {
            throw new Error(`Project root is outside workspaceRoot: ${project.name} -> ${projectRoot}`);
        }
        const projectRootExists = fs.existsSync(projectRoot) && fs.statSync(projectRoot).isDirectory();
        if (!Array.isArray(project.cases)) {
            throw new Error(`Project cases must be an array: ${project.name}`);
        }

        for (const benchmarkCase of project.cases) {
            if (!benchmarkCase.id || !benchmarkCase.question) {
                throw new Error(`Invalid case in ${project.name}: ${JSON.stringify(benchmarkCase)}`);
            }
            if (!Array.isArray(benchmarkCase.expected?.primaryPaths) || benchmarkCase.expected.primaryPaths.length === 0) {
                throw new Error(`Case ${project.name}/${benchmarkCase.id} must define at least one expected.primaryPaths entry`);
            }
            const caseKey = `${project.name}/${benchmarkCase.id}`;
            if (seenCaseKeys.has(caseKey)) {
                throw new Error(`Duplicate case id: ${caseKey}`);
            }
            seenCaseKeys.add(caseKey);
        }

        resolvedProjects.push({ ...project, projectRoot, projectRootExists });
    }

    return resolvedProjects;
}

function isPathInside(childPath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function readResultRecords(resultsPath: string): CaseResult[] {
    if (!fs.existsSync(resultsPath)) {
        return [];
    }

    const records: CaseResult[] = [];
    const lines = fs.readFileSync(resultsPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const [index, line] of lines.entries()) {
        try {
            records.push(JSON.parse(line) as CaseResult);
        } catch (error) {
            throw new Error(
                `Invalid JSONL record in ${resultsPath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
    return records;
}

function getLatestResults(resultsPath: string): Map<string, CaseResult> {
    const latest = new Map<string, CaseResult>();
    for (const result of readResultRecords(resultsPath)) {
        latest.set(resultKey(result.project, result.caseId), result);
    }
    return latest;
}

function readCompletedKeys(
    resultsPath: string,
    options: Pick<RunnerOptions, "retryErrors" | "retryEmpty" | "rerunAll">
): Set<string> {
    const completed = new Set<string>();
    if (options.rerunAll) {
        return completed;
    }

    for (const result of getLatestResults(resultsPath).values()) {
        const key = resultKey(result.project, result.caseId);
        if (result.status === "completed") {
            if (options.retryEmpty && result.scoringReason === "empty result") {
                continue;
            }
            completed.add(key);
        } else if (!options.retryErrors && result.status === "error") {
            completed.add(key);
        }
    }
    return completed;
}

function resultKey(projectName: string, caseId: string): string {
    return `${projectName}/${caseId}`;
}

function appendJsonl(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJsonl(filePath: string, values: unknown[]): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const content = values.map((value) => JSON.stringify(value)).join("\n");
    fs.writeFileSync(filePath, content ? `${content}\n` : "", "utf8");
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRelativePath(projectRoot: string, resultPath: string): string {
    const absolute = path.isAbsolute(resultPath) ? resultPath : path.join(projectRoot, resultPath);
    return path.relative(projectRoot, absolute).split(path.sep).join("/");
}

function normalizeExpectedPath(value: string): string {
    return value.replaceAll("\\", "/").replace(/^\.?\//, "");
}

function fileExistsInProject(projectRoot: string, relativePath: string): boolean {
    if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
        return false;
    }
    const normalized = normalizeExpectedPath(relativePath);
    const absolutePath = path.resolve(projectRoot, normalized);
    if (!isPathInside(absolutePath, projectRoot)) {
        return false;
    }

    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
}

function auditFreshness(
    projectRoot: string,
    benchmarkCase: BenchmarkCase,
    topResults: RecordedTopResult[]
): CaseFreshness {
    const expectedPaths = [
        ...benchmarkCase.expected.primaryPaths,
        ...(benchmarkCase.expected.acceptablePaths ?? []),
    ].map(normalizeExpectedPath);
    const uniqueExpectedPaths = [...new Set(expectedPaths)];
    const resultPaths = [...new Set(topResults.map((result) => normalizeExpectedPath(result.path)))];

    return {
        missingExpectedPaths: uniqueExpectedPaths.filter((expectedPath) => !fileExistsInProject(projectRoot, expectedPath)),
        staleResultPaths: resultPaths.filter((resultPath) => !fileExistsInProject(projectRoot, resultPath)),
    };
}

function countUniquePathsInTopResults(topResults: RecordedTopResult[], limit: number): number {
    return new Set(topResults.slice(0, limit).map((result) => result.path)).size;
}

function extractQueryAnchors(question: string): string[] {
    const anchors = new Set<string>();
    for (const rawTerm of question.split(/[^A-Za-z0-9_./:-]+/)) {
        const term = rawTerm.trim();
        if (term.length < 3 || term.length > 120 || !/^[A-Za-z0-9_./:-]+$/.test(term)) {
            continue;
        }
        if (isQueryAnchorStopword(term)) {
            continue;
        }

        const isHttpPath = /^\/[A-Za-z0-9_./:-]+$/.test(term) && term.includes("/");
        const isPathLike = /[./-]/.test(term);
        const isIdentifierLike = /[A-Z]/.test(term) && /[a-z]/.test(term);
        const isSnakeCase = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*$/.test(term) && term.length >= 6;
        const isEnvVar = /^[A-Z][A-Z0-9_]{2,}$/.test(term) && term.includes("_");
        const isDottedOrColonApi = /^[A-Za-z_][A-Za-z0-9_-]*(?:[.:][A-Za-z_][A-Za-z0-9_-]*)+$/.test(term);
        const isLongSpecificToken = term.length >= 12 && !/^[a-z]+$/.test(term);
        if (isHttpPath || isPathLike || isIdentifierLike || isSnakeCase || isEnvVar || isDottedOrColonApi || isLongSpecificToken) {
            anchors.add(term);
        }
    }

    return [...anchors].slice(0, 12);
}

function isQueryAnchorStopword(term: string): boolean {
    return /^(?:where|when|what|which|who|whom|whose|why|how|does|this|that|these|those|with|from|into|onto|between|including|implemented|handles?|uses?|reads?|writes?|shows?|find)$/i.test(term);
}

function computeAnchorCoverage(question: string, topResults: RecordedTopResult[]): CaseResult["anchorCoverage"] {
    const extracted = extractQueryAnchors(question);
    const recalled: string[] = [];
    const missing: string[] = [];
    for (const anchor of extracted) {
        const lowerAnchor = anchor.toLowerCase();
        const isRecalled = topResults.some((result) =>
            (result.anchorHits ?? []).some((hit) => hit.toLowerCase() === lowerAnchor) ||
            result.path.toLowerCase().includes(lowerAnchor) ||
            result.symbolHits.some((symbol) => symbol.toLowerCase() === lowerAnchor)
        );
        if (isRecalled) {
            recalled.push(anchor);
        } else {
            missing.push(anchor);
        }
    }

    return { extracted, recalled, missing };
}

function hasExpectedHit(scoring: Pick<CaseResult, "firstPrimaryRank" | "firstAcceptableRank">): boolean {
    return scoring.firstPrimaryRank !== null || scoring.firstAcceptableRank !== null;
}

function classifyFailure(
    scoring: Pick<CaseResult, "suggestedScore" | "firstPrimaryRank" | "firstAcceptableRank" | "firstPrimarySymbolRank" | "firstAcceptableSymbolRank" | "topResults">,
    freshness: CaseFreshness,
    benchmarkCase: BenchmarkCase
): Pick<CaseResult, "failureTaxonomy" | "failureDiagnostics" | "failureReasons"> {
    const diagnostics: FailureDiagnostic[] = [];
    if (freshness.missingExpectedPaths.length > 0) {
        diagnostics.push("missing_expected_path");
    }
    if (freshness.staleResultPaths.length > 0) {
        diagnostics.push("stale_result_path");
    }

    const top5UniquePathCount = countUniquePathsInTopResults(scoring.topResults, 5);
    const top10UniquePathCount = countUniquePathsInTopResults(scoring.topResults, 10);
    if (scoring.topResults.length >= 5 && (top5UniquePathCount <= 2 || top10UniquePathCount <= 3)) {
        diagnostics.push("same_file_saturation");
    }

    const expectsAnchor = (benchmarkCase.expected.primarySymbols?.length ?? 0) > 0;
    const hasSymbolHit = scoring.firstPrimarySymbolRank !== null || scoring.firstAcceptableSymbolRank !== null;
    if (expectsAnchor && !hasSymbolHit) {
        diagnostics.push("anchor_not_recalled");
    } else if (
        expectsAnchor &&
        hasSymbolHit &&
        scoring.suggestedScore <= 3 &&
        hasExpectedHit(scoring)
    ) {
        diagnostics.push("anchor_recalled_but_reranked");
    }

    let failureTaxonomy: FailureTaxonomy;
    if (scoring.topResults.length === 0) {
        failureTaxonomy = "empty_result";
    } else if (!hasExpectedHit(scoring)) {
        failureTaxonomy = "search_miss";
    } else {
        failureTaxonomy = "expected_hit";
    }

    const failureDiagnostics = [...new Set(diagnostics)];
    return {
        failureTaxonomy,
        failureDiagnostics,
        failureReasons: failureDiagnostics,
    };
}

function formatLineRange(result: SearchResultRecord): string {
    if (
        Number.isInteger(result.startLine) &&
        Number.isInteger(result.endLine) &&
        result.startLine > 0 &&
        result.endLine >= result.startLine
    ) {
        return `${result.startLine}-${result.endLine}`;
    }

    return "unknown";
}

function getSymbolAliases(symbol: string): string[] {
    const trimmed = symbol.trim();
    if (!trimmed) {
        return [];
    }

    const aliases = new Set<string>([trimmed]);
    const symbolParts = trimmed.split(/::|\./);
    const unqualified = symbolParts[symbolParts.length - 1];
    if (unqualified && unqualified.length >= 4) {
        aliases.add(unqualified);
    }

    return [...aliases];
}

function contentContainsSymbol(content: string, symbol: string): boolean {
    for (const alias of getSymbolAliases(symbol)) {
        if (alias.includes(".") || alias.includes(":")) {
            if (content.includes(alias)) {
                return true;
            }
            continue;
        }

        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${escaped}\\b`).test(content)) {
            return true;
        }
    }

    return false;
}

function getSymbolHits(result: SearchResultRecord, benchmarkCase: BenchmarkCase): string[] {
    const symbols = benchmarkCase.expected.primarySymbols ?? [];
    if (symbols.length === 0) {
        return [];
    }

    return symbols.filter((symbol) => contentContainsSymbol(result.content, symbol));
}

function hasRequiredSymbolHit(result: SearchResultRecord, benchmarkCase: BenchmarkCase): boolean {
    const symbols = benchmarkCase.expected.primarySymbols ?? [];
    return symbols.length > 0 && getSymbolHits(result, benchmarkCase).length > 0;
}

function getAnchorHits(result: SearchResultRecord, question: string): string[] {
    const anchors = extractQueryAnchors(question);
    if (anchors.length === 0) {
        return [];
    }

    const haystacks = [
        result.relativePath,
        result.content,
    ].map((value) => value.toLowerCase());

    return anchors.filter((anchor) => {
        const lowerAnchor = anchor.toLowerCase();
        return haystacks.some((haystack) => haystack.includes(lowerAnchor));
    });
}

type RecordedTopResult = CaseResult["topResults"][number];

function scoreTopResults(
    benchmarkCase: BenchmarkCase,
    rawTopResults: RecordedTopResult[]
): Pick<CaseResult, "suggestedScore" | "scoringReason" | "firstPrimaryRank" | "firstAcceptableRank" | "firstPrimarySymbolRank" | "firstAcceptableSymbolRank" | "symbolHitCount" | "needsManualReview" | "topResults"> {
    const requiresSymbolHit = (benchmarkCase.expected.primarySymbols?.length ?? 0) > 0;
    const dedupedResults: Array<{
        path: string;
        matched: "primary" | "acceptable" | "none";
        hasSymbolHit: boolean;
    }> = [];
    const seenByPath = new Map<string, number>();

    for (const result of rawTopResults) {
        const hasSymbolHit = requiresSymbolHit && result.symbolHits.length > 0;
        const existingIndex = seenByPath.get(result.path);
        if (existingIndex === undefined) {
            seenByPath.set(result.path, dedupedResults.length);
            dedupedResults.push({
                path: result.path,
                matched: result.matched,
                hasSymbolHit,
            });
            continue;
        }

        dedupedResults[existingIndex].hasSymbolHit ||= hasSymbolHit;
        if (dedupedResults[existingIndex].matched === "none" && result.matched !== "none") {
            dedupedResults[existingIndex].matched = result.matched;
        }
    }

    let firstPrimaryRank: number | null = null;
    let firstAcceptableRank: number | null = null;
    let firstPrimarySymbolRank: number | null = null;
    let firstAcceptableSymbolRank: number | null = null;
    let symbolHitCount = 0;

    dedupedResults.forEach((result, index) => {
        const rank = index + 1;
        if (result.hasSymbolHit) {
            symbolHitCount += 1;
        }
        if (result.matched === "primary") {
            firstPrimaryRank ??= rank;
            if (result.hasSymbolHit) {
                firstPrimarySymbolRank ??= rank;
            }
        } else if (result.matched === "acceptable") {
            firstAcceptableRank ??= rank;
            if (result.hasSymbolHit) {
                firstAcceptableSymbolRank ??= rank;
            }
        }
    });

    const reviewFields = {
        firstPrimaryRank,
        firstAcceptableRank,
        firstPrimarySymbolRank,
        firstAcceptableSymbolRank,
        symbolHitCount,
        needsManualReview: false,
        topResults: rawTopResults,
    };

    if (firstPrimarySymbolRank !== null && firstPrimarySymbolRank <= 5) {
        return {
            suggestedScore: 5,
            scoringReason: "primary file ranked in top 5 with expected symbol evidence",
            ...reviewFields,
        };
    }
    if (
        (firstPrimarySymbolRank !== null && firstPrimarySymbolRank <= 8) ||
        (firstPrimaryRank !== null && firstPrimaryRank <= 5) ||
        (firstAcceptableSymbolRank !== null && firstAcceptableSymbolRank <= 5)
    ) {
        return {
            suggestedScore: 4,
            scoringReason: "strong expected hit: primary file top 8 with symbol, primary file top 5 without symbol, or acceptable file top 5 with symbol",
            ...reviewFields,
            needsManualReview: firstPrimarySymbolRank === null,
        };
    }
    if (
        (firstPrimarySymbolRank !== null && firstPrimarySymbolRank <= 10) ||
        (firstAcceptableSymbolRank !== null && firstAcceptableSymbolRank <= 8) ||
        (firstPrimaryRank !== null && firstPrimaryRank <= 8) ||
        (firstAcceptableRank !== null && firstAcceptableRank <= 5)
    ) {
        return {
            suggestedScore: 3,
            scoringReason: "partial expected hit: primary symbol top 10, acceptable symbol top 8, primary file top 8 without symbol, or acceptable file top 5",
            ...reviewFields,
            needsManualReview: firstPrimarySymbolRank === null,
        };
    }
    if (
        (firstAcceptableSymbolRank !== null && firstAcceptableSymbolRank <= 10) ||
        (firstAcceptableRank !== null && firstAcceptableRank <= 10) ||
        (firstPrimaryRank !== null && firstPrimaryRank <= 20)
    ) {
        return {
            suggestedScore: 2,
            scoringReason: "weak expected hit: acceptable symbol top 10, acceptable file top 10, or primary file top 20 without symbol",
            ...reviewFields,
            needsManualReview: true,
        };
    }
    if (rawTopResults.length > 0) {
        return {
            suggestedScore: 1,
            scoringReason: "non-empty result without expected file hit",
            ...reviewFields,
            needsManualReview: true,
        };
    }

    return {
        suggestedScore: 0,
        scoringReason: "empty result",
        ...reviewFields,
    };
}

function scoreResult(
    projectRoot: string,
    benchmarkCase: BenchmarkCase,
    results: SearchResultRecord[]
): Pick<CaseResult, "suggestedScore" | "scoringReason" | "firstPrimaryRank" | "firstAcceptableRank" | "firstPrimarySymbolRank" | "firstAcceptableSymbolRank" | "symbolHitCount" | "needsManualReview" | "topResults"> {
    const primaryPaths = new Set(benchmarkCase.expected.primaryPaths.map(normalizeExpectedPath));
    const acceptablePaths = new Set((benchmarkCase.expected.acceptablePaths ?? []).map(normalizeExpectedPath));

    const topResults = results.map((result, index) => {
        const relativePath = normalizeRelativePath(projectRoot, result.relativePath);
        const rank = index + 1;
        const symbolHits = getSymbolHits(result, benchmarkCase);
        const anchorHits = getAnchorHits(result, benchmarkCase.question);
        const hasSymbolHit = hasRequiredSymbolHit(result, benchmarkCase);
        let matched: "primary" | "acceptable" | "none" = "none";
        if (primaryPaths.has(relativePath)) {
            matched = "primary";
        } else if (acceptablePaths.has(relativePath)) {
            matched = "acceptable";
        }

        return {
            rank,
            path: relativePath,
            score: result.score,
            lineRange: formatLineRange(result),
            matched,
            symbolHits,
            hasSymbolHit,
            anchorHits,
        };
    });

    return scoreTopResults(benchmarkCase, topResults);
}

async function runCase(
    context: BenchmarkContext,
    fixture: BenchmarkFixture,
    runId: string,
    project: ResolvedBenchmarkProject,
    benchmarkCase: BenchmarkCase,
    options: RunnerOptions
): Promise<CaseResult> {
    const projectRoot = project.projectRoot;
    const startedAtDate = new Date();
    const startedAt = startedAtDate.toISOString();

    try {
        const results = await context.semanticSearch(
            projectRoot,
            benchmarkCase.question,
            options.limit,
            options.threshold
        );
        const finishedAtDate = new Date();
        const scoring = scoreResult(projectRoot, benchmarkCase, results);
        const freshness = auditFreshness(projectRoot, benchmarkCase, scoring.topResults);
        const classification = classifyFailure(scoring, freshness, benchmarkCase);
        const anchorCoverage = computeAnchorCoverage(benchmarkCase.question, scoring.topResults);

        return {
            runId,
            fixture: fixture.name,
            project: project.name,
            projectRoot,
            caseId: benchmarkCase.id,
            question: benchmarkCase.question,
            status: "completed",
            startedAt,
            finishedAt: finishedAtDate.toISOString(),
            durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
            ...scoring,
            freshness,
            ...classification,
            queryAnchors: anchorCoverage.extracted,
            anchorCoverage,
            scoreVersion: SCORE_VERSION,
        };
    } catch (error) {
        const finishedAtDate = new Date();
        const freshness = auditFreshness(projectRoot, benchmarkCase, []);
        const failureDiagnostics: FailureDiagnostic[] = [
            ...(freshness.missingExpectedPaths.length > 0 ? ["missing_expected_path" as const] : []),
        ];
        return {
            runId,
            fixture: fixture.name,
            project: project.name,
            projectRoot,
            caseId: benchmarkCase.id,
            question: benchmarkCase.question,
            status: "error",
            startedAt,
            finishedAt: finishedAtDate.toISOString(),
            durationMs: finishedAtDate.getTime() - startedAtDate.getTime(),
            suggestedScore: 0,
            scoringReason: "search failed",
            firstPrimaryRank: null,
            firstAcceptableRank: null,
            firstPrimarySymbolRank: null,
            firstAcceptableSymbolRank: null,
            symbolHitCount: 0,
            needsManualReview: true,
            freshness,
            failureTaxonomy: "search_error",
            failureDiagnostics,
            failureReasons: failureDiagnostics,
            queryAnchors: extractQueryAnchors(benchmarkCase.question),
            anchorCoverage: computeAnchorCoverage(benchmarkCase.question, []),
            topResults: [],
            error: error instanceof Error ? error.stack || error.message : String(error),
            scoreVersion: SCORE_VERSION,
        };
    }
}

async function ensureProjectIndex(context: BenchmarkContext, project: ResolvedBenchmarkProject): Promise<void> {
    const collectionName = context.getCollectionName(project.projectRoot);
    const hasIndex = await context.hasIndex(project.projectRoot);
    if (hasIndex) {
        console.log(`Index ready for ${project.name}: ${collectionName}`);
        return;
    }

    console.log(`Index missing for ${project.name}: ${collectionName}`);
    console.log(`Indexing ${project.name}: ${project.projectRoot}`);

    let lastReportedPercentage = -1;
    const result = await context.indexCodebase(
        project.projectRoot,
        (progress) => {
            const percentage = Math.floor(progress.percentage);
            if (percentage === 100 || percentage >= lastReportedPercentage + 10) {
                lastReportedPercentage = percentage;
                console.log(`Indexing ${project.name}: ${percentage}% - ${progress.phase}`);
            }
        }
    );

    console.log(
        `Indexed ${project.name}: ${result.indexedFiles} files, ${result.totalChunks} chunks, status=${result.status}`
    );
}

function projectCompletedSuccessfully(resultsPath: string, project: ResolvedBenchmarkProject): boolean {
    const latest = getLatestResults(resultsPath);
    return project.cases.every((benchmarkCase) => {
        const result = latest.get(resultKey(project.name, benchmarkCase.id));
        return result?.status === "completed";
    });
}

async function clearCompletedProjectIndex(
    context: BenchmarkContext,
    resultsPath: string,
    statePath: string,
    runId: string,
    project: ResolvedBenchmarkProject,
    options: RunnerOptions
): Promise<void> {
    if (options.keepIndex) {
        return;
    }
    if (!projectCompletedSuccessfully(resultsPath, project)) {
        console.log(`Keeping index for ${project.name}: project has missing or non-completed case records.`);
        return;
    }

    const collectionName = context.getCollectionName(project.projectRoot);
    writeJson(statePath, {
        runId,
        status: "clearing-index",
        project: project.name,
        collectionName,
        updatedAt: new Date().toISOString(),
    });
    console.log(`Clearing completed project index for ${project.name}: ${collectionName}`);
    await context.clearIndex(project.projectRoot);
    console.log(`Cleared completed project index for ${project.name}: ${collectionName}`);
}

function createEmptyTaxonomyCounts(): Record<FailureTaxonomy, number> {
    return {
        expected_hit: 0,
        search_miss: 0,
        empty_result: 0,
        search_error: 0,
    };
}

function createEmptyDiagnosticCounts(): Record<FailureDiagnostic, number> {
    return {
        missing_expected_path: 0,
        stale_result_path: 0,
        same_file_saturation: 0,
        anchor_not_recalled: 0,
        anchor_recalled_but_reranked: 0,
    };
}

function createEmptyFreshnessSummary(): ProjectFreshnessSummary {
    return {
        missingExpectedPathCases: 0,
        missingExpectedPathCount: 0,
        staleResultPathCases: 0,
        staleResultPathCount: 0,
        missingExpectedPaths: [],
        staleResultPaths: [],
    };
}

function ensureResultTaxonomy(result: LegacyCaseResult): Pick<CaseResult, "freshness" | "failureTaxonomy" | "failureDiagnostics" | "failureReasons"> {
    const freshness = result.freshness ?? {
        missingExpectedPaths: [],
        staleResultPaths: [],
    };
    const fallbackTaxonomy: FailureTaxonomy =
        result.status === "error"
            ? "search_error"
            : result.topResults.length === 0
                ? "empty_result"
                : hasExpectedHit(result)
                    ? "expected_hit"
                    : "search_miss";

    const legacyReasons = (result.failureReasons ?? []).filter((reason): reason is FailureDiagnostic =>
        reason === "missing_expected_path" ||
        reason === "stale_result_path" ||
        reason === "same_file_saturation" ||
        reason === "anchor_not_recalled" ||
        reason === "anchor_recalled_but_reranked"
    );
    const failureDiagnostics = result.failureDiagnostics ?? legacyReasons;

    return {
        freshness,
        failureTaxonomy: result.failureTaxonomy ?? fallbackTaxonomy,
        failureDiagnostics,
        failureReasons: failureDiagnostics,
    };
}

function getResultTopResults(result: LegacyCaseResult): RecordedTopResult[] {
    return result.topResults ?? [];
}

function rematchTopResults(benchmarkCase: BenchmarkCase, topResults: RecordedTopResult[]): RecordedTopResult[] {
    const primaryPaths = new Set(benchmarkCase.expected.primaryPaths.map(normalizeExpectedPath));
    const acceptablePaths = new Set((benchmarkCase.expected.acceptablePaths ?? []).map(normalizeExpectedPath));

    return topResults.map((result) => {
        const relativePath = normalizeExpectedPath(result.path);
        let matched: RecordedTopResult["matched"] = "none";
        if (primaryPaths.has(relativePath)) {
            matched = "primary";
        } else if (acceptablePaths.has(relativePath)) {
            matched = "acceptable";
        }
        return {
            ...result,
            path: relativePath,
            matched,
        };
    });
}

function rewriteResultWithAudit(result: LegacyCaseResult, lookup: CaseLookup | undefined): CaseResult {
    if (!lookup) {
        const taxonomy = ensureResultTaxonomy(result);
        const anchorCoverage = result.anchorCoverage ?? computeAnchorCoverage(result.question, getResultTopResults(result));
        return {
            ...result,
            ...taxonomy,
            queryAnchors: result.queryAnchors ?? anchorCoverage.extracted,
            anchorCoverage,
            scoreVersion: result.scoreVersion ?? SCORE_VERSION,
        };
    }

    const projectRoot = result.projectRoot || lookup.projectRoot;
    const topResults = rematchTopResults(lookup.benchmarkCase, getResultTopResults(result));
    if (result.status !== "completed") {
        const freshness = auditFreshness(projectRoot, lookup.benchmarkCase, topResults);
        const failureDiagnostics: FailureDiagnostic[] = [
            ...(freshness.missingExpectedPaths.length > 0 ? ["missing_expected_path" as const] : []),
            ...(freshness.staleResultPaths.length > 0 ? ["stale_result_path" as const] : []),
        ];
        const anchorCoverage = computeAnchorCoverage(lookup.benchmarkCase.question, topResults);
        return {
            ...result,
            topResults,
            freshness,
            failureTaxonomy: result.status === "error" ? "search_error" : "empty_result",
            failureDiagnostics: [...new Set(failureDiagnostics)],
            failureReasons: [...new Set(failureDiagnostics)],
            queryAnchors: anchorCoverage.extracted,
            anchorCoverage,
            scoreVersion: result.scoreVersion ?? SCORE_VERSION,
        };
    }

    const scoring = scoreTopResults(lookup.benchmarkCase, topResults);
    const freshness = auditFreshness(projectRoot, lookup.benchmarkCase, scoring.topResults);
    const classification = classifyFailure(scoring, freshness, lookup.benchmarkCase);
    const anchorCoverage = computeAnchorCoverage(lookup.benchmarkCase.question, scoring.topResults);

    return {
        ...result,
        ...scoring,
        freshness,
        ...classification,
        queryAnchors: anchorCoverage.extracted,
        anchorCoverage,
        scoreVersion: SCORE_VERSION,
    };
}

function writeReport(resultsPath: string, reportPath: string): void {
    const results = Array.from(getLatestResults(resultsPath).values());
    const byProject = new Map<string, {
        total: number;
        completed: number;
        errors: number;
        suggestedScore: number;
        primaryTop5: number;
        primaryTop8: number;
        primarySymbolTop5: number;
        primarySymbolTop8: number;
        expectedTop10: number;
        expectedTop20: number;
        manualReview: number;
        failureTaxonomy: Record<FailureTaxonomy, number>;
        failureDiagnostics: Record<FailureDiagnostic, number>;
        freshness: ProjectFreshnessSummary;
    }>();

    for (const result of results) {
        const summary = byProject.get(result.project) ?? {
            total: 0,
            completed: 0,
            errors: 0,
            suggestedScore: 0,
            primaryTop5: 0,
            primaryTop8: 0,
            primarySymbolTop5: 0,
            primarySymbolTop8: 0,
            expectedTop10: 0,
            expectedTop20: 0,
            manualReview: 0,
            failureTaxonomy: createEmptyTaxonomyCounts(),
            failureDiagnostics: createEmptyDiagnosticCounts(),
            freshness: createEmptyFreshnessSummary(),
        };
        const taxonomy = ensureResultTaxonomy(result);
        summary.total += 1;
        summary.failureTaxonomy[taxonomy.failureTaxonomy] += 1;
        for (const diagnostic of taxonomy.failureDiagnostics) {
            summary.failureDiagnostics[diagnostic] += 1;
        }
        if (taxonomy.freshness.missingExpectedPaths.length > 0) {
            summary.freshness.missingExpectedPathCases += 1;
            summary.freshness.missingExpectedPathCount += taxonomy.freshness.missingExpectedPaths.length;
            summary.freshness.missingExpectedPaths.push({
                caseId: result.caseId,
                paths: taxonomy.freshness.missingExpectedPaths,
            });
        }
        if (taxonomy.freshness.staleResultPaths.length > 0) {
            summary.freshness.staleResultPathCases += 1;
            summary.freshness.staleResultPathCount += taxonomy.freshness.staleResultPaths.length;
            summary.freshness.staleResultPaths.push({
                caseId: result.caseId,
                paths: taxonomy.freshness.staleResultPaths,
            });
        }
        if (result.status === "completed") {
            summary.completed += 1;
            summary.suggestedScore += result.suggestedScore;
            if (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 5) {
                summary.primaryTop5 += 1;
            }
            if (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 8) {
                summary.primaryTop8 += 1;
            }
            if (result.firstPrimarySymbolRank !== null && result.firstPrimarySymbolRank <= 5) {
                summary.primarySymbolTop5 += 1;
            }
            if (result.firstPrimarySymbolRank !== null && result.firstPrimarySymbolRank <= 8) {
                summary.primarySymbolTop8 += 1;
            }
            if (
                (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 10) ||
                (result.firstAcceptableRank !== null && result.firstAcceptableRank <= 10)
            ) {
                summary.expectedTop10 += 1;
            }
            if (
                (result.firstPrimaryRank !== null && result.firstPrimaryRank <= 20) ||
                (result.firstAcceptableRank !== null && result.firstAcceptableRank <= 20)
            ) {
                summary.expectedTop20 += 1;
            }
            if (result.needsManualReview) {
                summary.manualReview += 1;
            }
        } else if (result.status === "error") {
            summary.errors += 1;
        }
        byProject.set(result.project, summary);
    }

    writeJson(reportPath, {
        generatedAt: new Date().toISOString(),
        resultsPath,
        scoreVersion: SCORE_VERSION,
        projects: Array.from(byProject.entries()).map(([project, summary]) => ({
            project,
            ...summary,
            maxScore: summary.total * 5,
        })),
    });
}

function buildCaseLookup(projects: ResolvedBenchmarkProject[]): Map<string, CaseLookup> {
    const map = new Map<string, CaseLookup>();
    for (const project of projects) {
        for (const benchmarkCase of project.cases) {
            map.set(resultKey(project.name, benchmarkCase.id), {
                benchmarkCase,
                projectRoot: project.projectRoot,
            });
        }
    }
    return map;
}

function resolveAllProjects(fixture: BenchmarkFixture, options: RunnerOptions): ResolvedBenchmarkProject[] {
    const workspaceRoot = resolveWorkspaceRoot(fixture, options);
    return fixture.projects.map((project) => {
        const projectRoot = resolveProjectRoot(project, fixture, workspaceRoot);
        return {
            ...project,
            projectRoot,
            projectRootExists: fs.existsSync(projectRoot) && fs.statSync(projectRoot).isDirectory(),
        };
    });
}

function auditProjectsForPlan(
    projects: ResolvedBenchmarkProject[],
    latest: Map<string, CaseResult>
): Map<string, ProjectFreshnessSummary> {
    const summaryByProject = new Map<string, ProjectFreshnessSummary>();
    for (const project of projects) {
        const summary = createEmptyFreshnessSummary();
        for (const benchmarkCase of project.cases) {
            const existingResult = latest.get(resultKey(project.name, benchmarkCase.id));
            const topResults = existingResult?.topResults ?? [];
            const freshness = auditFreshness(project.projectRoot, benchmarkCase, topResults);
            if (freshness.missingExpectedPaths.length > 0) {
                summary.missingExpectedPathCases += 1;
                summary.missingExpectedPathCount += freshness.missingExpectedPaths.length;
                summary.missingExpectedPaths.push({
                    caseId: benchmarkCase.id,
                    paths: freshness.missingExpectedPaths,
                });
            }
            if (freshness.staleResultPaths.length > 0) {
                summary.staleResultPathCases += 1;
                summary.staleResultPathCount += freshness.staleResultPaths.length;
                summary.staleResultPaths.push({
                    caseId: benchmarkCase.id,
                    paths: freshness.staleResultPaths,
                });
            }
        }
        summaryByProject.set(project.name, summary);
    }

    return summaryByProject;
}

function printFreshnessPlanSummary(summaryByProject: Map<string, ProjectFreshnessSummary>): void {
    let missingExpectedPathCount = 0;
    let staleResultPathCount = 0;
    for (const summary of summaryByProject.values()) {
        missingExpectedPathCount += summary.missingExpectedPathCount;
        staleResultPathCount += summary.staleResultPathCount;
    }

    console.log(`Freshness missing expected paths: ${missingExpectedPathCount}`);
    console.log(`Freshness stale result paths: ${staleResultPathCount}`);
    for (const [project, summary] of summaryByProject.entries()) {
        if (summary.missingExpectedPathCount === 0 && summary.staleResultPathCount === 0) {
            continue;
        }
        console.log(
            `- ${project} freshness: ${summary.missingExpectedPathCount} missing expected, ${summary.staleResultPathCount} stale result paths`
        );
    }
}

function resultNeedsAuditRefresh(result: CaseResult): boolean {
    return result.scoreVersion !== SCORE_VERSION ||
        result.freshness === undefined ||
        result.failureTaxonomy === undefined ||
        result.failureDiagnostics === undefined ||
        result.queryAnchors === undefined ||
        result.anchorCoverage === undefined ||
        result.topResults.some((topResult) => topResult.anchorHits === undefined);
}

function backupFilePath(filePath: string): string {
    return `${filePath}.backup-${new Date().toISOString().replaceAll(":", "-")}`;
}

function rescoreExistingResults(
    fixture: BenchmarkFixture,
    options: RunnerOptions,
    projects: ResolvedBenchmarkProject[],
    resultsPath: string,
    reportPath: string,
    statePath: string
): void {
    if (!fs.existsSync(resultsPath)) {
        throw new Error(`Results file does not exist: ${resultsPath}`);
    }
    if (!options.run) {
        throw new Error("--rescore-existing requires --run");
    }

    const selectedProjects = selectProjects(fixture, options.projects);
    if (selectedProjects.length === 0) {
        throw new Error("No projects selected.");
    }

    const selectedProjectNames = new Set(selectedProjects.map((project) => project.name));
    const caseLookup = buildCaseLookup(resolveAllProjects(fixture, options));
    const latest = Array.from(getLatestResults(resultsPath).values());
    const rescored = latest.map((result) => {
        if (!selectedProjectNames.has(result.project)) {
            return result;
        }
        return rewriteResultWithAudit(result, caseLookup.get(resultKey(result.project, result.caseId)));
    });

    const backupPath = backupFilePath(resultsPath);
    fs.copyFileSync(resultsPath, backupPath);
    writeJsonl(resultsPath, rescored);
    writeJson(statePath, {
        runId: `rescore-${new Date().toISOString().replaceAll(":", "-")}`,
        status: "rescored",
        updatedAt: new Date().toISOString(),
        scoreVersion: SCORE_VERSION,
        backupPath,
        note: "Rescored latest benchmark records without rerunning search.",
    });
    writeReport(resultsPath, reportPath);
    console.log(`Backed up previous results to ${backupPath}`);
    console.log(`Rewrote rescored results to ${resultsPath}`);
    console.log(`Wrote report to ${reportPath}`);
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    const fixture = readFixture(options.casesPath);
    const resultsPath = path.join(options.outDir, "results.jsonl");
    const statePath = path.join(options.outDir, "state.json");
    const reportPath = path.join(options.outDir, "report.json");
    const projects = validateFixture(fixture, options);
    const latest = getLatestResults(resultsPath);
    printFreshnessPlanSummary(auditProjectsForPlan(projects, latest));
    if (options.rescoreExisting) {
        rescoreExistingResults(fixture, options, projects, resultsPath, reportPath, statePath);
        return;
    }

    const totalCases = projects.reduce((total, project) => total + project.cases.length, 0);
    const completedKeys = readCompletedKeys(resultsPath, options);
    const selectedCaseKeys = new Set(
        projects.flatMap((project) => project.cases.map((benchmarkCase) => resultKey(project.name, benchmarkCase.id)))
    );
    const recordedSelectedCases = [...completedKeys].filter((key) => selectedCaseKeys.has(key)).length;
    const pendingCases = projects.reduce(
        (total, project) => total + project.cases.filter((benchmarkCase) => !completedKeys.has(resultKey(project.name, benchmarkCase.id))).length,
        0
    );

    console.log(`Fixture: ${fixture.name}`);
    console.log(`Projects: ${projects.length}`);
    console.log(`Cases: ${totalCases}`);
    console.log(`Already recorded: ${recordedSelectedCases}`);
    console.log(`Pending: ${pendingCases}`);
    console.log(`Mode: ${options.run ? "run" : "plan"}`);

    for (const project of projects) {
        const pendingInProject = project.cases.filter((benchmarkCase) => !completedKeys.has(resultKey(project.name, benchmarkCase.id))).length;
        const rootStatus = project.projectRootExists ? "root ok" : "root missing";
        console.log(`- ${project.name}: ${project.projectRoot} (${project.cases.length} cases, ${pendingInProject} pending, ${rootStatus})`);
    }

    if (!options.run) {
        return;
    }
    const missingProjectRoots = projects.filter((project) => !project.projectRootExists);
    if (missingProjectRoots.length > 0) {
        throw new Error(
            `Cannot run benchmark with missing project roots: ${missingProjectRoots.map((project) => `${project.name} -> ${project.projectRoot}`).join(", ")}`
        );
    }
    if (totalCases === 0) {
        throw new Error("No benchmark cases defined. Refusing to run an empty benchmark.");
    }
    const runId = new Date().toISOString().replaceAll(":", "-");
    if (pendingCases === 0) {
        const staleAuditRecords = Array.from(latest.values()).filter(resultNeedsAuditRefresh).length;
        if (staleAuditRecords > 0) {
            throw new Error(
                `No pending cases, but ${staleAuditRecords} existing records need refreshed scoring/audit fields. Run with --rescore-existing --run.`
            );
        }
        writeJson(statePath, {
            runId,
            status: "completed",
            updatedAt: new Date().toISOString(),
            note: "No pending cases.",
        });
        writeReport(resultsPath, reportPath);
        console.log("No pending cases.");
        console.log(`Wrote report to ${reportPath}`);
        return;
    }

    const [{ Context, MilvusVectorDatabase }, { createMcpConfig }, { createEmbeddingInstance }] = await Promise.all([
        import("@hitmux/hitmux-context-engine-core"),
        import("../packages/mcp/src/config.js"),
        import("../packages/mcp/src/embedding.js"),
    ]);
    const config = createMcpConfig();
    const embedding = createEmbeddingInstance(config, {
        openAiRetryMaxElapsedMs: BENCHMARK_EMBEDDING_RETRY_MAX_ELAPSED_MS,
    });
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

    for (const project of projects) {
        const pendingInProject = project.cases.some((benchmarkCase) => !completedKeys.has(resultKey(project.name, benchmarkCase.id)));
        if (!pendingInProject) {
            continue;
        }

        await ensureProjectIndex(context, project);

        for (const benchmarkCase of project.cases) {
            const key = resultKey(project.name, benchmarkCase.id);
            if (completedKeys.has(key)) {
                continue;
            }

            writeJson(statePath, {
                runId,
                status: "running",
                project: project.name,
                caseId: benchmarkCase.id,
                updatedAt: new Date().toISOString(),
            });
            console.log(`Running ${key}`);
            const result = await runCase(context, fixture, runId, project, benchmarkCase, options);
            appendJsonl(resultsPath, result);
            completedKeys.add(key);
        }

        writeReport(resultsPath, reportPath);
        await clearCompletedProjectIndex(context, resultsPath, statePath, runId, project, options);
    }

    writeJson(statePath, {
        runId,
        status: "completed",
        updatedAt: new Date().toISOString(),
    });
    writeReport(resultsPath, reportPath);
    console.log(`Wrote results to ${resultsPath}`);
    console.log(`Wrote report to ${reportPath}`);
}

const isMainModule = process.argv[1] !== undefined
    && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.stack || error.message : String(error));
        process.exitCode = 1;
    });
}

export {
    SCORE_VERSION,
    auditFreshness,
    classifyFailure,
    type RecordedTopResult,
    resultNeedsAuditRefresh,
    rewriteResultWithAudit,
    scoreTopResults,
};
