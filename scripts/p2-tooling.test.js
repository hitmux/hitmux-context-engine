const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");

function readText(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function readJson(relativePath) {
    return JSON.parse(readText(relativePath));
}

test("mcp status smoke default command matches local install wrapper", () => {
    const smoke = readText("scripts/mcp-status-smoke.mjs");
    const installer = readText("scripts/install-local-global.sh");

    assert.match(smoke, /process\.env\.HCE_MCP_COMMAND \|\| "hitmux-context-engine-mcp"/);
    assert.match(installer, /COMMAND_NAME="\$\{COMMAND_NAME:-hitmux-context-engine-mcp\}"/);
});

test("build:examples builds core before examples", () => {
    const rootPackage = readJson("package.json");

    assert.equal(
        rootPackage.scripts["build:examples"],
        "pnpm build:core && pnpm -r --parallel --filter='./examples/*' build",
    );
});

test("published core and mcp packages include src for sourcemaps", () => {
    for (const packagePath of ["packages/core/package.json", "packages/mcp/package.json"]) {
        const packageJson = readJson(packagePath);

        assert.ok(packageJson.files.includes("dist"));
        assert.ok(packageJson.files.includes("src"));
        assert.ok(packageJson.files.includes("!src/**/*.test.ts"));
    }
});

test("python legacy e2e uses stable paths and failure exit code", () => {
    const script = readText("python/test_endtoend.py");
    const context = readText("python/test_context.ts");

    assert.match(script, /SCRIPT_DIR = Path\(__file__\)\.resolve\(\)\.parent/);
    assert.match(script, /TypeScriptExecutor\(working_dir=str\(REPO_ROOT\)\)/);
    assert.match(script, /sys\.exit\(main\(\)\)/);
    assert.match(script, /return 0 if success else 1/);
    assert.match(context, /core-only Context smoke/);
});

test("CannonWar search-quality runner mirrors MCP database proxy setting", () => {
    const runner = readText("evaluation/search-quality/run-cannonwar-search-quality.ts");

    assert.match(runner, /useSystemProxy: config\.databaseUseSystemProxy/);
});
