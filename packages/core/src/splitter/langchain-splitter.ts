import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { Splitter, CodeChunk } from './index';

// Define LangChain supported language types
type SupportedLanguage = "cpp" | "go" | "java" | "js" | "php" | "proto" | "python" | "rst" | "ruby" | "rust" | "scala" | "swift" | "markdown" | "latex" | "html" | "sol";

export class LangChainCodeSplitter implements Splitter {
    private chunkSize: number = 1000;
    private chunkOverlap: number = 200;

    constructor(chunkSize?: number, chunkOverlap?: number) {
        if (chunkSize !== undefined) this.chunkSize = chunkSize;
        if (chunkOverlap !== undefined) this.chunkOverlap = chunkOverlap;
    }

    async split(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        try {
            // Create language-specific splitter
            const mappedLanguage = this.mapLanguage(language);
            if (mappedLanguage) {
                const splitter = RecursiveCharacterTextSplitter.fromLanguage(
                    mappedLanguage,
                    {
                        chunkSize: this.chunkSize,
                        chunkOverlap: this.chunkOverlap,
                    }
                );

                // Split code
                const documents = await splitter.createDocuments([code]);

                // Convert to CodeChunk format
                return documents.map((doc) => {
                    const lines = doc.metadata?.loc?.lines || { from: 1, to: 1 };
                    return {
                        content: doc.pageContent,
                        metadata: {
                            startLine: lines.from,
                            endLine: lines.to,
                            language,
                            filePath,
                        },
                    };
                });
            } else {
                // If language is not supported, use generic splitter directly
                return this.fallbackSplit(code, language, filePath);
            }
        } catch (error) {
            console.error('[LangChainSplitter] ❌ Error splitting code:', error);
            // If specific language splitting fails, use generic splitter
            return this.fallbackSplit(code, language, filePath);
        }
    }

    setChunkSize(chunkSize: number): void {
        this.chunkSize = chunkSize;
    }

    setChunkOverlap(chunkOverlap: number): void {
        this.chunkOverlap = chunkOverlap;
    }

    private mapLanguage(language: string): SupportedLanguage | null {
        // Map common language names to LangChain supported formats
        const languageMap: Record<string, SupportedLanguage> = {
            'javascript': 'js',
            'typescript': 'js',
            'tsx': 'js',
            'jsx': 'js',
            'python': 'python',
            'java': 'java',
            'cpp': 'cpp',
            'c++': 'cpp',
            'c': 'cpp',
            'go': 'go',
            'rust': 'rust',
            'php': 'php',
            'ruby': 'ruby',
            'swift': 'swift',
            'scala': 'scala',
            'html': 'html',
            'markdown': 'markdown',
            'md': 'markdown',
            'latex': 'latex',
            'tex': 'latex',
            'solidity': 'sol',
            'sol': 'sol',
        };

        return languageMap[language.toLowerCase()] || null;
    }

    private async fallbackSplit(code: string, language: string, filePath?: string): Promise<CodeChunk[]> {
        // Generic splitter as fallback
        const splitter = new RecursiveCharacterTextSplitter({
            chunkSize: this.chunkSize,
            chunkOverlap: this.chunkOverlap,
        });

        const documents = await splitter.createDocuments([code]);

        let nextSearchOffset = 0;
        return documents.map((doc) => {
            const lines = this.estimateLines(doc.pageContent, code, nextSearchOffset);
            nextSearchOffset = lines.nextSearchOffset;
            return {
                content: doc.pageContent,
                metadata: {
                    startLine: lines.start,
                    endLine: lines.end,
                    language,
                    filePath,
                },
            };
        });
    }

    private estimateLines(chunk: string, originalCode: string, searchOffset: number): { start: number; end: number; nextSearchOffset: number } {
        const chunkLines = chunk.split('\n');
        const chunkStart = originalCode.indexOf(chunk, searchOffset);
        if (chunkStart === -1) {
            const fallbackStart = originalCode.indexOf(chunk);
            if (fallbackStart === -1) {
                return { start: 1, end: chunkLines.length, nextSearchOffset: searchOffset };
            }

            const fallbackBefore = originalCode.substring(0, fallbackStart);
            const fallbackLine = fallbackBefore.split('\n').length;
            return {
                start: fallbackLine,
                end: fallbackLine + chunkLines.length - 1,
                nextSearchOffset: fallbackStart + 1,
            };
        }

        const beforeChunk = originalCode.substring(0, chunkStart);
        const startLine = beforeChunk.split('\n').length;
        const endLine = startLine + chunkLines.length - 1;

        return {
            start: startLine,
            end: endLine,
            nextSearchOffset: chunkStart + 1,
        };
    }
} 
