#!/usr/bin/env python3
"""
Legacy Hitmux Context Engine core-only end-to-end smoke.
Uses TypeScriptExecutor to call the direct core API path.
"""

import os
import sys
from pathlib import Path

# Add python directory to path
sys.path.append(str(Path(__file__).parent))

from ts_executor import TypeScriptExecutor

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent


def run_context_endtoend_test():
    """Run the legacy direct-core end-to-end smoke."""

    # Configuration parameters
    config = {
        "openaiApiKey": os.environ.get("OPENAI_API_KEY", "your-openai-api-key"),
        "milvusAddress": os.environ.get("MILVUS_ADDRESS", "localhost:19530"),
        "codebasePath": str(
            REPO_ROOT / "packages" / "core" / "src"
        ),  # Index core source code
        "searchQuery": "embedding creation and vector database configuration",
    }

    print("🚀 Starting legacy Hitmux Context Engine core-only end-to-end smoke")
    print(f"📊 Configuration:")
    print(f"   - Codebase path: {config['codebasePath']}")
    print(f"   - Vector database: {config['milvusAddress']}")
    print(f"   - Search query: {config['searchQuery']}")
    print(
        f"   - OpenAI API: {'✅ Configured' if config['openaiApiKey'] != 'your-openai-api-key' else '❌ Need to set OPENAI_API_KEY environment variable'}"
    )
    print()

    try:
        executor = TypeScriptExecutor(working_dir=str(REPO_ROOT))

        # Call end-to-end test
        result = executor.call_method(
            str(SCRIPT_DIR / "test_context.ts"), "testContextEndToEnd", config
        )

        # Output results
        if result.get("success"):
            print("✅ End-to-end test successful!")
            print(f"📅 Timestamp: {result.get('timestamp')}")

            # Display configuration info
            config_info = result.get("config", {})
            print(f"🔧 Configuration:")
            print(f"   - Embedding provider: {config_info.get('embeddingProvider')}")
            print(f"   - Embedding model: {config_info.get('embeddingModel')}")
            print(f"   - Embedding dimension: {config_info.get('dimension')}")
            print(f"   - Vector database: {config_info.get('vectorDatabase')}")
            print(f"   - Chunk size: {config_info.get('chunkSize')}")
            print(f"   - Chunk overlap: {config_info.get('chunkOverlap')}")

            # Display indexing statistics
            index_stats = result.get("indexStats", {})
            print(f"📚 Indexing statistics:")
            print(f"   - Indexed files: {index_stats.get('indexedFiles', 0)}")
            print(f"   - Total chunks: {index_stats.get('totalChunks', 0)}")

            # Display search results
            summary = result.get("summary", {})
            search_results = result.get("searchResults", [])
            print(f"🔍 Search results:")
            print(f"   - Query: '{result.get('searchQuery')}'")
            print(f"   - Results found: {summary.get('foundResults', 0)} items")
            print(f"   - Average relevance: {summary.get('avgScore', 0):.3f}")

            # Display top 3 search results
            if search_results:
                print(f"📋 Top {min(3, len(search_results))} most relevant results:")
                for i, item in enumerate(search_results[:3]):
                    print(
                        f"   {i+1}. {item['relativePath']} (lines {item['startLine']}-{item['endLine']})"
                    )
                    print(
                        f"      Language: {item['language']}, Relevance: {item['score']:.3f}"
                    )
                    print(f"      Preview: {item['contentPreview'][:100]}...")
                    print()

            return True

        else:
            print("❌ End-to-end test failed")
            print(f"Error: {result.get('error')}")
            if result.get("stack"):
                print(f"Stack trace: {result.get('stack')}")
            return False

    except Exception as e:
        print(f"❌ Execution failed: {e}")
        return False


def main():
    """Main function"""
    print("=" * 60)
    print("🧪 Hitmux Context Engine Legacy Core-Only End-to-End Smoke")
    print("=" * 60)
    print()

    success = run_context_endtoend_test()

    print()
    print("=" * 60)
    if success:
        print("🎉 Test completed! Hitmux Context Engine end-to-end workflow runs successfully!")
        print()
        print("💡 This proves:")
        print("   ✅ Can call TypeScript Hitmux Context Engine from Python")
        print("   ✅ Supports complete indexing and search workflow")
        print("   ✅ Supports complex configuration and parameter passing")
        print("   ✅ Can get detailed execution results and statistics")
    else:
        print("❌ Test failed. Please check:")
        print("   - OPENAI_API_KEY environment variable is correctly set")
        print("   - Milvus vector database is running properly")
        print("   - packages/core code is accessible")
    print("=" * 60)
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
