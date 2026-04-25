# Installing YT → MP3

A friendly walkthrough for getting the app running on your machine.
If you just want to download a file and double-click it, this is for you.
No coding experience required.

> **What this app does:** converts YouTube videos to high-quality MP3
> audio. The MP3 encoding happens entirely on your computer — your
> audio never gets uploaded to anyone's server.

---

## Pick the right download

Go to the **[latest release page](https://github.com/naousislam/yt-mp3/releases/latest)**
and download the file that matches your computer:

| Your computer            | Download this file                                       |
| ------------------------ | -------------------------------------------------------- |
| Windows                  | **`yt-mp3-windows-x64.exe`**                             |
| Mac with Apple Silicon (M1, M2, M3, M4) | **`yt-mp3-macos-arm64`**                  |
| Mac with Intel chip      | **`yt-mp3-macos-arm64`** (yes, the same one — see below) |
| Linux (x64)              | **`yt-mp3-linux-x64`**                                   |

> **Not sure if your Mac is Intel or Apple Silicon?**
> Click the Apple menu → **About This Mac**. If it says "Chip: Apple
> M1/M2/M3/M4", you're on Apple Silicon. If it says "Processor: Intel",
> you're on Intel. Either way, download the same `yt-mp3-macos-arm64`
> file — Intel Macs run it through Rosetta 2.

The file is around **80–110 MB** depending on your platform. That's
because it ships its own copy of Node.js and yt-dlp inside, so you
don't need to install anything else. One file, no dependencies.

---

## Windows — first launch

1. Double-click `yt-mp3-windows-x64.exe`.

2. **Windows will warn you** that the publisher is unknown:

   > Windows protected your PC
   > Microsoft Defender SmartScreen prevented an unrecognized app from starting.

   This happens because the binary isn't signed with a paid Microsoft
   certificate (those cost ~$300/year). The app is safe — you can
   verify the source code on
   [GitHub](https://github.com/naousislam/yt-mp3) — but Windows is
   being cautious.

   **To run it anyway:**
   - Click **More info** (small text at the top of the dialog)
   - Click **Run anyway** (button that appears at the bottom)

3. A black console window will open. **Don't close it** — that window
   *is* the app. Closing it will stop the server.

4. After about 2 seconds, your default browser will open to
   <http://localhost:3000>. That's the app.

5. Use it. When you're done, **close the black console window** (the
   X in the top right) to fully quit.

---

## macOS — first launch

1. Open your **Downloads** folder in Finder.

2. **Make the file executable.** Right-click the file (or
   Control-click), choose **Get Info**, and... actually, the easiest
   way is in Terminal:

   - Open **Terminal** (press Cmd+Space, type "terminal", hit Enter)
   - Type or paste this and press Enter:

     ```sh
     chmod +x ~/Downloads/yt-mp3-macos-arm64
     ```

3. **Tell macOS this app is OK to run.** macOS quarantines unsigned
   apps downloaded from the internet. To unquarantine:

   ```sh
   xattr -d com.apple.quarantine ~/Downloads/yt-mp3-macos-arm64
   ```

   If that command says "no such xattr," that's fine — it just means
   macOS already trusts the file.

4. **Run it.** From Terminal:

   ```sh
   ~/Downloads/yt-mp3-macos-arm64
   ```

   Or, after step 2, you can double-click it from Finder. The first
   time you do, macOS may show a dialog saying *"yt-mp3-macos-arm64
   cannot be opened because the developer cannot be verified"*. If
   so:

   - Click **OK** to dismiss
   - Open **System Settings → Privacy & Security**
   - Scroll to the bottom — you'll see *"yt-mp3-macos-arm64 was blocked from use because it is not from an identified developer"*
   - Click **Open Anyway**
   - Confirm with your password / Touch ID

5. A Terminal window will open showing the app's status messages.
   Your browser opens to <http://localhost:3000>.

6. When you're done, **close the Terminal window** (Cmd+Q in Terminal,
   or the red close button) to quit the app.

> **For Intel Mac users:** the first time you run it, macOS will say
> *"This application requires Rosetta to run."* and offer to install
> it. Click **Install**, enter your password, wait ~20 seconds, and
> the app launches. Future launches are instant.

---

## Linux — first launch

1. Open a terminal in your downloads folder:

   ```sh
   cd ~/Downloads
   ```

2. Make the file executable:

   ```sh
   chmod +x yt-mp3-linux-x64
   ```

3. Run it:

   ```sh
   ./yt-mp3-linux-x64
   ```

4. Your default browser should open to <http://localhost:3000>
   automatically. If it doesn't, open that URL manually in any
   browser.

5. To quit: press **Ctrl+C** in the terminal, or close the terminal
   window.

> **If the browser doesn't open automatically**, install `xdg-utils`:
> `sudo apt install xdg-utils` (Debian/Ubuntu) or
> `sudo dnf install xdg-utils` (Fedora).

---

## Using the app

Once the page loads in your browser, the workflow is the same on
every platform:

1. **Copy a YouTube URL** from your browser's address bar (or right-click
   a video and choose "Copy video URL").

2. **Paste it** into the input box on the page. The "Paste" button
   inside the input box will pull from your clipboard if you'd
   rather click than press Ctrl+V.

