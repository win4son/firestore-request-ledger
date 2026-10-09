/**
 * Deterministic JSON text with object keys sorted.
 *
 * Two values produce the same text exactly when `JSON.stringify` would send them
 * as the same JSON value, ignoring the order of object keys. It deliberately
 * mirrors `JSON.stringify` instead of inventing stricter rules, because the
 * comparison has to match what actually travels over the wire:
 *
 * - object properties whose value is `undefined`, a function or a symbol are omitted;
 * - the same values inside arrays (and array holes) become `null`;
 * - non-finite numbers become `null`, and `-0` becomes `0`;
 * - `toJSON()` is honoured, so a `Date` becomes its ISO string;
 * - `Number`, `String` and `Boolean` wrapper objects are unwrapped.
 *
 * Returns `undefined` when `JSON.stringify` would (a top-level `undefined`,
 * function or symbol). Throws `TypeError` for cycles and `BigInt`, as
 * `JSON.stringify` does. Values parsed from JSON never throw.
 */
export function canonicalJson(value: unknown): string | undefined {
    const ancestors = new Set<object>();

    const walk = (holderKey: string, input: unknown): string | undefined => {
        let current: unknown = input;
        if ((typeof current === 'object' && current !== null) || typeof current === 'bigint') {
            const toJSON = (current as { toJSON?: unknown }).toJSON;
            if (typeof toJSON === 'function') current = toJSON.call(current, holderKey);
        }
        if (current instanceof Number) current = Number(current);
        else if (current instanceof String) current = String(current);
        else if (current instanceof Boolean) current = current.valueOf();

        if (current === null) return 'null';
        switch (typeof current) {
            case 'boolean':
                return current ? 'true' : 'false';
            case 'number':
                return Number.isFinite(current) ? JSON.stringify(current) : 'null';
            case 'string':
                return JSON.stringify(current);
            case 'bigint':
                throw new TypeError('Do not know how to serialize a BigInt');
            case 'undefined':
            case 'function':
            case 'symbol':
                return undefined;
            default:
                break;
        }

        const node = current as object;
        if (ancestors.has(node)) throw new TypeError('Converting circular structure to JSON');
        ancestors.add(node);
        try {
            if (Array.isArray(node)) {
                const items: string[] = [];
                for (let index = 0; index < node.length; index += 1) {
                    items.push(walk(String(index), node[index]) ?? 'null');
                }
                return `[${items.join(',')}]`;
            }
            const record = node as Record<string, unknown>;
            const members: string[] = [];
            for (const key of Object.keys(record).sort()) {
                const encoded = walk(key, record[key]);
                if (encoded !== undefined) members.push(`${JSON.stringify(key)}:${encoded}`);
            }
            return `{${members.join(',')}}`;
        } finally {
            ancestors.delete(node);
        }
    };

    return walk('', value);
}

/** True when both values would be sent as the same JSON value (object key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
    return canonicalJson(a) === canonicalJson(b);
}
