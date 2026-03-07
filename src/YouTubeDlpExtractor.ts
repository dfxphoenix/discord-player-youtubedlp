import {
    BaseExtractor,
    Playlist,
    Track,
    QueryType,
    type ExtractorInfo,
    type ExtractorSearchContext,
    type ExtractorStreamable,
    type SearchQueryType
} from "discord-player";

import {
    getInfo,
    getPlaylistInfo,
    createPCMStream,
    type AgentOptions
} from "./YTDLP.js";

/**
 * Initialization options for the YouTubeDlpExtractor.
 */
export interface YouTubeDlpExtractorInit {
    /** Agent/cookies configuration */
    agent?: AgentOptions | string | null;

    /** Maximum search results */
    searchLimit?: number;

    /** Maximum playlist entries to resolve */
    playlistSearchLimit?: number;

    /** Maximum related tracks to return */
    relatedLimit?: number;

    /** Enables supported URL protocol handling */
    enableProtocols?: boolean;

    /** Search timeout in milliseconds */
    searchTimeoutMs?: number;

    /** Video resolution timeout in milliseconds */
    videoTimeoutMs?: number;

    /** Playlist resolution timeout in milliseconds */
    playlistTimeoutMs?: number;

    /** yt-dlp execution timeout in milliseconds */
    ytdlpTimeoutMs?: number;

    /** Cache TTL in milliseconds */
    infoCacheTtlMs?: number;

    /** Enables debug logging */
    debug?: boolean;
}

/** Generic raw payload returned by youtubei.js or yt-dlp. */
type YtRaw = Record<string, any>;

/** Simple in-memory cache entry with an absolute expiration timestamp. */
type CacheEntry<T> = {
    value: T;
    expiresAt: number;
};

let youtubeiClientPromise: Promise<any> | null = null;

/**
 * Checks whether a hostname belongs to YouTube or one of its supported subdomains.
 */
function isYouTubeHost(host: string): boolean {
    const h = host.toLowerCase();
    return (
        h === "youtube.com" ||
        h === "www.youtube.com" ||
        h === "m.youtube.com" ||
        h === "music.youtube.com" ||
        h === "youtu.be" ||
        h.endsWith(".youtube.com")
    );
}

/**
 * Returns true when the provided input can be parsed as a valid URL.
 */
function looksLikeUrl(input: string): boolean {
    try {
        new URL(input);
        return true;
    } catch {
        return false;
    }
}

/**
 * Extracts the URI scheme from a string such as http, https or spotify.
 */
function getProtocolScheme(input: string): string | null {
    const match = String(input || "").trim().match(/^([a-z][a-z0-9+.-]*):/i);
    return match ? match[1].toLowerCase() : null;
}

/**
 * Detects noisy youtubei.js parser logs that should be hidden from console output.
 */
function shouldMuteYoutubeJs(args: any[]): boolean {
    const text = args
        .map((x) => {
            if (typeof x === "string") return x;
            if (x instanceof Error) return x.stack || x.message || String(x);
            try {
                return JSON.stringify(x);
            } catch {
                return String(x);
            }
        })
        .join(" ");

        return (
            text.includes("[YOUTUBEJS]") ||
            text.includes("youtubei.js/dist/src/parser") ||
            text.includes("Unable to find matching run") ||
            text.includes("ParsingError:")
        );
}

/**
 * Returns true when a URL points to a supported YouTube host.
 */
function isYouTubeUrl(input: string): boolean {
    try {
        const u = new URL(input);
        return isYouTubeHost(u.hostname);
    } catch {
        return false;
    }
}

/**
 * Extracts a video id from common YouTube URL formats.
 */
function getYouTubeVideoId(input: string): string | null {
    try {
        const u = new URL(input);
        if (!isYouTubeHost(u.hostname)) return null;

        if (u.hostname === "youtu.be") {
            return u.pathname.split("/").filter(Boolean)[0] || null;
        }

        if (u.pathname.startsWith("/shorts/")) {
            return u.pathname.split("/").filter(Boolean)[1] || null;
        }

        return u.searchParams.get("v");
    } catch {
        return null;
    }
}

/**
 * Extracts the playlist id from a YouTube URL when present.
 */
function getYouTubeListId(input: string): string | null {
    try {
        const u = new URL(input);
        if (!isYouTubeHost(u.hostname)) return null;
        return u.searchParams.get("list");
    } catch {
        return null;
    }
}

/**
 * Checks whether the URL explicitly targets a single video.
 */
function hasExplicitVideo(input: string): boolean {
    return !!getYouTubeVideoId(input);
}

/**
 * Returns true when the URL contains playlist information.
 */
function isPlaylistUrl(input: string): boolean {
    try {
        const u = new URL(input);
        if (!isYouTubeHost(u.hostname)) return false;
        return !!u.searchParams.get("list") || u.pathname === "/playlist";
    } catch {
        return false;
    }
}

/**
 * Detects YouTube auto-generated mix playlists by their list id prefix.
 */
function isMixList(input: string): boolean {
    const listId = getYouTubeListId(input);
    if (!listId) return false;

    return (
        listId.startsWith("RD") ||
        listId.startsWith("RDMM") ||
        listId.startsWith("RDEM") ||
        listId.startsWith("RDAMVM")
    );
}

/**
 * Normalizes a YouTube video URL into the standard watch?v= format.
 */
function toCanonicalVideoUrl(input: string): string {
    const id = getYouTubeVideoId(input);
    return id ? `https://www.youtube.com/watch?v=${id}` : input;
}

/**
 * Normalizes a playlist URL into the standard /playlist?list= format.
 */
function toCanonicalPlaylistUrl(input: string): string {
    const listId = getYouTubeListId(input);
    return listId ? `https://www.youtube.com/playlist?list=${encodeURIComponent(listId)}` : input;
}

