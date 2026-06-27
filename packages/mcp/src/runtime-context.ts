import {
    Context,
    MilvusVectorDatabase,
} from "@hitmux/hitmux-context-engine-core";

import type { ContextMcpConfig } from "./config.js";
import {
    createEmbeddingInstance,
    logEmbeddingProviderInfo,
} from "./embedding.js";

export function createRuntimeContext(config: ContextMcpConfig): Context {
    const embedding = createEmbeddingInstance(config);
    logEmbeddingProviderInfo(config, embedding);

    const vectorDatabase = new MilvusVectorDatabase({
        address: config.milvusAddress,
        ...(config.milvusToken && { token: config.milvusToken }),
        useSystemProxy: config.databaseUseSystemProxy,
    });

    return new Context({
        embedding,
        vectorDatabase,
        collectionNameOverride: config.collectionNameOverride,
        collectionIdentity: {
            mode: config.codebaseIdentityMode,
            customIdentity: config.codebaseIdentity,
            globalName: config.globalCollectionName,
            gitRemoteName: config.gitRemoteName,
        },
    });
}
