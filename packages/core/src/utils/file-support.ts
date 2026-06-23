import * as path from 'path';

const DEFAULT_SUPPORTED_FILENAMES = new Set([
    'cmakelists.txt',
    'makefile',
    'gnumakefile',
    'go.mod',
    'go.sum',
    'package.json',
    'tsconfig.json',
    'jsconfig.json',
    'pyproject.toml',
    'cargo.toml',
]);

export function isDefaultSupportedFileName(fileName: string): boolean {
    return DEFAULT_SUPPORTED_FILENAMES.has(fileName.toLowerCase());
}

export function isSupportedCodeFileName(fileName: string, supportedExtensions: string[]): boolean {
    const ext = path.extname(fileName).toLowerCase();
    const normalizedSupportedExtensions = supportedExtensions.map(extension => extension.toLowerCase());
    return normalizedSupportedExtensions.includes(ext) || isDefaultSupportedFileName(fileName);
}

export function getKnownFileNameLanguage(filePath: string): string | undefined {
    const fileName = path.basename(filePath).toLowerCase();
    switch (fileName) {
        case 'cmakelists.txt':
            return 'cmake';
        case 'makefile':
        case 'gnumakefile':
            return 'makefile';
        case 'go.mod':
        case 'go.sum':
            return 'go';
        case 'package.json':
        case 'tsconfig.json':
        case 'jsconfig.json':
            return 'json';
        case 'pyproject.toml':
        case 'cargo.toml':
            return 'toml';
        default:
            return undefined;
    }
}
