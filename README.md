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


## Live execution and visual recovery

JEV now waits **5 seconds between successful browser actions** by default so the user can watch the automation happen live. Change this with `STEP_DELAY_MS`.

The dashboard has a **Stop automation** button. Stopping a job sets a cancellation flag; JEV checks it before planning and before continuing after an action/recovery.

When a deterministic Playwright action fails because the DOM has changed, JEV takes a compact JPEG screenshot and sends it to Gemini for **one visual recovery attempt**. Gemini returns a small structured action; JEV executes it directly. There is no second planner loop for that failure. If Gemini is unavailable, returns an invalid action, or recovery fails, the job stops.

### Gemini configuration

Add these to `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
STEP_DELAY_MS=5000
```

Gemini is not called during normal successful execution, which keeps Gemini usage low. The visual recovery request contains the screenshot plus a small amount of task/error/page context rather than the full DOM.

For the example:

1. Open browser / navigate
2. Search YouTube
3. Search for the video
4. Play the video

JEV's internal inspection and recovery work is not counted as additional user-visible action steps. A recovery attempt is attached to the failed action and does not create an unbounded loop.
