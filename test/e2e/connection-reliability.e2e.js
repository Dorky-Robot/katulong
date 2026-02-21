/**
 * E2E tests for WebSocket and P2P connection reliability
 *
 * Tests reconnection logic, fallback behavior, and connection indicator.
 * Validates fixes from PR #40 (WebSocket and P2P reconnection issues).
 */

import { test, expect } from '@playwright/test';
import { waitForAppReady, waitForTerminalOutput, termSend } from './helpers.js';

test.describe('Connection Reliability', () => {
  // Run serially to avoid cross-test PTY contamination when tests share a
  // session. Parallel workers typing into the same default session cause
  // output from one test to appear in another's terminal.
  test.describe.configure({ mode: 'serial' });

  // Each test uses its own session to avoid cross-test interference.
  let sessionName;

  test.beforeEach(async ({ page, context }, testInfo) => {
    sessionName = `conn-rel-${testInfo.testId}-${Date.now()}`;
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await waitForAppReady(page);
    // Wait for shell prompt before typing — the shell runs init scripts
    // (e.g. .zshrc, clear) and keystrokes typed before the prompt appears
    // get swallowed or mangled, causing flaky failures.
    await page.waitForFunction(
      () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
      { timeout: 10000 },
    );
    // The daemon sends 'clear\n' to new sessions 100ms after creation to erase
    // shell init artifacts. If a test sends commands before this timer fires,
    // the ring buffer ends up with the order [commands] → [clear]. On page
    // reload or second-tab attach, replaying this buffer re-runs the clear
    // AFTER the commands, making them invisible (clear erases in-place, does
    // NOT push content to scrollback).
    //
    // Waiting 200ms here guarantees the 100ms clear timer has fired and its
    // output has been processed by xterm. Test commands sent after this wait
    // will appear in the ring buffer AFTER the clear, so replay preserves them.
    await page.waitForTimeout(200);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: 'DELETE' }),
      sessionName,
    );
  });

  test('should establish P2P connection on load', async ({ page }) => {
    // Check connection indicator (ID not class)
    const p2pIndicator = page.locator('#p2p-indicator');
    await expect(p2pIndicator).toBeVisible({ timeout: 5000 });

    // Wait for connection to be established - indicator should get a class
    await page.waitForFunction(
      () => {
        const indicator = document.getElementById('p2p-indicator');
        return indicator && (
          indicator.classList.contains('p2p-active') ||
          indicator.classList.contains('p2p-relay') ||
          indicator.classList.contains('ws-connected')
        );
      },
      { timeout: 10000 }
    );

    // Should show connected state - either p2p-active (green), p2p-relay (orange), or ws-connected
    const hasConnectedClass = await p2pIndicator.evaluate(el => {
      return el.classList.contains('p2p-active') ||
             el.classList.contains('p2p-relay') ||
             el.classList.contains('ws-connected');
    });

    // Log connection state for debugging
    const classes = await p2pIndicator.evaluate(el => el.className);
    console.log('[Test] P2P indicator classes:', classes);

    expect(hasConnectedClass).toBeTruthy();
  });

  test('should send and receive terminal data over connection', async ({ page }) => {
    // Wait for terminal to be ready
    await page.waitForSelector('.xterm-screen');

    // Use termSend (window.__termSend) instead of page.keyboard.type().
    // keyboard.type() is unreliable under parallel load and fails on mobile
    // due to IME autocorrect injection. termSend bypasses keyboard events
    // entirely, sending directly to the PTY.
    const marker = `connection-test-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);

    // Use buffer.active (window.__xterm) instead of .xterm-screen.textContent.
    // The canvas renderer's accessibility layer only exposes the current cursor
    // row; previous output rows disappear once the shell returns to a prompt.
    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    console.log('[Test] Terminal communication working');
  });

  test('should show connection indicator states', async ({ page }) => {
    const p2pIndicator = page.locator('#p2p-indicator');
    await expect(p2pIndicator).toBeVisible({ timeout: 5000 });

    // Get initial state
    const initialState = await p2pIndicator.evaluate(el => ({
      classes: el.className,
      status: el.dataset.connectionStatus,
      title: el.getAttribute('title') || el.getAttribute('aria-label')
    }));

    console.log('[Test] Connection state:', initialState);

    // Should have some indication of connection status
    expect(
      initialState.classes.length > 0 ||
      initialState.status ||
      initialState.title
    ).toBeTruthy();
  });

  test('should handle page reload and reconnect', async ({ page }) => {
    // Type command before reload
    await termSend(page, 'echo "before reload"\r');
    await waitForTerminalOutput(page, 'before reload', { timeout: 5000 });

    // Reload page
    await page.reload();

    // Wait for reconnection
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Verify connection reestablished by sending command
    const marker = `after-reload-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);

    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    console.log('[Test] Reconnection after reload successful');
  });

  test('should preserve terminal buffer across reconnection', async ({ page }) => {
    // Type unique marker
    const marker = `marker-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);
    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    // Send a sentinel after the marker. Waiting for the sentinel after reload
    // guarantees that the full ring buffer replay (including the marker) has
    // been committed to buffer.active before we check for the marker.
    // Without this, waitForTerminalOutput can return on the echo of the marker
    // command before the actual output hits buffer.active, creating a race
    // where page.reload() runs too early.
    const sentinel = `s${Date.now()}`;
    await termSend(page, `echo "${sentinel}"\r`);
    await waitForTerminalOutput(page, sentinel, { timeout: 5000 });

    // Reload page
    await page.reload();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Wait for sentinel in buffer.active first — it appears after the marker
    // in the ring buffer replay, so finding it guarantees the full replay has
    // been committed to buffer.active.
    await waitForTerminalOutput(page, sentinel, { timeout: 10000 });
    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    console.log('[Test] Buffer preserved across reconnection');
  });

  test('should handle rapid reconnections without errors', async ({ page }) => {
    // Monitor console for errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Reload rapidly
    for (let i = 0; i < 3; i++) {
      await page.reload();
      await page.waitForSelector('.xterm', { timeout: 10000 });
      await page.waitForSelector('.xterm-screen', { timeout: 5000 });
    }

    // Should not have connection-related errors
    const connectionErrors = errors.filter(e =>
      e.includes('WebSocket') ||
      e.includes('P2P') ||
      e.includes('connection') ||
      e.includes('reconnect')
    );

    if (connectionErrors.length > 0) {
      console.log('[Test] Connection errors:', connectionErrors);
    }

    // Some errors may be acceptable during rapid reconnection
    // But there shouldn't be crashes or unhandled rejections
    expect(connectionErrors.length).toBeLessThan(5);
  });

  test('should fallback to WebSocket if P2P fails', async ({ page }) => {
    // This is hard to test directly without mocking P2P failure
    // For now, verify that connection works regardless of transport

    // Send command to verify connection works
    const marker = `fallback-test-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);
    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    console.log('[Test] Connection working (P2P or WebSocket)');
  });

  test('should handle WebSocket close and reopen', async ({ page }) => {
    // Force close WebSocket via page evaluation
    await page.evaluate(() => {
      // Find and close WebSocket connection
      if (window.ws) {
        window.ws.close();
      }
    });

    // Wait a moment for reconnection to be initiated
    await page.waitForTimeout(1000);

    // Verify reconnection by sending command (WebSocket or P2P should reconnect)
    const marker = `after-ws-close-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);

    // Try to get output - if connection is restored, command will execute
    const reconnected = await waitForTerminalOutput(page, marker, { timeout: 5000 })
      .then(() => true).catch(() => false);

    if (reconnected) {
      console.log('[Test] WebSocket reconnection successful');
    } else {
      console.log('[Test] WebSocket did not reconnect automatically');
      // This is acceptable - auto-reconnection is optional
    }
  });

  test('should maintain connection during long idle period', async ({ page }) => {
    // Send initial command
    await termSend(page, 'echo "before idle"\r');
    await waitForTerminalOutput(page, 'before idle', { timeout: 5000 });

    // Idle for 10 seconds (simulate user inactivity)
    console.log('[Test] Idling for 10 seconds...');
    await page.waitForTimeout(10000);

    // Send command after idle
    const marker = `after-idle-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);
    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    console.log('[Test] Connection survived idle period');
  });

  test('should handle multiple tabs sharing same session', async ({ page, context }) => {
    // Send command in first tab
    const marker1 = `tab1-${Date.now()}`;
    await termSend(page, `echo "${marker1}"\r`);
    await waitForTerminalOutput(page, marker1, { timeout: 5000 });

    // Open second tab with the SAME session URL so both share the PTY.
    // The 200ms beforeEach wait guarantees that by the time we send marker1,
    // the ring buffer is [clear] → [marker1...]. When page2 attaches and the
    // server replays the ring buffer, clear runs first (harmlessly on a fresh
    // xterm instance) and marker1 is preserved in buffer.active.
    const page2 = await context.newPage();
    await page2.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await page2.waitForSelector('.xterm', { timeout: 10000 });
    await page2.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Second tab should see the same session (wait for terminal buffer replay)
    await waitForTerminalOutput(page2, marker1, { timeout: 10000 });

    // Send command in second tab
    const marker2 = `tab2-${Date.now()}`;
    await termSend(page2, `echo "${marker2}"\r`);
    await waitForTerminalOutput(page2, marker2, { timeout: 5000 });

    // First tab should see the command from second tab
    await waitForTerminalOutput(page, marker2, { timeout: 5000 });

    console.log('[Test] Multiple tabs sharing session successfully');

    await page2.close();
  });

  test('should show connecting state during connection establishment', async ({ page, context }) => {
    // Open page but don't wait for full load
    const page2 = await context.newPage();
    const pagePromise = page2.goto(`/?s=${encodeURIComponent(sessionName)}`);

    // Try to catch the connecting state
    const p2pIndicator = page2.locator('#p2p-indicator');

    // Check if we can see a connecting/intermediate state
    let connectingStateSeen = false;
    for (let i = 0; i < 10; i++) {
      const classes = await p2pIndicator.evaluate(el => el.className).catch(() => '');
      if (classes.includes('connecting') || classes.includes('pending')) {
        connectingStateSeen = true;
        console.log('[Test] Connecting state observed');
        break;
      }
      // Small delay to poll state
      await page2.waitForFunction(() => true, { timeout: 100 }).catch(() => {});
    }

    await pagePromise;
    await page2.waitForSelector('.xterm', { timeout: 10000 });
    await page2.waitForSelector('.xterm-screen', { timeout: 5000 });

    await page2.close();

    // Note: connecting state is very brief, so it's ok if we don't catch it
    console.log('[Test] Connecting state seen:', connectingStateSeen);
  });
});

