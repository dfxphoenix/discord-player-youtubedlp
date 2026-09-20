import assert from "node:assert/strict";
import { test } from "node:test";
import { playlistId, videoId, videoUrl, playlistUrl, createExtractor } from "./helpers.js";

for (const failure of ["error", "empty", "invalid", "empty items with recommendations"]) {
    test(`uses yt-dlp when YouTube.js returns ${failure}`, async () => {
        const agent = { cookies: "test=value" };
        const { extractor, state } = createExtractor({ agent });
        state.playlist = { items: [] };
        if (failure === "error") state.playlistError = new Error("YouTube unavailable");
        if (failure === "invalid") state.playlist.items = [{ title: "Missing ID" }, { id: "invalid" }];
        if (failure === "empty items with recommendations") state.playlist.videos = [{ id: videoId, title: "Recommendation" }];
        const { tracks, playlist } = await extractor.handle(playlistUrl, {});

        assert.equal(tracks[0].url, videoUrl);
        assert.equal(tracks[0].title, "Fallback song");
        assert.equal(playlist.title, "Fallback playlist");
        assert.equal(state.calls.flat.length, 1);
        assert.equal(state.calls.flat[0].query, `https://www.youtube.com/playlist?list=${playlistId}`);
        assert.equal(state.calls.flat[0].options.agent, agent);
    });
}

test("uses the full yt-dlp response when flat extraction fails", async () => {
    const { extractor, state } = createExtractor();
    state.playlistError = new Error("YouTube unavailable");
    state.flatError = new Error("Flat extraction failed");
    state.full = { raw: { entries: [{ id: videoId, title: "Full song" }] } };
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks[0].title, "Full song");
    assert.equal(tracks[0].url, videoUrl);
    assert.equal(state.calls.full.length, 1);
});

test("rejects invalid flat entries before trying full extraction", async () => {
    const { extractor, state } = createExtractor();
    state.playlist = { items: [] };
    state.flat = { raw: { entries: [{ title: "Missing ID" }, { url: `https://www.youtube.com/playlist?list=${playlistId}` }] } };
    state.full = { raw: { entries: [{ id: videoId, title: "Full song" }] } };
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks[0].title, "Full song");
    assert.equal(state.calls.full.length, 1);
});

test("normalizes yt-dlp IDs and URLs while skipping unusable entries", async () => {
    const { extractor, state } = createExtractor();
    state.playlist = { items: [] };
    state.flat = {
        raw: {
            entries: [
                null,
                { id: "invalid", title: "Invalid" },
                { id: videoId, is_playable: false },
                { url: videoId, title: "First song" },
                { id: videoId, title: "Duplicate" },
                { webpage_url: "https://music.youtube.com/watch?v=oj5sHx9sweg&list=other", title: "Second song" }
            ]
        }
    };
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.deepEqual(tracks.map((track) => track.url), [videoUrl, "https://www.youtube.com/watch?v=oj5sHx9sweg"]);
    assert.deepEqual(tracks.map((track) => track.title), ["First song", "Second song"]);
});

test("returns an empty result when every provider fails", async () => {
    const { extractor, state } = createExtractor();
    state.playlistError = new Error("YouTube unavailable");
    state.flatError = new Error("yt-dlp unavailable");
    const result = await extractor.handle(playlistUrl, {});

    assert.equal(result.playlist, null);
    assert.deepEqual(result.tracks, []);
});

test("falls back after a failed continuation", async () => {
    const { extractor, state } = createExtractor();
    state.playlist.has_continuation = true;
    state.playlist.getContinuation = async () => { throw new Error("Continuation failed"); };
    const { tracks } = await extractor.handle(playlistUrl, {});

    assert.equal(tracks[0].title, "Fallback song");
    assert.equal(state.calls.flat.length, 1);
});
