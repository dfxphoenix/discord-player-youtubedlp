import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import type { Readable, Duplex } from 'stream';
import { PassThrough } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { YtDlp } from 'ytdlp-nodejs';

/* =========================================================
 * yt-dlp instance
 * =======================================================*/
const core = new YtDlp();

/* =========================================================
 * Public types
 * =======================================================*/
export type YTDLPDownloadOptions = Record<string, unknown>;

/**
 * Network/auth options translated to yt-dlp flags (and, for direct URLs, to FFmpeg headers).
 * These options let you pass cookies, user agent, proxy, and IPv4 forcing to both yt-dlp and ffmpeg.
 */
export interface AgentOptions {
    /** Proxy URL: http://user:pass@host:port or socks5://host:port */
    proxyUri?: string;

    /** Ask yt-dlp to use cookies exported from a browser profile */
    cookiesFromBrowser?: 'chrome' | 'brave' | 'firefox' | 'edge';

    /** Path to Netscape-format cookies.txt (yt-dlp --cookies <file>) */
    cookiesFile?: string;

    /** Path to cookies.json (array of cookie objects). We convert it to a temp cookies.txt for yt-dlp */
    cookiesJsonPath?: string;

    /** Raw cookie header to send: takes precedence over `cookies` if provided */
    cookiesHeader?: string;

    /**
     * Cookies:
     *  - string/map: "SID=...; HSID=..." or { SID:"...", HSID:"..." }
     *    sent as a `Cookie:` header and also written to a temporary cookies.txt (expires=0).
     *  - array: [{ name, value, domain?, path?, secure?, expires? }, ...]
     *    converted to a Netscape cookies.txt file (preserves all attributes).
     *
     * Note: JSON strings like "[{...}]" are NOT supported — use a real JS array instead.
     * Priority: cookiesFromBrowser > cookiesFile > cookiesJsonPath > array > header/simple pairs.
     */
    cookies?:
        | string
        | Record<string, string>
        | Array<{ name: string; value: string; domain?: string; path?: string; secure?: boolean; expires?: number; expirationDate?: number; }>
        ;

    /** If true, do NOT set a browser-like default User-Agent */
    noUA?: boolean;

    /** Force IPv4 for yt-dlp (FFmpeg has no perfect equivalent; see comments below) */
    forceIPv4?: boolean;

    /** Auto-detect and use cookies from the local browser profile. */
    autoCookiesFromBrowser?: boolean;
}

/**
 * PCM/transcode options for createPCMStream/arbitraryStream
 */
interface YTDLPStreamOptions extends YTDLPDownloadOptions {
    /** Start offset in seconds (applied in FFmpeg) */
    seek?: number;

    /** Additional FFmpeg encoder/filter args, e.g. ["-af","bass=g=10"] */
    encoderArgs?: string[];

    /**
     * Output container/format:
     * - For Discord voice: keep 's16le' (raw PCM 48k stereo)
     * - For file recording: 'mp3'/'wav' etc.
     * Default: 's16le'
     */
    fmt?: string;

    /** If true, re-encode the final PCM to Opus (via prism-media if present, else via FFmpeg) */
    opusEncoded?: boolean;

    /** Network/auth options (proxy, cookies, ...) */
    agent?: AgentOptions | string | null;

    /** Optional AbortSignal to cancel underlying processes/pipes */
    signal?: AbortSignal;
}

/* =========================================================
 * Prism (Opus) + FFmpeg path
 * =======================================================*/
let PRISM_OPUS_ENCODER: any = null;
try {
    const prism = require('prism-media');
    PRISM_OPUS_ENCODER = prism.opus?.Encoder ?? null;
} catch {}

/** Use ffmpeg-static if available, else fallback to system ffmpeg */
let FFMPEG_BIN = ((): string => {
    try {
        const staticPath = require('ffmpeg-static');
        if (staticPath) return staticPath;
    } catch {}
    return 'ffmpeg';
})();
export function setFFmpegPath(p: string) { FFMPEG_BIN = p; }
function getFFmpegPath(): string { return FFMPEG_BIN; }

/* =========================================================
 * Cookie/proxy helpers => yt-dlp runner options
 * =======================================================*/
/** Normalizes expiration to seconds (also handles ms timestamps). */
function toSec(exp: any): number {
    if (typeof exp !== 'number') return 0;
    return exp > 2_147_483_647 ? Math.floor(exp / 1000) : Math.floor(exp);
}

/**
 * Best-effort default browser profile discovery.
 * Returns an identifier like "chrome:Default" or "firefox:xyz.default-release".
 */
