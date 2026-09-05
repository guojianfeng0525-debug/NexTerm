import { expect } from '@wdio/globals';
import { unlockApp, waitForVisible } from './helpers/webkit';

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

async function expectElementText(element: WebdriverIO.Element, text: string): Promise<void> {
  expect(await element.getText()).toContain(text);
}

/**
 * Port-topology drill-down acceptance.
 *
 * wdio.conf.ts seeds the real SQLite store before the app process starts. Every
 * interaction below is local navigation and must not call either probe command.
 */
describe('Network port topology drill-down', () => {
  const password = `E2E_PORT_TOPOLOGY_${Date.now()}`;

  before(async () => {
    await browser.tauri.switchWindow('main');
    await unlockApp(password);
    await waitForVisible('[data-testid="toolbox-nav-topology"]');

    // Rows are seeded by wdio.conf.ts before the app process starts.

    await browser.execute(() => {
      const internals = (window as unknown as {
        __TAURI_INTERNALS__: { invoke: TauriInvoke };
      }).__TAURI_INTERNALS__;
      const original = internals.invoke.bind(internals);
      const tracked = (window as unknown as { __e2eNetworkCommands?: string[] });
      tracked.__e2eNetworkCommands = [];
      internals.invoke = async (command, args) => {
        if (command === 'probe_network_topology' || command === 'probe_tcp_ports') {
          tracked.__e2eNetworkCommands?.push(command);
        }
        return original(command, args);
      };
    });
  });

  it('drills from a server node to a port-centric inbound/outbound view without probing', async () => {
    const topologyButton = await waitForVisible('[data-testid="toolbox-nav-topology"]');
    await topologyButton.click();
    await waitForVisible('[data-node-id="e2e-node-a"]');

    const serverNode = await waitForVisible('[data-node-id="e2e-node-a"]');
    await browser.execute(
      (node: SVGGElement) => {
        const rect = node.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        };
        const svg = node.ownerSVGElement;
        node.dispatchEvent(new PointerEvent('pointerdown', init));
        svg?.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
      },
      serverNode,
    );
    const portButton = await waitForVisible('[data-testid="server-port-e2e-port-a"]');
    await expectElementText(portButton, '8080');
    await portButton.click();

    const portView = await waitForVisible('[data-testid="port-topology-view"]');
    await expectElementText(portView, '10.10.1.20:8080');
    await expectElementText(portView, 'gateway-a');
    await expectElementText(portView, 'web entry');
    await expectElementText(portView, 'app-a');
    await expectElementText(portView, '101');
    await expectElementText(portView, 'api-b');

    const peerButton = await waitForVisible('[data-testid="open-peer-port-e2e-node-b-e2e-port-b"]');
    await peerButton.click();
    await waitForVisible('[data-testid="port-topology-view"]');
    const inboundView = await $('[data-testid="port-topology-view"]');
    await expectElementText(inboundView, '10.10.1.21:8080');
    await expectElementText(inboundView, 'gateway-b');

    const inboundFilter = await waitForVisible('[data-testid="port-direction-inbound"]');
    await inboundFilter.click();
    await expectElementText(inboundView, '203.0.113.9');
    await expectElementText(inboundView, 'web-a');

    // Manual relation CRUD supplements connections that probes cannot infer.
    const addButton = await waitForVisible('[data-testid="port-link-add"]');
    await addButton.click();
    await waitForVisible('[data-testid="port-link-editor"]');
    await (await $('[data-testid="port-link-peer-port"]')).setValue('8080');
    await (await $('[data-testid="port-link-save"]')).click();
    await $('[data-testid="port-link-editor"]').waitForExist({ reverse: true });
    await (await $('[data-testid="port-direction-outbound"]')).click();
    const editButtons = await $$('button[data-testid^="port-link-edit-"]');
    expect(editButtons.length).toBe(1);
    await editButtons[0].click();
    await (await $('[data-testid="port-link-label"]')).setValue('reverse manual link');
    await (await $('[data-testid="port-link-save"]')).click();
    await $('[data-testid="port-link-editor"]').waitForExist({ reverse: true });
    await expectElementText(await $('[data-testid="port-topology-view"]'), 'reverse manual link');

    await (await $$('button[data-testid^="port-link-edit-"]'))[0].click();
    await (await $('[data-testid="port-link-request-delete"]')).click();
    await (await $('[data-testid="port-link-confirm-delete"]')).click();
    await $('[data-testid="port-link-editor"]').waitForExist({ reverse: true });
    const manualRows = await browser.execute(async () => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: TauriInvoke } })
        .__TAURI_INTERNALS__.invoke;
      const rows = await invoke('row_list', { table: 'net_port_links' }) as Array<{ manual_label?: string }>;
      return rows.filter((row) => row.manual_label === 'reverse manual link');
    });
    expect(manualRows).toHaveLength(0);

    const commands = await browser.execute(
      () => (window as unknown as { __e2eNetworkCommands?: string[] }).__e2eNetworkCommands ?? [],
    );
    expect(commands).toEqual([]);

    await browser.saveScreenshot('./test-results/wdio/network-port-topology.png');
  });
});
