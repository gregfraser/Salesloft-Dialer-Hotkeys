# Salesloft Dialer Hotkeys

Make cadence calling faster. Instead of clicking End Call, picking a disposition, and hitting Log & Complete for every no-answer, you press **one key** (or click one button) and it all happens for you.

<p align="center">
  <img src="images/controls.png" alt="The two control buttons: a red No Answer button and a green Call button, with a status line reading Ready" width="400">
</p>

- 🔴 **The red button** — ends the call, logs it as "No Answer," completes the cadence step, and lines up the next person.
- 🟢 **The green button** — starts the next call.

That's it. Dial, no answer, red, green, repeat.

---

## Installing (about 2 minutes)

You only have to do this once. The extension isn't in the Chrome Web Store, so Chrome needs you to load it manually — that's what these steps do.

### Step 1 — Unzip the folder

Find the file `salesloft-dialer-hotkeys-extension.zip` in your Downloads. Right-click it and choose **Extract All** (Windows) or double-click it (Mac). You'll get a folder called `salesloft-dialer-hotkeys`. Move that folder somewhere it can stay permanently — like your Documents folder.

> [!WARNING]
> Don't delete or move this folder later. Chrome runs the extension directly from it — if the folder goes in the trash, the extension stops working.

### Step 2 — Open Chrome's extensions page

In Chrome, type `chrome://extensions` into the address bar and press <kbd>Enter</kbd>.

### Step 3 — Turn on Developer mode

Look in the **top-right corner** of that page for a small toggle labeled **Developer mode**. Click it so it turns on.

> [!NOTE]
> This just allows Chrome to load extensions from a folder — it doesn't change anything else about your browser.

### Step 4 — Load the extension

Three new buttons will appear near the top-left. Click **Load unpacked**, then find and select the `salesloft-dialer-hotkeys` folder from Step 1 and click **Select Folder**.

### Step 5 — Pin it to your toolbar

Click the Extensions button (the puzzle-piece icon 🧩) to the right of Chrome's address bar, find **Salesloft Dialer Hotkeys** in the list, and click the pin 📌 next to it. Now its icon is always visible.

### Step 6 — Refresh Salesloft

If you already had Salesloft open, refresh that tab once. You should see the red and green buttons (pictured above) appear in the bottom-left corner of the page. You're done! 🎉

---

## Using it

Open Salesloft and start your cadence like normal. Then:

| You want to... | Press | Or click |
|---|---|---|
| Start the next call | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>0</kbd> (Mac: <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>0</kbd>) | 🟢 **▶ Call** |
| End the call, log "No Answer," move on | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>9</kbd> (Mac: <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>9</kbd>) | 🔴 **✕ No Answer** |

The keyboard shortcuts work **even when you're in a different tab** — reading a prospect's LinkedIn, checking ZoomInfo, whatever. The extension finds your Salesloft tab and does the work there.

If you're actually on the Salesloft tab, <kbd>F8</kbd> (red) and <kbd>F9</kbd> (green) also work as quick single-key versions.

The status line under the buttons (it says "Ready" in the picture above) tells you what's happening at each step — "Ending call…", "Logged No Answer ✓".

> [!TIP]
> Only use the red button for no-answers. If someone picks up, talk like normal and log that call yourself.

---

## Settings

Click the extension's icon in your toolbar to open settings:

| Setting | What it does |
|---|---|
| **Floating panel** | Puts the buttons in their own little window that you can drag anywhere — even a second monitor. It stays open while you work in other tabs. |
| **Buttons on Salesloft page** | Shows or hides the buttons in the corner of the Salesloft page. Turn off if you're using the floating panel or just the keyboard. |
| **Disposition** | The label the red button logs. Set to "No Answer." Only change this if your team's dropdown uses different wording — it must match the dropdown option in Salesloft **exactly**, including capitalization. |
| **Edit shortcuts** | Opens Chrome's shortcut settings if <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>9</kbd>/<kbd>0</kbd> conflicts with something else or you'd prefer different keys. |

---

## If something isn't working

<details>
<summary><strong>No buttons on the Salesloft page?</strong></summary>

Refresh the Salesloft tab. If they still don't appear, check that **Buttons on Salesloft page** is turned on in settings (click the extension icon).
</details>

<details>
<summary><strong>Pressed the shortcut and nothing happened?</strong></summary>

Make sure a Salesloft tab is actually open in Chrome. Then refresh that tab once and try again.
</details>

<details>
<summary><strong>The status line says "Stopped" or "Timed out"?</strong></summary>

The extension couldn't find a button it expected — this can happen if Salesloft is loading slowly or changed its screen layout. Just finish logging that one call by hand and keep going. If it happens on every call, tell whoever gave you this extension — Salesloft may have updated their site and the extension needs a small fix.
</details>

<details>
<summary><strong>It logged something with the wrong disposition?</strong></summary>

Check the **Disposition** field in settings — it must match your Salesloft dropdown word-for-word.
</details>

<details>
<summary><strong>The extension disappeared after restarting your computer?</strong></summary>

The folder from Step 1 probably got moved or deleted. Put it back (or re-extract the zip), go to `chrome://extensions`, and click **Load unpacked** again.
</details>

---

## Good to know

- The extension only runs on `app.salesloft.com`. It can't see or touch any other website.
- It doesn't store your calls, contacts, or any prospect data anywhere. It just clicks the same buttons you would click, faster.
- The red button never logs a call without setting the disposition first — if any step fails, it stops and tells you, rather than logging something half-finished.
