# Capri

Capri from *Cyberpunk: Edgerunners 2*, living on your Windows desktop. She talks back, moves when you ask, glitches across your screen and does real things on your PC.

**[Watch the trailer and join the beta](https://theagencymge.github.io/capri/)** · **[Download 0.2.0 beta](https://github.com/TheAgencyMGE/capri-companion/releases)**

![Capri on the desktop, chatting](docs/screenshots/desktop.jpg)

> Unofficial fan project. Not affiliated with CD PROJEKT RED, Studio Trigger or Netflix.

## What she does

- **Lives on your desktop.** Always on top, never steals focus, follows your cursor with her eyes, sits on your windows, lies on the taskbar, falls asleep when you're away, hides during fullscreen games and video.
- **Talks to you.** Type or push-to-talk. Google Gemini by default, or a local model through Ollama, or any OpenAI-compatible API. She only speaks when you talk to her.
- **Teleports.** Ask her to move and her window glitches apart and reassembles somewhere else on the screen.
- **Does real things.** Opens apps you approve, opens websites, sets timers and reminders, saves notes, searches files. Anything that matters asks first.
- **Uses your PC.** Ask her to do something ("open Calculator and work out 12 times 7") and, once you allow it, she looks at your screen and drives the mouse and keyboard herself, flying along beside whatever she's working on.
- **Explores on her own** (off until you turn it on). When you've been away a while she opens a site, reads, scrolls and clicks around, comments in her bubble, and leaves you a note in the chat. Read only: she can't type, sign in or post.
- **Reacts to you.** Poke her, pat her head, drag her around, fling her across the screen.

![Teleport](docs/screenshots/teleport.jpg)

![Expressions](docs/screenshots/expressions.jpg)

![Poses](docs/screenshots/poses.jpg)

## Install

1. Download `Capri-Setup-0.2.0.exe` from the [Releases page](https://github.com/TheAgencyMGE/capri-companion/releases) and run it. It installs for your user only, no admin needed.
2. The installer isn't code-signed yet, so Windows SmartScreen will warn. Choose **More info → Run anyway**.
3. On first launch, pick her brain:
   - **Google Gemini** (recommended): get a free key at [aistudio.google.com](https://aistudio.google.com/apikey) and paste it in **Model**. It's stored encrypted on your PC.
   - **Ollama** (free, runs locally): install [Ollama](https://ollama.com), run `ollama pull llama3.2`, then pick Ollama.
   - **No AI**: timers, reminders, notes and opening apps still work with plain commands.

Requires Windows 10 or 11, 64-bit.

## Controls

| Do this | To |
|---|---|
| Double-click her, or `Ctrl+Alt+Space` | open the chat |
| `Ctrl+Alt+T` | push-to-talk |
| `Ctrl+Alt+P` | teleport her |
| `Ctrl+Alt+H` | hide or show her |
| Drag her | move her; drop her on a window's top edge and she sits on it |
| Right-click her or the tray icon | menu |

If another app already uses a shortcut, Capri switches to `Ctrl+Alt+K / Y / O / J` instead. **System → Shortcuts** shows which ones are active.

Things to try: "come sit on the left side of my screen", "open the calculator", "set a timer for 25 minutes", "remind me to stretch at 3pm", "note: buy coffee", "what can you do?".

![Settings](docs/screenshots/panel.png)

## Beta 0.2.0

New: she can use your PC herself, and explore on her own while you're away. Both need a Gemini key.

- **Stopping her:** hold **Esc**, press stop in the chat, or just move your mouse. She stops at once.
- **What she won't do:** type passwords or card numbers, buy, delete files, send messages, or change system settings. She ignores instructions written on web pages. Every task asks for your OK first (**Privacy → Use your computer** controls that).
- **Exploring:** turn it on in **Character → Explore on her own while I'm away** and set how long you need to be idle.

If you want to test new builds first, [sign up on the site](https://theagencymge.github.io/capri/). Bugs and ideas go in [Issues](https://github.com/TheAgencyMGE/capri-companion/issues).

Coming next: sitting on the text box you're typing in, reading your screen, mischief mode, a study timer, voice lines with mute.

## Build from source

Needs Node.js 22+ on Windows 10/11 x64.

```bash
npm ci
npm start
```

| Command | Does |
|---|---|
| `npm test` | unit tests |
| `npm run test:e2e` | end-to-end tests in Electron, off-screen |
| `npm run dist` | builds `release/Capri-Setup-<version>.exe` |
| `npm run verify:package` | installs the build silently, tests it, uninstalls |

To use Gemini while developing, put `GEMINI_API_KEY=your-key` in `.env.local` (git-ignored, never packaged).

More: [architecture](docs/ARCHITECTURE.md) · [security and privacy](docs/SECURITY.md) · [testing](docs/TESTING.md) · [troubleshooting](docs/TROUBLESHOOTING.md) · [how her art is made](assets/capri/SOURCES.md)

## Privacy

Everything stays on your PC in `%APPDATA%\Capri`. API keys are encrypted with Windows DPAPI. There's no telemetry. Your messages go only to the AI provider you choose.

## License

The code is [MIT](LICENSE). Capri, her design and the reference frames she's traced from belong to CD PROJEKT RED, Studio Trigger and Netflix and are not covered by the MIT license. This is a non-commercial fan project; if you're a rights holder and want something removed, open an issue.
