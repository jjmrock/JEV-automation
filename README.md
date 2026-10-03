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

## Failure policy

JEV uses a fail-fast execution policy. If a planned browser action fails, the current job is immediately marked `failed` and stopped. JEV does not retry the failed action or ask the planner for another action after that failure.

The same applies to fatal planner/API errors, invalid model-selected actions, browser launch/navigation failures, and the maximum-step limit. This prevents runaway automation loops.

Each run ends with a terminal status such as `completed` or `failed`, and the event stream reports the reason for termination.
