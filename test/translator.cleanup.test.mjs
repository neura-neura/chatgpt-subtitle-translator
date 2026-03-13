import test from 'node:test';
import assert from 'node:assert';

import { sanitizeTranslatedLine } from '../src/translator.mjs';

test('sanitizeTranslatedLine removes flagged echoed source wrappers', () => {
    assert.strictEqual(
        sanitizeTranslatedLine('[Flagged][Model] おはようございます。 -> 早上好。', 'おはようございます。'),
        '早上好。'
    )
})

test('sanitizeTranslatedLine removes echoed source without flag prefix', () => {
    assert.strictEqual(
        sanitizeTranslatedLine('おはようございます。 -> 早上好。', 'おはようございます。'),
        '早上好。'
    )
})

test('sanitizeTranslatedLine preserves clean translations', () => {
    assert.strictEqual(
        sanitizeTranslatedLine('早上好。', 'おはようございます。'),
        '早上好。'
    )
})

test('sanitizeTranslatedLine handles multiline echoed source', () => {
    assert.strictEqual(
        sanitizeTranslatedLine('第一行\n第二行 -> Line one\nLine two', '第一行\n第二行'),
        'Line one\nLine two'
    )
})
