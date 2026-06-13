import { LangChainCodeSplitter } from './langchain-splitter';

describe('LangChainCodeSplitter fallback line estimation', () => {
    it('locates repeated generic chunks after the previous match', () => {
        const splitter = new LangChainCodeSplitter() as unknown as {
            estimateLines(chunk: string, originalCode: string, searchOffset: number): {
                start: number;
                end: number;
                nextSearchOffset: number;
            };
        };
        const code = [
            'repeat();',
            'middle();',
            'repeat();',
            'done();',
        ].join('\n');

        const first = splitter.estimateLines('repeat();', code, 0);
        const second = splitter.estimateLines('repeat();', code, first.nextSearchOffset);

        expect(first).toMatchObject({ start: 1, end: 1 });
        expect(second).toMatchObject({ start: 3, end: 3 });
    });
});
