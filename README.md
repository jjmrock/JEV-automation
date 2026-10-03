# JEV Automation

Natural-language browser automation using TypeSafe AI + Playwright.

## Setup
```bash
npm install
npx playwright install chromium
cp .env.example .env
npm start
```

Open http://localhost:3000.

Example:
```
Open https://www.google.com and search for "Playwright browser automation"
```

Supported agent actions include navigation, clicks, form filling, keyboard input, scrolling, selects, toggles, waits, back/forward/reload, extraction, screenshots, downloads and new tabs. The model chooses only from server-generated actions; it cannot execute arbitrary JavaScript.

For sensitive or irreversible actions, add a human approval step before production use.
