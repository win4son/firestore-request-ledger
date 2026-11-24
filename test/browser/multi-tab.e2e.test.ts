import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Locator, Page } from 'playwright';
import { createBrowserE2EHarness, createDeferred, waitForAppReady } from '../helpers/browser.ts';
import type { BrowserE2EHarness } from '../helpers/browser.ts';

let harness: BrowserE2EHarness | undefined;

before(async () => {
    harness = await createBrowserE2EHarness();
});

after(async () => {
    await harness?.close();
});

/**
 * 填寫演示表單並點擊送出。
 */
async function fillAndSubmit(page: Page, amount: number, note = 'e2e-synthetic'): Promise<void> {
    const amountInput = page.locator('input[type="number"]');
    await amountInput.fill(String(amount));
    const noteInput = page.locator('input[type="text"]');
    if ((await noteInput.count()) > 0) {
        await noteInput.fill(note);
    }
    await page.getByRole('button', { name: 'Submit' }).click();
}

/**
 * 等待狀態訊息區（.status）包含指定正則文字。
 */
async function waitForStatusText(page: Page, pattern: RegExp): Promise<string> {
    const statusLocator = page.locator('.status');
    await statusLocator.filter({ hasText: pattern }).waitFor({ state: 'visible', timeout: 10_000 });
    return (await statusLocator.textContent()) ?? '';
}

/**
 * 讀取前端畫面上顯示的當前帳號餘額。
 */
async function getFrontendBalance(page: Page): Promise<number> {
    const strong = page.locator('strong.figure');
    await strong.waitFor({ state: 'visible', timeout: 5_000 });
    const text = (await strong.textContent()) ?? '';
    const num = Number(text.trim());
    return Number.isFinite(num) ? num : NaN;
}

/**
 * 根據完整的 requestId 定位 Remembered requests 列表中的特定紀錄元素。
 */
function entryByRequestId(page: Page, requestId: string): Locator {
    return page.locator('.entries li').filter({ has: page.locator(`code[title="${requestId}"]`) });
}

/**
 * 取得列表中第一筆紀錄的完整 requestId。
 */
async function getLatestEntryRequestId(page: Page): Promise<string> {
    const code = page.locator('.entries li code').first();
    await code.waitFor({ state: 'visible', timeout: 5_000 });
    const title = await code.getAttribute('title');
    return title ?? '';
}

test('B01 single-tab normal submit and acknowledge: commits once and clears acknowledged entry', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B01', async ({ pageA, getAccountState }) => {
        const beforeBackend = await getAccountState('demo-user-a');
        const beforeFrontend = await getFrontendBalance(pageA);
        assert.equal(beforeFrontend, beforeBackend.balance, 'Initial frontend balance matches backend');

        await fillAndSubmit(pageA, 10, 'b01-normal');
        await waitForStatusText(pageA, /completed/i);

        const requestId = await getLatestEntryRequestId(pageA);
        assert.ok(requestId.length >= 8, 'Valid requestId generated and displayed');

        const entry = entryByRequestId(pageA, requestId);
        await entry.locator('.badge.completed').waitFor({ state: 'visible', timeout: 5_000 });

        // 驗證前端餘額增加提交金額 10
        const afterFrontend = await getFrontendBalance(pageA);
        assert.equal(afterFrontend, beforeFrontend + 10, 'Frontend balance increases by 10 points');

        // 驗證後端 Firestore 帳本餘額與明細
        const afterBackend = await getAccountState('demo-user-a');
        assert.equal(afterBackend.balance, beforeBackend.balance + 10, 'Backend balance increases by 10');
        assert.equal(afterBackend.entries, beforeBackend.entries + 1, 'Backend entries increase by 1');

        // 點擊確認按鈕（App.tsx 內 completed 項目為 Got it）
        const ackButton = entry.getByRole('button', { name: 'Got it' });
        await ackButton.click();

        // 驗證項目從列表移除
        await entry.waitFor({ state: 'detached', timeout: 5_000 });
    });
});

