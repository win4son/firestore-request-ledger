// Browser-side transport for the demo API. Also used by the example smoke test in Node.
// In your own app: import types from 'firestore-request-ledger/client'.
import type { OutgoingRequest } from '../../src/client/index.ts';

export interface Faults {
    /** The server runs and commits the request, then drops the connection before replying. */
    readonly dropResponse: boolean;
    /** The request is refused before it reaches the ledger (like an expired session). */
    readonly deny: boolean;
}

export const NO_FAULTS: Faults = { dropResponse: false, deny: false };

export interface DemoApi {
    send(request: OutgoingRequest): Promise<unknown>;
    lookup(request: OutgoingRequest): Promise<unknown>;
    account(): Promise<{ balance: number; entries: number }>;
}

export function createDemoApi(options: { actor: string; baseUrl?: string; takeFaults?: () => Faults }): DemoApi {
    const base = options.baseUrl ?? '';
    const headers = (faults: Faults): Record<string, string> => {
        const result: Record<string, string> = { 'content-type': 'application/json', 'x-demo-actor': options.actor };
        if (faults.deny) result['x-demo-fault'] = 'deny';
        else if (faults.dropResponse) result['x-demo-fault'] = 'drop-response';
        return result;
    };
    const post = async (path: string, request: OutgoingRequest): Promise<unknown> => {
        const faults = options.takeFaults?.() ?? NO_FAULTS;
        // Any network failure rejects; any body that arrives is returned as-is and judged by the tracker.
        const response = await fetch(`${base}${path}`, { method: 'POST', headers: headers(faults), body: JSON.stringify(request) });
        return response.json();
    };
    return {
        send: (request) => post('/api/execute', request),
        lookup: (request) => post('/api/lookup', request),
        async account() {
            const response = await fetch(`${base}/api/account`, { headers: { 'x-demo-actor': options.actor } });
            if (!response.ok) throw new Error(`account request failed with HTTP ${response.status}`);
            return (await response.json()) as { balance: number; entries: number };
        },
    };
}
