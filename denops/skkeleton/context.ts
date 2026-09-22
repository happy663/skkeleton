import { config } from "./config.ts";
import { HenkanType } from "./dictionary.ts";
import { PreEdit } from "./preedit.ts";
import { HenkanState, initializeState, State, toString } from "./state.ts";

import type { Denops } from "@denops/std";

type CandidateResult = {
  type: HenkanType;
  word: string;
  candidate: string;
};

// how the kakutei has been done
// "henkan" is one from the candidate selection, "completion" is one which a
// completion engine has done without ever entering that state
type KakuteiType = "henkan" | "completion";

// what |skkeleton-functions-kakuteiUndo| needs to take the last kakutei back
export type KakuteiResult = {
  type: KakuteiType;
  // the string the kakutei has inserted into the buffer
  kakutei: string;
  // the henkan state just before the kakutei
  state: HenkanState;
  // the skkeleton mode at the kakutei
  mode: string;
  // where the kakutei has happened
  // the undo deletes the text before the cursor, so it must not fire anywhere
  // else than the place the confirmed string has been written to
  vimMode: string;
  bufnr: number;
  lnum: number;
  // the line before the cursor as it was right after the kakutei
  // the undo needs the confirmed string to still be there: its tail is the
  // kakutei itself, and the rest is what has to still precede it
  bufferText: string;
};

// a kakutei whose bufferText is not known yet
// the pre-edit is written to the buffer after the key handling has returned,
// and a completion engine writes to the buffer by itself, so where the cursor
// ends up is only learned from the prevInput of the next key handling
type PendingKakuteiResult = Omit<KakuteiResult, "bufferText"> & {
  // what has been written after the kakutei within the same key handling
  // a candidate is confirmed by typing on as well, and then the key which has
  // confirmed it leaves its own input behind the confirmed string
  tail: string;
};

// where the cursor was when |skkeleton-functions-kakuteiUndo| walked away from
// it, so that the kakutei which picks another candidate can put it back
// columns are byte ones, the way Vim counts them
type RememberedPoint = {
  // the line it was on: the cursor is not sent back to a column of a line it
  // has since left, as it does when a kakutei is followed by a newline
  lnum: number;
  col: number;
  // the byte length of the taken back kakutei, so that whatever is confirmed
  // instead shifts the cursor by the difference
  bytes: number;
};

// where Vim has to put the cursor back once it has applied a key handling
type CursorPoint = {
  lnum: number;
  col: number;
};

// Vim counts columns in bytes
function byteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

export class Context {
  denops?: Denops;
  state: State = initializeState({});
  // g:skkeleton#mode copy
  // set from modeChange()
  mode = "hira"; // state of skkeleton#mode
  preEdit = new PreEdit();
  vimMode = "";
  // where Vim is at the current key handling
  // received from Vim on every handle()
  prevInput = ""; // the line before the cursor
  bufnr = -1;
  lnum = -1;
  lastCandidate: CandidateResult = {
    type: "okurinasi",
    word: "",
    candidate: "",
  };
  lastKakutei: KakuteiResult | undefined;
  pendingKakutei: PendingKakuteiResult | undefined;
  #rememberedPoint: RememberedPoint | undefined;
  // where Vim has to put the cursor once it has applied the output of this key
  // handling, or undefined for leaving it where the output ends
  restorePoint: CursorPoint | undefined;

  // remember where the cursor is standing, before kakuteiUndo() walks it back
  // to the kakutei it is about to delete
  recordPointRestore(kakutei: string, bufferText: string) {
    const col = byteLength(this.prevInput) + 1;
    // Note: the cursor was inside the kakutei, so the column it was at means
    //       nothing once something of another length has replaced it
    this.#rememberedPoint = col >= byteLength(bufferText) + 1
      ? { lnum: this.lnum, col, bytes: byteLength(kakutei) }
      : void 0;
  }

  // the byte column to put the cursor back at, now that {kakutei} is what has
  // been written where the undo walked away from, or 0 when there is nothing to
  // put back
  // the column is shifted by however much longer or shorter {kakutei} is than
  // what was taken back, so the cursor keeps its place in the text
  // an undo which never moved the cursor gives the column the kakutei ends at
  // anyway, so nothing visibly happens for it
  usePointRestore(kakutei: string): CursorPoint | undefined {
    const restore = this.#rememberedPoint;
    this.#rememberedPoint = void 0;
    return restore
      ? {
        lnum: restore.lnum,
        col: restore.col + byteLength(kakutei) - restore.bytes,
      }
      : void 0;
  }

