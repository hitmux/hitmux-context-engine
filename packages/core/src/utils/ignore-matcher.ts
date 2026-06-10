import ignore from 'ignore';

export class IgnoreMatcher {
    private matcher: ReturnType<typeof ignore>;

    constructor(patterns: string[] = []) {
        this.matcher = ignore({ allowRelativePaths: true });
        if (patterns.length > 0) {
            this.matcher.add(patterns);
        }
    }

    shouldIgnore(relativePath: string, isDirectory: boolean = false): boolean {
        const normalizedPath = this.normalizePath(relativePath);
        if (!normalizedPath) {
            return false;
        }

        // Keep the existing product policy: hidden files and directories are
        // not indexed even if a request or ignore file tries to unignore them.
        if (normalizedPath.split('/').some(part => part.startsWith('.'))) {
            return true;
        }

        if (this.matcher.ignores(normalizedPath)) {
            return true;
        }

        return isDirectory && this.matcher.ignores(`${normalizedPath}/`);
    }

    private normalizePath(relativePath: string): string {
        return relativePath
            .replace(/\\/g, '/')
            .replace(/^\.\/+/, '')
            .replace(/^\/+|\/+$/g, '');
    }
}
