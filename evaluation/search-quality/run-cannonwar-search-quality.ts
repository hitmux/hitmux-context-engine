import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Context, MilvusVectorDatabase } from "@hitmux/hitmux-context-engine-core";
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
    firstResultRole: ExpectedRole;
    testFirst: boolean;
    barrelFirst: boolean;
    relatedTestsPresent: boolean;
    topResults: Array<{
        rank: number;
        path: string;
        role: ExpectedRole;
        score: number;
        lineRange: string;
    }>;
}

interface BenchmarkReport {
    fixture: string;
    codebasePath: string;
    generatedAt: string;
    limit: number;
    threshold: number;
    summary: {
        totalCases: number;
        expectedImplementationTop3: number;
        expectedImplementationTop5: number;
        missingExpected: number;
        testFirstRate: number;
        barrelFirstRate: number;
        relatedTestsPresent: number;
    };
    cases: CaseReport[];
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CASES_PATH = path.join(SCRIPT_DIR, "cannonwar-cases.json");

function parseArgs(argv: string[]) {
    const options: {
        casesPath: string;
        codebasePath?: string;
        outPath?: string;
        limit: number;
        threshold: number;
    } = {
        casesPath: DEFAULT_CASES_PATH,
        limit: 20,
        threshold: 0.3,
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

function summarizeCase(benchmarkCase: BenchmarkCase, results: SearchResult[]): CaseReport {
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

    return {
        id: benchmarkCase.id,
        query: benchmarkCase.query,
        manualLabel: benchmarkCase.manualLabel,
        expected: benchmarkCase.expected,
        firstExpectedRank: firstExpectedIndex >= 0 ? firstExpectedIndex + 1 : null,
        expectedImplementationTop3: firstImplementationIndex >= 0 && firstImplementationIndex < 3,
        expectedImplementationTop5: firstImplementationIndex >= 0 && firstImplementationIndex < 5,
        firstResultRole,
        testFirst: firstResultRole === "test",
        barrelFirst: firstResultRole === "barrel",
        relatedTestsPresent: resultRoles.includes("test"),
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

function buildSummary(cases: CaseReport[]): BenchmarkReport["summary"] {
    const totalCases = cases.length;
    const expectedImplementationTop3 = cases.filter((item) => item.expectedImplementationTop3).length;
    const expectedImplementationTop5 = cases.filter((item) => item.expectedImplementationTop5).length;
    const missingExpected = cases.filter((item) => item.firstExpectedRank === null).length;
    const testFirstCount = cases.filter((item) => item.testFirst).length;
    const barrelFirstCount = cases.filter((item) => item.barrelFirst).length;
    const relatedTestsPresent = cases.filter((item) => item.relatedTestsPresent).length;

    return {
        totalCases,
        expectedImplementationTop3,
        expectedImplementationTop5,
        missingExpected,
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
        caseReports.push(summarizeCase(benchmarkCase, results));
    }

    const report: BenchmarkReport = {
        fixture: fixture.name,
        codebasePath,
        generatedAt: new Date().toISOString(),
        limit: options.limit,
        threshold: options.threshold,
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
