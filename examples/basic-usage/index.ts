import { Context, MilvusVectorDatabase, MilvusRestfulVectorDatabase, AstCodeSplitter, LangChainCodeSplitter } from '@hitmux/hitmux-context-engine-core';
import { configManager } from '@hitmux/hitmux-context-engine-core';
import * as path from 'path';

async function main() {
    console.log('🚀 Context Real Usage Example');
    console.log('===============================');

    try {
        // 1. Choose Vector Database implementation
        const useRestfulApi = configManager.getBoolean('milvusUseRestful') ?? false;
        const milvusAddress = configManager.getString('milvusAddress') || 'localhost:19530';
        const milvusToken = configManager.getString('milvusToken');
        const splitterType = configManager.getString('splitterType')?.toLowerCase() || 'ast';
        const topK = configManager.getNumber('searchTopK') || 5;
        const threshold = configManager.getNumber('searchThreshold') || 0;

        console.log(`🔧 Using ${useRestfulApi ? 'RESTful API' : 'gRPC'} implementation`);
        console.log(`🔌 Connecting to Milvus at: ${milvusAddress}`);

        let vectorDatabase;
        if (useRestfulApi) {
            // Use RESTful implementation (for environments without gRPC support)
            vectorDatabase = new MilvusRestfulVectorDatabase({
                address: milvusAddress,
                ...(milvusToken && { token: milvusToken })
            });
        } else {
            // Use gRPC implementation (default, more efficient)
            vectorDatabase = new MilvusVectorDatabase({
                address: milvusAddress,
                ...(milvusToken && { token: milvusToken })
            });
        }

        // 2. Create Context instance
        let codeSplitter;
        if (splitterType === 'langchain') {
            codeSplitter = new LangChainCodeSplitter(1000, 200);
        } else {
            codeSplitter = new AstCodeSplitter(2500, 300);
        }
        const context = new Context({
            vectorDatabase,
            codeSplitter,
            supportedExtensions: ['.ts', '.js', '.py', '.java', '.cpp', '.go', '.rs']
        });

        // 3. Check if index already exists and clear if needed
        console.log('\n📖 Starting to index codebase...');
        const codebasePath = path.join(__dirname, '../..'); // Index entire project

        // Check if index already exists
        const hasExistingIndex = await context.hasIndex(codebasePath);
        if (hasExistingIndex) {
            console.log('🗑️  Existing index found, clearing it first...');
            await context.clearIndex(codebasePath);
        }

        // Index with progress tracking
        const indexStats = await context.indexCodebase(codebasePath);

        // 4. Show indexing statistics
        console.log(`\n📊 Indexing stats: ${indexStats.indexedFiles} files, ${indexStats.totalChunks} code chunks`);

        // 5. Perform semantic search
        console.log('\n🔍 Performing semantic search...');

        const queries = [
            'Milvus vector database create collection and search',
            'AST code splitter chunk size overlap',
            'OpenAI embedding batch generation',
            'TypeScript VectorDatabase interface'
        ];

        for (const query of queries) {
            console.log(`\n🔎 Search: "${query}"`);
            const results = await context.semanticSearch(codebasePath, query, topK, threshold);

            if (results.length > 0) {
                results.forEach((result, index) => {
                    console.log(`   ${index + 1}. Score: ${result.score.toFixed(4)}`);
                    console.log(`      File: ${path.join(codebasePath, result.relativePath)}`);
                    console.log(`      Language: ${result.language}`);
                    console.log(`      Lines: ${result.startLine}-${result.endLine}`);
                    console.log(`      Preview: ${result.content.substring(0, 100)}...`);
                });
            } else {
                console.log(`   No relevant results found. Try SEARCH_THRESHOLD=0, a larger SEARCH_TOP_K, or verify the embedding model matches the indexed collection dimension.`);
            }
        }

        console.log('\n🎉 Example completed successfully!');

    } catch (error) {
        console.error('❌ Error occurred:', error);

        // Provide detailed error diagnostics
        if (error instanceof Error) {
            if (error.message.includes('API key')) {
                console.log('\n💡 Please set openrouterApiKey in ~/.hitmux-context-engine/config.jsonc');
            } else if (error.message.includes('Milvus') || error.message.includes('connect')) {
                console.log('\n💡 Please make sure Milvus service is running');
                console.log('   - Default address: localhost:19530');
                console.log('   - Can be modified via milvusAddress in ~/.hitmux-context-engine/config.jsonc');
                console.log('   - For RESTful API: set milvusUseRestful=true');
                console.log('   - For gRPC (default): set milvusUseRestful=false or leave unset');
                console.log('   - Start Milvus: docker run -p 19530:19530 milvusdb/milvus:latest');
            }

            console.log('\n💡 Config file: ~/.hitmux-context-engine/config.jsonc');
            console.log('   - openrouterApiKey: Your OpenRouter API key (required by default)');
            console.log('   - openaiApiKey: OpenAI-compatible API key fallback (optional)');
            console.log('   - openaiBaseUrl: Custom OpenAI-compatible API endpoint (default: https://openrouter.ai/api/v1)');
            console.log('   - embeddingModel: Embedding model (default: qwen/qwen3-embedding-4b)');
            console.log('   - milvusAddress: Milvus server address (default: localhost:19530)');
            console.log('   - milvusToken: Milvus authentication token (optional)');
            console.log('   - milvusUseRestful: Use Milvus REST API (default: false)');
            console.log('   - splitterType: Code splitter type - "ast" or "langchain" (default: ast)');
            console.log('   - searchTopK: Number of search results per query (default: 5)');
            console.log('   - searchThreshold: Minimum score threshold (default: 0)');
        }

        process.exit(1);
    }
}

// Run main program
if (require.main === module) {
    main().catch(console.error);
}

export { main };
