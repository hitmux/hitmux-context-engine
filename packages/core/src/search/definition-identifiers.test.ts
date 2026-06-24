import { extractDefinitionIdentifiers } from './definition-identifiers';

describe('extractDefinitionIdentifiers', () => {
    it('extracts definition symbols from C, CMake, TOML, Rust, and Go content', () => {
        const content = [
            'static void lrangeCommand(client *c) {',
            '    replyToClient(c);',
            '}',
            '#define CMD_ARG(name) name',
            'struct serverCommandTable { int argc; };',
            '{ .handler = lrangeCommand },',
            'MAKE_CMD("xread", "Reads streams", xreadCommand, -4)',
            'function(register_valkey_sources)',
            'endfunction()',
            'macro(add_tls_module)',
            'endmacro()',
            '[dependency-groups]',
            '[tool.ruff.lint]',
            'pub(crate) enum SearchMode { Exact }',
            'pub trait SearchProvider {}',
            'pub mod planner;',
            'func init() {}',
        ].join('\n');

        expect(extractDefinitionIdentifiers(content)).toEqual(expect.arrayContaining([
            'lrangeCommand',
            'CMD_ARG',
            'serverCommandTable',
            'xreadCommand',
            'register_valkey_sources',
            'add_tls_module',
            'dependency-groups',
            'tool.ruff.lint',
            'lint',
            'SearchMode',
            'SearchProvider',
            'planner',
            'init',
        ]));
    });

    it('does not treat comments, string literals, or generic calls as definitions', () => {
        const content = [
            '// export function CommentedOut() {}',
            '# def python_comment():',
            'const text = "function StringOnly() {}";',
            'logger.info("struct NotAType { int value; }");',
            'foo bar GenericCall(',
            'if (condition) {',
            '    runTask();',
            '}',
        ].join('\n');

        expect(extractDefinitionIdentifiers(content)).not.toEqual(expect.arrayContaining([
            'CommentedOut',
            'python_comment',
            'StringOnly',
            'NotAType',
            'GenericCall',
            'condition',
            'runTask',
        ]));
    });

    it('keeps Go startup files from triggering cross-line regex backtracking', () => {
        const flagLines = Array.from({ length: 120 }, (_, index) =>
            `\tflag.StringVar(&option${index}, "option-${index}", "", "option ${index}")`
        );
        const content = [
            'package main',
            '',
            'import (',
            '\t"context"',
            '\t"flag"',
            '\t"fmt"',
            '\t"os"',
            ')',
            '',
            'func init() {',
            '\tsetupLogger()',
            '}',
            '',
            'func shouldStartServer(commandMode, tuiMode, standalone bool) bool {',
            '\tif commandMode || (tuiMode && !standalone) {',
            '\t\treturn false',
            '\t}',
            '\treturn true',
            '}',
            '',
            'func main() {',
            '\tvar commandMode bool',
            '\tvar tuiMode bool',
            '\tvar standalone bool',
            ...flagLines,
            '\tif shouldStartServer(commandMode, tuiMode, standalone) {',
            '\t\tfmt.Println(os.Args)',
            '\t}',
            '}',
        ].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content);

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining([
            'init',
            'shouldStartServer',
            'main',
        ]));
    });

    it('bounds scanning time for long non-definition lines', () => {
        const longGenericCall = `${'VeryLongType '.repeat(4000)}notAFunctionCallWithoutTerminator`;
        const content = [
            longGenericCall,
            'func stillFound() {}',
        ].join('\n');

        const startedAt = Date.now();
        const identifiers = extractDefinitionIdentifiers(content);

        expect(Date.now() - startedAt).toBeLessThan(100);
        expect(identifiers).toEqual(expect.arrayContaining(['stillFound']));
    });
});
