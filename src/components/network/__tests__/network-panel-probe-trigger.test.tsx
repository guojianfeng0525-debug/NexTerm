/**
 * Regression guard for the module's hardest constraint: **a probe may only
 * ever run from an explicit user click**.
 *
 * The panel is mounted in the right sidebar and re-renders whenever the user
 * switches servers, the workspace rehydrates, or the topology store changes.
 * Every one of those paths is a plausible place for someone to later add an
 * "just refresh it automatically" effect — which would silently begin probing
 * customer servers without consent. These tests fail loudly if that happens.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NetworkPanel } from '@/components/network/network-panel';
import {
  makeFirewall,
  makeInterface,
  makeNode,
  makePort,
  makeRoute,
  makeRule,
  probeResult,
} from '@/lib/network/__tests__/fixtures';

/* ── mocks ──────────────────────────────────────────────────────────────── */

const api = vi.hoisted(() => ({
  probeServerTopology: vi.fn(),
  probeTcpPorts: vi.fn(),
  applyProbeResult: vi.fn(),
}));

const store = vi.hoisted(() => ({
  getNodeByConnectionId: vi.fn(),
  getNode: vi.fn(),
  getNodeInterfaces: vi.fn(),
  getNodeRoutes: vi.fn(),
  getNodeFirewall: vi.fn(),
  getNodeFirewallRules: vi.fn(),
  getNodePorts: vi.fn(),
  getPortProbes: vi.fn(),
  listPortLinks: vi.fn(),
  subscribeTopology: vi.fn(),
  appendPortProbe: vi.fn(),
  patchPortReachability: vi.fn(),
  patchPortManual: vi.fn(),
  patchInterfaceManual: vi.fn(),
  patchRouteManual: vi.fn(),
  patchFirewallRuleManual: vi.fn(),
  upsertNode: vi.fn(),
}));

vi.mock('@/lib/network/topology-api', () => ({
  probeServerTopology: api.probeServerTopology,
  probeTcpPorts: api.probeTcpPorts,
  applyProbeResult: api.applyProbeResult,
}));

vi.mock('@/lib/network/topology-storage', () => store);

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

/** Rendered button label comes from the real locale file (tests run in `en`). */
const PROBE_BUTTON = 'Probe this server';

function renderPanel(props: Partial<React.ComponentProps<typeof NetworkPanel>> = {}) {
  return render(
    <NetworkPanel
      connectionId="session-1"
      connectionName="web-01"
      host="10.0.0.5"
      assetConnectionId="conn-1"
      {...props}
    />,
  );
}

/** A node that has already been probed once, with data in every section. */
function seedProbedNode() {
  const node = makeNode({ id: 'node-1', connectionId: 'conn-1', lastProbeAt: 1_700_000_000_000 });
  store.getNodeByConnectionId.mockReturnValue(node);
  store.getNodeInterfaces.mockReturnValue([makeInterface({ nodeId: 'node-1' })]);
  store.getNodeRoutes.mockReturnValue([makeRoute({ nodeId: 'node-1' })]);
  store.getNodeFirewall.mockReturnValue(makeFirewall({ nodeId: 'node-1' }));
  store.getNodeFirewallRules.mockReturnValue([makeRule({ nodeId: 'node-1' })]);
  store.getNodePorts.mockReturnValue([makePort({ nodeId: 'node-1' })]);
  store.getPortProbes.mockReturnValue([]);
  return node;
}

/* ── tests ──────────────────────────────────────────────────────────────── */

describe('NetworkPanel — probe is strictly user-triggered', () => {
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    unsubscribe = vi.fn();
    store.subscribeTopology.mockReturnValue(unsubscribe);
    store.getNodeByConnectionId.mockReturnValue(undefined);
    store.getNode.mockReturnValue(undefined);
    store.getNodeInterfaces.mockReturnValue([]);
    store.getNodeRoutes.mockReturnValue([]);
    store.getNodeFirewall.mockReturnValue(null);
    store.getNodeFirewallRules.mockReturnValue([]);
    store.getNodePorts.mockReturnValue([]);
    store.getPortProbes.mockReturnValue([]);
    store.listPortLinks.mockReturnValue([]);
    api.probeServerTopology.mockResolvedValue(probeResult());
    api.applyProbeResult.mockReturnValue({
      nodeId: 'node-1',
      added: { interfaces: 0, routes: 0, rules: 0, ports: 0 },
      updated: { interfaces: 0, routes: 0, rules: 0, ports: 0 },
      missing: { interfaces: 0, routes: 0, rules: 0, ports: 0 },
      linksAdded: 0,
      linksConfirmed: 0,
    });
  });

  afterEach(cleanup);

  it('does not probe on mount when the server has never been probed', () => {
    renderPanel();
    expect(api.probeServerTopology).not.toHaveBeenCalled();
  });

  it('does not probe on mount even when stored data already exists', () => {
    seedProbedNode();
    renderPanel();
    expect(api.probeServerTopology).not.toHaveBeenCalled();
  });

  it('does not probe when the user switches to another server', () => {
    seedProbedNode();
    const { rerender } = renderPanel({ connectionId: 'session-1', assetConnectionId: 'conn-1' });

    rerender(
      <NetworkPanel
        connectionId="session-2"
        connectionName="db-01"
        host="10.0.0.6"
        assetConnectionId="conn-2"
      />,
    );

    expect(api.probeServerTopology).not.toHaveBeenCalled();
  });

  it('does not probe when the topology store changes under it', () => {
    seedProbedNode();
    renderPanel();

    // Simulate the global topology view editing data, which fires the
    // change event the panel subscribes to.
    const listener = store.subscribeTopology.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf('function');
    // The listener triggers a reload, so drive it inside `act`.
    act(() => {
      listener();
    });

    expect(api.probeServerTopology).not.toHaveBeenCalled();
  });

  it('probes exactly once when the button is clicked', async () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: new RegExp(PROBE_BUTTON, 'i') }));

    await waitFor(() => expect(api.probeServerTopology).toHaveBeenCalledTimes(1));
    expect(api.probeServerTopology).toHaveBeenCalledWith('session-1');
  });

  it('persists against the asset connection id, not the session id', async () => {
    renderPanel({ connectionId: 'session-1', assetConnectionId: 'conn-1' });

    fireEvent.click(screen.getByRole('button', { name: new RegExp(PROBE_BUTTON, 'i') }));

    await waitFor(() => expect(api.applyProbeResult).toHaveBeenCalledTimes(1));
    expect(api.applyProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'conn-1', connectionName: 'web-01' }),
    );
  });

  it('falls back to the session id when no asset id is supplied', async () => {
    renderPanel({ connectionId: 'session-1', assetConnectionId: undefined });

    fireEvent.click(screen.getByRole('button', { name: new RegExp(PROBE_BUTTON, 'i') }));

    await waitFor(() => expect(api.applyProbeResult).toHaveBeenCalledTimes(1));
    expect(api.applyProbeResult).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'session-1' }),
    );
  });

  it('unsubscribes from the store on unmount', () => {
    const { unmount } = renderPanel();
    expect(unsubscribe).not.toHaveBeenCalled();
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
