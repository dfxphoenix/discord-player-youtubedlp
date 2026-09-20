import assert from "node:assert/strict";
import { test } from "node:test";
import { Playlist, Track } from "discord-player";
import { playlistId, videoId, videoUrl, playlistUrl, thumbnail, createLockupVideo, createPlaylistVideo, createShortsVideo, createExtractor } from "./helpers.js";

const urls = [
    playlistUrl,
    `https://www.youtube.com/playlist?list=${playlistId}`,
    `https://music.youtube.com/watch?v=${videoId}&list=${playlistId}`,
    `https://music.youtube.com/playlist?list=${playlistId}`,
    `https://youtu.be/${videoId}?list=${playlistId}`
];

for (const url of urls) {
    test(`resolves the complete playlist from ${url}`, async () => {
        const { extractor, state } = createExtractor();
        const requestedBy = { id: "123456789012345678" };
        const result = await extractor.handle(url, { requestedBy });

        assert.ok(result.playlist instanceof Playlist);
        assert.deepEqual(result.tracks.map((track) => track.url), [videoUrl, "https://www.youtube.com/watch?v=oj5sHx9sweg"]);
        for (const track of result.tracks) {
            assert.ok(track instanceof Track);
            assert.equal(track.playlist, result.playlist);
            assert.equal(track.requestedBy, requestedBy);
        }
        assert.deepEqual(state.calls.playlist, [playlistId]);
        assert.equal(state.calls.video.length, 0);
        assert.equal(state.calls.flat.length, 0);
    });
}

test("reads modern and legacy track metadata", async () => {
    const { extractor } = createExtractor();
    const { tracks, playlist } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks[0].title, "Playlist song");
    assert.equal(tracks[0].author, "Test artist");
    assert.equal(tracks[0].duration, "3:42");
    assert.equal(tracks[0].thumbnail, thumbnail);
    assert.equal(tracks[1].title, "Legacy song");
    assert.equal(tracks[1].author, "Legacy artist");
    assert.equal(tracks[1].duration, "4:12");
    assert.equal(playlist.title, "Test playlist");
    assert.equal(playlist.author.name, "Playlist owner");
    assert.equal(playlist.thumbnail, thumbnail);
});

test("keeps separate LockupView videos in their original order", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.items = [createLockupVideo(), createLockupVideo({ contentId: "oj5sHx9sweg" })];
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.deepEqual(tracks.map((track) => track.url), [videoUrl, "https://www.youtube.com/watch?v=oj5sHx9sweg"]);
});

test("reads Shorts through their watch endpoint", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.items = [createShortsVideo()];
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks[0].url, videoUrl);
    assert.equal(tracks[0].title, "Short song");
    assert.equal(tracks[0].thumbnail, thumbnail);
});

test("uses playlist items instead of recommendations", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.items = [createLockupVideo()];
    state.playlist.videos = [...state.playlist.items, createPlaylistVideo()];
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.deepEqual(tracks.map((track) => track.url), [videoUrl]);
});

test("supports legacy responses without items or info", async () => {
    const { extractor, state } = createExtractor();
    state.playlist = { title: "Legacy playlist", author: "Legacy owner", videos: [createPlaylistVideo()] };
    const { tracks, playlist } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks.length, 1);
    assert.equal(playlist.title, "Legacy playlist");
    assert.equal(playlist.author.name, "Legacy owner");
});

test("skips unavailable videos, invalid IDs and recommended entries", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.items = [
        null,
        {},
        { id: "invalid" },
        { url: `https://www.youtube.com/playlist?list=${playlistId}` },
        createPlaylistVideo({ isPlayable: false }),
        { id: "oj5sHx9sweg", style: "PLAYLIST_VIDEO_RENDERER_STYLE_RECOMMENDED_VIDEO" },
        createLockupVideo({ contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST" }),
        createLockupVideo()
    ];
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.deepEqual(tracks.map((track) => track.url), [videoUrl]);
    assert.equal(state.calls.flat.length, 0);
});

test("preserves first-page metadata across continuations", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.items = [createLockupVideo()];
    state.playlist.has_continuation = true;
    state.playlist.getContinuation = async () => ({ items: [createLockupVideo(), createPlaylistVideo()] });
    const { tracks, playlist } = await extractor.handle(playlistUrl, {});

    assert.deepEqual(tracks.map((track) => track.url), [videoUrl, "https://www.youtube.com/watch?v=oj5sHx9sweg"]);
    assert.equal(playlist.title, "Test playlist");
    assert.equal(playlist.author.name, "Playlist owner");
    assert.equal(playlist.thumbnail, thumbnail);
});

test("continues after a page containing only unavailable entries", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.items = [createLockupVideo()];
    state.playlist.has_continuation = true;
    state.playlist.getContinuation = async () => ({
        items: [createPlaylistVideo({ isPlayable: false })],
        has_continuation: true,
        getContinuation: async () => ({ items: [createPlaylistVideo()] })
    });
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks.length, 2);
    assert.equal(state.calls.flat.length, 0);
});

test("respects the playlist limit without requesting another page", async () => {
    const { extractor, state } = createExtractor({ playlistSearchLimit: 1 });
    state.playlist.has_continuation = true;
    state.playlist.getContinuation = async () => assert.fail("Unnecessary continuation");
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.deepEqual(tracks.map((track) => track.url), [videoUrl]);
});

test("reuses playlist metadata without sharing requester data", async () => {
    const { extractor, state } = createExtractor();
    const first = await extractor.handle(playlistUrl, { requestedBy: { id: "first" } });
    const second = await extractor.handle(urls[1], { requestedBy: { id: "second" } });

    assert.equal(state.calls.playlist.length, 1);
    assert.equal(first.tracks[0].requestedBy.id, "first");
    assert.equal(second.tracks[0].requestedBy.id, "second");
    assert.notEqual(first.tracks[0], second.tracks[0]);
});
