# Salesloft Dialer Hotkeys

Make cadence calling faster. Instead of clicking End Call, picking a disposition and clicking Log & Complete after every no-answer, you press **one key** (or click one button) and it all happens for you.

<p align="center">
  <img src="extension/images/controls.png" alt="The dialer plate: a red No Answer button with the left arrow key beside a green Call button with the right arrow key, above a status line reading Connected and a call timer" width="268">
</p>

It also checks each contact before you dial. If Salesloft already has them tagged **Meeting Scheduled**, **Interested**, **Do Not Contact** or another tag you care about, a coloured alert says so above the buttons.

---

## Install

1. **Download it.** Click the green **Code** button at the top of this page, then **Download ZIP**.
2. **Unzip it.** On Windows, right-click the file and choose **Extract All**. On a Mac, double-click it.
3. **Put the folder somewhere permanent**, like Documents. Chrome runs the extension from this folder, so if it gets moved or deleted the extension stops working.
4. **Open Chrome's extensions page.** Type `chrome://extensions` in the address bar and press <kbd>Enter</kbd>.
5. **Turn on Developer mode** with the switch in the top-right corner.
6. **Click Load unpacked**, open the folder you unzipped, and select the folder inside it called **`extension`**.
7. **Pin it.** Click the puzzle piece 🧩 next to the address bar, then the pin 📌 next to **Salesloft Dialer Hotkeys**. Its icon opens the settings.
8. **Refresh Salesloft** if it was already open, then open any person's page.

✅ The red and green buttons appear in the bottom-left corner. You're done.

The buttons only appear where there's someone to dial: a person's page, or wherever you are while a call is up. You won't see them on your dashboard, a cadence, or the People list.

### Updating to a new version

1. Download the ZIP again and unzip it.
2. Replace the contents of your old folder with the new one (keep the folder in the same place).
3. On `chrome://extensions`, click the reload arrow ↻ on the **Salesloft Dialer Hotkeys** card.
4. Refresh your Salesloft tab.

The card on `chrome://extensions` shows which version you're running.

---

## Make calls

Start your cadence in Salesloft as usual. Then:

| You want to... | Press | Or click |
|---|---|---|
| Start the next call | <kbd>→</kbd> | the green **Call** button |
| End the call, log "No Answer", move on | <kbd>←</kbd> | the red **No Answer** button |

Only use the red button for no-answers. If someone picks up, end and log that call the normal way.

The line under the buttons tells you what's happening ("Ending call…", "Logged No Answer ✓"). Its dot turns green and it reads **Connected** while a call is up, with a timer on the right.

**Move it** by dragging the dark edge around the buttons. It stays where you leave it.

---

## Change your keys

1. Click the extension icon in your toolbar.
2. Under **Key bindings**, click the key next to an action.
3. Press the key you want. It saves straight away, and the button on the page changes to match.

- **Any key works**, including the number pad. Num Lock doesn't matter.
- **The keys work** on the Salesloft page and in the floating panel. They're ignored while you type in a box, so taking notes never dials anybody.
- **From another tab**, Chrome's own shortcuts do the same jobs (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>9</kbd> and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>0</kbd> unless another extension already has them). The settings list which ones Chrome actually gave you, and **Chrome shortcuts** opens the page to change them.
- **Clear a key** with the small ✕ next to it.

The key printed on each button is always the one that works, so you never have to remember it.

---

## Contact alerts

Before you dial, the extension reads the Disposition and Sentiment tags already on the contact's page. If it finds one on your watch list, a coloured band opens above the buttons (and in the floating panel, if you use it). It only reads what's on the page. Nothing is sent or saved.

Change which tags it watches in the settings under **Contact alerts**.

---

## Settings

Click the extension icon to open them.