/**
 * Rebuilds YouTube URLs into a predictable canonical form for caching and lookups.
 */
function normalizeYouTubeUrl(input: string): string {
    try {
        const u = new URL(input);
        if (!isYouTubeHost(u.hostname)) return input;

        const listId = u.searchParams.get("list");
        const videoId = getYouTubeVideoId(input);

        if (u.pathname === "/playlist" && listId) {
            return toCanonicalPlaylistUrl(input);
        }

        if (videoId) {
            return listId
                ? `https://www.youtube.com/watch?v=${videoId}&list=${encodeURIComponent(listId)}`
                : `https://www.youtube.com/watch?v=${videoId}`;
        }

        return input;
    } catch {
        return input;
    }
}

/**
 * Converts milliseconds into a player-friendly duration string.
 */
function millisecondsToDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms <= 0) return "0:00";
    const totalSeconds = Math.floor(ms / 1000);
    const s = String(totalSeconds % 60).padStart(2, "0");
    const minutes = Math.floor(totalSeconds / 60);
    const m = String(minutes % 60).padStart(2, "0");
    const h = Math.floor(minutes / 60);
    return h > 0 ? `${h}:${m}:${s}` : `${parseInt(m, 10)}:${s}`;
}

/**
 * Converts seconds into a player-friendly duration string.
 */
function secondsToDuration(sec: number): string {
    if (!Number.isFinite(sec) || sec <= 0) return "0:00";
    return millisecondsToDuration(sec * 1000);
}

/**
 * Narrowing helper that accepts only http/https URLs.
 */
function isHttpUrl(value: unknown): value is string {
    return typeof value === "string" && /^https?:\/\//i.test(value.trim());
}

/**
 * Picks the best available thumbnail URL from a raw video/playlist payload.
 */
function pickThumbnail(raw: YtRaw): string | undefined {
    if (Array.isArray(raw?.thumbnails) && raw.thumbnails.length) {
        const withUrl = raw.thumbnails
            .map((t: any) => t?.url)
            .filter(isHttpUrl);
        if (withUrl.length) return withUrl[withUrl.length - 1];
    }

    if (Array.isArray(raw?.thumbnail) && raw.thumbnail.length) {
        const withUrl = raw.thumbnail
            .map((t: any) => t?.url)
            .filter(isHttpUrl);
        if (withUrl.length) return withUrl[withUrl.length - 1];
    }

    if (isHttpUrl(raw?.thumbnail?.url)) return raw.thumbnail.url;
    if (isHttpUrl(raw?.thumbnail)) return raw.thumbnail;

    const videoId =
        raw?.videoId ||
        raw?.video_id ||
        raw?.id ||
        getYouTubeVideoId(raw?.webpage_url || raw?.original_url || raw?.url || "");

    if (videoId) {
        return `https://i.ytimg.com/vi/${String(videoId)}/hqdefault.jpg`;
    }

    return undefined;
}

/**
 * Resolves the most useful author/channel name from heterogeneous raw payloads.
 */
function pickAuthor(raw: YtRaw): string {
    return String(
        raw?.channel?.name ||
            raw?.channel ||
            raw?.uploader ||
            raw?.artist ||
            raw?.author ||
            "YouTube"
    );
}

/**
 * Resolves the best playback/watch URL for a raw video entry.
 */
function pickVideoUrl(raw: YtRaw, fallback: string): string {
    const direct = raw?.webpage_url || raw?.original_url || raw?.url;
    if (isHttpUrl(direct)) return String(direct);

    const id = raw?.id || raw?.videoId || raw?.video_id;
    if (id) return `https://www.youtube.com/watch?v=${String(id)}`;

    if (isYouTubeUrl(fallback)) return toCanonicalVideoUrl(fallback);

    return "";
}

/**
 * Resolves a readable track title from the raw metadata.
 */
function resolveTrackTitle(raw: YtRaw): string {
    return String(
        textFrom(raw?.title) ||
            textFrom(raw?.fulltitle) ||
            textFrom(raw?.track) ||
            textFrom(raw?.name) ||
            textFrom(raw?.video_title) ||
            textFrom(raw?.headline) ||
            "Unknown title"
    );
}

/**
 * Filters raw playlist/search entries down to usable video-like items.
 */
function normalizeEntries(raw: YtRaw): YtRaw[] {
    if (!Array.isArray(raw?.entries)) return [];
    return raw.entries.filter((e: any) => e && (e.id || e.videoId || e.video_id || e.url || e.webpage_url || e.title));
}

/**
 * Wraps an async operation with a timeout to avoid hanging extractor calls.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

/**
 * Safely extracts human-readable text from mixed youtubei.js/yt-dlp structures.
 */
function textFrom(value: any): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) return value.map((item) => textFrom(item)).filter(Boolean).join("");
    if (typeof value?.text === "string") return value.text;
    if (typeof value?.simpleText === "string") return value.simpleText;
    if (Array.isArray(value?.runs)) {
        return value.runs.map((run: any) => textFrom(run?.text ?? run)).filter(Boolean).join("");
    }
    if (Array.isArray(value?.items)) {
        return value.items.map((item: any) => textFrom(item)).filter(Boolean).join(" ");
    }
    if (typeof value?.name === "string") return value.name;
    if (typeof value?.title === "string") return value.title;
    if (typeof value?.toString === "function") {
        const stringified = String(value);
        if (stringified && stringified !== "[object Object]") return stringified;
    }
    return "";
}

/**
 * Parses raw numeric text such as 1.2M or 12,345 into a number.
 */
