export function splitStructuralToken(value: string): string[] {
    const normalized = value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2');

    const parts = normalized
        .split(/[^A-Za-z0-9]+/)
        .map(term => term.trim())
        .filter(term => term.length > 0);

    if (parts.length >= 2 && parts[0].length === 1 && /^[A-Z]$/.test(parts[0]) && /^[A-Z][a-z]/.test(parts[1])) {
        return [`${parts[0]}${parts[1]}`, ...parts.slice(2)];
    }

    return parts;
}

export function extractPathTokens(relativePath: string): string[] {
    const tokens = new Set<string>();
    const rawTokens = relativePath
        .split(/[\\/._-]+/)
        .map(token => token.trim())
        .filter(token => token.length >= 2);

    for (const token of rawTokens) {
        tokens.add(token);
        for (const structuralToken of splitStructuralToken(token)) {
            if (structuralToken.length >= 2) {
                tokens.add(structuralToken);
            }
        }
    }

    return [...tokens];
}
