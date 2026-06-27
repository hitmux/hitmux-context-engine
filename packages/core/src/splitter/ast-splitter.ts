import Parser from 'tree-sitter';
import { Splitter, CodeChunk } from './index';

type ParserConfig = {
    loadParser: () => any;
    nodeTypes: string[];
};

type CachedParserConfig = ParserConfig & {
    cacheKey: string;
};

function loadParserLanguage(packageName: string, exportName?: string): any {
    const parserModule = require(packageName);
    const languageExport = exportName ? parserModule[exportName] : parserModule.default || parserModule;
    return languageExport?.nodeTypeInfo ? languageExport : languageExport?.language || languageExport;
}

// Node types that represent logical code units
const SPLITTABLE_NODE_TYPES = {
    javascript: ['function_declaration', 'class_declaration', 'method_definition', 'export_statement', 'lexical_declaration', 'variable_declaration'],
    typescript: ['function_declaration', 'class_declaration', 'method_definition', 'export_statement', 'interface_declaration', 'type_alias_declaration', 'lexical_declaration', 'variable_declaration'],
    python: ['function_definition', 'class_definition', 'decorated_definition', 'async_function_definition'],
    java: ['package_declaration', 'method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration'],
    cpp: ['function_definition', 'class_specifier', 'namespace_definition', 'declaration'],
    go: ['package_clause', 'function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration'],
    rust: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item', 'use_declaration'],
    csharp: ['method_declaration', 'class_declaration', 'interface_declaration', 'struct_declaration', 'enum_declaration'],
    scala: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration']
};

const SUPPORTED_AST_LANGUAGES = [
    'javascript', 'js', 'jsx', 'typescript', 'ts', 'tsx', 'python', 'py',
    'java', 'cpp', 'c++', 'c', 'go', 'rust', 'rs', 'cs', 'csharp', 'scala',
    'markdown', 'md'
];

