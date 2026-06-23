export type FileRole = 'implementation' | 'test' | 'docs' | 'style' | 'config' | 'generated' | 'barrel' | 'entrypoint';

export interface FileRoleIntent {
    preferredRoles: ReadonlySet<FileRole>;
    explicitExtensions: ReadonlySet<string>;
    disableRoleScoring?: boolean;
}

const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.stylus', '.pcss']);
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.rst', '.adoc', '.txt']);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env', '.cmake']);

const CONFIG_FILENAMES = new Set([
    'cmakelists.txt',
    'makefile',
    'gnumakefile',
    'package.json',
    'pyproject.toml',
    'cargo.toml',
    'go.mod',
    'go.sum',
    'tsconfig.json',
    'jsconfig.json',
    'pnpm-workspace.yaml',
    'vite.config.ts',
    'vite.config.js',
    'vitest.config.ts',
    'vitest.config.js',
    'eslint.config.js',
    'eslint.config.mjs',
    'prettier.config.js',
    'jest.config.js',
    'jest.config.cjs',
    'webpack.config.js',
    'rollup.config.js',
    'tailwind.config.js',
]);

const ENTRYPOINT_BASENAMES = new Set(['main', 'app', 'server', 'client', 'bootstrap', 'startup']);
const MODULE_INDEX_BASENAMES = new Set(['index', '__init__', 'mod']);

export function classifyFileRole(relativePath: string, fileExtension?: string, content?: string): FileRole {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();
    const fileName = lowerPath.split('/').pop() || '';
    const basename = getBasename(fileName);
    const extension = normalizeExtension(fileExtension || getExtension(fileName));

    if (isGeneratedPath(lowerPath, fileName)) {
        return 'generated';
    }

    if (isTestPath(lowerPath, fileName)) {
        return 'test';
    }

    if (isConfigPath(lowerPath, fileName, extension)) {
        return 'config';
    }

    if (isDocsPath(lowerPath, fileName, extension)) {
        return 'docs';
    }

    if (STYLE_EXTENSIONS.has(extension)) {
        return 'style';
    }

    if (content && isPureBarrelFile(basename, extension, content)) {
        return 'barrel';
    }

    if (content && isModuleIndexFile(basename, extension)) {
        return hasRealImplementation(content, extension) ? 'implementation' : 'barrel';
    }

    if (isEntrypointFile(basename, extension)) {
        return 'entrypoint';
    }

    return 'implementation';
}

export function inferFileRoleIntent(query: string, filterExpr?: string): FileRoleIntent {
    const lowerQuery = query.toLowerCase();
    const explicitExtensions = new Set<string>();

    for (const match of lowerQuery.matchAll(/\.[a-z0-9][a-z0-9_-]*/g)) {
        explicitExtensions.add(normalizeExtension(match[0]));
    }

    if (filterExpr) {
        for (const match of filterExpr.matchAll(/['"](\.[^'"]+)['"]/g)) {
            explicitExtensions.add(normalizeExtension(match[1]));
        }
    }

    const preferredRoles = new Set<FileRole>();
    if (/\b(__tests__|tests?|specs?|e2e)\b/.test(lowerQuery)) {
        preferredRoles.add('test');
    }
    if (/\b(readme|docs?|documentation|markdown|mdx?)\b/.test(lowerQuery)) {
        preferredRoles.add('docs');
    }
    if (/\b(css|scss|sass|less|stylus?|styles?|stylesheet)\b/.test(lowerQuery)) {
        preferredRoles.add('style');
    }
    if (hasExplicitConfigIntent(lowerQuery)) {
        preferredRoles.add('config');
    }
    if (/\b(generated|__generated__|minified|min)\b/.test(lowerQuery)
        || /\b(?:dist|build|bundle)\s+(?:output|artifact|artifacts|directory|folder|files?)\b/.test(lowerQuery)) {
        preferredRoles.add('generated');
    }

    for (const extension of explicitExtensions) {
        if (STYLE_EXTENSIONS.has(extension)) {
            preferredRoles.add('style');
        } else if (DOC_EXTENSIONS.has(extension)) {
            preferredRoles.add('docs');
        } else if (CONFIG_EXTENSIONS.has(extension)) {
            preferredRoles.add('config');
        }
    }

    return {
        preferredRoles,
        explicitExtensions,
    };
}

function hasExplicitConfigIntent(lowerQuery: string): boolean {
    return /\b(?:config|configuration)\s+files?\b/.test(lowerQuery)
        || /\bfiles?\s+(?:config|configuration)\b/.test(lowerQuery)
        || /\bbuild\s+(?:config|configuration|script|scripts|metadata|files?|system)\b/.test(lowerQuery)
        || /\b(?:config|configuration)\s+for\s+(?:build|packaging|dependencies?)\b/.test(lowerQuery)
        || /\b(?:packaging|package)\s+metadata\b/.test(lowerQuery)
        || /\bdependency\s+groups?\b/.test(lowerQuery)
        || /\bsource\s+file\s+lists?\b/.test(lowerQuery)
        || /\b(?:cmake|cmakelists\.txt|makefile|pyproject(?:\.toml)?|cargo\.toml|go\.mod|package\.json)\b/.test(lowerQuery)
        || /(?:^|[/\\])configs?(?:[/\\]|$)/.test(lowerQuery);
}

export function isFileRoleExplicitlyRequested(role: FileRole, intent: FileRoleIntent, relativePath: string): boolean {
    if (role === 'implementation') {
        return true;
    }

    if (intent.preferredRoles.has(role)) {
        return true;
    }

    const extension = normalizeExtension(getExtension(relativePath.toLowerCase()));
    return extension.length > 0 && intent.explicitExtensions.has(extension);
}

