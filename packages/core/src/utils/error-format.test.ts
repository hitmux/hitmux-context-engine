import { formatErrorDetails } from './error-format';

describe('formatErrorDetails', () => {
    it('serializes object errors with status and reason details', () => {
        const message = formatErrorDetails({
            code: 65535,
            message: 'Error validating collection creation',
            status: {
                error_code: 'UnexpectedError',
                reason: 'field data type: 104 is not supported',
            },
        });

        expect(message).toContain('Error validating collection creation');
        expect(message).toContain('field data type: 104 is not supported');
        expect(message).not.toBe('[object Object]');
    });
});