test('B02 dropped response after server commit, reload, then same-id retry: replays without double execution', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B02', async ({ pageA, getAccountState }) => {
        const before = await getAccountState('demo-user-a');

        let droppedRequestId = '';
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            droppedRequestId = data?.requestId ?? '';
            await route.fetch();
            await route.abort('connectionreset');
        });

        await fillAndSubmit(pageA, 12, 'b02-drop');
        await waitForStatusText(pageA, /result unknown/i);

        assert.ok(droppedRequestId.length >= 8, 'Original requestId captured');
        const entryBeforeReload = entryByRequestId(pageA, droppedRequestId);
        await entryBeforeReload.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });

        // 驗證掉包前伺服器已成功提交
        const afterDropped = await getAccountState('demo-user-a');
        assert.equal(afterDropped.balance, before.balance + 12, 'Server must have committed before response was dropped');
        assert.equal(afterDropped.entries, before.entries + 1);

        await pageA.unroute('**/api/execute');

        // 重新整理頁面
        await pageA.reload({ waitUntil: 'networkidle' });

        // 驗證重整後原 requestId 未確認紀錄仍保留
        const entryAfterReload = entryByRequestId(pageA, droppedRequestId);
        await entryAfterReload.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });

        // 攔截重試請求，驗證發送的 requestId 與回傳的 replayed 結果
        let retryRequestId = '';
        let retryResponseBody: { status?: string; replayed?: boolean } | null = null;
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            retryRequestId = data?.requestId ?? '';
            const response = await route.fetch();
            retryResponseBody = (await response.json()) as { status?: string; replayed?: boolean };
            await route.fulfill({ response });
        });

        const retryButton = entryAfterReload.getByRole('button', { name: 'Retry with same id' });
        await retryButton.waitFor({ state: 'visible', timeout: 5_000 });
        await retryButton.click();

        await waitForStatusText(pageA, /replayed/i);

        const replyBody = retryResponseBody as { status?: string; replayed?: boolean } | null;
        assert.equal(retryRequestId, droppedRequestId, 'Retry must reuse the identical requestId');
        assert.equal(replyBody?.status, 'completed', 'Retry response status must be completed');
        assert.equal(replyBody?.replayed, true, 'Retry must be replayed from ledger');

        // 驗證後端入帳次數與金額嚴格維持一次
        const afterRetry = await getAccountState('demo-user-a');
        assert.equal(afterRetry.balance, before.balance + 12, 'Replay must not add balance twice');
        assert.equal(afterRetry.entries, before.entries + 1, 'Replay must not add entries twice');
    });
});

test('B03 cross-tab live visibility via native storage event and recovery from second tab', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B03', async ({ pageA, pageB, getAccountState }) => {
        const before = await getAccountState('demo-user-a');

        let originalRequestId = '';
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            originalRequestId = data?.requestId ?? '';
            await route.fetch();
            await route.abort('connectionreset');
        });

        await fillAndSubmit(pageA, 14, 'b03-crosstab');
        await waitForStatusText(pageA, /result unknown/i);
        await pageA.unroute('**/api/execute');

        assert.ok(originalRequestId.length >= 8, 'Original requestId captured');

        // 分頁 B 不重新整理，透過原生 window storage 事件即時渲染出該筆未確認請求
        const entryInB = entryByRequestId(pageB, originalRequestId);
        await entryInB.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 8_000 });

        // 由分頁 B 點擊 Check status 進行狀態查詢
        const checkButtonInB = entryInB.getByRole('button', { name: 'Check status' });
        await checkButtonInB.waitFor({ state: 'visible', timeout: 5_000 });
        await checkButtonInB.click();

        await waitForStatusText(pageB, /completed/i);
        await entryInB.locator('.badge.completed').waitFor({ state: 'visible', timeout: 5_000 });

        // 分頁 A 同樣不重整，收到分頁 B 寫入 storage 觸發的事件後，狀態同步轉為 completed
        const entryInA = entryByRequestId(pageA, originalRequestId);
        await entryInA.locator('.badge.completed').waitFor({ state: 'visible', timeout: 8_000 });

        const afterwards = await getAccountState('demo-user-a');
        assert.equal(afterwards.balance, before.balance + 14);
        assert.equal(afterwards.entries, before.entries + 1);
    });
});