function detectBrowserProfile(): string | null {
    const home = os.homedir();
    const platform = process.platform;
    type Candidate = { id: string; profile?: string; paths: string[] };
    const cands: Candidate[] = [];

    if (platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const roaming = process.env.APPDATA || '';
        cands.push(
            { id: 'chrome', profile: 'Default', paths: [path.join(local, 'Google/Chrome/User Data/Default')] },
            { id: 'edge', profile: 'Default', paths: [path.join(local, 'Microsoft/Edge/User Data/Default')] },
            { id: 'brave', profile: 'Default', paths: [path.join(local, 'BraveSoftware/Brave-Browser/User Data/Default')] },
        );
        const ffIni = path.join(roaming, 'Mozilla/Firefox/profiles.ini');
        if (fs.existsSync(ffIni)) {
            try {
                const txt = fs.readFileSync(ffIni, 'utf8');
                const m = txt.match(/Path=(.+?\.default.*)/i);
                if (m) {
                    const p = m[1].trim().replace(/\\/g, '/');
                    const full = path.join(roaming, 'Mozilla/Firefox', p);
                    cands.push({ id: 'firefox', profile: p.split('/').pop(), paths: [full] });
                }
            } catch {}
        }
    } else if (platform === 'darwin') {
        cands.push(
            { id: 'chrome', profile: 'Default', paths: [path.join(home, 'Library/Application Support/Google/Chrome/Default')] },
            { id: 'edge', profile: 'Default', paths: [path.join(home, 'Library/Application Support/Microsoft Edge/Default')] },
            { id: 'brave', profile: 'Default', paths: [path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/Default')] },
        );
        const ffBase = path.join(home, 'Library/Application Support/Firefox');
        const ffIni = path.join(ffBase, 'profiles.ini');
        if (fs.existsSync(ffIni)) {
            try {
                const txt = fs.readFileSync(ffIni, 'utf8');
                const m = txt.match(/Path=(.+?\.default.*)/i);
                if (m) {
                    const p = m[1].trim();
                    cands.push({ id: 'firefox', profile: p.split('/').pop(), paths: [path.join(ffBase, p)] });
                }
            } catch {}
        }
    } else {
        cands.push(
            { id: 'chrome', profile: 'Default', paths: [path.join(home, '.config/google-chrome/Default'), path.join(home, '.config/chromium/Default')] },
            { id: 'brave', profile: 'Default', paths: [path.join(home, '.config/BraveSoftware/Brave-Browser/Default')] },
        );
        const ffIni = path.join(home, '.mozilla/firefox/profiles.ini');
        if (fs.existsSync(ffIni)) {
            try {
                const txt = fs.readFileSync(ffIni, 'utf8');
                const m = txt.match(/Path=(.+?\.default.*)/i);
                if (m) {
                    const p = m[1].trim();
                    cands.push({ id: 'firefox', profile: p.split('/').pop(), paths: [path.join(home, '.mozilla/firefox', p)] });
                }
            } catch {}
        }
    }

    for (const c of cands) if (c.paths.some(p => fs.existsSync(p))) return c.profile ? `${c.id}:${c.profile}` : c.id;
    return null;
}

/** Normalizes any cookie representation to an HTTP Cookie header string. */
function normalizeCookieHeader(input: AgentOptions['cookies'] | string | null | undefined): string | null {
    if (!input) return null;
    if (typeof input === 'string') return input.trim();
    if (Array.isArray(input)) {
        const parts: string[] = [];
        for (const c of input) if (c?.name && c?.value != null) parts.push(`${c.name}=${c.value}`);
        return parts.length ? parts.join('; ') : null;
    }
    if (typeof input === 'object') {
        const parts = Object.entries(input).map(([k, v]) => `${k}=${String(v)}`);
        return parts.length ? parts.join('; ') : null;
    }
    return null;
}

/** Converts a JSON cookies array (Chrome-like exports) into Netscape format. */
function cookiesJsonToNetscape(arr: Array<any>) {
    const header = [
        '# Netscape HTTP Cookie File',
        '# Generated by YTDLP bridge',
        '# <domain>\t<flag>\t<path>\t<secure>\t<expiration>\t<name>\t<value>'
    ].join('\n');
    const map = new Map<string, string>(); // key -> line

    for (const c of arr) {
        const name = String(c.name ?? '').trim();
        if (!name) continue;
        const value = String(c.value ?? '').trim();
        if (value === '') continue;

        let domain = String(c.domain ?? '').trim();
        if (!domain) domain = '.youtube.com';
        // Normalize common exports that omit leading dot
        if (!domain.startsWith('.') && !domain.includes(':')) {
            // keep as-is (yt-dlp cookiejar handles both), but for youtube prefer dot-domain
            if (domain === 'youtube.com') domain = '.youtube.com';
            if (domain === 'google.com') domain = '.google.com';
        }

        const pathV = String(c.path ?? '/');
        const secureBool = (typeof c.secure === 'boolean')
            ? c.secure
            : (name.startsWith('__Secure-') || name.startsWith('__Host-'));
        const secure = secureBool ? 'TRUE' : 'FALSE';
        const exp = toSec(c.expires ?? c.expirationDate ?? c.expiration ?? 0);
        const flag = domain.startsWith('.') ? 'TRUE' : 'FALSE';

        const line = [domain, flag, pathV || '/', secure, exp, name, value].join('\t');
        const key = `${domain}|${pathV}|${name}`;
        map.set(key, line);
    }

    return `${header}\n${Array.from(map.values()).join('\n')}\n`;
}

/** Writes a temporary Netscape cookies.txt converted from a JSON file. */
function writeTempCookiesTxtFromJson(jsonPath: string) {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) throw new Error('cookies.json must be an array of cookie objects');
    const netscape = cookiesJsonToNetscape(arr);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-'));
    const file = path.join(dir, 'cookies.txt');
    fs.writeFileSync(file, netscape, 'utf8');
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    return { file, cleanup };
}

/** Validates that an array looks like a full cookie array (not just name=value pairs). */
function isFullCookieArray(arr: any[]): boolean {
    return Array.isArray(arr) && arr.length > 0 && arr.every(c =>
        c && typeof c === 'object' &&
        typeof c.name === 'string' &&
        ('value' in c) &&
        ('domain' in c || 'path' in c || 'secure' in c || 'expires' in c || 'expirationDate' in c)
    );
}

/** Writes temp cookies.txt from an in-memory cookie array. */
function writeTempCookiesTxtFromArray(arr: Array<any>) {
    const netscape = cookiesJsonToNetscape(arr);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-'));
    const file = path.join(dir, 'cookies.txt');
    fs.writeFileSync(file, netscape, 'utf8');
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    return { file, cleanup };
}

/** Parses a Cookie header string into name=value pairs. */
function parseCookieHeaderPairs(h: string): Array<{name:string,value:string}> {
    return h.split(';').map(s => s.trim()).filter(Boolean).map(p => {
        const i = p.indexOf('=');
        if (i < 0) return null;
        const name = p.slice(0, i).trim();
        const value = p.slice(i + 1).trim();
        return name ? { name, value } : null;
    }).filter(Boolean) as Array<{name:string,value:string}>;
}

/** Creates a Netscape file text from header pairs, mirrored to common YT domains. */
function pairsToNetscapeTxt(pairs: Array<{name:string,value:string}>, domains = ['.youtube.com', '.music.youtube.com', '.youtube-nocookie.com', '.google.com', '.googlevideo.com', '.youtubei.googleapis.com']) {
    const header = ['# Netscape HTTP Cookie File', '# Generated from Cookie header (best-effort)'].join('\n');
    const lines: string[] = [];
    for (const d of domains) {
        const flag = d.startsWith('.') ? 'TRUE' : 'FALSE';
        for (const { name, value } of pairs) {
            const secure = name.startsWith('__Secure-') ? 'TRUE' : 'FALSE';
            lines.push([d, flag, '/', secure, 0, name, value].join('\t')); // 0 = session
        }
    }
    return `${header}\n${lines.join('\n')}\n`;
}

/** Writes a temporary cookies.txt file from Cookie header pairs. */
function writeTempCookiesTxtFromPairs(pairs: Array<{name:string,value:string}>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dlp-'));
    const file = path.join(dir, 'cookies.txt');
    fs.writeFileSync(file, pairsToNetscapeTxt(pairs), 'utf8');
    const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
    return { file, cleanup };
}

/**
 * Convert AgentOptions into yt-dlp runner options, possibly creating temp cookies files.
 * Returns { opt, cleanup } where cleanup removes any generated temp files.
 */
function agentToRunnerOptions(agent?: AgentOptions | string | null) {
    const a: AgentOptions = typeof agent === 'string' ? { cookiesHeader: agent } : (agent ?? {});
    const opt: any = {};
    let cleanup: (() => void) | null = null;

    if (a.proxyUri) opt.proxy = a.proxyUri;
    if (a.forceIPv4) opt.forceIpv4 = true;

    opt.addHeader = Array.isArray(opt.addHeader) ? opt.addHeader : [];

    if (a.cookiesFromBrowser) {
        opt.cookiesFromBrowser = a.cookiesFromBrowser;
    } else if (a.cookiesFile) {
        opt.cookies = a.cookiesFile;
    } else if (a.cookiesJsonPath) {
        const tmp = writeTempCookiesTxtFromJson(a.cookiesJsonPath);
        opt.cookies = tmp.file;
        cleanup = tmp.cleanup;
    } else if (Array.isArray((a as any).cookies) && isFullCookieArray((a as any).cookies as any[])) {
        const tmp = writeTempCookiesTxtFromArray((a as any).cookies as any[]);
        opt.cookies = tmp.file;
        cleanup = tmp.cleanup;
    } else {
        const headerRaw = a.cookiesHeader ?? normalizeCookieHeader(a.cookies);
        const header = headerRaw?.trim();

        if (header) {
            try {
                const pairs = parseCookieHeaderPairs(header);
                if (pairs.length) {
                    const tmp = writeTempCookiesTxtFromPairs(pairs);
                    opt.cookies = tmp.file;
                    cleanup = ((prev) => () => { try { tmp.cleanup(); } finally { prev(); } })(cleanup ?? (() => {}));
                }
            } catch {}
            if (!opt.cookies) opt.addHeader.push(`Cookie: ${header}`);
        } else {
            const auto = (a.autoCookiesFromBrowser ?? true) ? detectBrowserProfile() : null;
            if (auto) opt.cookiesFromBrowser = auto;
        }

    }

    // Helpful defaults for YT/Google endpoints
    opt.addHeader.push('Referer: https://www.youtube.com');
    opt.addHeader.push('Origin: https://www.youtube.com');
    opt.addHeader.push('Accept-Language: en-US,en;q=0.9');

    if (!a.noUA) {
        opt.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
    }
    return { opt, cleanup: cleanup ?? (() => {}) };
}

/* =========================================================
 * FFmpeg helpers (always spawn so we can kill)
 * =======================================================*/
/** Builds a minimal, low-latency FFmpeg arg list for PCM/Opus transcoding. */
function makeFFmpegArgs(fmt = 's16le', seek = 0, encoderArgs: string[] = []) {
    const hasAudioFilter =
        encoderArgs.includes('-af') ||
        encoderArgs.includes('-filter:a') ||
        encoderArgs.includes('-lavfi');

    const base: string[] = [
        ...(seek > 0 ? ['-ss', String(seek)] : []),
        '-vn', '-sn', '-dn',
        ...(!hasAudioFilter ? ['-af', 'aresample=48000,asetpts=N/SR/TB'] : []),
        '-ar', '48000',
        '-ac', '2',
        ...(fmt === 's16le'
            ? ['-f', 's16le', '-acodec', 'pcm_s16le']
            : ['-f', fmt]),
    ];

    return base.concat(encoderArgs);
}

function buildFFmpegHeaders(addHeader: string[] | undefined) {
    const headers = (addHeader || []).filter(Boolean);
    if (!headers.length) return null;
    return headers.map(h => (h.endsWith('\r\n') ? h : `${h}\r\n`)).join('');
}

/** Attempts to kill a child process tree on all platforms. */
function killChildTree(child?: ChildProcessWithoutNullStreams) {
    if (!child) return;
    try {
        if (process.platform === 'win32') {
            if (child.pid) {
                try {
                    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('close', () => {
                        try { child.kill('SIGKILL'); } catch {}
                    });
                } catch {
                    try { child.kill('SIGKILL'); } catch {}
                }
            } else {
                try { child.kill('SIGKILL'); } catch {}
            }
        } else {
            if (child.pid) {
                try { process.kill(-child.pid, 'SIGTERM'); } catch {}
                setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 250);
            } else {
                child.kill('SIGTERM');
                setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 250);
            }
        }
    } catch {}
}

