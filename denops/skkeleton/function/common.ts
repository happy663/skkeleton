import { modifyCandidate } from "../candidate.ts";
import { config } from "../config.ts";
import { Context, KakuteiResult } from "../context.ts";
import { HenkanType } from "../dictionary.ts";
import { initializeStateWithAbbrev, modeChange } from "../mode.ts";
import { graphemeLength } from "../preedit.ts";
import { initializeState } from "../state.ts";
import { currentLibrary } from "../store.ts";
import { showCandidates } from "./henkan.ts";
import { kakuteiFeed } from "./input.ts";
import { hirakana } from "./mode.ts";

export async function kakutei(context: Context) {
  const state = context.state;
  switch (state.type) {
    case "henkan": {
      const snapshot = { ...state };
      const candidate = state.candidates[state.candidateIndex];
      const candidateMod = modifyCandidate(candidate, state.affix);
      if (candidate) {
        const lib = await currentLibrary.get();
        await lib.registerHenkanResult(
          state.mode,
          state.word,
          candidate,
        );
        context.lastCandidate = {
          type: state.mode,
          word: state.word,
          candidate,
        };
      }
      const okuriStr = state.converter
        ? state.converter(state.okuriFeed)
        : state.okuriFeed;
      const ret = (candidateMod ?? "error") + okuriStr;
      context.kakuteiWithUndoPoint(ret);
      // Note: remember what is needed to take this kakutei back
      context.recordKakutei("henkan", ret, snapshot);
      // Note: a henkan which an undo has restored owes the cursor its place
      //       back, now that the replacement is known and its length with it
      //       the text is written by the keys this handling returns, so the
      //       point rides along with them (see |skkeleton#restore_point()|)
      //       whether it is used at all is decided once the handling is over:
      //       the same key can confirm a henkan and open a new one after it
      context.restorePoint = context.usePointRestore(ret);
      break;
    }
    case "input": {
      kakuteiFeed(context);
      let result = state.henkanFeed + state.okuriFeed + state.feed;
      if (state.converter) {
        result = state.converter(result);
      }
      context.kakutei(result);
      break;
    }
    default:
      console.warn(
        `initializing unknown phase state: ${JSON.stringify(state)}`,
      );
  }
  await initializeStateWithAbbrev(context, ["converter", "table"]);
}

// remember a kakutei done by a completion engine so that kakuteiUndo can take
// it back as well
// {inserted} is the string the engine has written to the buffer: the candidate
// without its annotation, followed by the okurigana for an okuriari candidate
export async function completionKakutei(
  context: Context,
  type: HenkanType,
  midasi: string,
  word: string,
  inserted: string,
) {
  // the buffer has been rewritten by the engine, so an older kakutei is stale
  context.invalidateKakutei();
  const state = context.state;
  const candidateMod = modifyCandidate(word);
  if (
    state.type !== "input" ||
    // give it up when the engine has not told what it wrote: there is no way
    // to know how much of the buffer the kakutei owns then
    inserted === "" ||
    candidateMod == null || !inserted.startsWith(candidateMod)
  ) {
    return;
  }
  // Note: the engine has already written, so unlike a kakutei out of a henkan
  //       there are no keys for the point to ride along with and Vim is told
  //       right away
  //       asked before the lookup below, because the buffer holds the text even
  //       when the candidate turns out not to be in the dictionary
  const restore = context.usePointRestore(inserted);
  // Note: the report can arrive after a key handling has started something else
  //       where the cursor now is -- a new henkan point, or a reading being
  //       typed on -- and the cursor belongs to that
  const onThisReading = state.mode !== "direct" && state.henkanFeed === midasi;
  if (
    restore && (!context.hasPendingInput || onThisReading) && context.denops
  ) {
    await context.denops.call(
      "skkeleton#restore_point",
      restore.lnum,
      restore.col,
    );
  }
  // Note: the completion has never been in a henkan state, so the candidates
  //       are looked up instead of being restored from a snapshot
  //       this happens after the learning, hence the confirmed candidate comes
  //       first and is the one to select
  const lib = await currentLibrary.get();
  const candidates = await lib.getHenkanResult(type, midasi);
  const candidateIndex = candidates.indexOf(word);
  if (candidateIndex < 0) {
    return;
  }
  context.recordKakutei("completion", inserted, {
    ...state,
    type: "henkan",
    mode: type,
    affix: void 0,
    word: midasi,
    candidates,
    candidateIndex,
    feed: "",
    // Note: the completion may have extended the reading which has been
    //       typed, so take it from the midasi of the candidate
    henkanFeed: type === "okuriari" ? midasi.slice(0, -1) : midasi,
    okuriFeed: inserted.slice(candidateMod.length),
    previousFeed: false,
  });
}