test('B04 concurrent same-content submit across two tabs: native Web Locks serializes into one execution', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B04', async ({ context, pageA, pageB, getAccountState }) => {
        const before = await getAccountState('demo-user-a');
        let executeRequests = 0;
        const tabACommitted = createDeferred<void>();
        const releaseTabAResponse = createDeferred<void>();

        await context.route('**/api/execute', async (route) => {
            executeRequests += 1;
            const response = await route.fetch();
            tabACommitted.resolve();
            await releaseTabAResponse.promise;
            await route.fulfill({ response });
        });

        try {
            await pageA.locator('input[type="number"]').fill('15');
            await pageA.locator('input[type="text"]').fill('b04-concurrent-same');
            await pageB.locator('input[type="number"]').fill('15');
            await pageB.locator('input[type="text"]').fill('b04-concurrent-same');

            // 分頁 A 先送出，並等待後端已完成交易提交但尚未收到回應
            const submitA = pageA.getByRole('button', { name: 'Submit' }).click();
            await tabACommitted.promise;

            // 分頁 B 此時送出相同內容（透過 Web Locks 讀取相同 slot 與 requestId）
            const submitB = pageB.getByRole('button', { name: 'Submit' }).click();

            // 隨即放行分頁 A 回應，使其將 completed 寫入 storage
            releaseTabAResponse.resolve();

            await Promise.all([submitA, submitB]);

            // 兩分頁均順利完成
            await Promise.all([
                waitForStatusText(pageA, /completed/i),
                waitForStatusText(pageB, /completed/i),
            ]);

            const reqA = await getLatestEntryRequestId(pageA);
            const reqB = await getLatestEntryRequestId(pageB);
            assert.equal(reqA, reqB, 'Both tabs must share the exact same requestId');
            assert.equal(executeRequests, 1, 'Web Locks deduplication ensures only 1 HTTP request is sent');

            const afterwards = await getAccountState('demo-user-a');
            assert.equal(afterwards.balance, before.balance + 15, 'Backend commits exactly once');
            assert.equal(afterwards.entries, before.entries + 1);
        } finally {
            tabACommitted.resolve();
            releaseTabAResponse.resolve();
        }
    });
});

test('B05 concurrent different-content submit across two tabs: second tab is blocked with slot-busy', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B05', async ({ pageA, pageB, getAccountState }) => {
        const before = await getAccountState('demo-user-a');
        const requestStarted = createDeferred<void>();
        const allowFinish = createDeferred<void>();
        let pageBNetworkCalls = 0;

        await pageA.route('**/api/execute', async (route) => {
            requestStarted.resolve();
            await allowFinish.promise;
            await route.continue();
        });

        await pageB.route('**/api/execute', async (route) => {
            pageBNetworkCalls += 1;
            await route.continue();
        });

        try {
            const submitA = fillAndSubmit(pageA, 16, 'b05-tab-a');
            await requestStarted.promise;

            // 分頁 A 處於飛行中，分頁 B 嘗試在相同 slot 提交不同內容（金額 20）
            await fillAndSubmit(pageB, 20, 'b05-tab-b');
            await waitForStatusText(pageB, /slot-busy/i);
            assert.equal(pageBNetworkCalls, 0, 'Tab B must not send any network request while slot is busy');
        } finally {
            // 無論測試成敗，皆確保閘門放行，防止懸掛
            requestStarted.resolve();
            allowFinish.resolve();
        }

        await waitForStatusText(pageA, /completed/i);

        const afterwards = await getAccountState('demo-user-a');
        assert.equal(afterwards.balance, before.balance + 16, 'Firestore must only record Tab A amount');
        assert.equal(afterwards.entries, before.entries + 1);
    });
});

