import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Firestore } from '@google-cloud/firestore';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { createDemoApp } from '../../example/server.ts';
import { emulatorFirestore, uniqueName } from './emulator.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EXAMPLE_DIST_DIR = resolve(REPO_ROOT, 'example/dist');
const LIB_DIST_DIR = resolve(REPO_ROOT, 'dist');
const TRACE_OUT_DIR = resolve(REPO_ROOT, 'test-results/traces');

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.map': 'application/json; charset=utf-8',
};

export interface Deferred<T = void> {
    readonly promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
}

/**
 * 建立外部可控的承諾閘門（Deferred Gate），用於精確排程測試競態，嚴禁使用隨機延遲。
 */
export function createDeferred<T = void>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function serveStaticFile(baseDir: string, relativePath: string, response: ServerResponse): boolean {
    let decodedPath: string;
    try {
        decodedPath = decodeURIComponent(relativePath);
    } catch {
        response.writeHead(400);
        response.end('Bad Request');
        return true;
    }

    const safePath = normalize(decodedPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const fullPath = resolve(baseDir, safePath);
    const rel = relative(baseDir, fullPath);

    if (rel.startsWith('..') || isAbsolute(rel)) {
        response.writeHead(403);
        response.end('Forbidden');
        return true;
    }

    if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        return false;
    }

    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
    response.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-store',
    });

    const stream = createReadStream(fullPath);
    stream.on('error', () => {
        if (!response.headersSent) {
            response.writeHead(500);
            response.end('Internal Server Error');
        }
    });
    stream.pipe(response);
    return true;
}

export async function waitForAppReady(page: Page): Promise<void> {
    await page.locator('form').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('button[type="submit"]').waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('strong.figure').waitFor({ state: 'visible', timeout: 10_000 });
}

export interface MultiTabSession {
    readonly context: BrowserContext;
    readonly pageA: Page;
    readonly pageB: Page;
    readonly baseUrl: string;
    readonly db: Firestore;
    readonly prefix: string;
    getAccountState: (actor?: string) => Promise<{ balance: number; entries: number }>;
}

export interface BrowserE2EHarness {
    readonly db: Firestore;
    withMultiTabSession: (label: string, run: (session: MultiTabSession) => Promise<void>) => Promise<void>;
    close: () => Promise<void>;
}

/**
 * 啟動本機 Firestore 模擬器連線與無頭 Chromium 瀏覽器。
 * 每個測試案例在 withMultiTabSession 內部享有完全隔離的 Firestore 集合與同源伺服器。
 */
export async function createBrowserE2EHarness(): Promise<BrowserE2EHarness> {
    if (!existsSync(resolve(EXAMPLE_DIST_DIR, 'index.html'))) {
        throw new Error('Missing example/dist/index.html. Run `npm run build:example` before browser tests.');
    }
    if (!existsSync(resolve(LIB_DIST_DIR, 'client/index.js'))) {
        throw new Error('Missing dist/client/index.js. Run `npm run build:lib` before browser tests.');
    }

    const db = emulatorFirestore();
    let browser: Browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (launchError) {
        await db.terminate().catch(() => {});
        throw launchError;
    }

    const withMultiTabSession = async (
        label: string,
        run: (session: MultiTabSession) => Promise<void>,
    ): Promise<void> => {
        // 案例層級隔離：獨立 Firestore prefix 與測試帳號
        const prefix = uniqueName('e2e');
        const app = createDemoApp(db, { prefix });
        await app.ensureAccounts();

        // 案例層級獨立同源伺服器，監聽 127.0.0.1:0
        const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');

            if (url.pathname.startsWith('/api/')) {
                app.handler(request, response);
                return;
            }

            if (url.pathname.startsWith('/dist/')) {
                const subPath = url.pathname.slice('/dist/'.length);
                if (serveStaticFile(LIB_DIST_DIR, subPath, response)) return;
                response.writeHead(404);
                response.end('Not found');
                return;
            }

            const requestedAsset = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            const ext = extname(requestedAsset).toLowerCase();
            const isAsset = Boolean(ext) && ext !== '.html';

            if (serveStaticFile(EXAMPLE_DIST_DIR, requestedAsset, response)) return;

            // 靜態資產若未找到直接 404，不回退 index.html
            if (isAsset) {
                response.writeHead(404);
                response.end('Not found');
                return;
            }

            // SPA 導覽路由回退至 index.html
            if (serveStaticFile(EXAMPLE_DIST_DIR, 'index.html', response)) return;

            response.writeHead(404);
            response.end('Not found');
        });

        await new Promise<void>((resolveListen, rejectListen) => {
            server.once('error', rejectListen);
            server.listen(0, '127.0.0.1', () => resolveListen());
        });

        const address = server.address() as AddressInfo;
        const baseUrl = `http://127.0.0.1:${address.port}`;

        const getAccountState = async (actor = 'demo-user-a'): Promise<{ balance: number; entries: number }> => {
            const accountRef = db.collection(`${prefix}Accounts`).doc(actor);
            const snapshot = await accountRef.get();
            const entriesSnapshot = await accountRef.collection('entries').count().get();
            return {
                balance: Number(snapshot.data()?.balance ?? 0),
                entries: entriesSnapshot.data().count,
            };
        };

        let context: BrowserContext | undefined;
        let testError: unknown = null;
        let contextClosed = false;

        try {
            context = await browser.newContext();
            await context.tracing.start({ screenshots: true, snapshots: true });

            const pageA = await context.newPage();
            const pageB = await context.newPage();

            await Promise.all([
                pageA.goto(baseUrl, { waitUntil: 'networkidle' }),
                pageB.goto(baseUrl, { waitUntil: 'networkidle' }),
            ]);

            // 等待 React 元件與 RequestTracker 初始化完成
            await Promise.all([
                waitForAppReady(pageA),
                waitForAppReady(pageB),
            ]);

            await run({ context, pageA, pageB, baseUrl, db, prefix, getAccountState });
        } catch (error) {
            testError = error;
            if (context) {
                try {
                    mkdirSync(TRACE_OUT_DIR, { recursive: true });
                    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_');
                    const uniqueSuffix = randomUUID().replace(/-/g, '').slice(0, 8);
                    await context.tracing.stop({ path: resolve(TRACE_OUT_DIR, `${safeLabel}-${uniqueSuffix}.zip`) });
                } catch (traceError) {
                    // Trace 匯出失敗不得掩蓋原始測試錯誤
                    console.error('Failed to export trace:', traceError);
                }
            }
        } finally {
            if (!testError && !contextClosed && context) {
                try {
                    await context.tracing.stop();
                } catch {
                    // ignore
                }
            }
            if (!contextClosed && context) {
                try {
                    await context.close();
                } catch {
                    // ignore
                }
                contextClosed = true;
            }

            server.closeAllConnections();
            await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

            if (testError) {
                throw testError;
            }
        }
    };

    const close = async (): Promise<void> => {
        try {
            await browser.close();
        } finally {
            await db.terminate();
        }
    };

    return { db, withMultiTabSession, close };
}