| Setting | What it does |
|---|---|
| **Floating panel** | Puts the buttons in their own small window you can drag anywhere, even to a second monitor. It stays open while you work in other tabs. |
| **Buttons on Salesloft page** | Shows or hides the buttons on the page. Turn it off if you only use the floating panel or the keys. |
| **Compact bar** | Shrinks the buttons to a small bar while you're between calls. It opens back to full size during a call. |
| **Disposition** | What the red button logs. Starts as "No Answer". Only change it if your team's dropdown says something different, and match it exactly, capitals included. |
| **Key bindings** | Your key for each action. See [Change your keys](#change-your-keys). |
| **Alert on tags** | Turns contact alerts on or off. |
| **Tags to watch** | Which tags raise an alert, separated by commas and spelled exactly as Salesloft spells them. Starts with No Interest, Bad Fit, Meeting Scheduled, Interested, Connected, Wrong Number and Do Not Contact. |
| **Strict matching** | On by default. Only counts a tag where Salesloft shows it as a tag, so ordinary text like "we had a meeting scheduled last quarter" doesn't set it off. Turn it off only if you're missing alerts. |
| **Live transcription** | See below. |

---

## Live transcription (optional)

Shows what the prospect is saying, as text, while you're on the call. It runs entirely on your own computer. No audio is recorded, saved or sent anywhere. The setup files are for **Windows**.

### Set it up (once)

1. **Install Python** 3.10 or newer from [python.org](https://www.python.org/downloads/). On the installer's first screen, tick **Add python.exe to PATH**.
2. **Double-click `Install.cmd`** in the folder you downloaded.
3. **Wait** a few minutes until it says **"Setup complete"**, then close the window. If something goes wrong it stops and tells you what; see the **Setup** section of [docs/troubleshooting.md](docs/troubleshooting.md).

### Use it (each day)

1. **Double-click `Start Server.cmd`** and leave that window open. Closing it turns transcription off.
2. Click the extension icon and switch on **Live transcription**. Click **Test server** to check it's connected.
3. **Arm it once** by pressing <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>8</kbd> with the Salesloft tab in front. Until you do, the transcript says it's not armed. This is a Chrome rule, and once armed it stays armed.

The transcript appears beside the buttons and starts by itself when a call does. It keeps the last few calls, so you can look back at the previous one while dialing the next. You can shrink it to a thin strip, pause it, or save it with the ↓ button. Nothing is ever saved unless you click that.

> [!TIP]
> **Double-click `Auto-start.cmd`** to have the server start by itself every time you log in. Double-click it again to turn that off. It uses about 1 GB of memory while it runs.

---

## If something isn't working

<details>
<summary><strong>No buttons on the Salesloft page</strong></summary>

1. Make sure you're on a **person's page**. The buttons stay hidden on your dashboard, cadences and the People list.
2. Refresh the Salesloft tab.
3. Click the extension icon and check **Buttons on Salesloft page** is on.
4. You may have dragged them somewhere else. Check the edges of the page.
</details>

<details>
<summary><strong>Pressing the key does nothing</strong></summary>

1. Make sure a Salesloft tab is open.
2. Refresh it and try again.
3. Look at the button: the key printed on it is the one that works. If it's blank, that action has no key; set one in the settings.
</details>

<details>
<summary><strong>The line under the buttons says "Stopped"</strong></summary>

The extension couldn't find something it expected on the Salesloft page, usually because the page was slow to load. Finish that call by hand and carry on. If it happens on every call, Salesloft has probably changed its page and the extension needs an update; tell whoever gave it to you.
</details>

<details>
<summary><strong>A call was logged with the wrong disposition</strong></summary>

Check **Disposition** in the settings. It must match your Salesloft dropdown word for word.
</details>

<details>
<summary><strong>Missing an alert, or getting one you shouldn't</strong></summary>

- **Missing:** check the tag in **Tags to watch** matches Salesloft's wording exactly ("No Interest" and "Not Interested" are different). If it does, try turning **Strict matching** off.
- **Unwanted:** turn **Strict matching** on, or remove tags you don't need from **Tags to watch**.
</details>

<details>
<summary><strong>The extension disappeared after a restart</strong></summary>

The folder was probably moved or deleted. Put it back (or download it again), then go to `chrome://extensions` and click **Load unpacked** again.
</details>

Transcription problems (can't hear the prospect, "offline", falling behind) are covered in [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Good to know

- It only runs on `app.salesloft.com` and can't see any other website.
- It doesn't store your calls, contacts or prospect data. It clicks the same buttons you would, faster.
- It never logs a call without setting the disposition first. If any step fails, it stops and tells you rather than logging something half-finished.
- If transcription breaks, it goes quiet and the call carries on. It never interrupts you with a popup.