  // give up on putting the cursor back
  // called once skkeleton has nothing pending where the undo happened: the
  // reading may have been taken all the way back with cancel, or skkeleton
  // disabled, and a column remembered for a spot nobody is editing any more
  // would move the cursor on some unrelated kakutei later on
  forgetPointRestore() {
    this.#rememberedPoint = void 0;
  }

  // whether skkeleton is still writing where the undo left off: a henkan, a
  // reading being typed, or a pre-edit waiting to become one
  get hasPendingInput(): boolean {
    const state = this.state;
    return state.type !== "input" || state.mode !== "direct" ||
      state.feed !== "" || this.preEdit.current !== "";
  }

  // remember a kakutei so that |skkeleton-functions-kakuteiUndo| can take it
  // back
  // the buffer is only written after this key handling has returned, hence the
  // recording is completed at the next one
  recordKakutei(type: KakuteiType, kakutei: string, state: HenkanState) {
    this.lastKakutei = void 0;
    this.pendingKakutei = {
      type,
      kakutei,
      state,
      mode: this.mode,
      vimMode: this.vimMode,
      bufnr: this.bufnr,
      lnum: this.lnum,
      tail: "",
    };
  }

  // forget the last kakutei because it can no longer be taken back
  invalidateKakutei() {
    this.lastKakutei = void 0;
    this.pendingKakutei = void 0;
  }

  // complete the kakutei recorded at the previous key handling
  // prevInput has just been received from Vim, so it tells where the kakutei
  // has left the cursor
  // returns whether the buffer has been rewritten by a kakutei skkeleton knows
  // about, which is what explains a mismatch against the pre-edit
  resolvePendingKakutei(): boolean {
    const pending = this.pendingKakutei;
    if (!pending) {
      return false;
    }
    this.pendingKakutei = void 0;
    if (!this.#isAt(pending)) {
      return false;
    }
    // Note: what the key handling has left behind the kakutei is not a part of
    //       it: the input of the key which has confirmed a candidate by typing
    //       on, and the pre-edit it has started
    //       it is not stripped when it is not found in the buffer, which is
    //       the case for a completion: the engine has rewritten the buffer and
    //       the pre-edit skkeleton remembers is a stale one
    const tail = pending.tail + this.preEdit.current;
    const bufferText = tail !== "" && this.prevInput.endsWith(tail)
      ? this.prevInput.slice(0, -tail.length)
      : this.prevInput;
    if (!bufferText.endsWith(pending.kakutei)) {
      return false;
    }
    this.lastKakutei = { ...pending, bufferText };
    return true;
  }

  // the kakutei which can be taken back right now, if any
  // Note: that the confirmed string is still in the buffer is not decided here
  //       the cursor may have moved on since the kakutei, and only Vim knows
  //       what the line looks like beyond it, so kakuteiUndo() asks before it
  //       deletes anything
  takeBackableKakutei(): KakuteiResult | undefined {
    const last = this.lastKakutei;
    if (
      !last || !this.#isAt(last) ||
      // Note: a key handled before this one within the same handling has
      //       written to the buffer already, which prevInput cannot know yet
      //       (|skkeleton#handle()| takes a list of keys)
      this.preEdit.dirty
    ) {
      return void 0;
    }
    return last;
  }

  // whether the cursor is right after the last kakutei, which is where the
  // undo can delete it without moving anything
  isRightAfterKakutei(last: KakuteiResult): boolean {
    return this.prevInput === last.bufferText;
  }

  // whether Vim is still where the kakutei has happened
  #isAt(at: Pick<KakuteiResult, "vimMode" | "bufnr" | "lnum">): boolean {
    return this.vimMode === at.vimMode && this.bufnr === at.bufnr &&
      this.lnum === at.lnum;
  }

  kakutei(str: string) {
    // remember what the rest of this key handling writes behind a kakutei it
    // has just recorded
    if (this.pendingKakutei) {
      this.pendingKakutei.tail += str;
    }
    this.preEdit.doKakutei(str);
  }

  kakuteiWithUndoPoint(str: string) {
    if (config.setUndoPoint && this.vimMode === "i") {
      str += "\x07u";
    }
    this.preEdit.doKakutei(str);
  }

  toString() {
    return toString(this.state);
  }
}