function parseNumeric(value: any): number {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const text = textFrom(value).trim();
    if (!text) return 0;
    const compactMatch = text.match(/([\d.,]+)\s*([KMBT])/i);
    if (compactMatch) {
        const base = Number(compactMatch[1].replace(/,/g, ""));
        const suffix = compactMatch[2].toUpperCase();
        const multiplier = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : suffix === "B" ? 1e9 : 1e12;
        if (Number.isFinite(base)) return Math.round(base * multiplier);
    }
    const digits = text.replace(/[^\d]/g, "");
    return digits ? Number(digits) : 0;
}

/**
 * Normalizes thumbnail payloads into a simple { url } array.
 */
function normalizeThumbnailList(input: any): Array<{ url: string }> {
    const list = Array.isArray(input)
        ? input
        : Array.isArray(input?.thumbnails)
            ? input.thumbnails
            : input?.url
                ? [input]
                : [];

    return list
        .map((thumb: any) => ({ url: String(thumb?.url || thumb) }))
        .filter((thumb: { url: string }) => !!thumb.url && thumb.url !== "[object Object]");
}

/**
 * Extracts thumbnails from the most common youtubei.js node shapes.
 */
function extractThumbnailList(node: any): Array<{ url: string }> {
    return normalizeThumbnailList(
        node?.thumbnails ||
            node?.thumbnail?.thumbnails ||
            node?.thumbnail ||
            node?.author?.thumbnails ||
            node?.author?.thumbnail ||
            node?.basic_info?.thumbnail
    );
}

/**
 * Extracts a channel/author name from youtubei.js entities.
 */
function extractAuthorName(node: any): string {
    return (
        textFrom(node?.author?.name) ||
        textFrom(node?.author) ||
        textFrom(node?.channel?.name) ||
        textFrom(node?.owner?.name) ||
        textFrom(node?.uploader) ||
        textFrom(node?.artists?.[0]?.name) ||
        textFrom(node?.short_author) ||
        "YouTube"
    );
}

/**
 * Extracts a channel URL when youtubei.js exposes one.
 */
function extractChannelUrl(node: any): string | undefined {
    const candidates = [
        node?.author?.url,
        node?.author?.endpoint?.metadata?.url,
        node?.channel?.url,
        node?.owner?.url,
        node?.uploader_url
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "string" && candidate) return candidate;
    }

    return undefined;
}

/**
 * Resolves a duration string from youtubei.js nodes using seconds first,
 * then human-readable fallback fields.
 */
function extractDurationFormatted(node: any): string {
    const seconds = Number(
        node?.duration?.seconds ??
            node?.duration_seconds ??
            node?.length_seconds ??
            node?.lengthSeconds ??
            node?.basic_info?.duration ??
            0
    );

    if (Number.isFinite(seconds) && seconds > 0) {
        return secondsToDuration(seconds);
    }

    return (
        textFrom(node?.duration?.text) ||
        textFrom(node?.duration_text) ||
        textFrom(node?.length_text) ||
        textFrom(node?.durationFormatted) ||
        "0:00"
    );
}

/**
 * Normalizes a youtubei.js search/playlist video node into the extractor raw format.
 */
function normalizeYoutubeiVideoNode(node: any, fallbackQuery: string): YtRaw | null {
    if (!node) return null;

    const rawId =
        node?.id ||
        node?.video_id ||
        node?.videoId ||
        getYouTubeVideoId(String(node?.url || node?.webpage_url || node?.original_url || ""));

    const id = rawId ? String(rawId) : "";
    const fallbackUrl = id ? `https://www.youtube.com/watch?v=${id}` : fallbackQuery;
    const url = toCanonicalVideoUrl(String(node?.url || node?.webpage_url || node?.original_url || fallbackUrl));
    const title = textFrom(node?.title || node?.headline || node?.video_title) || "Unknown title";
    const author = extractAuthorName(node);
    const durationFormatted = extractDurationFormatted(node);
    const thumbnails = extractThumbnailList(node);

    return {
        id: id || getYouTubeVideoId(url) || undefined,
        title,
        description: textFrom(node?.description || node?.snippet || node?.short_description || ""),
        url,
        webpage_url: url,
        original_url: url,
        author,
        channel: author,
        uploader: author,
        channel_url: extractChannelUrl(node),
        thumbnails,
        durationFormatted,
        duration: durationFormatted,
        view_count: parseNumeric(node?.view_count ?? node?.views ?? node?.viewCount),
        youtubei: true,
        source_name: "youtubei.js"
    };
}

/**
 * Normalizes detailed youtubei.js video info into the extractor raw format.
 */
function normalizeYoutubeiVideoInfo(info: any, fallbackQuery: string): YtRaw | null {
    const basic = info?.basic_info ?? info?.video_details ?? info ?? {};
    const rawId = basic?.id || basic?.video_id || basic?.videoId || getYouTubeVideoId(fallbackQuery);
    const id = rawId ? String(rawId) : "";
    const fallbackUrl = id ? `https://www.youtube.com/watch?v=${id}` : fallbackQuery;
    const url = toCanonicalVideoUrl(String(basic?.url || basic?.webpage_url || basic?.original_url || fallbackUrl));
    const author =
        textFrom(basic?.channel?.name) ||
        textFrom(basic?.author) ||
        textFrom(info?.primary_info?.owner?.author) ||
        textFrom(info?.secondary_info?.owner?.author) ||
        "YouTube";
    const durationSeconds = Number(
        basic?.duration ??
            basic?.duration_seconds ??
            basic?.length_seconds ??
            basic?.lengthSeconds ??
            0
    );
    const durationFormatted = durationSeconds > 0 ? secondsToDuration(durationSeconds) : extractDurationFormatted(basic);
    const title =
        textFrom(basic?.title) ||
        textFrom(info?.primary_info?.title) ||
        textFrom(info?.microformat?.player_microformat_renderer?.title) ||
        textFrom(info?.microformat?.microformat_data_renderer?.title) ||
        "Unknown title";

    return {
        id: id || getYouTubeVideoId(url) || undefined,
        title,
        description: textFrom(basic?.short_description || basic?.description || info?.secondary_info?.description || ""),
        url,
        webpage_url: url,
        original_url: url,
        author,
        channel: author,
        uploader: author,
        channel_url: extractChannelUrl(basic) || extractChannelUrl(info?.primary_info) || extractChannelUrl(info?.secondary_info),
        thumbnails: extractThumbnailList(basic).length ? extractThumbnailList(basic) : extractThumbnailList(info),
        durationFormatted,
        duration: durationFormatted,
        view_count: parseNumeric(basic?.view_count ?? basic?.viewCount),
        youtubei: true,
        source_name: "youtubei.js"
    };
}

