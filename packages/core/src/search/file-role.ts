export type FileRole = 'implementation' | 'test' | 'docs' | 'style' | 'config' | 'generated' | 'barrel' | 'entrypoint';

export interface FileRoleIntent {
    preferredRoles: ReadonlySet<FileRole>;
    explicitExtensions: ReadonlySet<string>;
}

const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.stylus', '.pcss']);
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.rst', '.adoc', '.txt']);
const CONFIG_EXTENSIONS = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.env']);

const CONFIG_FILENAMES = new Set([
    'package.json',
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

export function classifyFileRole(relativePath: string, fileExtension?: string): FileRole {
    const normalizedPath = relativePath.replace(/\\/g, '/');
    const lowerPath = normalizedPath.toLowerCase();
    const fileName = lowerPath.split('/').pop() || '';
    const extension = normalizeExtension(fileExtension || getExtension(fileName));

    if (isGeneratedPath(lowerPath, fileName)) {
        return 'generated';
    }

    if (isTestPath(lowerPath, fileName)) {
        return 'test';
    }

    if (isDocsPath(lowerPath, fileName, extension)) {
        return 'docs';
    }

    if (STYLE_EXTENSIONS.has(extension)) {
        return 'style';
    }

    if (isConfigPath(lowerPath, fileName, extension)) {
        return 'config';
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
    if (/\b(generated|__generated__|dist|build|bundle|minified|min)\b/.test(lowerQuery)) {
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
        || /\b(jsonc?|ya?ml|toml|ini|env)\b/.test(lowerQuery)
        || /(?:^|[\/\\])configs?(?:[\/\\]|$)/.test(lowerQuery);
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
    return lowerPath.includes('/__tests__/')
        || lowerPath.includes('/test/')
        || lowerPath.includes('/tests/')
        || lowerPath.includes('/spec/')
        || lowerPath.includes('/specs/')
        || fileName.includes('.test.')
        || fileName.includes('.spec.')
        || fileName.includes('.e2e.');
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
