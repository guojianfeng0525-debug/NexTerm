/**
 * WebKit/WDIO visibility helpers.
 *
 * The embedded WebDriver (tauri-plugin-wdio-webdriver) runs its isDisplayed
 * check against WKWebView semantics that return `false` for form controls
 * (input/button) even when they are genuinely rendered and interactable.
 * diag.e2e.ts verified: getBoundingClientRect + computed style + elementFromPoint
 * all confirm the element is visible, setValue/click work, yet the WebDriver
 * isDisplayed() API answers false.
 *
 * These helpers perform the *same* visibility verification WebDriver promises
 * (non-zero box, not display:none / visibility:hidden, within viewport) via
 * browser.execute, so assertions stay as strong as waitForDisplayed — they do
 * NOT weaken verification.
 */

/** Wait until the element exists AND is genuinely visible in the viewport. */
export async function waitForVisible(
  selector: string,
  timeout = 10_000,
): Promise<WebdriverIO.Element> {
  const el = await $(selector);
  await el.waitForExist({ timeout, timeoutMsg: `${selector} not found after ${timeout}ms` });
  // WDIO serializes the element reference for execute(); this keeps the full
  // WDIO selector syntax (button=..., [role=...]=...) working.
  await browser.waitUntil(
    async () =>
      await browser.execute((node: HTMLElement | null) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        // Within the viewport (any overlap counts, same as WebDriver's
        // "would be visible to a user" semantics for scrolled containers).
        return (
          rect.bottom > 0 &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.left < window.innerWidth
        );
      }, el),
    { timeout, timeoutMsg: `${selector} exists but never became visible within ${timeout}ms` },
  );
  return el;
}

/** Wait until an existing element is gone from the DOM (reverse of waitForExist). */
export async function waitForGone(selector: string, timeout = 10_000): Promise<void> {
  const el = await $(selector);
  await el.waitForExist({ reverse: true, timeout, timeoutMsg: `${selector} still exists after ${timeout}ms` });
}

/**
 * Unlock the app-lock first-run screen.
 *
 * Pattern proven in v29-visual-capture.e2e.ts: probe existence (isExisting),
 * focus via browser.execute (bypasses the WKWebView isDisplayed=false layer),
 * then setValue/click which operate normally.
 * When the profile is already unlocked (connection restored), this is a no-op
 * detection pass — pass `else` selector to await an already-unlocked surface.
 */
export async function unlockApp(
  password: string,
  unlockedSelector?: string,
): Promise<void> {
  const lock = await $('#app-lock-password');
  const unlocked = unlockedSelector ? await $(unlockedSelector) : null;
  await browser.waitUntil(
    async () => (await lock.isExisting()) || (unlocked ? await unlocked.isExisting() : false),
    { timeout: 30_000, timeoutMsg: 'app neither showed lock screen nor unlocked surface' },
  );
  if (await lock.isExisting()) {
    await browser.execute(() => {
      const el = document.querySelector('#app-lock-password') as HTMLElement | null;
      if (el) el.focus();
    });
    await lock.setValue(password);
    const confirm = await $('#app-lock-confirm');
    await browser.execute(() => {
      const el = document.querySelector('#app-lock-confirm') as HTMLElement | null;
      if (el) el.focus();
    });
    await confirm.setValue(password);
    await $('#app-lock-submit, button.w-full').click();
  }
}