/**
 * Lazily creates and reuses a shared youtubei.js client instance.
 */
async function getYoutubeiClient(): Promise<any> {
    if (!youtubeiClientPromise) {
        youtubeiClientPromise = (async () => {
            const mod: any = await import("youtubei.js");
            const Innertube = mod?.Innertube ?? mod?.default?.Innertube;
            const UniversalCache = mod?.UniversalCache ?? mod?.default?.UniversalCache;

            if (!Innertube?.create) {
                throw new Error("youtubei.js Innertube.create is not available");
            }

            const config: Record<string, any> = {};
            if (UniversalCache) {
                config.cache = new UniversalCache(false);
            }

            return Innertube.create(config);
        })().catch((error) => {
            youtubeiClientPromise = null;
            throw error;
        });
    }

    return youtubeiClientPromise;
}

/**
 * YouTube extractor that combines youtubei.js for fast metadata lookups
 * with yt-dlp as a robust fallback for search, video and playlist resolution.
 */
export class YouTubeDlpExtractor extends BaseExtractor<YouTubeDlpExtractorInit> {
    public static identifier = "com.dfxphoenix.youtubedlp-extractor" as const;
    public override priority = 100;

    private readonly videoInfoCache = new Map<string, CacheEntry<YtRaw>>();
    private readonly playlistInfoCache = new Map<string, CacheEntry<YtRaw>>();
    private readonly searchCache = new Map<string, CacheEntry<YtRaw[]>>();
    private youtubeiLogged = false;
    private originalConsoleWarn?: typeof console.warn;
    private originalConsoleError?: typeof console.error;
    private originalConsoleLog?: typeof console.log;
    private originalConsoleInfo?: typeof console.info;
    private originalConsoleDebug?: typeof console.debug;

    /**
     * Builds a YouTube-friendly fallback search query for bridging tracks
     * coming from other extractors.
     */
    public createBridgeQuery = (track: Track) =>
        `${track.title} ${track.author} official audio`;

    /**
     * Effective timeout used for search requests.
     */
    private get searchTimeoutMs(): number {
        return Math.max(1200, this.options.searchTimeoutMs ?? 6000);
    }

    /**
     * Effective timeout used for single-video metadata requests.
     */
    private get videoTimeoutMs(): number {
        return Math.max(1500, this.options.videoTimeoutMs ?? 7000);
    }

    /**
     * Effective timeout used for playlist loading and continuations.
     */
    private get playlistTimeoutMs(): number {
        return Math.max(8000, this.options.playlistTimeoutMs ?? 25000);
    }

    /**
     * Effective timeout used for yt-dlp-backed operations.
     */
    private get ytdlpTimeoutMs(): number {
        return Math.max(3000, this.options.ytdlpTimeoutMs ?? 25000);
    }

    /**
     * TTL applied to in-memory metadata caches.
     */
    private get infoCacheTtlMs(): number {
        return Math.max(5000, this.options.infoCacheTtlMs ?? 2 * 60 * 1000);
    }

    /**
     * Writes debug logs only when extractor debugging is enabled.
     */
    private log(...args: any[]) {
        if (!this.options.debug) return;
        console.log("[YouTubeDlpExtractor]", ...args);
    }

    /**
     * Temporarily silences noisy youtubei.js parser logs without affecting other output.
     */
    private muteYoutubeJsConsole() {
        if (this.originalConsoleWarn) return;

        this.originalConsoleWarn = console.warn.bind(console);
        this.originalConsoleError = console.error.bind(console);
        this.originalConsoleLog = console.log.bind(console);
        this.originalConsoleInfo = console.info.bind(console);
        this.originalConsoleDebug = console.debug.bind(console);

        console.warn = (...args: any[]) => {
            if (shouldMuteYoutubeJs(args)) return;
            this.originalConsoleWarn?.(...args);
        };

        console.error = (...args: any[]) => {
            if (shouldMuteYoutubeJs(args)) return;
            this.originalConsoleError?.(...args);
        };

        console.log = (...args: any[]) => {
            if (shouldMuteYoutubeJs(args)) return;
            this.originalConsoleLog?.(...args);
        };

        console.info = (...args: any[]) => {
            if (shouldMuteYoutubeJs(args)) return;
            this.originalConsoleInfo?.(...args);
        };

        console.debug = (...args: any[]) => {
            if (shouldMuteYoutubeJs(args)) return;
            this.originalConsoleDebug?.(...args);
        };
    }

    /**
     * Restores the original console methods previously wrapped for youtubei.js noise filtering.
     */
    private unmuteYoutubeJsConsole() {
        if (this.originalConsoleWarn) console.warn = this.originalConsoleWarn;
        if (this.originalConsoleError) console.error = this.originalConsoleError;
        if (this.originalConsoleLog) console.log = this.originalConsoleLog;
        if (this.originalConsoleInfo) console.info = this.originalConsoleInfo;
        if (this.originalConsoleDebug) console.debug = this.originalConsoleDebug;

        this.originalConsoleWarn = undefined;
        this.originalConsoleError = undefined;
        this.originalConsoleLog = undefined;
        this.originalConsoleInfo = undefined;
        this.originalConsoleDebug = undefined;
    }