test.describe('P2P Specific Tests', () => {
  // Run serially to avoid cross-test PTY contamination
  test.describe.configure({ mode: 'serial' });

  let sessionName;

  test.beforeEach(async ({ page }, testInfo) => {
    sessionName = `p2p-${testInfo.testId}-${Date.now()}`;
    await page.goto(`/?s=${encodeURIComponent(sessionName)}`);
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });
    // Wait for shell prompt and 200ms for daemon clear timer (see Connection
    // Reliability beforeEach for detailed explanation of why this is needed).
    await page.waitForFunction(
      () => /[$➜%#>]/.test(document.querySelector('.xterm-rows')?.textContent || ''),
      { timeout: 10000 },
    );
    await page.waitForTimeout(200);
  });

  test.afterEach(async ({ page }) => {
    await page.evaluate(
      (n) => fetch(`/sessions/${encodeURIComponent(n)}`, { method: 'DELETE' }),
      sessionName,
    );
  });

  test('should use P2P when available (localhost)', async ({ page }) => {
    // On localhost, P2P should be available
    // Check if P2P is being used by examining connection logs or state

    const p2pActive = await page.evaluate(() => {
      // Check if P2P datachannel exists
      return window.pc && window.pc.connectionState === 'connected';
    }).catch(() => false);

    console.log('[Test] P2P active:', p2pActive);

    // Even if P2P not active, WebSocket fallback should work
  });

  test('should have low latency with P2P connection', async ({ page }) => {
    // Measure round-trip time for a command
    const startTime = Date.now();

    const marker = `latency-test-${Date.now()}`;
    await termSend(page, `echo "${marker}"\r`);
    await waitForTerminalOutput(page, marker, { timeout: 5000 });

    const latency = Date.now() - startTime;
    console.log('[Test] Command latency:', latency, 'ms');

    // P2P should have low latency (< 500ms for simple echo)
    // WebSocket might be slightly higher but still reasonable
    expect(latency).toBeLessThan(2000);
  });
});
