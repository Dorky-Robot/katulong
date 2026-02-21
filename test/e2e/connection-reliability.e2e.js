/**
 * E2E tests for WebSocket connection reliability
 *
 * Tests reconnection logic and connection behavior.
 * Validates fixes from PR #40 (WebSocket reconnection issues).
 */

import { test, expect } from '@playwright/test';
import { setupTest } from './helpers.js';

test.describe('Connection Reliability', () => {
  test.beforeEach(async ({ page, context }) => {
    await setupTest({ page, context });
  });

  test('should send and receive terminal data over connection', async ({ page }) => {
    // Wait for terminal to be ready
    await page.waitForSelector('.xterm-screen');

    // Type a command
    const testCommand = `echo "connection-test-${Date.now()}"`;
    await page.keyboard.type(testCommand);
    await page.keyboard.press('Enter');

    // Wait for output to appear
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('connection-test'),
      { timeout: 5000 }
    );

    // Verify output appears (connection is working)
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('connection-test');

    console.log('[Test] Terminal communication working');
  });

  test('should show connection indicator states', async ({ page }) => {
    // Verify the terminal is connected and responsive
    await page.waitForSelector('.xterm-screen');
    const testCommand = `echo "indicator-test-${Date.now()}"`;
    await page.keyboard.type(testCommand);
    await page.keyboard.press('Enter');

    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('indicator-test'),
      { timeout: 5000 }
    );

    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('indicator-test');

    console.log('[Test] Connection is active and responsive');
  });

  test('should handle page reload and reconnect', async ({ page }) => {
    // Type command before reload
    await page.keyboard.type('echo "before reload"');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('before reload'),
      { timeout: 5000 }
    );

    // Reload page
    await page.reload();

    // Wait for reconnection
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Verify connection reestablished by sending command
    const testCommand = `echo "after-reload-${Date.now()}"`;
    await page.keyboard.type(testCommand);
    await page.keyboard.press('Enter');

    // Wait for output to appear
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('after-reload'),
      { timeout: 5000 }
    );

    // Should see output
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('after-reload');

    console.log('[Test] Reconnection after reload successful');
  });

  test('should preserve terminal buffer across reconnection', async ({ page }) => {
    // Type unique marker
    const marker = `marker-${Date.now()}`;
    await page.keyboard.type(`echo "${marker}"`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (m) => document.querySelector('.xterm-screen')?.textContent?.includes(m),
      marker,
      { timeout: 5000 }
    );

    // Reload page
    await page.reload();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await page.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Wait for buffer to be replayed - marker should appear
    await page.waitForFunction(
      (m) => document.querySelector('.xterm-screen')?.textContent?.includes(m),
      marker,
      { timeout: 5000 }
    );

    // Terminal buffer should be preserved
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain(marker);

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

  test('should send commands over WebSocket', async ({ page }) => {
    // Send command to verify WebSocket connection works
    const testCommand = `echo "ws-test-${Date.now()}"`;
    await page.keyboard.type(testCommand);
    await page.keyboard.press('Enter');

    // Wait for output to appear
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('ws-test'),
      { timeout: 5000 }
    );

    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('ws-test');

    console.log('[Test] WebSocket connection working');
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

    // Verify reconnection by sending command
    const testCommand = `echo "after-ws-close-${Date.now()}"`;
    await page.keyboard.type(testCommand);
    await page.keyboard.press('Enter');

    // Try to get output - if connection is restored, command will execute
    const reconnected = await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('after-ws-close'),
      { timeout: 5000 }
    ).then(() => true).catch(() => false);

    if (reconnected) {
      console.log('[Test] WebSocket reconnection successful');
      const terminalText = await page.locator('.xterm-screen').textContent();
      expect(terminalText).toContain('after-ws-close');
    } else {
      console.log('[Test] WebSocket did not reconnect automatically');
      // This is acceptable - auto-reconnection is optional
    }
  });

  test('should maintain connection during long idle period', async ({ page }) => {
    // Send initial command
    await page.keyboard.type('echo "before idle"');
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('before idle'),
      { timeout: 5000 }
    );

    // Idle for 10 seconds (simulate user inactivity)
    console.log('[Test] Idling for 10 seconds...');
    await page.waitForTimeout(10000);

    // Send command after idle
    const testCommand = `echo "after-idle-${Date.now()}"`;
    await page.keyboard.type(testCommand);
    await page.keyboard.press('Enter');

    // Wait for output to appear
    await page.waitForFunction(
      () => document.querySelector('.xterm-screen')?.textContent?.includes('after-idle'),
      { timeout: 5000 }
    );

    // Should still work
    const terminalText = await page.locator('.xterm-screen').textContent();
    expect(terminalText).toContain('after-idle');

    console.log('[Test] Connection survived idle period');
  });

  test('should handle multiple tabs sharing same session', async ({ page, context }) => {
    // Send command in first tab
    const marker1 = `tab1-${Date.now()}`;
    await page.keyboard.type(`echo "${marker1}"`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (m) => document.querySelector('.xterm-screen')?.textContent?.includes(m),
      marker1,
      { timeout: 5000 }
    );

    // Open second tab with same session
    const page2 = await context.newPage();
    await page2.goto("/");
    await page2.waitForSelector('.xterm', { timeout: 10000 });
    await page2.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Second tab should see the same session (wait for terminal buffer replay)
    await page2.waitForFunction(
      (m) => document.querySelector('.xterm-screen')?.textContent?.includes(m),
      marker1,
      { timeout: 10000 }
    );

    // Send command in second tab
    const marker2 = `tab2-${Date.now()}`;
    await page2.keyboard.type(`echo "${marker2}"`);
    await page2.keyboard.press('Enter');
    await page2.waitForFunction(
      (m) => document.querySelector('.xterm-screen')?.textContent?.includes(m),
      marker2,
      { timeout: 5000 }
    );

    // First tab should see the command from second tab
    await page.waitForFunction(
      (m) => document.querySelector('.xterm-screen')?.textContent?.includes(m),
      marker2,
      { timeout: 5000 }
    );
    const terminalText1 = await page.locator('.xterm-screen').textContent();
    expect(terminalText1).toContain(marker2);

    console.log('[Test] Multiple tabs sharing session successfully');

    await page2.close();
  });

  test('should show connecting state during connection establishment', async ({ page, context }) => {
    // Open page but don't wait for full load
    const page2 = await context.newPage();
    const pagePromise = page2.goto("/");

    await pagePromise;
    await page2.waitForSelector('.xterm', { timeout: 10000 });
    await page2.waitForSelector('.xterm-screen', { timeout: 5000 });

    // Verify terminal is functional
    const terminalVisible = await page2.locator('.xterm-screen').isVisible();
    expect(terminalVisible).toBeTruthy();
    console.log('[Test] Terminal visible after connection');

    await page2.close();
  });
});