/** Spawns FFmpeg to read PCM from a Readable stream. */
function ffmpegFromReadable(
    input: Readable,
    args: string[]
): { stream: Readable; child: ChildProcessWithoutNullStreams } {
    const ff = spawn(
        getFFmpegPath(),
        [
            '-nostdin',
            '-thread_queue_size', '8192',
            '-analyzeduration', '1000000',
            '-probesize', '1000000',
            '-i', 'pipe:0',
            ...args,
            'pipe:1'
        ],
        { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' }
    );
    if (process.platform !== 'win32') ff.unref();

    input.pipe(ff.stdin!);

    // Ignore expected teardown errors
    ff.stdin?.on('error', (err: NodeJS.ErrnoException) => {
        if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
    });
    (input as any).once?.('end', () => { try { ff.stdin?.end(); } catch {} });
    (input as any).once?.('close', () => { try { ff.stdin?.end(); } catch {} });
    (input as any).once?.('error', () => { try { ff.stdin?.destroy(); } catch {} });

    return { stream: ff.stdout as unknown as Readable, child: ff };
}

/** Spawns FFmpeg to fetch and transcode from a direct URL. */
function ffmpegFromUrl(
    url: string,
    args: string[],
    agent?: AgentOptions | string | null,
    addHeaders?: string[]
): { stream: Readable; child: ChildProcessWithoutNullStreams } {
    const a: AgentOptions = typeof agent === 'string' ? { cookiesHeader: agent } : (agent ?? {});
    const netArgs: string[] = [];

    if (a.proxyUri) netArgs.push('-http_proxy', String(a.proxyUri));

    if (!a.noUA) {
        netArgs.push(
            '-user_agent',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
        );
    }

    const hdr = buildFFmpegHeaders(addHeaders);
    if (hdr) netArgs.push('-headers', hdr);

    const ff = spawn(
        getFFmpegPath(),
        [
            '-nostdin',
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_on_network_error', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_delay_max', '10',
            ...netArgs,
            '-rw_timeout', '30000000',
            '-i', url,
            ...args,
            'pipe:1'
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' }
    );
    if (process.platform !== 'win32') ff.unref();

    return { stream: ff.stdout as unknown as Readable, child: ff };
}

/* =========================================================
 * Abort helper
 * =======================================================*/
/** Binds an AbortSignal to multiple killable resources (streams and processes). */
function attachAbort(signal: AbortSignal | undefined, killables: Array<ChildProcessWithoutNullStreams | Readable | null | undefined>) {
    if (!signal) return;
    const killAll = () => {
        for (const p of killables) {
            try { (p as any)?.destroy?.(); } catch {}
            try { (p as any)?.kill?.('SIGKILL'); } catch {}
        }
    };
    if (signal.aborted) return killAll();
    signal.addEventListener('abort', killAll, { once: true });
}

/* =========================================================
 * Single-session guard (prevents overlapping plays)
 * =======================================================*/
const _activeSessions = new Set<() => void>();
function stopAllSessions() {
    for (const stop of Array.from(_activeSessions)) {
        try { stop(); } catch {}
        _activeSessions.delete(stop);
    }
}

/* =========================================================
 * yt-dlp spawn (stdout) so we can kill it reliably
 * =======================================================*/
let YTDLP_BIN: string | null = null;
export function setYtDlpPath(p: string) { YTDLP_BIN = p; }

/** Finds an executable in system PATH (respects PATHEXT on Windows) */
function which(cmd: string): string | null {
    const PATH = process.env.PATH || '';
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').toLowerCase().split(';').filter(Boolean)
        : [''];
    for (const dir of PATH.split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const full = path.join(dir, cmd + ext);
            try { if (fs.existsSync(full)) return full; } catch {}
        }
    }
    return null;
}

/** Resolves the yt-dlp binary path (package bin, or 'yt-dlp'). */
function getYtDlpBinaryPath(): string {
    if (YTDLP_BIN) return YTDLP_BIN;

    const fromPath = which('yt-dlp');
    if (fromPath) return fromPath;

    const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    try {
        const entry = require.resolve('ytdlp-nodejs');
        let dir = path.dirname(entry);
        for (let i = 0; i < 4; i++) {
            const candidate = path.join(dir, 'bin', binName);
            if (fs.existsSync(candidate)) {
                try { if (process.platform !== 'win32') fs.chmodSync(candidate, 0o755); } catch {}
                return candidate;
            }
            dir = path.dirname(dir);
        }
    } catch {}

    return binName;
}

/** Get yt-dlp args from command. */
function supportsArg(cmd: string, arg: string): boolean {
    try {
        const r = spawnSync(cmd, ['--help'], { encoding: 'utf8', windowsHide: true });
        const out = (r.stdout || '') + (r.stderr || '');
        return out.includes(arg);
    } catch {
        return false;
    }
}

/** Spawns yt-dlp to stream bestaudio to stdout, with headers/cookies/proxy applied. */
function spawnYtDlpReadable(
    url: string,
    opt: any,
    extraArgs: string[] = []
): { child: ChildProcessWithoutNullStreams; stdout: Readable } {
    const cmd = getYtDlpBinaryPath();
    const hasJsRuntimes = supportsArg(cmd, '--js-runtimes');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytdlp-frag-'));

    const args: string[] = [
        '--quiet', '--no-progress',
        '--no-playlist',
        '--retries', 'infinite',
        '--fragment-retries', 'infinite',
        '--retry-sleep', '1',
        '--no-cache-dir',
        ...(hasJsRuntimes ? ['--js-runtimes', 'node'] : []),
        '--no-keep-fragments',
        '--no-part',
        '--concurrent-fragments', '1',
        '--paths', `temp:${tmpDir}`,
        '-f', 'bestaudio[acodec!=none]/bestaudio/best',
        '-o', '-',
        ...(opt?.proxy ? ['--proxy', String(opt.proxy)] : []),
        ...(opt?.forceIpv4 ? ['--force-ipv4'] : []),
        ...(opt?.cookiesFromBrowser ? ['--cookies-from-browser', String(opt.cookiesFromBrowser)] : []),
        ...(opt?.cookies ? ['--cookies', String(opt.cookies)] : []),
        ...(opt?.userAgent ? ['--user-agent', String(opt.userAgent)] : []),
        ...((Array.isArray(opt?.addHeader) ? opt.addHeader : (opt?.addHeader ? [opt?.addHeader] : []))
            .flatMap((h: string) => ['--add-header', h])),
        url,
        ...extraArgs
    ];

    const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
        cwd: tmpDir,
        env: {
            ...process.env,
            TMPDIR: tmpDir,
            TMP: tmpDir,
            TEMP: tmpDir
        }
    });
    if (process.platform !== 'win32') child.unref();

    (child as any)._tmpDir = tmpDir;

    const rmTmp = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };
    child.once('close', rmTmp);
    child.once('exit', rmTmp);
    child.once('error', rmTmp);

    return { child, stdout: child.stdout! };
}

