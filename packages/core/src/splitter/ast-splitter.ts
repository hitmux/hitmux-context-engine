import Parser from 'tree-sitter';
import { Splitter, CodeChunk } from './index';

type ParserConfig = {
    loadParser: () => any;
    nodeTypes: string[];
};

function loadParserLanguage(packageName: string, exportName?: string): any {
    const parserModule = require(packageName);
    const languageExport = exportName ? parserModule[exportName] : parserModule.default || parserModule;
    return languageExport?.nodeTypeInfo ? languageExport : languageExport?.language || languageExport;
}

// Node types that represent logical code units
const SPLITTABLE_NODE_TYPES = {
    javascript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition', 'export_statement', 'lexical_declaration', 'variable_declaration'],
    typescript: ['function_declaration', 'arrow_function', 'class_declaration', 'method_definition', 'export_statement', 'interface_declaration', 'type_alias_declaration', 'lexical_declaration', 'variable_declaration'],
    python: ['function_definition', 'class_definition', 'decorated_definition', 'async_function_definition'],
    java: ['method_declaration', 'class_declaration', 'interface_declaration', 'constructor_declaration'],
    cpp: ['function_definition', 'class_specifier', 'namespace_definition', 'declaration'],
    go: ['function_declaration', 'method_declaration', 'type_declaration', 'var_declaration', 'const_declaration'],
    rust: ['function_item', 'impl_item', 'struct_item', 'enum_item', 'trait_item', 'mod_item'],
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

            const parser = new Parser();
            parser.setLanguage(langConfig.loadParser());
            const tree = parser.parse(code);
            const rootNode = this.getRootNode(tree);

            if (!rootNode) {
                console.warn(`[ASTSplitter] ⚠️  Failed to parse AST for ${language}, falling back to LangChain: ${filePath || 'unknown'}`);
                return await this.langchainFallback.split(code, language, filePath);
            }

            // Extract chunks based on AST nodes
            const chunks = this.extractChunks(rootNode, code, langConfig.nodeTypes, language, filePath);

            // If chunks are too large, split them further
            const refinedChunks = await this.refineChunks(chunks);

            return refinedChunks;
        } catch (error) {
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

    private getLanguageConfig(language: string): ParserConfig | null {
        const langMap: Record<string, ParserConfig> = {
            'javascript': { loadParser: () => loadParserLanguage('tree-sitter-javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'js': { loadParser: () => loadParserLanguage('tree-sitter-javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'jsx': { loadParser: () => loadParserLanguage('tree-sitter-javascript'), nodeTypes: SPLITTABLE_NODE_TYPES.javascript },
            'typescript': { loadParser: () => loadParserLanguage('tree-sitter-typescript', 'typescript'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'ts': { loadParser: () => loadParserLanguage('tree-sitter-typescript', 'typescript'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'tsx': { loadParser: () => loadParserLanguage('tree-sitter-typescript', 'tsx'), nodeTypes: SPLITTABLE_NODE_TYPES.typescript },
            'python': { loadParser: () => loadParserLanguage('tree-sitter-python'), nodeTypes: SPLITTABLE_NODE_TYPES.python },
            'py': { loadParser: () => loadParserLanguage('tree-sitter-python'), nodeTypes: SPLITTABLE_NODE_TYPES.python },
            'java': { loadParser: () => loadParserLanguage('tree-sitter-java'), nodeTypes: SPLITTABLE_NODE_TYPES.java },
            'cpp': { loadParser: () => loadParserLanguage('tree-sitter-cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'c++': { loadParser: () => loadParserLanguage('tree-sitter-cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'c': { loadParser: () => loadParserLanguage('tree-sitter-cpp'), nodeTypes: SPLITTABLE_NODE_TYPES.cpp },
            'go': { loadParser: () => loadParserLanguage('tree-sitter-go'), nodeTypes: SPLITTABLE_NODE_TYPES.go },
            'rust': { loadParser: () => loadParserLanguage('tree-sitter-rust'), nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            'rs': { loadParser: () => loadParserLanguage('tree-sitter-rust'), nodeTypes: SPLITTABLE_NODE_TYPES.rust },
            'cs': { loadParser: () => loadParserLanguage('tree-sitter-c-sharp'), nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            'csharp': { loadParser: () => loadParserLanguage('tree-sitter-c-sharp'), nodeTypes: SPLITTABLE_NODE_TYPES.csharp },
            'scala': { loadParser: () => loadParserLanguage('tree-sitter-scala'), nodeTypes: SPLITTABLE_NODE_TYPES.scala }
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
                    isDefinition: false,
                }
            }];
        }

        return chunks;
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
            if (this.shouldEmitChunkForNode(currentNode, splittableTypes)) {
                const leadingCommentStartRow = this.findLeadingCommentStartRow(currentNode, codeLines);
                const startLine = leadingCommentStartRow + 1;
                const endLine = currentNode.endPosition.row + 1;
                const nodeText = codeLines.slice(leadingCommentStartRow, currentNode.endPosition.row + 1).join('\n');

                // Only create chunk if it has meaningful content
                if (nodeText.trim().length > 0) {
                    const symbolMetadata = this.extractSymbolMetadata(currentNode.type, nodeText);
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

    private shouldEmitChunkForNode(node: Parser.SyntaxNode, splittableTypes: string[]): boolean {
        if (!splittableTypes.includes(node.type)) {
            return false;
        }

        return node.type !== 'export_statement' || !this.hasSplittableDescendant(node, splittableTypes);
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
        nodeText: string
    ): Pick<CodeChunk['metadata'], 'chunkKind' | 'symbolName' | 'symbolKind' | 'isDefinition'> {
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
            { kind: 'method', pattern: /^\s*(?:public|private|protected|internal|static|final|abstract|override|virtual|async|sealed|synchronized|\s)*(?:[A-Za-z_$][A-Za-z0-9_$<>\[\],.?]*\s+)+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/m },
            { kind: 'method', pattern: /^\s*(?:public|private|protected|static|async|override|readonly|\s)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/m },
        ];

        for (const { kind, pattern } of symbolPatterns) {
            const match = nodeText.match(pattern);
            if (match?.[1]) {
                return {
                    chunkKind: this.getChunkKind(nodeType, kind),
                    symbolName: match[1],
                    symbolKind: kind,
                    isDefinition: true,
                };
            }
        }

        return {
            chunkKind: this.getChunkKind(nodeType),
            isDefinition: false,
        };
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