    /**
     * Returns the shared youtubei.js client and logs available methods once in debug mode.
     */
    private async getYoutubei() {
        const client = await getYoutubeiClient();

        if (this.options.debug && !this.youtubeiLogged) {
            this.youtubeiLogged = true;
            this.log("youtubei.js methods", {
                search: typeof client?.search,
                getInfo: typeof client?.getInfo,
                getBasicInfo: typeof client?.getBasicInfo,
                getPlaylist: typeof client?.getPlaylist
            });
        }

        return client;
    }

    /**
     * Activates the extractor and registers the protocols it can handle.
     */
    public async activate(): Promise<void> {
        this.muteYoutubeJsConsole();

        this.protocols = this.options.enableProtocols === false
            ? []
            : ["youtube", "youtu.be", "ytsearch", "ytvideo", "ytplaylist"];
    }

    /**
     * Deactivates the extractor and clears any runtime state and caches.
     */
    public async deactivate(): Promise<void> {
        this.unmuteYoutubeJsConsole();

        this.protocols = [];
        this.videoInfoCache.clear();
        this.playlistInfoCache.clear();
        this.searchCache.clear();
    }

    /**
     * Validates whether the query should be handled by this extractor.
     */
    public async validate(query: string, type?: SearchQueryType | null): Promise<boolean> {
        if (!query || typeof query !== "string") return false;
        if (isYouTubeUrl(query)) return true;
        if (looksLikeUrl(query)) return false;

        return type === QueryType.YOUTUBE_SEARCH || type === QueryType.AUTO_SEARCH;
    }

    /**
     * Reads a cache entry and evicts it automatically if it has expired.
     */
    private getCacheValue<T>(map: Map<string, CacheEntry<T>>, key: string): T | null {
        const cached = map.get(key);
        if (!cached) return null;
        if (cached.expiresAt <= Date.now()) {
            map.delete(key);
            return null;
        }
        return cached.value;
    }

    /**
     * Removes expired entries from an in-memory cache map.
     */
    private pruneCache<T>(map: Map<string, CacheEntry<T>>) {
        const now = Date.now();
        for (const [key, value] of map) {
            if (value.expiresAt <= now) map.delete(key);
        }
    }