/* =========================================================
 * yt-dlp --help flag support cache
 * =======================================================*/
const _ytdlpHelpCache: { text: string | null } = { text: null };

function getYtDlpHelpText(): string {
    if (_ytdlpHelpCache.text != null) return _ytdlpHelpCache.text;
    try {
        const cmd = getYtDlpBinaryPath();
        const r = spawnSync(cmd, ['--help'], { encoding: 'utf8', windowsHide: true });
        _ytdlpHelpCache.text = String(r.stdout || '') + '\n' + String(r.stderr || '');
        return _ytdlpHelpCache.text;
    } catch {
        _ytdlpHelpCache.text = '';
        return '';
    }
}

function ytDlpSupportsFlag(flag: string): boolean {
    const h = getYtDlpHelpText();
    return h.includes(flag);
}

/* =========================================================
 * yt-dlp JSON info via spawn
 * =======================================================*/
async function spawnYtDlpJson(url: string, runnerOpt: any, extraArgs: string[] = []) {
    const cmd = getYtDlpBinaryPath();

    const addHeaders = (Array.isArray(runnerOpt?.addHeader)
        ? runnerOpt.addHeader
        : (runnerOpt?.addHeader ? [runnerOpt.addHeader] : [])
    ).filter(Boolean) as string[];

    const args: string[] = [
        '--quiet',
        '--no-warnings',
        '--dump-single-json',
        '--skip-download',
        '--ignore-config',
        ...(runnerOpt?.proxy ? ['--proxy', String(runnerOpt.proxy)] : []),
        ...(runnerOpt?.forceIpv4 ? ['--force-ipv4'] : []),
        ...(runnerOpt?.cookiesFromBrowser ? ['--cookies-from-browser', String(runnerOpt.cookiesFromBrowser)] : []),
        ...(runnerOpt?.cookies ? ['--cookies', String(runnerOpt.cookies)] : []),
        ...(runnerOpt?.userAgent ? ['--user-agent', String(runnerOpt.userAgent)] : []),
        ...addHeaders.flatMap(h => ['--add-header', h]),
    ];

    if (ytDlpSupportsFlag('--js-runtimes')) {
        args.push('--js-runtimes', 'node');
    }

    if (Array.isArray(extraArgs) && extraArgs.length) {
        args.push(...extraArgs.filter(Boolean).map(x => String(x)));
    }

    args.push(url);

    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let out = '';
    let err = '';
    p.stdout.on('data', (b) => { out += b.toString('utf8'); });
    p.stderr.on('data', (b) => { err += b.toString('utf8'); });

    const code: number = await new Promise(res => p.once('close', res as any));
    if (code !== 0) {
        throw new Error(`yt-dlp getInfo failed code=${code}\n${err.trim()}`);
    }

    const txt = out.trim();
    if (!txt) return null;

    try {
        return JSON.parse(txt);
    } catch (e) {
        throw new Error(`yt-dlp getInfo JSON parse failed\n${String(e)}\nOutput:\n${txt.slice(0, 2000)}`);
    }
}