test('B06 late network failure in tab A does not revert settled outcome confirmed by tab B', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B06', async ({ pageA, pageB, getAccountState }) => {
        const before = await getAccountState('demo-user-a');
        const committedOnServer = createDeferred<void>();
        const releaseAbort = createDeferred<void>();

        let submittedRequestId = '';
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            submittedRequestId = data?.requestId ?? '';
            await route.fetch();
            committedOnServer.resolve();
            await releaseAbort.promise;
            await route.abort('timedout');
        });

        try {
            const submitA = fillAndSubmit(pageA, 25, 'b06-late-fail');
            await committedOnServer.promise;
            assert.ok(submittedRequestId.length >= 8);

            // 分頁 B 觀察到未確認紀錄，點擊 Check status 確認為 completed
            const entryInB = entryByRequestId(pageB, submittedRequestId);
            await entryInB.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });

            const checkButtonInB = entryInB.getByRole('button', { name: 'Check status' });
            await checkButtonInB.click();
            await waitForStatusText(pageB, /completed/i);
            await entryInB.locator('.badge.completed').waitFor({ state: 'visible', timeout: 5_000 });

            // 設置可觀測的前端處理完成訊號：
            // 1. 監聽 pageA 的 requestfailed 事件（網路層連線中斷）
            const requestFailedPromise = pageA.waitForEvent('requestfailed', {
                predicate: (req) => req.url().includes('/api/execute'),
            });

            // 放行分頁 A 的連線中斷（逾時錯誤）
            releaseAbort.resolve();
            await submitA;
            await requestFailedPromise;

            // 2. 等待分頁 A 完成遲到錯誤的狀態機處理，表單送出按鈕恢復為可用狀態且狀態區更新
            await pageA.locator('button[type="submit"]:not([disabled])').waitFor({ state: 'visible', timeout: 10_000 });
            await waitForStatusText(pageA, /completed/i);

            // 驗證分頁 A 的未確認紀錄不會因為連線逾時覆蓋已定案狀態，依然為 completed
            const entryInA = entryByRequestId(pageA, submittedRequestId);
            await entryInA.locator('.badge.completed').waitFor({ state: 'visible', timeout: 5_000 });
            assert.equal(await pageA.locator('.badge.unconfirmed').count(), 0);

            // 直接讀取 localStorage 驗證持久化紀錄未被降級
            const storageCheck = await pageA.evaluate((reqId) => {
                const keys = Object.keys(window.localStorage);
                const entryKey = `frl-demo/v1/entry/demo-user-a/${reqId}`;
                const doneKeys = keys.filter((k) => k.startsWith(`frl-demo/v1/done/demo-user-a/${reqId}`));
                const doneValues = doneKeys.map((k) => JSON.parse(window.localStorage.getItem(k) ?? '{}') as { state?: string });
                return {
                    hasEntry: window.localStorage.getItem(entryKey) !== null,
                    hasCompletedDone: doneValues.some((d) => d.state === 'completed'),
                };
            }, submittedRequestId);
            assert.ok(storageCheck.hasEntry, 'Entry must exist in localStorage');
            assert.ok(storageCheck.hasCompletedDone, 'LocalStorage done record must remain completed');

            const afterwards = await getAccountState('demo-user-a');
            assert.equal(afterwards.balance, before.balance + 25);
            assert.equal(afterwards.entries, before.entries + 1);
        } finally {
            committedOnServer.resolve();
            releaseAbort.resolve();
        }
    });
});