export class AstCodeSplitter implements Splitter {
    private chunkSize: number = 2500;
    private chunkOverlap: number = 300;
    private langchainFallback: any; // LangChainCodeSplitter for fallback
    private readonly languageCache = new Map<string, any>();
    private readonly parserCache = new Map<string, Parser>();

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize !== undefined) this.chunkSize = chunkSize;
        if (chunkOverlap !== undefined) this.chunkOverlap = chunkOverlap;

        // Initialize fallback splitter
        const { LangChainCodeSplitter } = require('./langchain-splitter');
        this.langchainFallback = new LangChainCodeSplitter(chunkSize, chunkOverlap);
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        if (this.isMarkdownLanguage(language)) {
            console.log(`📝 Using Markdown section splitter for: ${filePath || 'unknown'}`);
            return this.refineChunks(this.splitMarkdownSections(code, language, filePath));
        }

        // Check if language is supported by AST splitter
        const langConfig = this.getLanguageConfig(language);
        if (!langConfig) {
            console.log(`📝 Language ${language} not supported by AST, using LangChain splitter for: ${filePath || 'unknown'}`);
            return await this.langchainFallback.split(code, language, filePath);
        }

        try {
            console.log(`🌳 Using AST splitter for ${language} file: ${filePath || 'unknown'}`);

            const parser = this.getParser(langConfig);
            const tree = parser.parse(code);
            const rootNode = this.getRootNode(tree);

            if (!rootNode) {
                const fallbackChunks = this.extractRegexChunks(code, language, filePath);
                if (fallbackChunks.length > 0) {
                    return this.refineChunks(fallbackChunks);
                }

                console.warn(`[ASTSplitter] ⚠️  Failed to parse AST for ${language}, falling back to LangChain: ${filePath || 'unknown'}`);
                return await this.langchainFallback.split(code, language, filePath);
            }

            // Extract chunks based on AST nodes
            const chunks = this.extractChunks(rootNode, code, langConfig.nodeTypes, language, filePath);

            // If chunks are too large, split them further
            const refinedChunks = await this.refineChunks(chunks);

            return refinedChunks;
        } catch (error) {
            const fallbackChunks = this.extractRegexChunks(code, language, filePath);
            if (fallbackChunks.length > 0) {
                return this.refineChunks(fallbackChunks);
            }

            console.warn(`[ASTSplitter] ⚠️  AST splitter failed for ${language}, falling back to LangChain: ${error}`);
            return await this.langchainFallback.split(code, language, filePath);
        }
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = chunkSize;
        this.langchainFallback.setChunkSize(chunkSize);
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = chunkOverlap;
        this.langchainFallback.setChunkOverlap(chunkOverlap);
    }

    private getParser(langConfig: CachedParserConfig): Parser {
        const existingParser = this.parserCache.get(langConfig.cacheKey);
        if (existingParser) {
            return existingParser;
        }

        const parser = new Parser();
        parser.setLanguage(this.getParserLanguage(langConfig));
        this.parserCache.set(langConfig.cacheKey, parser);
        return parser;
    }

    private getParserLanguage(langConfig: CachedParserConfig): any {
        const existingLanguage = this.languageCache.get(langConfig.cacheKey);
        if (existingLanguage) {
            return existingLanguage;
        }

        const parserLanguage = langConfig.loadParser();
        this.languageCache.set(langConfig.cacheKey, parserLanguage);
        return parserLanguage;
    }

    private getLanguageConfig(language: string): CachedParserConfig | null {
        const langMap: Record<string, CachedParserConfig> = {
            'javascript': { cacheKey: 'javascript', loadParser: () => loadParserLanguage('tree-sitter-javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'js': { cacheKey: 'javascript', loadParser: () => loadParserLanguage('tree-sitter-javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'jsx': { cacheKey: 'javascript', loadParser: () => loadParserLanguage('tree-sitter-javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'typescript': { cacheKey: 'typescript', loadParser: () => loadParserLanguage('tree-sitter-typescript', 'typescript'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'ts': { cacheKey: 'typescript', loadParser: () => loadParserLanguage('tree-sitter-typescript', 'typescript'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'tsx': { cacheKey: 'tsx', loadParser: () => loadParserLanguage('tree-sitter-typescript', 'tsx'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'python': { cacheKey: 'python', loadParser: () => loadParserLanguage('tree-sitter-python'), nodeTypes: SPLITTABLE_NODE_TYPES.python },
            'py': { cacheKey: 'python', loadParser: () => loadParserLanguage('tree-sitter-python'), nodeTypes: SPLITTABLE_NODE_TYPES.python },
            'java': { cacheKey: 'java', loadParser: () => loadParserLanguage('tree-sitter-java'), nodeTypes: SPLITTABLE_NODE_TYPES.java },
            'cpp': { cacheKey: 'cpp', loadParser: () => loadParserLanguage('tree-sitter-cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'c++': { cacheKey: 'cpp', loadParser: () => loadParserLanguage('tree-sitter-cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'c': { cacheKey: 'cpp', loadParser: () => loadParserLanguage('tree-sitter-cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'go': { cacheKey: 'go', loadParser: () => loadParserLanguage('tree-sitter-go'), nodeTypes: SPLITTABLE_NODE_TYPES.go },
            'rust': { cacheKey: 'rust', loadParser: () => loadParserLanguage('tree-sitter-rust'), nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            'rs': { cacheKey: 'rust', loadParser: () => loadParserLanguage('tree-sitter-rust'), nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            'cs': { cacheKey: 'csharp', loadParser: () => loadParserLanguage('tree-sitter-c-sharp'), nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            'csharp': { cacheKey: 'csharp', loadParser: () => loadParserLanguage('tree-sitter-c-sharp'), nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            'scala': { cacheKey: 'scala', loadParser: () => loadParserLanguage('tree-sitter-scala'), nodeTypes: SPLITTABLE_NODE_TYPES.scala }
        };

        return langMap[language.toLowerCase()] || null;
    }

    private getRootNode(tree: unknown): Parser.SyntaxNode | undefined {
        const candidate = tree as {
            rootNode?: Parser.SyntaxNode | (() => Parser.SyntaxNode);
            root_node?: Parser.SyntaxNode | (() => Parser.SyntaxNode);
        };

        const rootNode = typeof candidate.rootNode === 'function' ? candidate.rootNode() : candidate.rootNode;
        if (rootNode) {
            return rootNode;
        }

        const rootNodeSnakeCase = typeof candidate.root_node === 'function' ? candidate.root_node() : candidate.root_node;
        return rootNodeSnakeCase;
    }

    private isMarkdownLanguage(language: string): boolean {
        const normalized = language.toLowerCase();
        return normalized === 'markdown' || normalized === 'md';
    }

    private splitMarkdownSections(code: string, language: string, filePath?: string): CodeChunk[] {
        const lines = code.split('\n');
        const chunks: CodeChunk[] = [];
        let sectionStart = 0;
        let sectionTitle = '';

        const pushSection = (endExclusive: number) => {
            if (endExclusive <= sectionStart) {
                return;
            }

            const content = lines.slice(sectionStart, endExclusive).join('\n');
            if (content.trim().length === 0) {
                return;
            }

            const hasHeader = sectionTitle.length > 0;
            chunks.push({
                content,
                metadata: {
                    startLine: sectionStart + 1,
                    endLine: endExclusive,
                    language,
                    filePath,
                    chunkKind: hasHeader ? 'markdown_section' : 'markdown_preamble',
                    chunkRole: 'reference',
                    symbolName: hasHeader ? sectionTitle : undefined,
                    symbolKind: hasHeader ? 'markdown_header' : undefined,
                    isDefinition: hasHeader,
                }
            });
        };

        for (let index = 0; index < lines.length; index++) {
            const header = this.extractMarkdownHeader(lines[index]);
            if (!header) {
                continue;
            }

            pushSection(index);
            sectionStart = index;
            sectionTitle = header;
        }

        pushSection(lines.length);

        if (chunks.length === 0) {
            return [{
                content: code,
                metadata: {
                    startLine: 1,
                    endLine: lines.length,
                    language,
                    filePath,
                    chunkKind: 'markdown',
                    chunkRole: 'reference',
                    isDefinition: false,
                }
            }];
        }

        return chunks;
    }

    private extractRegexChunks(code: string, language: string, filePath?: string): CodeChunk[] {
        const lines = code.split('\n');
        const starts = this.findRegexChunkStarts(lines, language);
        if (starts.length === 0) {
            return [];
        }

        const chunks: CodeChunk[] = [];
        const occupiedStarts = new Set<number>();

        for (const start of starts) {
            const leadingStart = this.findLeadingCommentStartLine(start.lineIndex, lines);
            const startKey = leadingStart;
            if (occupiedStarts.has(startKey)) {
                continue;
            }
            occupiedStarts.add(startKey);

            const endIndex = this.findRegexChunkEnd(lines, start.lineIndex, start.nodeType, language);
            const content = lines.slice(leadingStart, endIndex + 1).join('\n');
            if (content.trim().length === 0) {
                continue;
            }

            chunks.push({
                content,
                metadata: {
                    startLine: leadingStart + 1,
                    endLine: endIndex + 1,
                    language,
                    filePath,
                    ...this.extractSymbolMetadata(start.nodeType, content, language, filePath),
                }
            });
        }

        return chunks;
    }

    private findRegexChunkStarts(lines: string[], language: string): Array<{ lineIndex: number; nodeType: string }> {
        const normalizedLanguage = language.toLowerCase();
        const starts: Array<{ lineIndex: number; nodeType: string }> = [];

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                continue;
            }

            if (['typescript', 'ts', 'tsx', 'javascript', 'js', 'jsx'].includes(normalizedLanguage)) {
                if (this.getIndentWidth(line) !== 0) {
                    continue;
                }
                if (/^export\s+(?:type\s+)?(?:\*|\{[\s\S]*\})\s+from\s+['"][^'"]+['"];?$/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'export_statement' });
                } else if (/^(?:export\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'class_declaration' });
                } else if (/^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'function_declaration' });
                } else if (/^(?:export\s+)?interface\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'interface_declaration' });
                } else if (/^(?:export\s+)?type\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'type_alias_declaration' });
                } else if (/^(?:export\s+)?(?:const|let|var)\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'lexical_declaration' });
                }
                continue;
            }

            if (['python', 'py'].includes(normalizedLanguage)) {
                if (/^\s*class\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(line)) {
                    starts.push({ lineIndex: index, nodeType: 'class_definition' });
                } else if (/^\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(line)) {
                    starts.push({ lineIndex: index, nodeType: 'function_definition' });
                }
                continue;
            }

            if (normalizedLanguage === 'go') {
                if (/^package\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'package_clause' });
                } else if (/^type\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'type_declaration' });
                } else if (/^func\s+(?:\([^)]+\)\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'function_declaration' });
                } else if (/^(?:var|const)\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'var_declaration' });
                }
                continue;
            }

            if (['rust', 'rs'].includes(normalizedLanguage)) {
                if (/^(?:pub\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*;?$/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'mod_item' });
                } else if (/^(?:pub\s+)?use\s+[\s\S]+;?$/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'use_declaration' });
                } else if (/^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'function_item' });
                } else if (/^(?:pub(?:\([^)]*\))?\s+)?struct\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'struct_item' });
                } else if (/^(?:pub(?:\([^)]*\))?\s+)?(?:enum|trait)\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'trait_item' });
                }
                continue;
            }

            if (['java', 'csharp', 'cs'].includes(normalizedLanguage)) {
                if (/^package\s+[A-Za-z0-9_.]+\s*;?$/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'package_declaration' });
                } else if (/^(?:public|private|protected|internal|static|final|abstract|sealed|\s)*(?:class|interface|struct|enum)\s+[A-Za-z_$][A-Za-z0-9_$]*\b/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'class_declaration' });
                } else if (/^(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>[\],.?]*\s+)+[A-Za-z_$][A-Za-z0-9_$]*\s*\(/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'method_declaration' });
                }
                continue;
            }

            if (['c', 'cpp', 'c++'].includes(normalizedLanguage)) {
                if (/^(?:static\s+)?(?:inline\s+)?[A-Za-z_][A-Za-z0-9_*\s]+\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^;]*\)\s*\{?/.test(trimmed)) {
                    starts.push({ lineIndex: index, nodeType: 'function_definition' });
                }
            }
        }

        return starts;
    }

    private findRegexChunkEnd(lines: string[], startLine: number, nodeType: string, language: string): number {
        const normalizedLanguage = language.toLowerCase();
        if (nodeType === 'package_clause' || nodeType === 'package_declaration' || nodeType === 'export_statement' || nodeType === 'use_declaration') {
            return startLine;
        }

        if (
            ['typescript', 'ts', 'tsx', 'javascript', 'js', 'jsx'].includes(normalizedLanguage)
            && (nodeType === 'lexical_declaration' || nodeType === 'variable_declaration')
            && /;\s*$/.test(lines[startLine].trim())
        ) {
            return startLine;
        }

        if (['python', 'py'].includes(normalizedLanguage)) {
            const startIndent = this.getIndentWidth(lines[startLine]);
            for (let index = startLine + 1; index < lines.length; index++) {
                const line = lines[index];
                if (line.trim().length === 0 || this.isCommentLine(line.trim())) {
                    continue;
                }

                if (this.getIndentWidth(line) <= startIndent) {
                    return index - 1;
                }
            }
            return lines.length - 1;
        }

        let balance = 0;
        let sawOpeningBrace = false;
        for (let index = startLine; index < lines.length; index++) {
            for (const char of lines[index]) {
                if (char === '{') {
                    balance++;
                    sawOpeningBrace = true;
                } else if (char === '}') {
                    balance--;
                }
            }

            if (sawOpeningBrace && balance <= 0) {
                return index;
            }

            if (!sawOpeningBrace && index > startLine && lines[index].trim().length > 0) {
                return index - 1;
            }
        }

        return startLine;
    }

    private findLeadingCommentStartLine(startLine: number, lines: string[]): number {
        let row = startLine - 1;
        let commentStart = startLine;
        let foundComment = false;

        while (row >= 0) {
            const line = lines[row].trim();
            if (line.length === 0) {
                if (!foundComment) {
                    break;
                }
                commentStart = row;
                row--;
                continue;
            }

            if (this.isCommentLine(line)) {
                foundComment = true;
                commentStart = row;
                row--;
                continue;
            }

            break;
        }

        while (commentStart < startLine && lines[commentStart].trim().length === 0) {
            commentStart++;
        }

        return commentStart;
    }

    private getIndentWidth(line: string): number {
        const match = line.match(/^\s*/);
        return match ? match[0].replace(/\t/g, '    ').length : 0;
    }

    private extractMarkdownHeader(line: string): string | undefined {
        const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
        const title = match?.[1]?.trim();
        return title && title.length > 0 ? title : undefined;
    }

    private extractChunks(
        node: Parser.SyntaxNode,
        code: string,
        splittableTypes: string[],
        language: string,
        filePath?: string
    ): CodeChunk[] {
        const chunks: CodeChunk[] = [];
        const codeLines = code.split('\n');

        const traverse = (currentNode: Parser.SyntaxNode) => {
            // Check if this node type should be split into a chunk
            if (this.shouldEmitChunkForNode(currentNode, splittableTypes, language)) {
                const leadingCommentStartRow = this.findLeadingCommentStartRow(currentNode, codeLines);
                const startLine = leadingCommentStartRow + 1;
                const endLine = currentNode.endPosition.row + 1;
                const nodeText = codeLines.slice(leadingCommentStartRow, currentNode.endPosition.row + 1).join('\n');

                // Only create chunk if it has meaningful content
                if (nodeText.trim().length > 0) {
                    const symbolMetadata = this.extractSymbolMetadata(currentNode.type, nodeText, language, filePath);
                    chunks.push({
                        content: nodeText,
                        metadata: {
                            startLine,
                            endLine,
                            language,
                            filePath,
                            ...symbolMetadata,
                        }
                    });
                }
            }

            // Continue traversing child nodes
            for (const child of currentNode.children) {
                traverse(child);
            }
        };

        traverse(node);

        // If no meaningful chunks found, create a single chunk with the entire code
        if (chunks.length === 0) {
            chunks.push({
                content: code,
                metadata: {
                    startLine: 1,
                    endLine: codeLines.length,
                    language,
                    filePath,
                }
            });
        }

        return chunks;
    }

    private async refineChunks(chunks: CodeChunk[]): Promise<CodeChunk[]> {
        const refinedChunks: CodeChunk[] = [];

        for (const chunk of chunks) {
            if (chunk.content.length <= this.chunkSize) {
                refinedChunks.push(chunk);
            } else {
                // Split large chunks using character-based splitting
                const subChunks = this.splitLargeChunk(chunk);
                refinedChunks.push(...subChunks);
            }
        }

        return refinedChunks;
    }

    private shouldEmitChunkForNode(node: Parser.SyntaxNode, splittableTypes: string[], language: string): boolean {
        if (!splittableTypes.includes(node.type)) {
            return false;
        }

        if (
            this.isJavaScriptLikeLanguage(language)
            && (node.type === 'lexical_declaration' || node.type === 'variable_declaration')
            && !this.isTopLevelVariableDeclaration(node)
        ) {
            return false;
        }

        return node.type !== 'export_statement' || !this.hasSplittableDescendant(node, splittableTypes);
    }

    private isJavaScriptLikeLanguage(language: string): boolean {
        return ['typescript', 'ts', 'tsx', 'javascript', 'js', 'jsx'].includes(language.toLowerCase());
    }

    private isTopLevelVariableDeclaration(node: Parser.SyntaxNode): boolean {
        const parentType = node.parent?.type;
        return parentType === 'program'
            || parentType === 'source_file'
            || parentType === 'export_statement';
    }

    private hasSplittableDescendant(node: Parser.SyntaxNode, splittableTypes: string[]): boolean {
        for (const child of node.children) {
            if (splittableTypes.includes(child.type) || this.hasSplittableDescendant(child, splittableTypes)) {
                return true;
            }
        }

        return false;
    }

    private extractSymbolMetadata(
        nodeType: string,
        nodeText: string,
        language: string,
        filePath?: string
    ): Pick<CodeChunk['metadata'], 'chunkKind' | 'chunkRole' | 'symbolName' | 'symbolKind' | 'isDefinition'> {
        const symbolPatterns: Array<{ kind: string; pattern: RegExp }> = [
            { kind: 'class', pattern: /\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'interface', pattern: /\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'function', pattern: /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'function', pattern: /\b(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
            { kind: 'function', pattern: /\bfunc\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
            { kind: 'function', pattern: /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/ },
            { kind: 'type', pattern: /\btype\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'enum', pattern: /\benum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'struct', pattern: /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
            { kind: 'trait', pattern: /\btrait\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
            { kind: 'module', pattern: /\bmod\s+([A-Za-z_][A-Za-z0-9_]*)\b/ },
            { kind: 'const', pattern: /\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'let', pattern: /\blet\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'var', pattern: /\bvar\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/ },
            { kind: 'method', pattern: /^\s*(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>[\],.?]*\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/m },
            { kind: 'method', pattern: /^\s*(?:public|private|protected|static|async|override|readonly|\s)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/m },
        ];

        for (const { kind, pattern } of symbolPatterns) {
            const match = nodeText.match(pattern);
            if (match?.[1]) {
                const chunkKind = this.getChunkKind(nodeType, kind);
                return {
                    chunkKind,
                    chunkRole: this.getChunkRole(nodeType, nodeText, chunkKind, true, kind, match[1], language, filePath),
                    symbolName: match[1],
                    symbolKind: kind,
                    isDefinition: true,
                };
            }
        }

        return {
            chunkKind: this.getChunkKind(nodeType),
            chunkRole: this.getChunkRole(nodeType, nodeText, this.getChunkKind(nodeType), false, undefined, undefined, language, filePath),
            isDefinition: false,
        };
    }

    private getChunkRole(
        nodeType: string,
        nodeText: string,
        chunkKind: string,
        isDefinition: boolean,
        symbolKind?: string,
        symbolName?: string,
        language?: string,
        filePath?: string
    ): NonNullable<CodeChunk['metadata']['chunkRole']> {
        if (this.isModuleDeclarationChunk(nodeType, nodeText, language)) {
            return 'module_decl';
        }

        if (this.isReExportChunk(nodeText, language)) {
            return 're_export';
        }

        if (this.isTestCaseChunk(nodeText, symbolName, filePath)) {
            return 'test_case';
        }

        if (!isDefinition && this.isAssertionChunk(nodeText)) {
            return 'assertion';
        }

        if (isDefinition) {
            return symbolKind === 'method' ? 'method_body' : 'definition';
        }

        return chunkKind === 'export' ? 'reference' : 'reference';
    }

    private getChunkKind(nodeType: string, symbolKind?: string): string {
        if (symbolKind) {
            return `${symbolKind}_definition`;
        }
        if (nodeType.includes('export')) {
            return 'export';
        }
        if (nodeType.includes('declaration') || nodeType.includes('definition')) {
            return 'definition';
        }
        return 'code';
    }

    private isReExportChunk(nodeText: string, language?: string): boolean {
        const meaningfulLines = this.stripLineComments(nodeText, language)
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        if (meaningfulLines.length === 0) {
            return false;
        }

        if (language && ['python', 'py'].includes(language.toLowerCase())) {
            return meaningfulLines.every(line =>
                /^from\s+\.+[A-Za-z0-9_.*]+\s+import\s+[\s\S]+$/.test(line)
                || /^__all__\s*=/.test(line)
            );
        }

        if (language && ['rust', 'rs'].includes(language.toLowerCase())) {
            return meaningfulLines.every(line =>
                /^(?:pub\s+)?mod\s+[A-Za-z_][A-Za-z0-9_]*\s*;?$/.test(line)
                || /^pub\s+use\s+[\s\S]+;?$/.test(line)
            );
        }

        return meaningfulLines.every(line =>
            /^export\s+(?:type\s+)?(?:\*|\{[\s\S]*\})\s+from\s+['"][^'"]+['"];?$/.test(line)
            || /^export\s+(?:type\s+)?\{[\s\S]*\};?$/.test(line)
        );
    }

    private isModuleDeclarationChunk(nodeType: string, nodeText: string, language?: string): boolean {
        const normalizedLanguage = language?.toLowerCase();
        return nodeType === 'package_clause'
            || nodeType === 'package_declaration'
            || nodeType === 'mod_item'
            || (normalizedLanguage === 'go' && /^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\s*$/.test(nodeText.trim()))
            || (normalizedLanguage === 'java' && /^\s*package\s+[A-Za-z0-9_.]+\s*;?\s*$/.test(nodeText.trim()));
    }

    private isTestCaseChunk(nodeText: string, symbolName?: string, filePath?: string): boolean {
        const lowerPath = (filePath || '').replace(/\\/g, '/').toLowerCase();
        const isTestFile = lowerPath.includes('/test/')
            || lowerPath.includes('/tests/')
            || lowerPath.includes('/__tests__/')
            || lowerPath.includes('/spec/')
            || lowerPath.includes('/specs/')
            || /(?:\.test|\.spec|_test|_spec)\.[a-z0-9]+$/.test(lowerPath)
            || /(?:^|\/)test_[^/]+\.py$/.test(lowerPath)
            || /(?:^|\/)[^/]+test\.java$/.test(lowerPath)
            || /(?:^|\/)[^/]+tests\.cs$/.test(lowerPath);

        if (!isTestFile) {
            return false;
        }

        return /^(?:test_|test[A-Z0-9_]|Test[A-Z0-9_])/.test(symbolName || '')
            || /\b(?:it|test|describe)\s*\(/.test(nodeText)
            || /\bassert(?:That|Equals|True|False)?\s*\(/.test(nodeText)
            || /\bexpect\s*\(/.test(nodeText);
    }

    private isAssertionChunk(nodeText: string): boolean {
        return /\b(?:assert|expect)\s*\(/.test(nodeText)
            || /\bassert(?:That|Equals|True|False)\s*\(/.test(nodeText);
    }

    private stripLineComments(content: string, language?: string): string {
        const withoutBlockComments = content.replace(/\/\*[\s\S]*?\*\//g, '');
        if (language && ['python', 'py'].includes(language.toLowerCase())) {
            return withoutBlockComments.replace(/^\s*#.*$/gm, '');
        }

        return withoutBlockComments.replace(/^\s*\/\/.*$/gm, '');
    }

    private splitLargeChunk(chunk: CodeChunk): CodeChunk[] {
        const lines = chunk.content.split('\n');
        const subChunks: CodeChunk[] = [];
        let currentChunk = '';
        let currentStartLine = chunk.metadata.startLine;
        let currentLineCount = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineWithNewline = i === lines.length - 1 ? line : line + '\n';

            if (currentChunk.length + lineWithNewline.length > this.chunkSize && currentChunk.length > 0) {
                // Create a sub-chunk
                subChunks.push({
                    content: currentChunk.trim(),
                    metadata: this.createSubChunkMetadata(chunk, currentStartLine, currentLineCount, subChunks.length === 0)
                });

                currentChunk = lineWithNewline;
                currentStartLine = chunk.metadata.startLine + i;
                currentLineCount = 1;
            } else {
                currentChunk += lineWithNewline;
                currentLineCount++;
            }
        }

        // Add the last sub-chunk
        if (currentChunk.trim().length > 0) {
            subChunks.push({
                content: currentChunk.trim(),
                metadata: this.createSubChunkMetadata(chunk, currentStartLine, currentLineCount, subChunks.length === 0)
            });
        }

        return this.addOverlap(subChunks);
    }

    private createSubChunkMetadata(
        chunk: CodeChunk,
        startLine: number,
        lineCount: number,
        isFirstSubChunk: boolean
    ): CodeChunk['metadata'] {
        const metadata: CodeChunk['metadata'] = {
            startLine,
            endLine: startLine + lineCount - 1,
            language: chunk.metadata.language,
            filePath: chunk.metadata.filePath,
            chunkKind: isFirstSubChunk ? chunk.metadata.chunkKind : 'code',
            chunkRole: isFirstSubChunk ? chunk.metadata.chunkRole : 'method_body',
        };

        if (isFirstSubChunk) {
            metadata.symbolName = chunk.metadata.symbolName;
            metadata.symbolKind = chunk.metadata.symbolKind;
            metadata.isDefinition = chunk.metadata.isDefinition;
        } else {
            metadata.isDefinition = false;
        }

        return metadata;
    }

    private addOverlap(chunks: CodeChunk[]): CodeChunk[] {
        if (chunks.length <= 1 || this.chunkOverlap <= 0) {
            return chunks;
        }

        const overlappedChunks: CodeChunk[] = [];

        for (let i = 0; i < chunks.length; i++) {
            let content = chunks[i].content;
            const metadata = { ...chunks[i].metadata };

            // Add overlap from previous chunk
            if (i > 0 && this.chunkOverlap > 0) {
                const prevChunk = chunks[i - 1];
                const overlapText = prevChunk.content.slice(-this.chunkOverlap);
                content = overlapText + '\n' + content;
                metadata.startLine = Math.max(1, metadata.startLine - this.getLineCount(overlapText));
            }

            overlappedChunks.push({
                content,
                metadata
            });
        }

        return overlappedChunks;
    }

    private getLineCount(text: string): number {
        return text.split('\n').length;
    }

    private findLeadingCommentStartRow(node: Parser.SyntaxNode, codeLines: string[]): number {
        let row = node.startPosition.row - 1;
        let startRow = node.startPosition.row;
        let foundComment = false;
        let insideBlockComment = false;

        while (row >= 0) {
            const line = codeLines[row].trim();

            if (line.length === 0) {
                if (!foundComment) {
                    break;
                }
                startRow = row;
                row--;
                continue;
            }

            if (insideBlockComment || this.isCommentLine(line)) {
                foundComment = true;
                startRow = row;
                insideBlockComment = !line.includes('/*') && (insideBlockComment || line.endsWith('*/') || line.startsWith('*'));

                if (line.includes('/*') || line.includes('/**')) {
                    insideBlockComment = false;
                    row--;
                    continue;
                }

                row--;
                continue;
            }

            break;
        }

        while (startRow < node.startPosition.row && codeLines[startRow].trim().length === 0) {
            startRow++;
        }

        return startRow;
    }

    private isCommentLine(line: string): boolean {
        return line.startsWith('//') ||
            line.startsWith('#') ||
            line.startsWith('/*') ||
            line.startsWith('*') ||
            line.endsWith('*/') ||
            line.startsWith('"""') ||
            line.startsWith("'''");
    }

    /**
     * Check if AST splitting is supported for the given language
     */
    static isLanguageSupported(language: string): boolean {
        return SUPPORTED_AST_LANGUAGES.includes(language.toLowerCase());
    }

    static getSupportedLanguages(): string[] {
        return [...SUPPORTED_AST_LANGUAGES];
    }
}
