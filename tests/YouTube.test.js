import assert from "node:assert/strict";
import { test } from "node:test";
import { videoId, videoUrl, playlistUrl, createLockupVideo, createPlaylistVideo, createExtractor } from "./helpers.js";

for (const url of [videoUrl, `https://music.youtube.com/watch?v=${videoId}`, `https://youtu.be/${videoId}`, `${videoUrl}&list=RD${videoId}`]) {
    test(`keeps single-video handling for ${url}`, async () => {
        const { extractor, state } = createExtractor();
        const { tracks, playlist } = await extractor.handle(url, {});

        assert.equal(playlist, null);
        assert.equal(tracks.length, 1);
        assert.equal(tracks[0].url, videoUrl);
        assert.equal(tracks[0].title, "Single song");
        assert.equal(tracks[0].duration, "3:42");
        assert.equal(state.calls.playlist.length, 0);
    });
}

test("searches both video layouts and preserves the search limit", async () => {
    const { extractor, state } = createExtractor({ searchLimit: 2 });
    state.search.videos = [createLockupVideo(), createPlaylistVideo(), createLockupVideo({ contentId: "abcdefghijk" })];
    const { tracks } = await extractor.handle("test artist", {});

    assert.deepEqual(tracks.map((track) => track.title), ["Playlist song", "Legacy song"]);
    assert.deepEqual(tracks.map((track) => track.url), [videoUrl, "https://www.youtube.com/watch?v=oj5sHx9sweg"]);
    assert.deepEqual(state.calls.search, ["test artist"]);
});

test("falls back when search results have no video IDs", async () => {
    const { extractor, state } = createExtractor();
    state.search.videos = [{ title: "Missing ID" }];
    state.full = { raw: { entries: [{ id: videoId, title: "Search fallback" }] } };
    const { tracks } = await extractor.handle("test artist", {});

    assert.equal(tracks[0].title, "Search fallback");
    assert.equal(state.calls.full[0].query, "ytsearch1:test artist");
});

test("passes a canonical video URL to the audio stream", async () => {
    const { extractor, state } = createExtractor();
    const { tracks } = await extractor.handle(playlistUrl, {});
    const result = await extractor.stream(tracks[0]);

    assert.equal(state.calls.stream[0].query, videoUrl);
    result.stream.destroy();
});