    /**
     * Stores a value in cache using the configured TTL and returns it unchanged.
     */
    private setCacheValue<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): T {
        this.pruneCache(map);
        map.set(key, { value, expiresAt: Date.now() + this.infoCacheTtlMs });
        return value;
    }

    /**
     * Extracts playlist items from different raw payload shapes.
     */
    private extractPlaylistItems(raw: YtRaw): YtRaw[] {
        if (Array.isArray(raw?.videos)) return raw.videos.filter(Boolean);
        if (Array.isArray(raw?.items)) return raw.items.filter(Boolean);
        if (Array.isArray(raw?.tracks)) return raw.tracks.filter(Boolean);
        return normalizeEntries(raw);
    }

    /**
     * Removes duplicate playlist/search items while preserving their original order.
     */
    private dedupeItems(items: YtRaw[]): YtRaw[] {
        const seen = new Set<string>();
        const output: YtRaw[] = [];

        for (const item of items) {
            if (!item) continue;
            const key = String(item.id || item.videoId || item.video_id || item.url || item.webpage_url || item.title || "");
            if (!key || seen.has(key)) continue;
            seen.add(key);
            output.push(item);
        }

        return output;
    }

    /**
     * Normalizes a playlist entry so it always exposes a canonical video URL and id.
     */
    private normalizePlaylistEntry(item: YtRaw): YtRaw {
        const id = item?.id || item?.videoId || item?.video_id || item?.url;
        const finalId = typeof id === "string" && id.startsWith("http")
            ? (getYouTubeVideoId(id) || id)
            : id;
        const baseUrl = item?.url || item?.webpage_url || item?.original_url || "";
        const finalUrl = finalId && typeof finalId === "string" && !finalId.startsWith("http")
            ? `https://www.youtube.com/watch?v=${String(finalId)}`
            : (baseUrl ? toCanonicalVideoUrl(String(baseUrl)) : "");

        return {
            ...item,
            id: item?.id || item?.videoId || item?.video_id || getYouTubeVideoId(finalUrl) || undefined,
            ...(finalUrl
                ? {
                      url: finalUrl,
                      webpage_url: finalUrl,
                      original_url: finalUrl
                  }
                : {})
        };
    }

    /**
     * Converts raw metadata into a discord-player Track instance.
     */
    private buildTrack(
        raw: YtRaw,
        context: ExtractorSearchContext,
        fallbackQuery: string,
        playlist?: Playlist
    ): Track {
        const duration =
            raw?.durationFormatted ||
            raw?.duration_string ||
            (typeof raw?.duration === "number"
                ? (raw.duration > 10000 ? millisecondsToDuration(raw.duration) : secondsToDuration(raw.duration))
                : undefined) ||
            (typeof raw?.duration === "string" ? raw.duration : undefined) ||
            (typeof raw?.lengthSeconds === "string" ? secondsToDuration(Number(raw.lengthSeconds)) : undefined) ||
            "0:00";

        const title = resolveTrackTitle(raw);
        const pickedUrl = pickVideoUrl(raw, fallbackQuery);
        const url = isHttpUrl(pickedUrl)
            ? toCanonicalVideoUrl(pickedUrl)
            : `https://www.youtube.com/watch?v=${String(raw?.id || raw?.videoId || raw?.video_id || "")}`;

        const thumbnail = pickThumbnail(raw);

        return new Track(this.context.player, {
            title,
            description: String(raw?.description || ""),
            author: pickAuthor(raw),
            url,
            thumbnail,
            duration,
            views: Number(raw?.views ?? raw?.view_count ?? raw?.viewCount ?? 0) || 0,
            requestedBy: context.requestedBy ?? undefined,
            playlist,
            source: "youtube",
            queryType: context.type ?? undefined,
            engine: raw,
            metadata: raw,
            requestMetadata: async () => raw,
            cleanTitle: title,
            raw: {
                ...raw,
                extractor: "youtube-ytdlp",
                sourceUrl: url
            }
        });
    }

    /**
     * Converts raw playlist metadata into a discord-player Playlist instance.
     */
    private buildPlaylist(raw: YtRaw, context: ExtractorSearchContext): Playlist {
        const url = String(raw?.webpage_url || raw?.original_url || raw?.url || "");
        const playlist = new Playlist(this.context.player, {
            title: String(raw?.title || "YouTube Playlist"),
            description: String(raw?.description || ""),
            thumbnail: pickThumbnail(raw),
            type: "playlist",
            source: "youtube",
            author: {
                name: pickAuthor(raw),
                url: raw?.channel_url || raw?.uploader_url || raw?.channel?.url || undefined
            },
            tracks: [],
            id: String(raw?.id || raw?.playlist_id || getYouTubeListId(url) || url),
            url,
            rawPlaylist: raw
        });

        const allItems = this.dedupeItems(this.extractPlaylistItems(raw).map((item) => this.normalizePlaylistEntry(item)));
        const limitedItems = typeof this.options.playlistSearchLimit === "number"
            ? allItems.slice(0, Math.max(1, this.options.playlistSearchLimit))
            : allItems;

        playlist.tracks = limitedItems.map((item) => this.buildTrack(item, context, item?.url || url, playlist));
        return playlist;
    }

    /**
     * Resolves search results using youtubei.js first, then yt-dlp as fallback.
     */
    private async fetchSearchEntries(query: string, count: number): Promise<YtRaw[]> {
        const key = `${count}:${query.trim().toLowerCase()}`;
        const cached = this.getCacheValue(this.searchCache, key);
        if (cached) return cached;

        try {
            const youtube = await this.getYoutubei();
            const search: any = await withTimeout(
                youtube.search(query),
                this.searchTimeoutMs,
                "youtubei.js search"
            );
            const results = Array.from(search?.videos || [])
                .map((item: any) => normalizeYoutubeiVideoNode(item, query))
                .filter(Boolean) as YtRaw[];

            if (results.length) {
                const filtered = results.slice(0, count);
                this.log("search -> youtubei.js", query, filtered.length);
                return this.setCacheValue(this.searchCache, key, filtered);
            }
        } catch (e: any) {
            this.log("search youtubei.js failed", query, e?.message || e);
        }

        try {
            const info = await withTimeout(
                getInfo(`ytsearch${count}:${query}`, { agent: this.options.agent ?? null }),
                this.ytdlpTimeoutMs,
                "yt-dlp search"
            );
            const raw = info?.raw as YtRaw | undefined;
            const entries = raw ? normalizeEntries(raw) : [];
            if (entries.length) {
                this.log("search -> yt-dlp", query, entries.length);
            }
            return this.setCacheValue(this.searchCache, key, entries.slice(0, count));
        } catch (e: any) {
            this.log("search yt-dlp failed", query, e?.message || e);
            return [];
        }
    }

    /**
     * Resolves a single video metadata payload using youtubei.js first,
     * then yt-dlp if richer data or a fallback is needed.
     */
    private async fetchVideoRaw(query: string): Promise<YtRaw | null> {
        const normalized = toCanonicalVideoUrl(query);
        const cached = this.getCacheValue(this.videoInfoCache, normalized);
        if (cached) return cached;

        let youtubeiRaw: YtRaw | null = null;
        const videoId = getYouTubeVideoId(normalized);
        if (videoId) {
            try {
                const youtube = await this.getYoutubei();

                if (typeof youtube?.getBasicInfo === "function") {
                    const basicInfo = await withTimeout(
                        youtube.getBasicInfo(videoId),
                        this.videoTimeoutMs,
                        "youtubei.js getBasicInfo"
                    );

                    const basicRaw = normalizeYoutubeiVideoInfo(basicInfo, normalized);
                    if (basicRaw) {
                        youtubeiRaw = basicRaw;
                    }
                }

                if ((!youtubeiRaw || resolveTrackTitle(youtubeiRaw) === "Unknown title") && typeof youtube?.getInfo === "function") {
                    const fullInfo = await withTimeout(
                        youtube.getInfo(videoId),
                        Math.max(this.videoTimeoutMs, 12000),
                        "youtubei.js getInfo"
                    );

                    const fullRaw = normalizeYoutubeiVideoInfo(fullInfo, normalized);
                    if (fullRaw) {
                        youtubeiRaw = fullRaw;
                    }
                }

                const youtubeiTitleOk = !!youtubeiRaw && resolveTrackTitle(youtubeiRaw) !== "Unknown title";
                const youtubeiUrlOk = !!youtubeiRaw && isHttpUrl(pickVideoUrl(youtubeiRaw, normalized));
                const youtubeiThumbOk = !!youtubeiRaw && !!pickThumbnail(youtubeiRaw);

                if (youtubeiTitleOk && youtubeiUrlOk && youtubeiThumbOk) {
                    this.log("video -> youtubei.js", videoId);
                    return this.setCacheValue(this.videoInfoCache, normalized, youtubeiRaw);
                }
            } catch (e: any) {
                this.log("video youtubei.js failed", videoId, e?.message || e);
            }
        }

        try {
            const info = await withTimeout(
                getInfo(normalized, { agent: this.options.agent ?? null }),
                this.ytdlpTimeoutMs,
                "yt-dlp getInfo(video)"
            );
            const raw = info?.raw as YtRaw | undefined;
            if (raw) {
                this.log("video -> yt-dlp", normalized);
                return this.setCacheValue(this.videoInfoCache, normalized, raw);
            }
        } catch (e: any) {
            this.log("video yt-dlp failed", normalized, e?.message || e);
        }

        if (youtubeiRaw) {
            this.log("video -> youtubei.js fallback", videoId || normalized);
            return this.setCacheValue(this.videoInfoCache, normalized, youtubeiRaw);
        }

        return null;
    }

    /**
     * Resolves playlist metadata and entries, supporting normal playlists,
     * mixes and yt-dlp fallbacks when youtubei.js is incomplete.
     */
    private async fetchPlaylistRaw(query: string): Promise<YtRaw | null> {
        const normalized = normalizeYouTubeUrl(query);
        const mix = isMixList(normalized);
        const listId = getYouTubeListId(normalized);
        if (!listId) return null;

        const videoId = getYouTubeVideoId(normalized);
        const playlistOnlyUrl = toCanonicalPlaylistUrl(normalized);
        const playlistUrl = mix ? normalized : playlistOnlyUrl;
        const mixWatchUrl = mix && videoId
            ? `https://www.youtube.com/watch?v=${videoId}&list=${encodeURIComponent(listId)}&start_radio=1`
            : playlistUrl;

        const cacheKey = `playlist:${listId}:${mix ? (videoId || "mix") : "playlist"}`;
        const cached = this.getCacheValue(this.playlistInfoCache, cacheKey);
        if (cached) return cached;

        try {
            const youtube = await this.getYoutubei();
            let playlist: any = await withTimeout(
                youtube.getPlaylist(listId),
                this.playlistTimeoutMs,
                "youtubei.js getPlaylist"
            );

            const maxItems = typeof this.options.playlistSearchLimit === "number"
                ? Math.max(1, this.options.playlistSearchLimit)
                : Number.POSITIVE_INFINITY;

            let items = Array.from(playlist?.videos || [])
                .map((item: any) => normalizeYoutubeiVideoNode(item, playlistUrl))
                .filter(Boolean) as YtRaw[];

            while (
                items.length < maxItems &&
                playlist?.has_continuation &&
                typeof playlist?.getContinuation === "function"
            ) {
                playlist = await withTimeout(
                    playlist.getContinuation(),
                    this.playlistTimeoutMs,
                    "youtubei.js playlist continuation"
                );

                const nextItems = Array.from(playlist?.videos || [])
                    .map((item: any) => normalizeYoutubeiVideoNode(item, playlistUrl))
                    .filter(Boolean) as YtRaw[];

                if (!nextItems.length) break;
                items = this.dedupeItems([...items, ...nextItems]);
            }

            const normalizedItems = this.dedupeItems(items.map((item) => this.normalizePlaylistEntry(item)));
            if (normalizedItems.length) {
                const raw: YtRaw = {
                    id: String((playlist as any)?.id || listId),
                    playlist_id: String(listId),
                    title: textFrom((playlist as any)?.title) || "YouTube Playlist",
                    description: textFrom((playlist as any)?.description || ""),
                    author: extractAuthorName(playlist),
                    channel: extractAuthorName(playlist),
                    channel_url: extractChannelUrl(playlist),
                    thumbnails: extractThumbnailList(playlist),
                    url: playlistUrl,
                    webpage_url: playlistUrl,
                    original_url: playlistUrl,
                    videos: normalizedItems,
                    items: normalizedItems,
                    entries: normalizedItems,
                    youtubei: true,
                    source_name: "youtubei.js"
                };

                this.log("playlist -> youtubei.js", listId, normalizedItems.length);
                return this.setCacheValue(this.playlistInfoCache, cacheKey, raw);
            }
        } catch (e: any) {
            this.log("playlist youtubei.js failed", listId, e?.message || e);
        }

        const flatCandidates = [...new Set([mixWatchUrl, playlistUrl, playlistOnlyUrl, normalized])];

        for (const candidate of flatCandidates) {
            try {
                const info = await withTimeout(
                    getPlaylistInfo(candidate, { agent: this.options.agent ?? null }),
                    Math.max(this.playlistTimeoutMs, this.ytdlpTimeoutMs),
                    "yt-dlp flat playlist"
                );
                const raw = info?.raw as YtRaw | undefined;
                const entries = raw ? this.dedupeItems(normalizeEntries(raw).map((item) => this.normalizePlaylistEntry(item))) : [];
                if (raw && entries.length) {
                    this.log("playlist -> yt-dlp flat", candidate, entries.length);
                    return this.setCacheValue(this.playlistInfoCache, cacheKey, {
                        ...raw,
                        id: String(raw?.id || raw?.playlist_id || listId),
                        url: playlistUrl,
                        webpage_url: playlistUrl,
                        original_url: playlistUrl,
                        videos: entries,
                        items: entries,
                        entries
                    });
                }
            } catch (e: any) {
                this.log("playlist yt-dlp flat failed", candidate, e?.message || e);
            }
        }

        const fullCandidates = [...new Set([mixWatchUrl, playlistUrl, playlistOnlyUrl, normalized])];

        for (const candidate of fullCandidates) {
            try {
                const info = await withTimeout(
                    getInfo(candidate, { agent: this.options.agent ?? null }),
                    Math.max(this.playlistTimeoutMs, this.ytdlpTimeoutMs),
                    "yt-dlp getInfo(playlist)"
                );
                const raw = info?.raw as YtRaw | undefined;
                const entries = raw ? this.dedupeItems(normalizeEntries(raw).map((item) => this.normalizePlaylistEntry(item))) : [];
                if (raw && entries.length) {
                    this.log("playlist -> yt-dlp full", candidate, entries.length);
                    return this.setCacheValue(this.playlistInfoCache, cacheKey, {
                        ...raw,
                        id: String(raw?.id || raw?.playlist_id || listId),
                        url: playlistUrl,
                        webpage_url: playlistUrl,
                        original_url: playlistUrl,
                        videos: entries,
                        items: entries,
                        entries
                    });
                }
            } catch (e: any) {
                this.log("playlist yt-dlp full failed", candidate, e?.message || e);
            }
        }

        return null;
    }

    /**
     * Runs a YouTube search and converts the results into extractor tracks.
     */
    private async runSearch(query: string, context: ExtractorSearchContext, limit?: number): Promise<ExtractorInfo> {
        const count = Math.max(1, limit ?? this.options.searchLimit ?? 1);
        const entries = await this.fetchSearchEntries(query, count);
        if (!entries.length) return this.createResponse();

        const tracks = entries.slice(0, count).map((entry) => this.buildTrack(entry, context, query));
        return this.createResponse(null, tracks);
    }

    /**
     * Resolves a single YouTube URL into one playable track.
     */
    private async resolveVideo(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        const normalized = toCanonicalVideoUrl(query);
        const raw = await this.fetchVideoRaw(normalized);
        if (!raw) return this.createResponse();
        return this.createResponse(null, [this.buildTrack(raw, context, normalized)]);
    }

    /**
     * Resolves a YouTube playlist URL into a Playlist response with tracks.
     */
    private async resolvePlaylist(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        const normalized = normalizeYouTubeUrl(query);
        const raw = await this.fetchPlaylistRaw(normalized);
        if (!raw) return this.createResponse();

        const playlist = this.buildPlaylist(raw, context);
        if (!playlist.tracks.length) return this.createResponse();
        return this.createResponse(playlist, playlist.tracks);
    }

    /**
     * Main query dispatcher that decides between video, playlist, mix or search handling.
     */
    public async handle(query: string, context: ExtractorSearchContext): Promise<ExtractorInfo> {
        if (isYouTubeUrl(query)) {
            const normalized = normalizeYouTubeUrl(query);

            if (isMixList(normalized)) {
                this.log("handle -> mix/single", normalized);
                return this.resolveVideo(normalized, context);
            }

            if (isPlaylistUrl(normalized) && !isMixList(normalized)) {
                this.log("handle -> playlist", normalized);
                return this.resolvePlaylist(normalized, context);
            }

            if (hasExplicitVideo(normalized)) {
                this.log("handle -> video", normalized);
                return this.resolveVideo(normalized, context);
            }
        }

        this.log("handle -> search", query);
        return this.runSearch(
            query,
            {
                ...context,
                type: context.type ?? QueryType.YOUTUBE_SEARCH
            } as ExtractorSearchContext,
            this.options.searchLimit ?? 1
        );
    }

    /**
     * Creates a raw PCM stream for the provided YouTube track.
     */
    public async stream(info: Track): Promise<ExtractorStreamable> {
        const raw = (info.raw as any) || {};
        const rawUrl = info.url || raw.sourceUrl || raw.webpage_url;
        const url = rawUrl ? toCanonicalVideoUrl(String(rawUrl)) : null;

        if (!url) throw new Error("YouTubeDlpExtractor: missing track url for stream()");

        return {
            $fmt: "raw",
            stream: createPCMStream(url, {
                agent: this.options.agent ?? null
            })
        };
    }

    /**
     * Bridges a non-YouTube track into a playable YouTube result when possible.
     */
    public async bridge(
        track: Track,
        sourceExtractor: BaseExtractor<object> | null
    ): Promise<null | ExtractorStreamable> {
        const raw = (track.raw as any) || {};
        const directUrl =
            track.url ||
            raw.sourceUrl ||
            raw.url ||
            null;

        const scheme = directUrl ? getProtocolScheme(String(directUrl)) : null;

        if (sourceExtractor?.identifier === this.identifier && directUrl && isYouTubeUrl(String(directUrl))) {
            return this.stream(track);
        }

        if (scheme && !["http", "https"].includes(scheme)) {
            return null;
        }

        const query =
            sourceExtractor?.createBridgeQuery(track) ??
            this.createBridgeQuery(track);

        const info = await this.handle(query, {
            requestedBy: track.requestedBy,
            type: QueryType.YOUTUBE_SEARCH
        } as ExtractorSearchContext);

        if (!info.tracks.length) return null;

        const result = await this.stream(info.tracks[0]);

        if (result) {
            track.bridgedTrack = info.tracks[0];
            track.bridgedExtractor = this;
        }

        return result;
    }

    /**
     * Returns related YouTube tracks by reusing the bridge search query and filtering duplicates.
     */
    public async getRelatedTracks(track: Track): Promise<ExtractorInfo> {
        const limit = Math.max(1, this.options.relatedLimit ?? 5);
        const result = await this.runSearch(
            this.createBridgeQuery(track),
            {
                requestedBy: track.requestedBy ?? undefined,
                type: QueryType.YOUTUBE_SEARCH
            } as ExtractorSearchContext,
            limit + 1
        );

        const filtered = result.tracks.filter((candidate) => {
            const sameUrl = candidate.url && track.url && candidate.url === track.url;
            const sameTitleAuthor =
                candidate.title?.toLowerCase() === track.title?.toLowerCase() &&
                candidate.author?.toLowerCase() === track.author?.toLowerCase();
            return !sameUrl && !sameTitleAuthor;
        });

        return this.createResponse(null, filtered.slice(0, limit));
    }
}

export default YouTubeDlpExtractor;
