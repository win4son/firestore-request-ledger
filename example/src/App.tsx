import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
// In your own app: import from 'firestore-request-ledger/client'.
import { NotSentError, createRequestTracker } from '../../src/client/index.ts';
import type { RequestTracker, SubmitOutcome, TrackedRequest } from '../../src/client/index.ts';
import { NO_FAULTS, createDemoApi } from './api.ts';
import type { Faults } from './api.ts';

const ACTORS = ['demo-user-a', 'demo-user-b'];
const SLOT = 'add-points';

export function App() {
    const [actor, setActor] = useState(ACTORS[0] as string);
    return (
        <main>
            <header>
                <h1>Request ledger demo</h1>
                <p className="muted">Synthetic data only. Every request goes to a local Firestore emulator.</p>
                <label className="inline">
                    Synthetic user{' '}
                    <select value={actor} onChange={(event) => setActor(event.target.value)}>
                        {ACTORS.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </select>
                </label>
            </header>
            {/* Keyed by user: switching users unmounts everything, so nothing from the previous user is sent or shown. */}
            <Workspace key={actor} actor={actor} />
        </main>
    );
}

function useTrackedRequests(tracker: RequestTracker): { entries: TrackedRequest[]; durable: boolean } {
    const [state, setState] = useState(() => ({ entries: tracker.list(), durable: tracker.durable() }));
    useEffect(() => {
        const refresh = (): void => setState({ entries: tracker.list(), durable: tracker.durable() });
        refresh();
        return tracker.subscribe(refresh);
    }, [tracker]);
    return state;
}

function describe(outcome: SubmitOutcome): string {
    if (outcome.status === 'completed') {
        const result = outcome.result as { balance?: number } | null;
        const replay = outcome.replayed ? ' The stored result was replayed; nothing ran twice.' : '';
        return `completed, balance ${result?.balance ?? '?'}.${replay}`;
    }
    if (outcome.status === 'rejected') return `rejected (${outcome.code}): ${outcome.message}. Nothing was written.`;
    const why = outcome.error ? ` (${outcome.error.code}: ${outcome.error.message})` : '';
    return `result unknown${why}. The request is kept: check its status or retry it with the same request id.`;
}

function Workspace({ actor }: { actor: string }) {
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);

    const tracker = useMemo(() => createRequestTracker({ actor, namespace: 'frl-demo' }), [actor]);
    const nextFaults = useRef<Faults>(NO_FAULTS);
    const [faults, setFaults] = useState<Faults>(NO_FAULTS);
    const api = useMemo(
        () => createDemoApi({
            actor,
            takeFaults: () => {
                const taken = nextFaults.current;
                nextFaults.current = NO_FAULTS;
                if (mounted.current) setFaults(NO_FAULTS);
                return taken;
            },
        }),
        [actor],
    );
    const { entries, durable } = useTrackedRequests(tracker);
    const [amount, setAmount] = useState('25');
    const [note, setNote] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [account, setAccount] = useState<{ balance: number; entries: number } | null>(null);

    const refreshAccount = useCallback(async () => {
        try {
            const next = await api.account();
            if (mounted.current) setAccount(next);
        } catch {
            if (mounted.current) setAccount(null);
        }
    }, [api]);
    useEffect(() => {
        void refreshAccount();
    }, [refreshAccount]);

    const setFault = (patch: Partial<Faults>): void => {
        const next = { ...nextFaults.current, ...patch };
        nextFaults.current = next;
        setFaults(next);
    };

    const run = async (label: string, task: () => Promise<SubmitOutcome>): Promise<void> => {
        setBusy(true);
        try {
            const outcome = await task();
            if (mounted.current) setMessage(`${label}: ${describe(outcome)}`);
        } catch (error) {
            const text = error instanceof NotSentError ? `not sent (${error.reason}). ${error.message}.` : String(error);
            if (mounted.current) setMessage(`${label}: ${text}`);
        } finally {
            if (mounted.current) setBusy(false);
            void refreshAccount();
        }
    };

    const onSubmit = (event: FormEvent): void => {
        event.preventDefault();
        void run('Submit', () => tracker.submit({
            slot: SLOT,
            operation: 'addPoints',
            input: { amount: Number(amount), note },
            send: api.send,
            stillValid: () => mounted.current,
        }));
    };

    const onDiscard = (entry: TrackedRequest): void => {
        const confirmed = entry.state !== 'unconfirmed' || window.confirm(
            'Discarding only forgets this request in this browser. It does not cancel anything on the server: '
            + 'if it already ran, sending the same thing again would run it again. Check its status first. Discard anyway?',
        );
        if (confirmed) tracker.discard(entry.requestId);
    };

    return (
        <>
            <section className="card">
                <h2>Balance</h2>
                <p>
                    {account ? (
                        <>
                            <strong className="figure">{account.balance}</strong> points from {account.entries} committed{' '}
                            {account.entries === 1 ? 'entry' : 'entries'}
                        </>
                    ) : (
                        'Not loaded.'
                    )}{' '}
                    <button type="button" className="secondary" onClick={() => void refreshAccount()}>
                        Refresh
                    </button>
                </p>
            </section>

            <section className="card">
                <h2>Add points</h2>
                <form onSubmit={onSubmit}>
                    <div className="row">
                        <label>
                            Amount
                            <input type="number" min={1} max={500} step={1} value={amount} onChange={(event) => setAmount(event.target.value)} />
                        </label>
                        <label className="grow">
                            Note
                            <input type="text" maxLength={120} value={note} onChange={(event) => setNote(event.target.value)} />
                        </label>
                    </div>
                    <fieldset>
                        <legend>Fault injection (applies to the next request only)</legend>
                        <label className="inline">
                            <input type="checkbox" checked={faults.dropResponse} onChange={(event) => setFault({ dropResponse: event.target.checked })} />{' '}
                            Lose the response after the server commits
                        </label>
                        <label className="inline">
                            <input type="checkbox" checked={faults.deny} onChange={(event) => setFault({ deny: event.target.checked })} />{' '}
                            Refuse the request before it reaches the ledger
                        </label>
                    </fieldset>
                    <button type="submit" disabled={busy}>
                        Submit
                    </button>
                </form>
                {!durable && (
                    <p className="warning">Some changes are only held in this tab's memory. Resolve pending requests before reloading.</p>
                )}
                <p role="status" className="status">
                    {message}
                </p>
            </section>

            <section className="card">
                <h2>Remembered requests</h2>
                {entries.length === 0 ? (
                    <p className="muted">Nothing remembered for this user.</p>
                ) : (
                    <ul className="entries">
                        {entries.map((entry) => (
                            <li key={entry.requestId}>
                                <div className="entry-head">
                                    <span className={`badge ${entry.state}`}>{entry.state}</span>
                                    <code title={entry.requestId}>{entry.requestId.slice(0, 8)}</code>
                                    <span>
                                        {entry.operation} {JSON.stringify(entry.input)}
                                    </span>
                                </div>
                                <div className="muted small">
                                    attempts {entry.attempts}
                                    {entry.lastError && entry.state === 'unconfirmed' ? ` · last: ${entry.lastError.code}` : ''}
                                </div>
                                <div className="actions">
                                    {entry.state === 'unconfirmed' ? (
                                        <>
                                            <button type="button" disabled={busy} onClick={() => void run('Check', () => tracker.check(entry.requestId, { lookup: api.lookup }))}>
                                                Check status
                                            </button>
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void run('Retry', () => tracker.retry(entry.requestId, { send: api.send, stillValid: () => mounted.current }))}
                                            >
                                                Retry with same id
                                            </button>
                                            <button type="button" className="secondary" onClick={() => onDiscard(entry)}>
                                                Discard
                                            </button>
                                        </>
                                    ) : (
                                        <button type="button" className="secondary" onClick={() => tracker.acknowledge(entry.requestId)}>
                                            Got it
                                        </button>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            <section className="card muted">
                <h2>Try it</h2>
                <ol>
                    <li>Submit once: the balance goes up.</li>
                    <li>Tick “Lose the response” and submit: the page says the result is unknown, yet Refresh shows the balance already changed.</li>
                    <li>Press “Check status” or “Retry with same id”: the stored result comes back as a replay and the balance does not change again.</li>
                    <li>Open this page in a second tab: unconfirmed requests show up there too, and either tab can resolve them.</li>
                    <li>Lose another response, then tick “Refuse the request” and retry: the refusal leaves the request unconfirmed instead of calling it failed.</li>
                </ol>
            </section>
        </>
    );
}