/* =========================================================
 * getInfo (robust)
 * =======================================================*/
/**
 * Fetches video information using ytdlp-nodejs' getInfoAsync,
 * returning a lightweight "videoDetails"-like shape plus the raw payload.
 */
export async function getInfo(
    url: string,
    opts: {
        agent?: AgentOptions | string | null;
        cookies?: string;
        cookiesFromBrowser?: AgentOptions['cookiesFromBrowser'];
    } = {}
) {
    const merged: AgentOptions =
        typeof opts.agent === 'string' ? { cookiesHeader: opts.agent } : { ...(opts.agent ?? {}) };

    if (opts.cookies) merged.cookiesHeader = opts.cookies;
    if (opts.cookiesFromBrowser) merged.cookiesFromBrowser = opts.cookiesFromBrowser;

    const { opt, cleanup } = agentToRunnerOptions(merged);

    try {
        const raw = await spawnYtDlpJson(url, opt);
        if (!raw) return null;

        if (raw._type === 'playlist' && Array.isArray(raw.entries)) {
            return { entries: raw.entries, raw };
        }

        const isVideoLike = raw._type === 'video' || raw.webpage_url || raw.title;
        if (!isVideoLike) return null;

        const vd = {
            title: String(raw.title ?? ''),
            description: String(raw.description ?? ''),
            author: { name: (raw.uploader || raw.channel || null) as (string | null) },
            video_url: String(raw.webpage_url ?? url),
            thumbnails: Array.isArray(raw.thumbnails) ? raw.thumbnails : (raw.thumbnail ? [{ url: raw.thumbnail }] : []),
            viewCount: String(raw.view_count ?? 0),
            lengthSeconds: String((raw.duration ?? 0) | 0),
        };

        return { videoDetails: vd, raw };
    } finally {
        try { cleanup(); } catch {}
    }
}

