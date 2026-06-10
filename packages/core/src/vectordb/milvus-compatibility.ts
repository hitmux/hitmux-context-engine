import { formatErrorDetails } from '../utils/error-format';

export function isUnsupportedSparseVectorError(error: unknown): boolean {
    const message = formatErrorDetails(error);
    return /field data type:\s*104 is not supported/i.test(message) ||
        /SparseFloatVector.*not supported/i.test(message) ||
        /unsupported.*SparseFloatVector/i.test(message);
}

export function milvusHybridCompatibilityError(operation: string, error: unknown): Error {
    const details = formatErrorDetails(error);
    return new Error(
        `${operation} failed: the connected Milvus server does not support Hitmux Context Engine hybrid search schema fields ` +
        `(SparseFloatVector/BM25). Use Milvus 2.4 or later, upgrade Zilliz Cloud/Milvus Lite to a compatible version, ` +
        `or set "hybridMode": false in ~/.hitmux-context-engine/config.jsonc to use dense vector search. Original error: ${details}`
    );
}
