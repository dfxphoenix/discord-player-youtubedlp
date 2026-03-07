# Discord Player YouTubeDlp

A YouTube extractor for **Discord Player 7+** that uses **youtubei.js** for fast search and metadata resolution, then falls back to **yt-dlp** when needed. Audio streaming is done through **yt-dlp + FFmpeg**.

It supports:

- single YouTube videos
- YouTube playlists
- text search
- direct streaming
- bridging from other extractors to YouTube
- related tracks
- cookies, browser sessions and proxy support

> This extractor uses the same internal YT-DLP helper/backend as [@bleah/discord-player](https://www.npmjs.com/package/@bleah/discord-player), adapted for this standalone Discord Player extractor.

## Installation

```bash
npm install discord-player-youtubedlp
```

You also need [discord-player](https://www.npmjs.com/package/discord-player) in your project.

## Requirements

This extractor requires:

- **FFmpeg** for audio transcoding
- **yt-dlp** for extraction and streaming

### FFmpeg
You can:
- install the system `ffmpeg` binary
- or use `ffmpeg-static`

```sh
npm install ffmpeg-static
```

### yt-dlp
You can:
- install the system `yt-dlp` binary
- or rely on the bundled fallback from `ytdlp-nodejs`

In most cases, manual installation is not required if the bundled setup works correctly on your system.

## Optional dependencies

### prism-media
`prism-media` is optional and only useful if you want Opus re-encoding.

If `prism-media` is installed, you should also have an Opus backend available, such as:

- `@discordjs/opus` (recommended)
- or `opusscript`

If `prism-media` is not installed, the extractor falls back to FFmpeg for Opus output.

For normal extractor usage, `prism-media` is not required.

#### Install prism-media
```sh
npm install prism-media @discordjs/opus
```

Or, if you prefer `opusscript`:

```sh
npm install prism-media opusscript
```

### mediaplex
`mediaplex` is not required for this extractor, but it can be useful in Discord Player setups that also play local files, because it can probe media metadata such as title, author, and duration.

## Basic usage

### CommonJS

```js
const { Player } = require("discord-player");
const { YouTubeDlpExtractor } = require("discord-player-youtubedlp");

const player = new Player(client);

await player.extractors.register(YouTubeDlpExtractor, {});
```

### ESM

```js
import { Player } from "discord-player";
import { YouTubeDlpExtractor } from "discord-player-youtubedlp";

const player = new Player(client);

await player.extractors.register(YouTubeDlpExtractor, {});
```

## What it does

### Search

For text queries, the extractor tries `youtubei.js` first. If that fails or returns nothing useful, it falls back to yt-dlp search.

Examples:

```js
await player.play(channel, "linkin park numb");
await player.play(channel, "vescan andrei banuta");
```

### Single videos

Supports normal YouTube URLs, short URLs and Shorts-style video IDs.

```js
await player.play(channel, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
await player.play(channel, "https://youtu.be/dQw4w9WgXcQ");
```

### Playlists

Supports standard YouTube playlists.

```js
await player.play(channel, "https://www.youtube.com/playlist?list=PL1234567890");
await player.play(channel, "https://www.youtube.com/watch?v=abc123&list=PL1234567890");
```

### Bridge support

If another extractor gives Discord Player a track without a usable YouTube stream, this extractor can try to find a matching YouTube result and stream that instead.

By default, the bridge query is:

```txt
<track title> <track author> official audio
```

### Related tracks

The extractor can return related tracks by searching YouTube using the bridge query and filtering obvious duplicates.

## Supported features

| Feature | Supported |
| --- | --- |
| Single tracks | ✅ |
| Playlists | ✅ |
| Search | ✅ |
| Direct streaming | ✅ |
| Can be used as a bridge | ✅ |
| Related tracks | ✅ |

## Options

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `agent` | `AgentOptions \| string \| null` | `null` | Network/auth options for yt-dlp and FFmpeg. Useful for cookies, proxies and browser sessions. |
| `searchLimit` | `number` | `1` | Number of tracks returned for normal text search. |
| `playlistSearchLimit` | `number` | unlimited | Maximum number of playlist entries turned into tracks. |
| `relatedLimit` | `number` | `5` | Maximum number of tracks returned by `getRelatedTracks()`. |
| `enableProtocols` | `boolean` | `true` | Registers `youtube`, `youtu.be`, `ytsearch`, `ytvideo`, `ytplaylist`. |
| `searchTimeoutMs` | `number` | `6000` | Timeout for `youtubei.js` search. Minimum effective value: `1200`. |
| `videoTimeoutMs` | `number` | `7000` | Timeout for `youtubei.js` video info. Minimum effective value: `1500`. |
| `playlistTimeoutMs` | `number` | `25000` | Timeout for playlist loading. Minimum effective value: `8000`. |
| `ytdlpTimeoutMs` | `number` | `25000` | Timeout for yt-dlp fallback metadata calls. Minimum effective value: `3000`. |
| `infoCacheTtlMs` | `number` | `120000` | In-memory cache lifetime for search, video and playlist metadata. Minimum effective value: `5000`. |
| `debug` | `boolean` | `false` | Enables extractor logs for search, fallback and resolver flow. |

## Option details

### `agent`

Use this when you need cookies, browser login sessions, a proxy or custom request behavior.

Supported fields:

- `proxyUri`
- `cookiesFromBrowser`
- `cookiesFile`
- `cookiesJsonPath`
- `cookiesHeader`
- `cookies`
- `noUA`
- `forceIPv4`
- `autoCookiesFromBrowser`

Examples:

```js
await player.extractors.register(YouTubeDlpExtractor, {
    agent: {
        cookiesFromBrowser: "chrome"
    }
});
```

```js
await player.extractors.register(YouTubeDlpExtractor, {
    agent: {
        proxyUri: "http://127.0.0.1:8080",
        cookiesFile: "/path/to/cookies.txt"
    }
});
```

```js
await player.extractors.register(YouTubeDlpExtractor, {
    agent: {
        cookies: [
        {
            domain: ".youtube.com",
            expirationDate: 1234567890,
            hostOnly: false,
            httpOnly: true,
            name: "LOGIN_INFO",
            path: "/",
            sameSite: "no_restriction",
            secure: true,
            session: false,
            value: "---xxx---",
        },
        "...",
        ]
    }
});
```

```js
await player.extractors.register(YouTubeDlpExtractor, {
    agent: "SID=abc; HSID=def"
});
```

#### How to get cookies

- Install [Get cookies.txt LOCALLY](https://github.com/kairi003/Get-cookies.txt-LOCALLY) extension for your browser.
- Go to [YouTube](https://www.youtube.com/).
- Log in to your account. (You should use a new account for this purpose)
- Change the export format to JSON.
- Click on the extension icon and click "Copy" button.
- Your cookie will be added to your clipboard and paste it into your code.

### `searchLimit`

Controls how many tracks are returned for a normal text search.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    searchLimit: 5
});
```

### `playlistSearchLimit`

Useful when you want to avoid adding an entire large playlist into the queue.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    playlistSearchLimit: 100
});
```

### `relatedLimit`

Controls how many tracks are returned when Discord Player asks this extractor for related songs.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    relatedLimit: 10
});
```

### `enableProtocols`

When enabled, the extractor registers these protocol names:

- `youtube`
- `youtu.be`
- `ytsearch`
- `ytvideo`
- `ytplaylist`

Disable this only if you do not want protocol-based access for this extractor.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    enableProtocols: false
});
```

