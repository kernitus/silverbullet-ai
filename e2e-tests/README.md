# E2E Tests for SilverBullet AI Plugin

This directory contains end-to-end browser tests for the SilverBullet AI plugin using [Playwright](https://playwright.dev/).

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or later) and bun install --frozen-lockfileed
- SilverBullet CLI installed globally

### Install Dependencies and Playwright Browsers

Before running tests for the first time, install dependencies and Playwright browsers:

```bash
bun install --frozen-lockfile
bunx playwright install
```

This will download Chromium, Firefox, and WebKit browsers.

## Running Tests

### Run all tests

```bash
bunx playwright test
```

### Run tests in UI mode (interactive)

```bash
bunx playwright test --ui
```

### Run tests in a specific browser

```bash
# Chromium only
bunx playwright test --project=chromium

# Firefox only
bunx playwright test --project=firefox

# Mobile Chrome
bunx playwright test --project="Mobile Chrome"
```

### Run tests in headed mode (see the browser)

```bash
bunx playwright test --headed
```

### Run specific test file

```bash
bunx playwright test tests/chat-panel.spec.ts
```

## Test Structure

```
e2e-tests/
├── playwright.config.ts    # Playwright configuration
├── tests/                  # Test files
│   └── chat-panel.spec.ts # Chat panel E2E tests
└── README.md              # This file
```

## Writing Tests

Tests use Playwright's test framework. Example:

```typescript
import { test, expect } from "@playwright/test";

test("my test", async ({ page }) => {
  await page.goto("/");

  // Your test code here
  await expect(page.locator("h1")).toHaveText("SilverBullet");
});
```

## Test Reports

After running tests, you can view the HTML report:

```bash
bunx playwright show-report
```

## CI/CD Integration

E2E tests are configured to run in GitHub Actions on every push and pull request.

## Debugging

### Debug mode

Run tests in debug mode with Playwright Inspector:

```bash
bunx playwright test --debug
```

### Screenshots and Videos

On test failure, Playwright automatically captures:
- Screenshots (in `test-results/`)
- Videos (in `test-results/`)
- Traces (viewable with `bunx playwright show-trace`)

## Troubleshooting

### SilverBullet not starting

If the test web server fails to start:

1. Check that port 3000 is available
2. Ensure SilverBullet is installed: `bun add --global silverbullet`
3. Manually test: `silverbullet ./test-space --port 3000`

### Tests timing out

Increase timeout in `playwright.config.ts`:

```typescript
use: {
  timeout: 30000, // 30 seconds per test
}
```

### Browser not found

Reinstall browsers:

```bash
bunx playwright install --force
```

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [SilverBullet Documentation](https://silverbullet.md/)
