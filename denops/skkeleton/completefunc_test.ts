import { test } from "./testutil.ts";
import { currentContext, currentLibrary } from "./store.ts";

import type { Denops } from "@denops/std";
import { assertEquals } from "@std/assert/equals";

type CompleteResult = {
  words: { word: string; user_data: string }[];
  refresh: string;
};

test({
  mode: "all",
  name: "completefunc gives up when there is no pre-edit",
  async fn(denops: Denops) {
    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), -3);
  },
});

test({
  mode: "all",
  name: "completefunc starts right after markerHenkan",
  async fn(denops: Denops) {
    const lib = await currentLibrary.get();
    lib.registerHenkanResult("okurinasi", "あ", "亜");

    await denops.cmd('call skkeleton#handle("handleKey", {"key": "A"})');
    assertEquals(currentContext.get().toString(), "▽あ");

    // `ab▽あcd` の `c` にカーソルを置く (`▽` は3バイト目から始まる)
    await denops.call("setline", 1, "ab▽あcd");
    await denops.call("cursor", 1, 9);

    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), 5);

    const result = await denops.call(
      "skkeleton#completefunc",
      0,
      "あ",
    ) as CompleteResult;
    assertEquals(result.refresh, "always");
    assertEquals(result.words.map((word) => word.word), ["亜"]);
    assertEquals(JSON.parse(result.words[0].user_data), {
      tag: "skkeleton",
      midasi: "あ",
      word: "亜",
      type: "okurinasi",
    });
  },
});

test({
  mode: "all",
  name: "complete_done removes markerHenkan for a selected candidate",
  async fn(denops: Denops) {
    const lib = await currentLibrary.get();
    lib.registerHenkanResult("okurinasi", "あ", "亜");

    await denops.cmd('call skkeleton#handle("handleKey", {"key": "A"})');
    await denops.call("setline", 1, "ab▽あcd");
    await denops.call("cursor", 1, 9);
    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), 5);

    // 補完が `あ` を `亜` に置き換えた状態
    await denops.call("setline", 1, "ab▽亜cd");
    await denops.cmd(
      "let v:completed_item = #{word: '亜', user_data: userData}",
      {
        userData: JSON.stringify({
          tag: "skkeleton",
          midasi: "あ",
          word: "亜",
          type: "okurinasi",
        }),
      },
    );
    await denops.cmd("call skkeleton#complete_done()");

    assertEquals(await denops.call("getline", 1), "ab亜cd");
    // what the completion has written to the buffer is remembered, hence
    // |skkeleton-functions-kakuteiUndo| can take it back
    assertEquals(currentContext.get().pendingKakutei?.kakutei, "亜");
  },
});

test({
  mode: "all",
  name: "complete_done keeps markerHenkan when the pre-edit is being rewritten",
  async fn(denops: Denops) {
    const lib = await currentLibrary.get();
    lib.registerHenkanResult("okurinasi", "あ", "亜");

    await denops.cmd('call skkeleton#handle("handleKey", {"key": "A"})');
    await denops.call("setline", 1, "ab▽あcd");
    await denops.call("cursor", 1, 9);
    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), 5);

    // 'autocomplete' でpre-editの書き直しが補完を中断した状態
    await denops.call("setline", 1, "ab▽cd");
    await denops.call("cursor", 1, 6);
    await denops.cmd("let v:completed_item = {}");
    await denops.cmd("call skkeleton#complete_done()");

    assertEquals(await denops.call("getline", 1), "ab▽cd");
  },
});

test({
  mode: "all",
  name: "complete_done keeps markerHenkan when the completion was cancelled",
  async fn(denops: Denops) {
    const lib = await currentLibrary.get();
    lib.registerHenkanResult("okurinasi", "あ", "亜");

    await denops.cmd('call skkeleton#handle("handleKey", {"key": "A"})');
    await denops.call("setline", 1, "ab▽あcd");
    await denops.call("cursor", 1, 9);
    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), 5);

    // <C-e> でpre-editが元に戻された状態
    await denops.cmd("let v:completed_item = {}");
    await denops.cmd("call skkeleton#complete_done()");

    assertEquals(await denops.call("getline", 1), "ab▽あcd");
  },
});