### Timeouts

These control how long the extractor waits before falling back or aborting a metadata request.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    searchTimeoutMs: 6000,
    videoTimeoutMs: 7000,
    playlistTimeoutMs: 25000,
    ytdlpTimeoutMs: 25000
});
```

### `infoCacheTtlMs`

Search results, video info and playlist metadata are cached in memory. Increase this if you want fewer repeated metadata requests.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    infoCacheTtlMs: 120000
});
```

### `debug`

Enables internal logs so you can see whether the extractor used `youtubei.js` or a yt-dlp fallback.

```js
await player.extractors.register(YouTubeDlpExtractor, {
    debug: true
});
```

## Full example

```js
import { Player } from "discord-player";
import { YouTubeDlpExtractor } from "discord-player-youtubedlp";

const player = new Player(client);

await player.extractors.register(YouTubeDlpExtractor, {
    agent: {
        /**
         * Global proxy (http/https/socks). Example: "http://user:pass@host:8080"
         * Leave undefined if you don't need a proxy.
         */
        proxyUri: undefined,

        /**
         * Pull cookies from a local browser profile ('chrome' | 'brave' | 'firefox' | 'edge').
         * Helpful for age-gated or region-locked content.
         */
        cookiesFromBrowser: undefined,

        /** Path to Netscape cookies.txt (used by yt-dlp --cookies). */
        cookiesFile: undefined,

        /** Path to cookies.json (array). Will be auto-converted to cookies.txt. */
        cookiesJsonPath: undefined,

        /**
         * Raw 'Cookie' header (takes priority over 'cookies' when building request headers).
         * If no other cookie sources are provided (browser/file/json),
         * it will also be used to generate a temporary cookies.txt file (fallback)
         * and is passed as an HTTP header.
         */
        cookiesHeader: undefined,

        /**
         * Cookies - supported in two main modes:
         *
         * (A) SIMPLE PAIRS / HEADER-LIKE  
         *   - string: "SID=xxx; HSID=yyy"  
         *   - object: { SID: "xxx", HSID: "yyy" }  
         *   - array: [{ name: "SID", value: "xxx" }, ...]  
         *   Behavior: a 'Cookie:' header is always forwarded to yt-dlp/FFmpeg, and a temporary
         *   synthetic cookies.txt (with expires=0) is auto-generated to help bypass age-restricted videos.
         *   These sessions are short-lived (hours to a few days) since no 'expires' or domain/path metadata is preserved.
         *
         * (B) FULL COOKIE ARRAY (persistent; preserves domain/path/secure/expires metadata)  
         *   - array: [{ name, value, domain, path, secure, expires }, ...]  
         *   Behavior: converted into a Netscape cookies.txt file preserving all attributes
         *   (equivalent to what yt-dlp expects from '--cookies'). These sessions persist according
         *   to each cookie’s own 'expires' timestamp — often days, weeks, or months.
         *
         * NOTES:
         *  - JSON strings like "[{...}]" or "{...}" are NOT supported — use a real JS array instead.
         *  - If 'cookiesFromBrowser', 'cookiesFile', or 'cookiesJsonPath' are provided, they take priority.
         *  - A plain object like '{ SID: "...", HSID: "..." }' is treated as a simple map → mode (A).
         *  - Priority (highest -> lowest):
         *      cookiesFromBrowser > cookiesFile > cookiesJsonPath > full array > header/simple pairs
         */
        cookies: undefined,

        /** If true, do not set a browser-like default User-Agent.
         * Defaults to 'false'.
         */
        noUA: false,

        /** Force IPv4 in yt-dlp requests (can help with some networks/ISPs).
         * Defaults to 'false'.
         */
        forceIPv4: false,

        /**
         * If 'true', attempt to auto-detect a local browser profile (Chrome/Brave/Edge/Firefox)
         * and instruct yt-dlp to use its cookies (equivalent to '--cookies-from-browser').
         * - Useful to reuse an existing signed-in session without manually exporting cookies.
         * - If detection fails or the option is 'false', no browser profile will be used.
         * Defaults to 'true'.
         */
        autoCookiesFromBrowser: true
    },
    searchLimit: 3,
    playlistSearchLimit: 200,
    relatedLimit: 5,
    enableProtocols: true,
    searchTimeoutMs: 6000,
    videoTimeoutMs: 7000,
    playlistTimeoutMs: 25000,
    ytdlpTimeoutMs: 25000,
    infoCacheTtlMs: 120000,
    debug: false
});
```

## Exported helpers

The package also re-exports helper functions from `YTDLP.ts`, including:

- `setFFmpegPath(path)`
- `setYtDlpPath(path)`

Example:

```js
import { setFFmpegPath, setYtDlpPath } from "discord-player-youtubedlp";

setFFmpegPath("/usr/bin/ffmpeg");
setYtDlpPath("/usr/local/bin/yt-dlp");
```

## Notes

- Metadata resolution uses `youtubei.js` first and falls back to yt-dlp when needed.
- Audio streaming itself is done through yt-dlp + FFmpeg.
- Standard playlists are supported.
- Mix-style YouTube lists are currently treated as single videos, not expanded as full playlists.