3. **Click "Fetch"**. After a second or two, you'll see the video's
   title, thumbnail, channel name, duration, and file size.

4. **Pick a quality**: 128, 192, 256, or 320 kbps. Higher = better
   sound, bigger file.
   - 128 kbps: roughly podcast quality. ~1 MB per minute.
   - 192 kbps: a good balance for most music. ~1.5 MB per minute.
   - 256 kbps: noticeably better than 192 on good headphones.
   - 320 kbps: the highest MP3 supports. ~2.5 MB per minute.

5. **Click "Convert to MP3"**. You'll see a progress bar with three
   stages:
   - Downloading audio (the only part that uses the internet)
   - Decoding audio (a quick flash; happens locally)
   - Encoding MP3 (a few seconds; happens locally)

6. **The MP3 downloads automatically** to your normal downloads
   folder. If you want to download it again, click "Download again"
   on the success card.

The whole process takes around **5–15 seconds** for a typical music
video, depending on your computer's speed and internet connection.

---

## Limits and what's *not* supported

- **15 minutes maximum.** Longer videos are refused — partly to keep
  encoding fast, partly because YouTube's anti-bot systems are
  friendlier with shorter requests.
- **No live streams.** Live videos and premieres are refused.
- **No age-restricted videos.** YouTube requires sign-in for those,
  and we don't ask for your account.
- **No private videos** or videos you'd need to be logged in to
  watch.
- **No 4K, no video.** This app is audio-only; if you want video, use
  a different tool.

---

## Troubleshooting

### "YouTube is asking this server to sign in to confirm it isn't a bot"

YouTube occasionally rate-limits requests it thinks look automated.
This is rare on a home internet connection (it's mostly a problem on
servers / VPNs). If it happens:

- **Wait 5–10 minutes** and try again.
- **Try a different video** to confirm it's a YouTube-side block, not
  something specific to your network.
- **Restart your router** if you can — sometimes you'll get a new IP.

### "No suitable audio stream was found for this video"

Usually means yt-dlp's parser is briefly out of sync with a YouTube
update. yt-dlp ships fixes within hours of every YouTube change.
**Update your copy of the app** by downloading the latest release —
each release bundles a fresh yt-dlp.

### Conversions used to work, now they don't

Same as above: download the latest release. The bundled yt-dlp goes
stale every few months.

### The browser opens but the page won't load

Make sure the console window is still open. If it closed, the server
isn't running. Re-launch the app.

If the console is open but the page shows "This site can't be
reached," try:

- The URL printed in the console (it might be on a different port if
  3000 was already in use)
- Disabling any local firewall / antivirus temporarily — some flag
  Node servers as suspicious

### Antivirus quarantines the .exe

Some Windows antivirus tools (Avast, AVG, Norton) flag unsigned
single-file executables built with `pkg` as suspicious. They're
not — but you can verify yourself by reading the source on
[GitHub](https://github.com/naousislam/yt-mp3) and building it
yourself (see the README for instructions). To use the binary, add
an exception in your antivirus or whitelist the file.

### Mac says "the application can't be opened"

You skipped the `chmod +x` step. Run that command again, then try
launching.

### "What if I want to uninstall?"

There's no installer; there's nothing installed. Just delete:

- The downloaded binary itself (e.g.
  `~/Downloads/yt-mp3-windows-x64.exe`)
- The `.yt-mp3` folder in your home directory (this is where the
  bundled yt-dlp gets extracted on first run; it's about 18 MB)

That's it. No registry keys, no system files, no leftovers.

---

## Updating

When YouTube changes something and conversions stop working
(typically every 1–3 months), download the latest release, replace
your old binary with the new one, and **delete the `.yt-mp3` folder
in your home directory** so the new release's bundled yt-dlp gets
extracted fresh.

That's the whole update process. There's no auto-updater — if you
want a notification when a new release is available, click "Watch"
→ "Custom" → "Releases" on the
[GitHub repo](https://github.com/naousislam/yt-mp3).

---

## Privacy

- **Audio never leaves your computer's network.** The server proxies
  YouTube → your browser. The browser then encodes the MP3 locally.
  No third party touches the audio.
- **No analytics, no telemetry, no phone-home.** The app makes
  network requests only to YouTube (for the video) and to your
  browser (for the page). That's it.
- **No accounts, no cookies, no signup.** The app doesn't know who
  you are.

You can verify all of the above by reading the source on
[GitHub](https://github.com/naousislam/yt-mp3) — it's about 1,500
lines of TypeScript.

---

## Legal stuff

Downloading content from YouTube generally violates
[YouTube's Terms of Service](https://www.youtube.com/t/terms) unless
you own the content, the content is in the public domain, or YouTube
provides a download button for it.

This app is intended for **personal use** with content you have the
right to download. You're responsible for how you use it.

---

## Still stuck?

Open an issue on [GitHub](https://github.com/naousislam/yt-mp3/issues)
with:

- Your OS and OS version
- The exact text of any error message (from the page or the console
  window)
- The video URL you were trying to convert

If you don't have a GitHub account, ask whoever sent you the link to
this app for help.