/* =========================================================
 * getPlaylistInfo (robust)
 * =======================================================*/
/**
 * Fetches playlist data via yt-dlp JSON output using flat playlist mode.
 * Returns an object containing the playlist entries and the raw response,
 * or null if the result is not a playlist.
 */
export async function getPlaylistInfo(
    url: string,
    opts: {
        agent?: AgentOptions | string | null;
        cookies?: string;
        cookiesFromBrowser?: AgentOptions['cookiesFromBrowser'];
    } = {}
) {
    const merged: AgentOptions =
        typeof opts.agent === 'string' ? { cookiesHeader: opts.agent } : { ...(opts.agent ?? {}) };

    if (opts.cookies) merged.cookiesHeader = opts.cookies;
    if (opts.cookiesFromBrowser) merged.cookiesFromBrowser = opts.cookiesFromBrowser;

    const { opt, cleanup } = agentToRunnerOptions(merged);

    try {
        const raw = await spawnYtDlpJson(url, opt, ['--flat-playlist', '--yes-playlist']);
        if (!raw) return null;

        if (raw._type === 'playlist' || Array.isArray(raw.entries)) {
            return { entries: Array.isArray(raw.entries) ? raw.entries : [], raw };
        }

        return null;
    } finally {
        try { cleanup(); } catch {}
    }
}