// put the cursor right after the confirmed string, which is where the undo
// deletes it by feeding backspaces
//
// a mis-conversion is usually noticed after typing on, so the cursor having
// moved past the kakutei must not give up on it: ask Vim to walk back to it,
// leaving whatever has been typed since then alone. Vim only moves when the
// confirmed string is still where it was written, so an edit which has rewritten
// or displaced it takes the undo out of reach instead of deleting the wrong
// text.
//
// the cursor never having left is the common case and is answered here, without
// a round-trip to Vim.
async function locateKakutei(
  context: Context,
  last: KakuteiResult,
): Promise<boolean> {
  if (context.isRightAfterKakutei(last)) {
    return true;
  }
  if (!context.denops) {
    return false;
  }
  const before = last.bufferText.slice(
    0,
    last.bufferText.length - last.kakutei.length,
  );
  return await context.denops.call(
    "skkeleton#locate_kakutei",
    last.bufnr,
    last.lnum,
    before,
    last.kakutei,
  ) as boolean;
}

// take the last kakutei back into the candidate selection state
export async function kakuteiUndo(context: Context) {
  const state = context.state;
  const last = context.takeBackableKakutei();
  if (
    !last ||
    state.type !== "input" ||
    state.mode !== "direct" ||
    state.feed !== ""
  ) {
    return;
  }
  if (!await locateKakutei(context, last)) {
    return;
  }
  if (config.debug) {
    console.log(`kakuteiUndo: take back a ${last.type} kakutei`);
  }
  context.kakutei("\b".repeat(graphemeLength(last.kakutei)));
  const restored = { ...last.state };
  context.state = restored;
  // Note: prevInput still tells where the cursor was when the undo was asked
  //       for, which is where the kakutei picking another candidate puts it
  //       back
  context.recordPointRestore(last.kakutei, last.bufferText);
  context.invalidateKakutei();
  if (context.mode !== last.mode) {
    await modeChange(context, last.mode);
  }
  // show the candidate list again when it was shown at the kakutei
  // (the popup is closed on every key press)
  if (context.denops && restored.candidateIndex >= config.showCandidatesCount) {
    await showCandidates(context.denops, restored);
  }
}

// 確定キーの処理には強制的にひらがな入力に戻す物があるが、内部的な確定では必要ないため分けておく
export async function kakuteiKey(context: Context) {
  const { state } = context;
  // 確定する物が無い状態で確定しようとした際にモードを解除する
  // この動作はddskkに存在する
  if (state.type === "input" && state.mode === "direct" && state.feed === "") {
    await hirakana(context);
    return;
  }
  await kakutei(context);
}

export async function newline(context: Context) {
  const insertNewline = !(config.eggLikeNewline &&
    (context.state.type === "henkan" ||
      (context.state.type === "input" && context.state.mode !== "direct")));
  await kakutei(context);
  if (insertNewline) {
    context.kakutei("\n");
  }
}

export async function cancel(context: Context) {
  const state = context.state;
  if (
    state.type === "input" &&
    state.mode === "direct" &&
    context.vimMode === "c"
  ) {
    context.kakutei("\x03");
  }
  if (config.immediatelyCancel) {
    await initializeStateWithAbbrev(context);
    return;
  }
  switch (state.type) {
    case "input":
      await initializeStateWithAbbrev(context);
      break;
    case "henkan":
      context.state.type = "input";
      break;
  }
}

export async function purgeCandidate(context: Context) {
  const state = context.state;
  let type: HenkanType;
  let word: string;
  let candidate: string;
  if (state.type === "input") {
    type = context.lastCandidate.type;
    word = context.lastCandidate.word;
    candidate = context.lastCandidate.candidate;
  } else if (state.type === "henkan") {
    type = state.mode;
    word = state.word;
    candidate = state.candidates[state.candidateIndex];
  } else {
    console.log("purgeCandidate: reach illegal state");
    console.log(context);
    return;
  }
  if (word === "") {
    return;
  }
  const msg = `Really purge? ${word} /${candidate}/`;
  if (await context.denops!.call("confirm", msg, "&Yes\n&No\n", 2) === 1) {
    const lib = await currentLibrary.get();
    lib.purgeCandidate(type, word, candidate);
    initializeState(state);
    context.lastCandidate.word = "";
    // taking the kakutei back would restore a henkan state with the purged
    // candidate selected, so it must not be undoable anymore
    context.invalidateKakutei();
  }
}
