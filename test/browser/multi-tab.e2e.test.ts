import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Locator, Page } from 'playwright';
import { createBrowserE2EHarness, createDeferred } from '../helpers/browser.ts';
import type { BrowserE2EHarness } from '../helpers/browser.ts';

let harness: BrowserE2EHarness;

before(async () => {
    harness = await createBrowserE2EHarness();
});

after(async () => {
    await harness.close();
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

test('B01 single-tab normal submit and acknowledge: commits once and clears acknowledged entry', async () => {
    await harness.withMultiTabSession('B01', async ({ pageA, getAccountState }) => {
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

test('B02 dropped response after server commit, reload, then same-id retry: replays without double execution', async () => {
    await harness.withMultiTabSession('B02', async ({ pageA, getAccountState }) => {
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

test('B03 cross-tab live visibility via native storage event and recovery from second tab', async () => {
    await harness.withMultiTabSession('B03', async ({ pageA, pageB, getAccountState }) => {
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

test('B04 concurrent same-content submit across two tabs: native Web Locks serializes into one execution', async () => {
    await harness.withMultiTabSession('B04', async ({ context, pageA, pageB, getAccountState }) => {
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
    });
});

test('B05 concurrent different-content submit across two tabs: second tab is blocked with slot-busy', async () => {
    await harness.withMultiTabSession('B05', async ({ pageA, pageB, getAccountState }) => {
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
            allowFinish.resolve();
        }

        await waitForStatusText(pageA, /completed/i);

        const afterwards = await getAccountState('demo-user-a');
        assert.equal(afterwards.balance, before.balance + 16, 'Firestore must only record Tab A amount');
        assert.equal(afterwards.entries, before.entries + 1);
    });
});

test('B09 actor isolation across tabs: switching user in tab B is unaffected by pending slot in tab A', async () => {
    await harness.withMultiTabSession('B09', async ({ pageA, pageB, getAccountState }) => {
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