test('B07 cross-tab discard prevents resurrection when a late completed reply arrives', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B07', async ({ pageA, pageB, getAccountState }) => {
        const before = await getAccountState('demo-user-a');
        const committedOnServer = createDeferred<void>();
        const releaseLateReply = createDeferred<void>();

        let submittedReqId = '';
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            submittedReqId = data?.requestId ?? '';
            const response = await route.fetch();
            committedOnServer.resolve();
            await releaseLateReply.promise;
            await route.fulfill({ response });
        });

        try {
            const submitA = fillAndSubmit(pageA, 30, 'b07-discard-race');
            await committedOnServer.promise;
            assert.ok(submittedReqId.length >= 8);

            // 分頁 B 觀察到未確認紀錄，點擊 Discard 丟棄
            const entryInB = entryByRequestId(pageB, submittedReqId);
            await entryInB.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });

            pageB.once('dialog', (dialog) => dialog.accept());
            await entryInB.getByRole('button', { name: 'Discard' }).click();
            await entryInB.waitFor({ state: 'detached', timeout: 5_000 });

            // 先確認分頁 A 已透過 storage 事件觀察到該 requestId 從列表移除
            const entryInA = entryByRequestId(pageA, submittedReqId);
            await entryInA.waitFor({ state: 'detached', timeout: 5_000 });

            // 設置可觀測的前端處理完成訊號：
            // 1. 監聽 pageA 收到 response 事件
            const responsePromise = pageA.waitForEvent('response', {
                predicate: (res) => res.url().includes('/api/execute'),
            });

            // 再放行分頁 A 遲到的 completed 回應
            releaseLateReply.resolve();
            await submitA;
            await responsePromise;

            // 2. 等待分頁 A 完成遲到回應的前端處理（busy 解除，按鈕回到可用狀態）
            await pageA.locator('button[type="submit"]:not([disabled])').waitFor({ state: 'visible', timeout: 10_000 });
            await waitForStatusText(pageA, /completed/i);

            // 驗證分頁 A 完成回應處理後紀錄未復活
            assert.equal(await entryByRequestId(pageA, submittedReqId).count(), 0);

            // 重新整理兩分頁，驗證紀錄依然保持已移除狀態
            await pageA.reload({ waitUntil: 'networkidle' });
            await pageB.reload({ waitUntil: 'networkidle' });
            await waitForAppReady(pageA);
            await waitForAppReady(pageB);

            assert.equal(await entryByRequestId(pageA, submittedReqId).count(), 0);
            assert.equal(await entryByRequestId(pageB, submittedReqId).count(), 0);

            // 後端交易已提交的餘額維持不變（客戶端丟棄不影響後端已提交資料）
            const afterwards = await getAccountState('demo-user-a');
            assert.equal(afterwards.balance, before.balance + 30);
            assert.equal(afterwards.entries, before.entries + 1);
        } finally {
            committedOnServer.resolve();
            releaseLateReply.resolve();
        }
    });
});

test('B08 abrupt tab close while holding Web Lock releases lock cleanly for remaining tabs', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B08', async ({ context, pageA, pageB, baseUrl, getAccountState }) => {
        const before = await getAccountState('demo-user-a');
        const realLockName = 'firestore-request-ledger:frl-demo:demo-user-a';

        // 驗證 1：原生 Web Lock 釋放（分頁 A 持鎖排隊，關閉分頁 A 後分頁 B 成功取得鎖）
        const pageAHeldLock = createDeferred<void>();
        const serverCommitted = createDeferred<void>();
        const pageBGotLock = createDeferred<void>();

        try {
            await pageA.exposeFunction('notifyPageAHeldLock', () => {
                pageAHeldLock.resolve();
            });

            // 捕捉因關閉分頁產生的 evaluate 拒絕，避免未處理 rejection
            let pageAEvalError: unknown = null;
            const pageALockTask = pageA.evaluate(async (lockName) => {
                await navigator.locks.request(lockName, async () => {
                    await (window as unknown as { notifyPageAHeldLock: () => Promise<void> }).notifyPageAHeldLock();
                    await new Promise(() => {
                        // 持續持有鎖直到分頁關閉
                    });
                });
            }, realLockName).catch((err: unknown) => {
                pageAEvalError = err;
            });

            await pageAHeldLock.promise;

            // 分頁 B 嘗試請求同名鎖（排隊等待）
            await pageB.exposeFunction('notifyPageBGotLock', () => {
                pageBGotLock.resolve();
            });

            const pageBLockTask = pageB.evaluate(async (lockName) => {
                await navigator.locks.request(lockName, async () => {
                    await (window as unknown as { notifyPageBGotLock: () => Promise<void> }).notifyPageBGotLock();
                });
            }, realLockName);

            // 強制關閉分頁 A
            await pageA.close({ runBeforeUnload: false });
            await pageALockTask;

            // 驗證分頁 B 成功取得鎖（不死鎖）
            await pageBGotLock.promise;
            await pageBLockTask;
            if (pageAEvalError) {
                const msg = String(pageAEvalError);
                assert.ok(msg.includes('Target closed') || msg.includes('destroyed') || msg.includes('closed'));
            }

            // 驗證 2：分頁透過真實 UI 提交中斷關閉後，另一分頁能依持久化狀態完成合法復原
            const pageA2 = await context.newPage();
            await pageA2.goto(baseUrl, { waitUntil: 'networkidle' });
            await waitForAppReady(pageA2);

            let interruptedReqId = '';
            await pageA2.route('**/api/execute', async (route) => {
                const data = route.request().postDataJSON() as { requestId?: string } | null;
                interruptedReqId = data?.requestId ?? '';
                await route.fetch();
                serverCommitted.resolve();
                // 不回傳回應，模擬在提交完成但未收回應時分頁立即崩潰
            });

            void fillAndSubmit(pageA2, 35, 'b08-ui-crash').catch(() => {});
            await serverCommitted.promise;
            assert.ok(interruptedReqId.length >= 8);

            // 關閉 pageA2
            await pageA2.close({ runBeforeUnload: false });

            // 分頁 B 依據持久化 localStorage 狀態即時渲染出該筆未確認請求
            const entryInB = entryByRequestId(pageB, interruptedReqId);
            await entryInB.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });

            // 由分頁 B 點擊 Retry with same id 完成重試復原
            const retryButtonInB = entryInB.getByRole('button', { name: 'Retry with same id' });
            await retryButtonInB.click();
            await waitForStatusText(pageB, /replayed/i);
            await entryInB.locator('.badge.completed').waitFor({ state: 'visible', timeout: 5_000 });

            const afterwards = await getAccountState('demo-user-a');
            assert.equal(afterwards.balance, before.balance + 35, 'Committed exactly once');
            assert.equal(afterwards.entries, before.entries + 1);
        } finally {
            pageAHeldLock.resolve();
            pageBGotLock.resolve();
            serverCommitted.resolve();
        }
    });
});