test({
  mode: "all",
  name: "completefunc gives up when the buffer does not hold the pre-edit",
  async fn(denops: Denops) {
    const lib = await currentLibrary.get();
    lib.registerHenkanResult("okurinasi", "あ", "亜");

    await denops.cmd('call skkeleton#handle("handleKey", {"key": "A"})');
    assertEquals(currentContext.get().toString(), "▽あ");

    await denops.call("setline", 1, "abcdefghij");
    await denops.call("cursor", 1, 9);

    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), -3);
  },
});

test({
  mode: "all",
  name: "completefunc gives up when there is no candidate",
  async fn(denops: Denops) {
    await denops.cmd('call skkeleton#handle("handleKey", {"key": ["N", "u"]})');
    assertEquals(currentContext.get().toString(), "▽ぬ");

    await denops.call("setline", 1, "▽ぬx");
    await denops.call("cursor", 1, 7);

    assertEquals(await denops.call("skkeleton#completefunc", 1, ""), -3);
  },
});

test({
  mode: "all",
  name: "complete_done ignores completion items of other plugins",
  async fn(denops: Denops) {
    for (
      const userData of [
        '{"tag": {}}',
        '{"tag": []}',
        '{"tag": 1.5}',
        '{"tag": "other"}',
        '{"tag": "skkeleton", "midasi": 1, "word": "亜", "type": "okurinasi"}',
        "not json",
        "",
      ]
    ) {
      await denops.cmd(
        "let v:completed_item = #{word: 'x', user_data: userData}",
        { userData },
      );
      await denops.cmd("call skkeleton#complete_done()");
    }
  },
});

// Note: the bundled completefunc reports a confirmation from CompleteDone,
//       which Vim fires after the mapping of the key that ended the completion
//       (measured). So the same ordering a completion engine of its own can
//       produce applies here too, and the cursor of
//       |skkeleton-functions-kakuteiUndo| has to survive it
test({
  mode: "nvim", // can input mode test only in nvim
  name: "complete_done leaves the cursor to what a key has started since",
  async fn(denops: Denops) {
    const lib = await currentLibrary.get();
    await lib.registerHenkanResult("okurinasi", "かく", "各");
    await lib.registerHenkanResult("okurinasi", "かくい", "各位");
    await denops.cmd(
      'call skkeleton#register_keymap("input", "<C-u>", "kakuteiUndo")',
    );
    await denops.cmd("call skkeleton#config(#{immediatelyCancel: v:false})");
    await denops.cmd("set virtualedit=onemore");
    await denops.cmd("startinsert");

    const done = async (midasi: string, word: string) => {
      await denops.cmd(
        "let v:completed_item = #{word: word, user_data: userData}",
        {
          word,
          userData: JSON.stringify({
            tag: "skkeleton",
            midasi,
            word,
            type: "okurinasi",
          }),
        },
      );
      await denops.cmd("call skkeleton#complete_done()");
    };

    // the completion confirms 各位 out of ▽かく
    for (const key of ["K", "a", "k", "u"]) {
      await denops.cmd(`call skkeleton#handle("handleKey", {"key": "${key}"})`);
    }
    await denops.call("setline", 1, "各位");
    await denops.call("cursor", 1, 7);
    await done("かくい", "各位");
    assertEquals(await denops.call("getline", 1), "各位");

    // take it back, go to the reading and shorten it
    for (const key of ["<c-u>", "<c-g>", "<c-h>"]) {
      await denops.cmd(`call skkeleton#handle("handleKey", {"key": "${key}"})`);
    }
    assertEquals(await denops.call("getline", 1), "▽かく");

    // 各 is only selected, and an uppercase key starts a new henkan point
    // instead of confirming it. CompleteDone comes after that mapping
    await denops.call("setline", 1, "各");
    await denops.call("cursor", 1, 4);
    await denops.cmd('call skkeleton#handle("handleKey", {"key": "J"})');
    assertEquals(await denops.call("getline", 1), "各▽j");
    const col = await denops.call("col", ".");
    await done("かく", "各");

    // the cursor belongs to the ▽ that key has started, not to the column the
    // undo remembered (which would be 4)
    assertEquals(await denops.call("col", "."), col);
  },
});
