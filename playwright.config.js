const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests',
    timeout: 90_000,
    expect: {
        timeout: 20_000
    },
    use: {
        baseURL: 'http://127.0.0.1:4173',
        viewport: { width: 1440, height: 1280 },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure'
    },
    projects: [
        {
            name: 'chromium',
            use: {
                browserName: 'chromium'
            }
        }
    ],
    webServer: {
        command: 'python3 -m http.server 4173 --bind 127.0.0.1',
        url: 'http://127.0.0.1:4173/converter.html',
        reuseExistingServer: true,
        timeout: 120_000
    }
});