test('B09 actor isolation across tabs: switching user in tab B is unaffected by pending slot in tab A', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B09', async ({ pageA, pageB, getAccountState }) => {
        const beforeA = await getAccountState('demo-user-a');
        const beforeB = await getAccountState('demo-user-b');

        let droppedReqA = '';
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            droppedReqA = data?.requestId ?? '';
            await route.fetch();
            await route.abort('connectionreset');
        });

        await fillAndSubmit(pageA, 40, 'b09-user-a');
        await waitForStatusText(pageA, /result unknown/i);
        await pageA.unroute('**/api/execute');

        assert.ok(droppedReqA.length >= 8);

        // 分頁 B 切換為 demo-user-b
        await pageB.getByLabel(/Synthetic user/i).selectOption('demo-user-b');

        // 分頁 B 列表為空，不受 demo-user-a 未確認請求干擾
        await pageB.locator('.muted:has-text("Nothing remembered for this user")').waitFor({ state: 'visible', timeout: 5_000 });
        assert.equal(await entryByRequestId(pageB, droppedReqA).count(), 0, 'Page B must not see user A requests');

        // 分頁 B 在 demo-user-b 身分下順利提交金額 45（不受 slot-busy 阻擋）
        await fillAndSubmit(pageB, 45, 'b09-user-b');
        await waitForStatusText(pageB, /completed/i);

        const frontendBalanceB = await getFrontendBalance(pageB);
        assert.equal(frontendBalanceB, beforeB.balance + 45);

        // 驗證後端 Firestore 兩使用者資料完全隔離且各自入帳
        const afterA = await getAccountState('demo-user-a');
        const afterB = await getAccountState('demo-user-b');
        assert.equal(afterA.balance, beforeA.balance + 40, 'User A balance updated');
        assert.equal(afterA.entries, beforeA.entries + 1);
        assert.equal(afterB.balance, beforeB.balance + 45, 'User B balance updated');
        assert.equal(afterB.entries, beforeB.entries + 1);

        // 驗證 localStorage 鍵名按 actor 隔離
        const storageKeys = await pageB.evaluate(() => Object.keys(window.localStorage));
        const userAEntryKey = `frl-demo/v1/entry/demo-user-a/${droppedReqA}`;
        assert.ok(storageKeys.includes(userAEntryKey), 'User A entry key exists in localStorage');
        const userBKeys = storageKeys.filter((k) => k.includes('/demo-user-b/'));
        assert.ok(userBKeys.length > 0, 'User B keys exist in localStorage');

        // 切換分頁 B 回 demo-user-a，驗證原未確認紀錄仍可見
        await pageB.getByLabel(/Synthetic user/i).selectOption('demo-user-a');
        const restoredEntryInB = entryByRequestId(pageB, droppedReqA);
        await restoredEntryInB.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });
    });
});