/* =========================================================
 * createPCMStream (YouTube via yt-dlp we spawn; FFmpeg we control)
 * =======================================================*/
/**
 * Creates a single active PCM (or Opus) stream from a YouTube URL (via yt-dlp - ffmpeg).
 */
export function createPCMStream(url: string, options: YTDLPStreamOptions = {}): Readable {
    let opusEnc: any = null;
    const fmt = options.fmt ?? 's16le';
    const seek = Number(options.seek) || 0;
    const encoderArgs = options.encoderArgs ?? [];
    const ffArgs = makeFFmpegArgs(fmt, seek, encoderArgs);

    const { opt, cleanup } = agentToRunnerOptions(
        typeof options.agent === 'string'
            ? { cookiesHeader: options.agent }
            : (options.agent as AgentOptions)
    );

    const exposed = new PassThrough({ allowHalfOpen: false, highWaterMark: 4 * 1024 * 1024 });

    let ff: ChildProcessWithoutNullStreams | null = null;
    let opusChild: ChildProcessWithoutNullStreams | null = null;
    let ytdlpProc: ChildProcessWithoutNullStreams | null = null;
    let jitter: PassThrough | null = null;
    let upstream: Readable | null = null;
    let closed = false;

    const killAll = () => {
        if (closed) return; closed = true;

        try { jitter?.destroy(); } catch {}
        try { killChildTree(ytdlpProc as any); } catch {}

        try { upstream?.unpipe?.(exposed as any); } catch {}
        try { exposed.end(); } catch {}

        try { (upstream as any)?.destroy?.(); } catch {}

        try { opusEnc?.destroy?.(); } catch {}

        try { killChildTree(opusChild as any); } catch {}
        try { killChildTree(ff as any); } catch {}

        try { cleanup(); } catch {}
        _activeSessions.delete(killAll);
    };

    _activeSessions.add(killAll);

    const origDestroy = exposed.destroy.bind(exposed);
    (exposed as any).destroy = (err?: any) => { try { killAll(); } catch {} return origDestroy(err); };

    (async () => {
        try {
            const spawned = spawnYtDlpReadable(url, opt);
            ytdlpProc = spawned.child;

            jitter = new PassThrough({ highWaterMark: 8 * 1024 * 1024 });
            spawned.stdout.pipe(jitter);

            const built = ffmpegFromReadable(jitter as unknown as Readable, ffArgs);
            upstream = built.stream;
            ff = built.child;

            (upstream as any).once?.('end', killAll);
            (upstream as any).once?.('close', killAll);
            (upstream as any).once?.('error', killAll);

            attachAbort(options.signal, [exposed as any, ff as any, ytdlpProc as any, jitter as any]);

            let ytdlpStderr = '';
            (ytdlpProc.stderr as any)?.on?.('data', (b: Buffer) => {
                ytdlpStderr = (ytdlpStderr + b.toString('utf8')).slice(-8000);
            });

            ytdlpProc.once('error', (e) => {
                exposed.destroy(e);
            });

            ytdlpProc.once('close', (code) => {
                if (code === 0) {
                try { jitter?.end(); } catch {}
                } else {
                exposed.destroy(new Error(`yt-dlp exited code=${code}\n${ytdlpStderr}`));
                }
            });
            ff.once('error', killAll);
            ff.once('close', killAll);

            let finalOut: Readable = upstream as Readable;

            if (options.opusEncoded) {
                if (PRISM_OPUS_ENCODER) {
                    const enc = new PRISM_OPUS_ENCODER({ rate: 48000, channels: 2, frameSize: 960 });
                    opusEnc = enc;
                    finalOut = finalOut.pipe(enc) as unknown as Readable;

                    (enc as any).once?.('close', killAll);
                    (enc as any).once?.('end', killAll);
                    (enc as any).once?.('error', killAll);
                } else {
                    const ff2 = spawn(
                        getFFmpegPath(),
                        ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-f', 'opus', 'pipe:1'],
                        { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' }
                );
                if (process.platform !== 'win32') ff2.unref();

                (finalOut as Readable).pipe(ff2.stdin!);
                ff2.stdin?.on('error', () => {});
                opusChild = ff2;
                finalOut = ff2.stdout as unknown as Readable;
                }
            }

            (finalOut as Readable).pipe(exposed);
        } catch (err: any) {
            exposed.destroy(err);
        }
    })();

    return exposed as Readable;
}

/* =========================================================
 * arbitraryStream (direct URL/Readable - FFmpeg we control)
 * =======================================================*/
/**
 * Transcodes from either a direct URL or any Node Readable/Duplex to PCM (or Opus).
 */
export function arbitraryStream(
    stream: string | Readable | Duplex,
    options: YTDLPStreamOptions = {}
): Readable {
    let opusEnc: any = null;
    const fmt = options.fmt ?? 's16le';
    const seek = Number(options.seek) || 0;
    const encoderArgs = options.encoderArgs ?? [];
    const ffArgs = makeFFmpegArgs(fmt, seek, encoderArgs);

    let out: Readable;
    let ff: ChildProcessWithoutNullStreams | null = null;
    let opusChild: ChildProcessWithoutNullStreams | null = null;

    if (typeof stream === 'string') {
        const agentForFFmpeg =
        typeof options.agent === 'string'
            ? undefined
            : (options.agent ? { noUA: (options.agent as AgentOptions).noUA } : undefined);

        const built = ffmpegFromUrl(stream, ffArgs, agentForFFmpeg);
        out = built.stream; ff = built.child;
    } else {
        const built = ffmpegFromReadable(stream as Readable, ffArgs);
        out = built.stream; ff = built.child;
    }

    if (options.opusEncoded) {
        if (PRISM_OPUS_ENCODER) {
            const enc = new PRISM_OPUS_ENCODER({ rate: 48000, channels: 2, frameSize: 960 });
            opusEnc = enc;
            const piped = (out as Readable).pipe(enc) as unknown as Readable;
            (piped as any).on?.('close', () => enc.destroy());
            out = piped;
        } else {
            const ff2 = spawn(
                getFFmpegPath(),
                ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0', '-f', 'opus', 'pipe:1'],
                { stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32' }
            );
            if (process.platform !== 'win32') ff2.unref();
            (out as Readable).pipe(ff2.stdin!);
            ff2.stdin?.on('error', () => {});
            out = ff2.stdout as unknown as Readable;
            opusChild = ff2;
        }
    }

    const exposed = new PassThrough({ allowHalfOpen: false, highWaterMark: 256 * 1024 });
    (out as Readable).pipe(exposed);

    let closed = false;
    const killAll = () => {
        if (closed) return; closed = true;

        try { (out as any).unpipe?.(exposed); } catch {}
        try { exposed.end(); } catch {}

        try { (out as any).destroy?.(); } catch {}

        try { opusEnc?.destroy?.(); } catch {}

        try { killChildTree(opusChild as any); } catch {}
        try { killChildTree(ff as any); } catch {}

        _activeSessions.delete(killAll);
    };
    _activeSessions.add(killAll);

    (out as any).once?.('end', killAll);
    (out as any).once?.('close', killAll);
    (out as any).once?.('error', killAll);
    ff?.once('error', killAll);
    ff?.once('close', killAll);
    opusChild?.once?.('error', killAll);
    opusChild?.once?.('close', killAll);

    attachAbort(options.signal, [exposed as any, ff as any, opusChild as any]);

    const origDestroy = (exposed as any).destroy?.bind(exposed);
    (exposed as any).destroy = (err?: any) => { try { killAll(); } catch {} return origDestroy ? origDestroy(err) : undefined; };
    (exposed as any)._killAll = killAll;

    return exposed as Readable;
}

/* =========================================================
 * Back-compat helpers
 * =======================================================*/
/** Primary callable factory (mimics old StreamDownloader usage). */
function StreamDownloader(url: string, options?: YTDLPStreamOptions) {
    if (!url || typeof url !== 'string') throw new Error('No input url provided or not a string');
    return createPCMStream(url, options);
}
(StreamDownloader as any).arbitraryStream = arbitraryStream;

/* =========================================================
 * Auto-cleanup (module-only, no exports)
 * Closes ffmpeg/yt-dlp when the process exits.
 * =======================================================*/
(() => {
    if (process.env.YTDLP_DISABLE_HOOKS === '1') return;

    // Guard: don't install twice if the module is loaded multiple times
    const k = '__ytdlp_cleanup_installed__';
    if ((global as any)[k]) return;
    (global as any)[k] = true;

    const safeCleanup = () => { try { stopAllSessions(); } catch {} };

    // Normal exit
    process.on('exit', safeCleanup);

    // Ctrl+C
    process.once('SIGINT', () => { safeCleanup(); });

    // SIGTERM (systemd/docker/etc.)
    process.once('SIGTERM', () => { safeCleanup(); });

    // Uncaught errors/unhandled promises
    process.on('uncaughtException', (err) => {
        try { console.error(err); } catch {}
        safeCleanup();
    });
    process.on('unhandledRejection', (err) => {
        try { console.error(err); } catch {}
        safeCleanup();
    });
})();

/** Named export bundle for convenience in CommonJS/ESM mixes. */
const ytdlp = Object.assign(StreamDownloader, {
    setFFmpegPath,
    setYtDlpPath,
    getInfo,
    getPlaylistInfo,
    createPCMStream,
    arbitraryStream
});

export default ytdlp;
