import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { runInThisContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { YTNodes } from "youtubei.js";
import ts from "typescript";

const require = createRequire(import.meta.url);
const filename = fileURLToPath(new URL("../src/YouTubeDlpExtractor.ts", import.meta.url));
const source = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

const playlistId = "PL2oSsDTDZXA88j_UcvtwwXfoTfDrazKgC";
const videoId = "uLZhMJgGg4g";
const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
const playlistUrl = `${videoUrl}&list=${playlistId}`;
const thumbnail = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

/**
 * Creates a playlist video using the YouTube.js LockupView parser
 * @param {object} [overrides={}] The raw renderer properties to override
 * @returns {object} The parsed video
 */
function createLockupVideo(overrides = {}) {
    return new YTNodes.LockupView({
        contentId: videoId,
        contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
        metadata: {
            lockupMetadataViewModel: {
                title: { content: "Playlist song" },
                metadata: {
                    contentMetadataViewModel: {
                        metadataRows: [
                            {
                                metadataParts: [
                                    {
                                        text: {
                                            content: "Test artist",
                                            commandRuns: [
                                                {
                                                    startIndex: 0,
                                                    length: 11,
                                                    onTap: { innertubeCommand: { browseEndpoint: { browseId: "UCtest" } } }
                                                }
                                            ]
                                        }
                                    }
                                ]
                            }
                        ]
                    }
                }
            }
        },
        contentImage: {
            thumbnailViewModel: {
                image: { sources: [{ url: thumbnail, width: 480, height: 360 }] },
                overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: "3:42" } }] } }]
            }
        },
        ...overrides
    });
}

/**
 * Creates a playlist video using the legacy YouTube.js parser
 * @param {object} [overrides={}] The raw renderer properties to override
 * @returns {object} The parsed video
 */
function createPlaylistVideo(overrides = {}) {
    return new YTNodes.PlaylistVideo({
        videoId: "oj5sHx9sweg",
        title: { simpleText: "Legacy song", accessibility: { accessibilityData: { label: "Legacy song" } } },
        shortBylineText: { runs: [{ text: "Legacy artist" }] },
        thumbnail: { thumbnails: [{ url: thumbnail, width: 480, height: 360 }] },
        isPlayable: true,
        lengthText: { simpleText: "4:12" },
        lengthSeconds: "252",
        ...overrides
    });
}

/**
 * Creates a short video using the YouTube.js ShortsLockupView parser
 * @returns {object} The parsed short video
 */
function createShortsVideo() {
    return new YTNodes.ShortsLockupView({
        entityId: "shorts-item",
        thumbnail: { sources: [{ url: thumbnail, width: 480, height: 360 }] },
        onTap: { innertubeCommand: { reelWatchEndpoint: { videoId } } },
        overlayMetadata: { primaryText: { content: "Short song" } }
    });
}

/** Creates an isolated extractor with local service responses */
function createExtractor(options = {}) {
    const state = {
        playlist: { info: { title: "Test playlist", author: { name: "Playlist owner" }, thumbnails: [{ url: thumbnail }] }, items: [createLockupVideo(), createPlaylistVideo()] },
        playlistError: null,
        search: { videos: [createLockupVideo()] },
        video: { basic_info: { id: videoId, title: "Single song", author: "Test artist", duration: 222, view_count: 42 } },
        flat: { raw: { id: playlistId, title: "Fallback playlist", entries: [{ id: videoId, title: "Fallback song" }] } },
        flatError: null,
        full: null,
        calls: { playlist: [], search: [], video: [], flat: [], full: [], stream: [] }
    };
    const ytdlp = {
        getPlaylistInfo: async (query, options) => {
            state.calls.flat.push({ query, options });
            if (state.flatError) throw state.flatError;
            return state.flat;
        },
        getInfo: async (query, options) => {
            state.calls.full.push({ query, options });
            return state.full;
        },
        createPCMStream: (query, options) => {
            state.calls.stream.push({ query, options });
            return new PassThrough();
        }
    };
    const module = { exports: {} };
    const load = (name) => name === "./YTDLP.js" ? ytdlp : require(name);
    runInThisContext(`(function(require, module, exports) { ${source}\n})`, { filename })(load, module, module.exports);
    const extractor = new module.exports.YouTubeDlpExtractor({ player: {} }, options);
    extractor.getYoutubei = async () => ({
        getPlaylist: async (id) => {
            state.calls.playlist.push(id);
            if (state.playlistError) throw state.playlistError;
            return state.playlist;
        },
        search: async (query) => {
            state.calls.search.push(query);
            return state.search;
        },
        getInfo: async (id) => {
            state.calls.video.push(id);
            return state.video;
        }
    });
    return { extractor, state };
}

export { playlistId, videoId, videoUrl, playlistUrl, thumbnail, createLockupVideo, createPlaylistVideo, createShortsVideo, createExtractor };