test('B10 corrupt localStorage slot records block new sends until resetSlot recovers the slot', { timeout: 30_000 }, async () => {
    await harness!.withMultiTabSession('B10', async ({ pageA, pageB, getAccountState }) => {
        const before = await getAccountState('demo-user-a');

        let droppedReqId = '';
        await pageA.route('**/api/execute', async (route) => {
            const data = route.request().postDataJSON() as { requestId?: string } | null;
            droppedReqId = data?.requestId ?? '';
            await route.fetch();
            await route.abort('connectionreset');
        });

        await fillAndSubmit(pageA, 50, 'b10-corrupt-slot');
        await waitForStatusText(pageA, /result unknown/i);
        await pageA.unroute('**/api/execute');
        assert.ok(droppedReqId.length >= 8);

        // 故意破壞雙份 localStorage slot 與 slotcopy 紀錄
        await pageA.evaluate(() => {
            window.localStorage.setItem('frl-demo/v1/slot/demo-user-a/add-points', '{corrupt-json');
            window.localStorage.setItem('frl-demo/v1/slotcopy/demo-user-a/add-points', '{corrupt-json');
        });

        // 驗證槽位損壞時，分頁 B 嘗試送出會遭遇 broken-slot 阻擋，發出 0 次網路請求
        let sentWhileBroken = 0;
        await pageB.route('**/api/execute', async (route) => {
            sentWhileBroken += 1;
            await route.continue();
        });

        await fillAndSubmit(pageB, 50, 'b10-corrupt-slot');
        await waitForStatusText(pageB, /broken-slot/i);
        assert.equal(sentWhileBroken, 0, 'broken slot must block network requests');
        await pageB.unroute('**/api/execute');

        // 透過變數路徑動態載入打包後的 client API 呼叫 resetSlot()
        const recoveredIds = await pageB.evaluate(async (slotName) => {
            const clientModuleUrl = '/dist/client/index.js';
            const mod = await import(clientModuleUrl);
            const tracker = mod.createRequestTracker({ actor: 'demo-user-a', namespace: 'frl-demo' });
            return tracker.resetSlot(slotName);
        }, 'add-points');

        assert.ok(Array.isArray(recoveredIds), 'resetSlot returns array of IDs');
        assert.ok(recoveredIds.includes(droppedReqId), 'Recovered IDs must include the original requestId');

        // 重新整理分頁 B
        await pageB.reload({ waitUntil: 'networkidle' });
        await waitForAppReady(pageB);

        // 驗證未確認紀錄依然存在且為同一個 requestId
        const entryAfterReset = entryByRequestId(pageB, droppedReqId);
        await entryAfterReset.locator('.badge.unconfirmed').waitFor({ state: 'visible', timeout: 5_000 });

        // 攔截重試請求，驗證回傳 replayed: true
        let retryReplayed = false;
        await pageB.route('**/api/execute', async (route) => {
            const response = await route.fetch();
            const body = (await response.json()) as { replayed?: boolean };
            retryReplayed = Boolean(body?.replayed);
            await route.fulfill({ response });
        });

        const retryBtn = entryAfterReset.getByRole('button', { name: 'Retry with same id' });
        await retryBtn.click();
        await waitForStatusText(pageB, /replayed/i);
        assert.equal(retryReplayed, true, 'Retry must return replayed: true');

        // 後端入帳嚴格維持一次
        const afterwards = await getAccountState('demo-user-a');
        assert.equal(afterwards.balance, before.balance + 50, 'Server must execute only once after slot recovery');
        assert.equal(afterwards.entries, before.entries + 1);
    });
});
