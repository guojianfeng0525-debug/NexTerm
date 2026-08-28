import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE_ERROR:', String(e).slice(0,200)));
page.on('console', (m) => { if (m.type()==='error') console.log('CONSOLE:', m.text().slice(0,200)); });
await page.addInitScript(() => {
  window.__copied = [];
  window.__calls = [];
  Object.assign(window, {
    __TAURI_INTERNALS__: {
      transformCallback: () => 1,
      invoke: (command, args) => {
        window.__calls.push({ command, args });
        if (command.includes('clipboard-manager') || command.includes('write_text')) {
          window.__copied.push(String((args && args.data) ?? ''));
          return Promise.resolve();
        }
        return Promise.resolve(undefined);
      },
    },
  });
});
await page.goto('http://127.0.0.1:1420/');
// 直接模拟插件调用路径
const res = await page.evaluate(async () => {
  await window.__TAURI_INTERNALS__.invoke('plugin:clipboard-manager|write_text', { data: 'LINE 1: SELEC * FROM users\n        ^' });
  return { copied: window.__copied, calls: window.__calls };
});
console.log('RESULT:', JSON.stringify(res));
await browser.close();