export function normalizeExtension(extension: string): string {
    const trimmed = extension.trim().toLowerCase();
    if (trimmed.length === 0) {
        return '';
    }

    return trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
}

function getExtension(fileName: string): string {
    const lastSlash = Math.max(fileName.lastIndexOf('/'), fileName.lastIndexOf('\\'));
    const basename = lastSlash >= 0 ? fileName.slice(lastSlash + 1) : fileName;
    const lastDot = basename.lastIndexOf('.');
    return lastDot > 0 ? basename.slice(lastDot) : '';
}

function getBasename(fileName: string): string {
    const extension = getExtension(fileName);
    return extension ? fileName.slice(0, -extension.length) : fileName;
}

function isGeneratedPath(lowerPath: string, fileName: string): boolean {
    return lowerPath.includes('/dist/')
        || lowerPath.includes('/build/')
        || lowerPath.includes('/generated/')
        || lowerPath.includes('/__generated__/')
        || fileName.includes('.generated.')
        || fileName.includes('.gen.')
        || fileName.endsWith('.d.ts')
        || fileName.endsWith('.min.css')
        || fileName.endsWith('.bundle.css');
}

function isTestPath(lowerPath: string, fileName: string): boolean {
    const basename = getBasename(fileName);
    return lowerPath.includes('/__tests__/')
        || lowerPath.includes('/test/')
        || lowerPath.includes('/tests/')
        || lowerPath.includes('/spec/')
        || lowerPath.includes('/specs/')
        || fileName.includes('.test.')
        || fileName.includes('.spec.')
        || fileName.includes('.e2e.')
        || fileName.endsWith('_test.go')
        || fileName.endsWith('_test.py')
        || fileName.startsWith('test_') && fileName.endsWith('.py')
        || /^[a-z0-9_-]+test\.java$/.test(fileName)
        || /^[a-z0-9_-]+tests\.cs$/.test(fileName)
        || fileName.endsWith('_spec.rb')
        || basename.endsWith('_spec')
        || basename.endsWith('_test');
}

function isDocsPath(lowerPath: string, fileName: string, extension: string): boolean {
    return lowerPath.includes('/docs/')
        || lowerPath.includes('/doc/')
        || fileName === 'readme.md'
        || fileName === 'readme.markdown'
        || DOC_EXTENSIONS.has(extension);
}

function isConfigPath(lowerPath: string, fileName: string, extension: string): boolean {
    return lowerPath.includes('/config/')
        || lowerPath.includes('/configs/')
        || CONFIG_FILENAMES.has(fileName)
        || fileName.includes('.config.')
        || fileName.startsWith('.')
        || CONFIG_EXTENSIONS.has(extension);
}

function isModuleIndexFile(basename: string, extension: string): boolean {
    return MODULE_INDEX_BASENAMES.has(basename) && isCodeExtension(extension);
}

function isEntrypointFile(basename: string, extension: string): boolean {
    return ENTRYPOINT_BASENAMES.has(basename) && isCodeExtension(extension);
}

function isCodeExtension(extension: string): boolean {
    return [
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
        '.py', '.go', '.rs', '.java', '.cs', '.rb',
    ].includes(extension);
}

function isPureBarrelFile(basename: string, extension: string, content: string): boolean {
    if (!isModuleIndexFile(basename, extension)) {
        return false;
    }

    if (hasRealImplementation(content, extension)) {
        return false;
    }

    const meaningfulLines = stripComments(content)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0);

    if (meaningfulLines.length === 0) {
        return false;
    }

    if (extension === '.py') {
        return meaningfulLines.every(isPythonBarrelLine);
    }

    if (extension === '.rs') {
        return meaningfulLines.every(isRustBarrelLine);
    }

    return meaningfulLines.every(isJavaScriptBarrelLine);
}

function hasRealImplementation(content: string, extension: string): boolean {
    const stripped = stripComments(content);

    if (extension === '.py') {
        return /^\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/m.test(stripped)
            || /^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\b/m.test(stripped);
    }

    if (extension === '.go') {
        return /^\s*func\s+(?:\([^)]+\)\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\(/m.test(stripped)
            || /^\s*type\s+[A-Za-z_][A-Za-z0-9_]*\s+(?:struct|interface)\b/m.test(stripped);
    }

    if (extension === '.rs') {
        return /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/m.test(stripped)
            || /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|impl)\s+[A-Za-z_][A-Za-z0-9_]*\b/m.test(stripped);
    }

    return /\b(?:class|interface|function|enum)\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(stripped)
        || /\b(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/.test(stripped);
}

function stripComments(content: string): string {
    return content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*#.*$/gm, '');
}

function isJavaScriptBarrelLine(line: string): boolean {
    return /^import\s+(?:type\s+)?[\s\S]+;?$/.test(line)
        || /^export\s+(?:type\s+)?(?:\*|\{[\s\S]*\})\s+from\s+['"][^'"]+['"];?$/.test(line)
        || /^export\s+(?:type\s+)?\{[\s\S]*\};?$/.test(line);
}

function isPythonBarrelLine(line: string): boolean {
    return /^from\s+\.+[A-Za-z0-9_.*]+\s+import\s+[\s\S]+$/.test(line)
        || /^import\s+\.+[A-Za-z0-9_.*]+$/.test(line)
        || /^__all__\s*=/.test(line);
}

function isRustBarrelLine(line: string): boolean {
    return /^(?:pub\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*;?$/.test(line)
        || /^pub\s+use\s+[\s\S]+;?$/.test(line)
        || /^use\s+[\s\S]+;?$/.test(line);
}
