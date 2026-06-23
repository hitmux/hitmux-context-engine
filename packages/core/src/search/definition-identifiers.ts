const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const C_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const HWS = '[^\\S\\r\\n]';

export function extractDefinitionIdentifiers(content: string): string[] {
    const identifiers = new Set<string>();
    const add = (value: string | undefined) => {
        const trimmed = value?.trim();
        if (trimmed && trimmed.length <= 512) {
            identifiers.add(trimmed);
        }
    };

    const definitionPatterns = [
        new RegExp(`^${HWS}*(?:export${HWS}+)?(?:default${HWS}+)?(?:abstract${HWS}+)?(?:class|interface|function|type|enum|const|let|var)${HWS}+(${IDENTIFIER})\\b`, 'gm'),
        new RegExp(`^${HWS}*(?:async${HWS}+)?def${HWS}+(${C_IDENTIFIER})${HWS}*\\(`, 'gm'),
        new RegExp(`^${HWS}*func${HWS}+(?:\\([^\\r\\n)]+\\)${HWS}*)?(${C_IDENTIFIER})${HWS}*\\(`, 'gm'),
        new RegExp(`^${HWS}*(?:pub(?:\\([^\\r\\n)]*\\))?${HWS}+)?(?:async${HWS}+)?fn${HWS}+(${C_IDENTIFIER})${HWS}*\\(`, 'gm'),
        new RegExp(`^${HWS}*(?:pub(?:\\([^\\r\\n)]*\\))?${HWS}+)?(?:struct|enum|trait|mod)${HWS}+(${C_IDENTIFIER})\\b`, 'gm'),
        new RegExp(`^${HWS}*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized)${HWS}+)*(?:${IDENTIFIER}[A-Za-z0-9_$<>\\[\\],.?]*${HWS}+)+(${IDENTIFIER})${HWS}*\\(`, 'gm'),
        new RegExp(`^${HWS}*#${HWS}*define${HWS}+(${C_IDENTIFIER})\\b`, 'gm'),
        new RegExp(`^${HWS}*(?:typedef${HWS}+)?(?:struct|enum|union)${HWS}+(${C_IDENTIFIER})\\b`, 'gm'),
        new RegExp(`^${HWS}*(?:(?:static|extern|inline|const|volatile|unsigned|signed|long|short|struct${HWS}+${C_IDENTIFIER}|enum${HWS}+${C_IDENTIFIER})${HWS}+)*(?:${C_IDENTIFIER}[A-Za-z0-9_ \\t*]*${HWS}+)+(${C_IDENTIFIER})${HWS}*\\([^;{}\\r\\n]*\\)${HWS}*\\{`, 'gm'),
        /^#{1,6}[^\S\r\n]+(.+?)[^\S\r\n]*#*[^\S\r\n]*$/gm,
    ];

    for (const pattern of definitionPatterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            add(match[1]);
        }
    }

    for (const match of content.matchAll(/^[^\S\r\n]*(?:function|macro)[^\S\r\n]*\([^\S\r\n]*([A-Za-z_][A-Za-z0-9_]*)\b/gim)) {
        add(match[1]);
    }

    for (const match of content.matchAll(/^[^\S\r\n]*\[+[^\S\r\n]*([A-Za-z0-9_.-]+)[^\S\r\n]*\]+[^\S\r\n]*$/gm)) {
        add(match[1]);
        const leaf = match[1].split('.').filter(Boolean).at(-1);
        add(leaf);
    }

    for (const match of content.matchAll(/\.\s*(?:handler|callback|command|proc|function|fn)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/gim)) {
        add(match[1]);
    }

    for (const match of content.matchAll(/\b[A-Z][A-Z0-9_]*CMD[A-Z0-9_]*\s*\([^)]*\b([A-Za-z_][A-Za-z0-9_]*(?:Command|Handler|Callback|Proc))\b[^)]*\)/g)) {
        add(match[1]);
    }

    return [...identifiers];
}
