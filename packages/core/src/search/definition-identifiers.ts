const IDENTIFIER = '[A-Za-z_$][A-Za-z0-9_$]*';
const C_IDENTIFIER = '[A-Za-z_][A-Za-z0-9_]*';
const HWS = '[^\\S\\r\\n]';
const MAX_DEFINITION_SCAN_LINE_LENGTH = 1000;

const LINE_DEFINITION_PATTERNS: Array<{ pattern: RegExp; required?: string[] }> = [
    { pattern: new RegExp(`^${HWS}*(?:export${HWS}+)?(?:default${HWS}+)?(?:abstract${HWS}+)?(?:class|interface|function|type|enum|const|let|var)${HWS}+(${IDENTIFIER})\\b`) },
    { pattern: new RegExp(`^${HWS}*(?:async${HWS}+)?def${HWS}+(${C_IDENTIFIER})${HWS}*\\(`), required: ['('] },
    { pattern: new RegExp(`^${HWS}*func${HWS}+(?:\\([^\\r\\n)]+\\)${HWS}*)?(${C_IDENTIFIER})${HWS}*\\(`), required: ['('] },
    { pattern: new RegExp(`^${HWS}*(?:pub(?:\\([^\\r\\n)]*\\))?${HWS}+)?(?:async${HWS}+)?fn${HWS}+(${C_IDENTIFIER})${HWS}*\\(`), required: ['('] },
    { pattern: new RegExp(`^${HWS}*(?:pub(?:\\([^\\r\\n)]*\\))?${HWS}+)?(?:struct|enum|trait|mod)${HWS}+(${C_IDENTIFIER})\\b`) },
    { pattern: new RegExp(`^${HWS}*(?:(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized)${HWS}+)*(?:${IDENTIFIER}[A-Za-z0-9_$<>\\[\\],.?]*${HWS}+)+(${IDENTIFIER})${HWS}*\\(`), required: ['('] },
    { pattern: new RegExp(`^${HWS}*#${HWS}*define${HWS}+(${C_IDENTIFIER})\\b`) },
    { pattern: new RegExp(`^${HWS}*(?:typedef${HWS}+)?(?:struct|enum|union)${HWS}+(${C_IDENTIFIER})\\b`) },
    { pattern: new RegExp(`^${HWS}*(?:(?:static|extern|inline|const|volatile|unsigned|signed|long|short|struct${HWS}+${C_IDENTIFIER}|enum${HWS}+${C_IDENTIFIER})${HWS}+)*(?:${C_IDENTIFIER}[A-Za-z0-9_ \\t*]*${HWS}+)+(${C_IDENTIFIER})${HWS}*\\([^;{}\\r\\n]*\\)${HWS}*\\{`), required: ['(', '{'] },
    { pattern: /^#{1,6}[^\S\r\n]+(.+?)[^\S\r\n]*#*[^\S\r\n]*$/ },
];

const FUNCTION_MACRO_PATTERN = /^[^\S\r\n]*(?:function|macro)[^\S\r\n]*\([^\S\r\n]*([A-Za-z_][A-Za-z0-9_]*)\b/i;
const SECTION_PATTERN = /^[^\S\r\n]*\[+[^\S\r\n]*([A-Za-z0-9_.-]+)[^\S\r\n]*\]+[^\S\r\n]*$/;
const HANDLER_ASSIGNMENT_PATTERN = /\.\s*(?:handler|callback|command|proc|function|fn)\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\b/gi;
const COMMAND_PATTERN = /\b[A-Z][A-Z0-9_]*CMD[A-Z0-9_]*\s*\([^)]*\b([A-Za-z_][A-Za-z0-9_]*(?:Command|Handler|Callback|Proc))\b[^)]*\)/g;

export function extractDefinitionIdentifiers(content: string): string[] {
    const identifiers = new Set<string>();
    const add = (value: string | undefined) => {
        const trimmed = value?.trim();
        if (trimmed && trimmed.length <= 512) {
            identifiers.add(trimmed);
        }
    };

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.length > MAX_DEFINITION_SCAN_LINE_LENGTH
            ? rawLine.slice(0, MAX_DEFINITION_SCAN_LINE_LENGTH)
            : rawLine;

        for (const { pattern, required } of LINE_DEFINITION_PATTERNS) {
            if (required?.some(token => !line.includes(token))) {
                continue;
            }

            const match = pattern.exec(line);
            if (match) {
                add(match[1]);
            }
        }

        let match = FUNCTION_MACRO_PATTERN.exec(line);
        if (match) {
            add(match[1]);
        }

        match = SECTION_PATTERN.exec(line);
        if (match) {
            add(match[1]);
            const leaf = match[1].split('.').filter(Boolean).at(-1);
            add(leaf);
        }

        HANDLER_ASSIGNMENT_PATTERN.lastIndex = 0;
        while ((match = HANDLER_ASSIGNMENT_PATTERN.exec(line)) !== null) {
            add(match[1]);
        }

        COMMAND_PATTERN.lastIndex = 0;
        while ((match = COMMAND_PATTERN.exec(line)) !== null) {
            add(match[1]);
        }
    }

    return [...identifiers];
}
