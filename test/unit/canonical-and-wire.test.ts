import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, sameJson } from '../../src/shared/canonical.ts';
import {
    REQUEST_ID_PATTERN,
    isNotFoundFor,
    isTerminalFor,
    isValidRequestId,
    settledReplyFor,
} from '../../src/shared/wire.ts';

test('K01 object key order does not matter, at any depth', () => {
    assert.equal(
        canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'z' } }),
        canonicalJson({ a: { c: 'z', d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
    assert.ok(sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }));
});

test('K02 equality matches what JSON.stringify would send (both directions)', () => {
    const samples: unknown[] = [
        { a: undefined, b: 1 },
        [undefined, () => 1, Symbol('s')],
        { n: Number.NaN, i: Number.POSITIVE_INFINITY, z: -0 },
        new Date('2026-01-02T03:04:05.000Z'),
        { nested: { when: new Date(0) } },
        { toJSON: () => ({ replaced: true }) },
        [new Number(1), new String('s'), new Boolean(false)],
        'plain',
        42,
        null,
        true,
    ];
    for (const sample of samples) {
        const wire = JSON.parse(JSON.stringify(sample)) as unknown;
        assert.equal(canonicalJson(sample), canonicalJson(wire), `sample ${String(JSON.stringify(sample))}`);
        assert.deepEqual(JSON.parse(canonicalJson(sample) as string), wire);
    }
    // eslint-style sparse array: holes travel as null.
    // eslint-disable-next-line no-sparse-arrays
    assert.equal(canonicalJson([1, , 3]), '[1,null,3]');
    assert.equal(canonicalJson(undefined), undefined);
    assert.equal(canonicalJson(() => 1), undefined);
});

test('K03 different JSON values never compare equal', () => {
    assert.ok(!sameJson({ a: '1' }, { a: 1 }));
    assert.ok(!sameJson({ a: null }, {}));
    assert.ok(!sameJson([1, 2], [2, 1]));
    assert.ok(!sameJson({ a: [] }, { a: {} }));
    assert.ok(!sameJson({ 'a,b': 1 }, { a: 1, b: 1 }));
    assert.ok(!sameJson('{"a":1}', { a: 1 }));
});

test('K04 cycles and BigInt throw like JSON.stringify; shared references are fine', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalJson(cyclic), TypeError);
    assert.throws(() => canonicalJson({ big: 1n }), TypeError);
    const shared = { x: 1 };
    assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

test('W01 a reply settles only its own request id, with a well-formed shape', () => {
    const completed = { requestId: 'req-00000001', status: 'completed', result: { id: 'x' }, replayed: false };
    assert.deepEqual(settledReplyFor(completed, 'req-00000001'), completed);
    assert.equal(settledReplyFor(completed, 'req-00000002'), null);
    assert.equal(settledReplyFor({ ...completed, replayed: 'no' }, 'req-00000001'), null);
    const { result: _dropped, ...withoutResult } = completed;
    assert.equal(settledReplyFor(withoutResult, 'req-00000001'), null);
    assert.deepEqual(
        settledReplyFor({ requestId: 'req-00000001', status: 'completed', result: null, replayed: true }, 'req-00000001'),
        { requestId: 'req-00000001', status: 'completed', result: null, replayed: true },
    );
});

test('W02 only a rejected reply with terminal:true for the same id is terminal; error codes never are', () => {
    const rejected = { requestId: 'req-00000001', status: 'rejected', terminal: true, code: 'invalid-argument', message: 'no', replayed: false };
    assert.ok(isTerminalFor(rejected, 'req-00000001'));
    assert.ok(!isTerminalFor(rejected, 'req-00000002'));
    assert.ok(!isTerminalFor({ ...rejected, terminal: 'true' }, 'req-00000001'));
    assert.ok(!isTerminalFor({ requestId: 'req-00000001', status: 'error', terminal: false, code: 'permission-denied', message: '' }, 'req-00000001'));
    // A thrown error with a "definite-sounding" code is still not terminal.
    assert.ok(!isTerminalFor(Object.assign(new Error('denied'), { code: 'permission-denied' }), 'req-00000001'));
    assert.ok(!isTerminalFor({ requestId: 'req-00000001', status: 'not-found' }, 'req-00000001'));
    assert.ok(isNotFoundFor({ requestId: 'req-00000001', status: 'not-found' }, 'req-00000001'));
    assert.ok(!isNotFoundFor({ requestId: 'req-00000001', status: 'not-found' }, 'req-00000002'));
});

test('W03 request id format', () => {
    assert.ok(isValidRequestId('abcdEFGH'));
    assert.ok(isValidRequestId('a'.repeat(128)));
    assert.ok(isValidRequestId('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
    for (const bad of ['short', 'a'.repeat(129), 'has/slash', 'has space', 'dot.dot.', '', 12345678, null]) {
        assert.ok(!isValidRequestId(bad), String(bad));
    }
    assert.equal(REQUEST_ID_PATTERN.source, '^[A-Za-z0-9_-]{8,128}$');
});
