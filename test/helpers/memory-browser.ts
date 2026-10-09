import type { CrossTabPort, LockManagerLike, StorageLike } from '../../src/client/index.ts';

type Listener = (key: string | null) => void;

/**
 * One browser profile: a single localStorage shared by any number of tabs.
 * Each `tab()` gets its own storage object (so per-tab state stays separate)
 * and a cross-tab port that hears writes made by the other tabs, asynchronously,
 * like the real `storage` event.
 */
export class MemoryBrowser {
    readonly data = new Map<string, string>();
    /** Return true to make a write (value) or removal (null) throw, like a full quota. */
    failWrite: ((key: string, value: string | null) => boolean) | null = null;
    failReads = false;
    readonly #listeners = new Map<object, Set<Listener>>();

    tab(): { storage: StorageLike; crossTab: CrossTabPort } {
        const browser = this;
        const self = {};
        const storage: StorageLike = {
            get length() {
                return browser.data.size;
            },
            key(index) {
                return [...browser.data.keys()][index] ?? null;
            },
            getItem(key) {
                if (browser.failReads) throw new Error('SecurityError (test double)');
                return browser.data.get(key) ?? null;
            },
            setItem(key, value) {
                if (browser.failWrite?.(key, value)) throw Object.assign(new Error('QuotaExceededError (test double)'), { name: 'QuotaExceededError' });
                browser.data.set(key, String(value));
                browser.#emit(self, key);
            },
            removeItem(key) {
                if (browser.failWrite?.(key, null)) throw Object.assign(new Error('QuotaExceededError (test double)'), { name: 'QuotaExceededError' });
                browser.data.delete(key);
                browser.#emit(self, key);
            },
        };
        const crossTab: CrossTabPort = {
            subscribe(listener) {
                let set = browser.#listeners.get(self);
                if (!set) {
                    set = new Set();
                    browser.#listeners.set(self, set);
                }
                set.add(listener);
                return () => set.delete(listener);
            },
        };
        return { storage, crossTab };
    }

    #emit(source: object, key: string): void {
        for (const [tab, listeners] of this.#listeners) {
            if (tab === source) continue; // The storage event never fires in the tab that wrote.
            for (const listener of listeners) queueMicrotask(() => listener(key));
        }
    }
}

/** An exclusive lock manager shared by tabs, recording which locks are held. */
export class FakeLocks implements LockManagerLike {
    readonly held = new Set<string>();
    requests = 0;
    readonly #tails = new Map<string, Promise<void>>();

    async request<T>(name: string, callback: (lock: unknown) => T | Promise<T>): Promise<T> {
        this.requests += 1;
        const previous = this.#tails.get(name) ?? Promise.resolve();
        let release = (): void => undefined;
        const done = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.#tails.set(name, previous.then(() => done));
        await previous;
        this.held.add(name);
        try {
            return await callback({ name });
        } finally {
            this.held.delete(name);
            release();
        }
    }
}

/** A promise you resolve or reject from the outside, to order events precisely. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Let queued microtasks (cross-tab notifications) run. */
export function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * One browser profile whose tabs read their own cached copy of localStorage,
 * like the per-process cache real browsers keep. A tab's writes go to the
 * shared store and to its own cache; another tab sees them only after
 * `deliver(tab)` (or immediately, for tabs created with `lagging: false`).
 * Single operations are atomic; read-modify-write sequences are not, and a
 * lagging tab can write values computed from an old view.
 */
export class LaggingBrowser {
    readonly data = new Map<string, string>();
    readonly #caches = new Map<object, Map<string, string>>();

    tab(options: { lagging?: boolean } = {}): { storage: StorageLike; id: object } {
        const browser = this;
        const id = {};
        const lagging = options.lagging ?? true;
        const cache = new Map(this.data);
        this.#caches.set(id, cache);
        const view = (): Map<string, string> => (lagging ? cache : browser.data);
        const storage: StorageLike = {
            get length() {
                return view().size;
            },
            key(index) {
                return [...view().keys()][index] ?? null;
            },
            getItem(key) {
                return view().get(key) ?? null;
            },
            setItem(key, value) {
                browser.data.set(key, String(value));
                cache.set(key, String(value));
            },
            removeItem(key) {
                browser.data.delete(key);
                cache.delete(key);
            },
        };
        return { storage, id };
    }

    /** The tab sees only the given keys' current values (visibility out of write order, as some storages allow). */
    deliverKeys(tab: { id: object }, keys: (key: string) => boolean): void {
        const cache = this.#caches.get(tab.id);
        if (!cache) return;
        for (const [key, value] of this.data) if (keys(key)) cache.set(key, value);
    }

    /** The tab catches up with everything written so far. */
    deliver(tab: { id: object }): void {
        const cache = this.#caches.get(tab.id);
        if (!cache) return;
        cache.clear();
        for (const [key, value] of this.data) cache.set(key, value);
    }
}
