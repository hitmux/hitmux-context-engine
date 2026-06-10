import { isUnsupportedSparseVectorError, milvusHybridCompatibilityError } from './milvus-compatibility';

describe('Milvus compatibility diagnostics', () => {
    it('detects unsupported SparseFloatVector schema errors from Milvus', () => {
        const error = {
            code: 65535,
            message: 'Error validating collection creation',
            status: {
                error_code: 'UnexpectedError',
                reason: 'field data type: 104 is not supported',
            },
        };

        expect(isUnsupportedSparseVectorError(error)).toBe(true);
    });

    it('returns an actionable hybrid search compatibility message', () => {
        const error = new Error('field data type: 104 is not supported');
        const message = milvusHybridCompatibilityError('Milvus createHybridCollection', error).message;

        expect(message).toContain('Milvus 2.4 or later');
        expect(message).toContain('"hybridMode": false');
        expect(message).toContain('SparseFloatVector');
    });
});
