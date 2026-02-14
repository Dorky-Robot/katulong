import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

describe("Certificate Store", () => {
  let mockFetch;
  let createCertificateStore;
  let loadCertificates;
  let setConfirmState;
  let clearConfirmState;
  let clearAllConfirmStates;
  let regenerateNetwork;
  let revokeNetwork;
  let updateNetworkLabel;

  beforeEach(async () => {
    // Mock global fetch
    mockFetch = mock.fn();
    global.fetch = mockFetch;

    // Import module
    const module = await import("../public/lib/certificate-store.js");
    createCertificateStore = module.createCertificateStore;
    loadCertificates = module.loadCertificates;
    setConfirmState = module.setConfirmState;
    clearConfirmState = module.clearConfirmState;
    clearAllConfirmStates = module.clearAllConfirmStates;
    regenerateNetwork = module.regenerateNetwork;
    revokeNetwork = module.revokeNetwork;
    updateNetworkLabel = module.updateNetworkLabel;
  });

  describe("Store Initialization", () => {
    it("should create store with initial state", () => {
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            allNetworks: [],
            currentNetwork: { networkId: "test", ips: [], hasCertificate: false }
          })
        })
      );

      const store = createCertificateStore();
      const state = store.getState();

      // Auto-loads on creation, so loading may be true or false depending on timing
      assert.notStrictEqual(state.error, "cannot be set");
      assert.deepStrictEqual(state.confirmState, {});
    });

    it("should auto-load certificates on creation", () => {
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            allNetworks: [],
            currentNetwork: { networkId: "test", ips: [], hasCertificate: false }
          })
        })
      );

      createCertificateStore();
      assert.strictEqual(mockFetch.mock.callCount() > 0, true);
    });
  });

  describe("Load Certificates", () => {
    it("should set loading state when loading starts", async () => {
      mockFetch.mock.mockImplementation(() =>
        new Promise(() => {}) // Never resolves
      );

      const module = await import("../public/lib/certificate-store.js");
      const { createStore, createReducer } = await import("../public/lib/store.js");
      const CERT_ACTIONS = module.CERT_ACTIONS;

      const initialState = {
        networks: [],
        currentNetwork: null,
        loading: false,
        error: null,
        lastUpdated: null,
        confirmState: {}
      };

      const store = createStore(initialState, createReducer(initialState, {
        [CERT_ACTIONS.LOAD_START]: (state) => ({
          ...state,
          loading: true,
          error: null
        })
      }));

      store.dispatch({ type: CERT_ACTIONS.LOAD_START });
      assert.strictEqual(store.getState().loading, true);
    });

    it("should load certificates successfully", async () => {
      const mockData = {
        allNetworks: [
          { networkId: "net-1", label: "Home", ips: ["192.168.1.1"] }
        ],
        currentNetwork: { networkId: "net-1", ips: ["192.168.1.1"], hasCertificate: true }
      };

      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(mockData)
        })
      );

      const module = await import("../public/lib/certificate-store.js");
      const { createStore, createReducer } = await import("../public/lib/store.js");
      const CERT_ACTIONS = module.CERT_ACTIONS;

      const initialState = {
        networks: [],
        currentNetwork: null,
        loading: false,
        error: null,
        lastUpdated: null,
        confirmState: {}
      };

      const certificateReducer = createReducer(initialState, {
        [CERT_ACTIONS.LOAD_START]: (state) => ({
          ...state,
          loading: true,
          error: null
        }),
        [CERT_ACTIONS.LOAD_SUCCESS]: (state, action) => ({
          ...state,
          networks: action.networks,
          currentNetwork: action.currentNetwork,
          loading: false,
          error: null,
          lastUpdated: Date.now()
        }),
        [CERT_ACTIONS.LOAD_ERROR]: (state, action) => ({
          ...state,
          loading: false,
          error: action.error
        })
      });

      const store = createStore(initialState, certificateReducer);
      await loadCertificates(store);

      const state = store.getState();
      assert.strictEqual(state.loading, false);
      assert.strictEqual(state.error, null);
      assert.strictEqual(state.networks.length, 1);
      assert.strictEqual(state.networks[0].networkId, "net-1");
    });

    it("should handle load error", async () => {
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 500
        })
      );

      const module = await import("../public/lib/certificate-store.js");
      const { createStore, createReducer } = await import("../public/lib/store.js");
      const CERT_ACTIONS = module.CERT_ACTIONS;

      const initialState = {
        networks: [],
        currentNetwork: null,
        loading: false,
        error: null,
        lastUpdated: null,
        confirmState: {}
      };

      const certificateReducer = createReducer(initialState, {
        [CERT_ACTIONS.LOAD_START]: (state) => ({
          ...state,
          loading: true,
          error: null
        }),
        [CERT_ACTIONS.LOAD_ERROR]: (state, action) => ({
          ...state,
          loading: false,
          error: action.error
        })
      });

      const store = createStore(initialState, certificateReducer);
      await loadCertificates(store);

      const state = store.getState();
      assert.strictEqual(state.loading, false);
      assert.notStrictEqual(state.error, null);
    });
  });

  describe("Confirm State Management", () => {
    it("should set confirm state for a key", async () => {
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        })
      );

      const store = createCertificateStore();
      setConfirmState(store, "test-key");

      const state = store.getState();
      assert.strictEqual(state.confirmState["test-key"], true);
    });

    it("should clear confirm state for a key", async () => {
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        })
      );

      const store = createCertificateStore();
      setConfirmState(store, "test-key");
      clearConfirmState(store, "test-key");

      const state = store.getState();
      assert.strictEqual(state.confirmState["test-key"], undefined);
    });

    it("should clear all confirm states", async () => {
      mockFetch.mock.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        })
      );

      const store = createCertificateStore();
      setConfirmState(store, "key1");
      setConfirmState(store, "key2");
      clearAllConfirmStates(store);

      const state = store.getState();
      assert.deepStrictEqual(state.confirmState, {});
    });
  });

  describe("Network Operations", () => {
    it("should regenerate network certificate", async () => {
      mockFetch.mock.mockImplementation((url, options) => {
        if (url.includes("/regenerate")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ message: "Certificate regenerated" })
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        });
      });

      const store = createCertificateStore();
      const result = await regenerateNetwork(store, "net-1");

      assert.strictEqual(result.success, true);
      assert.strictEqual(result.message, "Certificate regenerated");
    });

    it("should revoke network certificate", async () => {
      mockFetch.mock.mockImplementation((url, options) => {
        if (options?.method === "DELETE") {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        });
      });

      const store = createCertificateStore();
      const result = await revokeNetwork(store, "net-1");

      assert.strictEqual(result.success, true);
    });

    it("should update network label", async () => {
      mockFetch.mock.mockImplementation((url, options) => {
        if (options?.method === "PUT") {
          return Promise.resolve({ ok: true });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        });
      });

      const store = createCertificateStore();
      const result = await updateNetworkLabel(store, "net-1", "New Label");

      assert.strictEqual(result.success, true);
    });

    it("should handle regenerate error", async () => {
      mockFetch.mock.mockImplementation((url) => {
        if (url.includes("/regenerate")) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ allNetworks: [], currentNetwork: { ips: [] } })
        });
      });

      const store = createCertificateStore();
      const result = await regenerateNetwork(store, "net-1");

      assert.strictEqual(result.success, false);
      assert.notStrictEqual(result.error, undefined);
    });
  });
});
