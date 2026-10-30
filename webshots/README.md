# Webshots

A screenshot tool for Microsoft Edge and Google Chrome that captures part of a web page as **text or HTML instead of an image**. Paste the result into an AI assistant that can't read images (for example, GitHub Copilot with vision turned off).

Every capture starts with the page URL, title and time:

```
URL: https://intranet.company.com/orders?page=2&token=REDACTED
Title: Acme Ops – Orders
Captured: 2026-10-30 14:05
Selection: element table#orders

| Order | Customer  | Status  | Total     | Shipped |
| ---   | ---       | ---     | ---       | ---     |
| #1001 | Jane Cruz | Paid    | $1,200.00 | [x]     |
| #1002 | Mark Lee  | Overdue | $980.50   | [ ]     |
```

## Install

No build step. Load the folder as an unpacked extension:

**Edge:** open `edge://extensions`, turn on **Developer mode** (left sidebar), click **Load unpacked**, and select this folder.

**Chrome:** open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, and select this folder.

If Developer mode is greyed out, your company's browser policy blocks unpacked extensions. Ask IT to allow it, or to publish the extension internally (see [Sharing with your team](#sharing-with-your-team)).

## Use

1. Click the Webshots toolbar button, or press **Alt+Shift+S** (**Option+Shift+S** on Mac).
2. Pick what to capture:
   - **Click** an element. Press **↑** to widen the selection to the surrounding element and **↓** to go back; **Enter** captures.
   - **Drag** a box around an area.
   - Click **Visible area** to capture everything in the window.
3. The capture is copied to your clipboard. Paste it into Copilot Chat.

The notice in the corner shows the size in characters and approximate tokens, and has **Copy again** and **Download** buttons. **Esc** cancels.

To change the shortcut, open `edge://extensions/shortcuts` (or `chrome://extensions/shortcuts`).

## Output modes

Choose a mode in the toolbar. Your choice is remembered.

| Mode | What you get | Use it for |
|---|---|---|
| **Text** (default) | Markdown: headings, lists, links, `[x]` checkboxes, `[input: value]` fields. Tables become Markdown tables. | "What does this screen say?", table data, error messages. Smallest output. |
| **HTML** | Cleaned HTML: no scripts, no tracking attributes, no generated class names. Form fields show their current values. | Questions about markup and structure. |
| **HTML + CSS** | The cleaned HTML plus only the styles that differ from browser defaults. Repeated styles are grouped into classes. | Asking Copilot to reproduce or fix how something looks. |

In testing, Text was 3–7 times smaller than HTML for the same content.

### Tables

- Regular HTML tables and div-based data grids (AG Grid, MUI DataGrid and similar) become Markdown tables. Pinned columns and rows that are out of order on the page are put back together using the grid's row and column numbers.
- Tables with merged cells (`colspan` or `rowspan`) stay as a minimal HTML table, because Markdown can't show merged cells.
- If you drag over part of a table, the matching header cells are included even when the header has scrolled out of view.

## What's removed automatically

- **Things you can't see:** hidden elements, transparent elements, screen-reader-only text, and the contents of closed `<details>` sections.
- **Hidden form fields**, such as CSRF tokens.
- **Password, one-time-code and card-number values**, which become `••••••`.
- **Sensitive URL parameters** such as `token`, `code`, `session`, `api_key` and `signature`, in the page URL and in every link. Their values become `REDACTED`.
- **Base64 image data**, scripts and styles.

Everything else on the page, such as names, emails and numbers, is captured as-is. Check the capture before you paste it if the page shows personal data.

## Limits

- **Pixels can't become text.** Canvas charts, WebGL, video and the contents of images aren't captured (images keep their alt text). SVG charts work, because their labels and values are text.
- **Long grids only include rows that are drawn.** Many data grids only put the visible rows on the page, so off-screen rows aren't captured. Scroll and capture again if you need them.
- **Embedded frames from another site** are listed but not captured.
- **Browser pages can't be captured:** `edge://`, `chrome://`, the add-on stores and the built-in PDF viewer. The toolbar button shows a red `!` there.
- **Only web pages.** Desktop apps such as your IDE are outside the browser.

## Testing

`test/fixture.html` is a test page with the tricky cases: tables, merged cells, a pinned-column grid, hidden fields, web components, charts, a scrolling list and an iframe. Serve it locally and try the extension on it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000/test/fixture.html
```

Use a local server rather than opening the file directly. Extensions can't run on `file://` pages unless you turn on **Allow access to file URLs** in the extension's details.

## Sharing with your team

- **Edge Add-ons store:** zip this folder and submit it at the [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/). You can publish it as hidden, so only people with the link can install it.
- **Company policy:** IT can force-install it with the `ExtensionInstallForcelist` policy, or allow it with `ExtensionInstallAllowlist`.

## How it works

| File | Role |
|---|---|
| `manifest.json` | Manifest V3. Permissions: `activeTab` (access only to the tab you click it on), `scripting`, `storage` (remembers the mode), `clipboardWrite`. |
| `background.js` | Injects the scripts below when you click the button. |
| `content/capture.js` | Walks the live page, including web components, and builds a cleaned tree of what's visible. |
| `content/render.js` | Turns that tree into Text, HTML or HTML + CSS, and adds the URL header. |
| `content/overlay.js` | The picker UI: highlight, drag box, toolbar, clipboard and the corner notice. |

Nothing is sent anywhere. The extension has no network access, and captures go only to your clipboard or a downloaded file.
