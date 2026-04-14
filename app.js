// ============================================================
//  VIM LEARNER — Full interactive Vim simulator
// ============================================================

// ─── Vim Engine ─────────────────────────────────────────────

class VimEngine {
  constructor(text) {
    this.lines = text.split("\n");
    this.cur = { line: 0, col: 0 };
    this.mode = "normal";          // normal | insert | visual | visual-line
    this.register = "";
    this.registerIsLine = false;
    this.undoStack = [];
    this.redoStack = [];
    this.pendingKeys = [];
    this.count = null;
    this.operator = null;          // 'd' | 'c' | 'y' | '>' | '<'
    this.visualStart = null;
    this.lastChange = null;        // {keys, beforeState}
    this.recordingChange = [];
    this.searchPattern = "";
    this.statusMsg = "";
    this._snapshot();
  }

  getText() { return this.lines.join("\n"); }

  _snapshot() {
    return {
      lines: this.lines.map(l => l),
      cur: { ...this.cur },
      register: this.register,
      registerIsLine: this.registerIsLine,
    };
  }

  _pushUndo() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  _restore(snap) {
    this.lines = snap.lines.map(l => l);
    this.cur = { ...snap.cur };
    this.register = snap.register;
    this.registerIsLine = snap.registerIsLine;
  }

  _clampCursor() {
    this.cur.line = Math.max(0, Math.min(this.cur.line, this.lines.length - 1));
    const maxCol = this.mode === "insert"
      ? this.lines[this.cur.line].length
      : Math.max(0, this.lines[this.cur.line].length - 1);
    this.cur.col = Math.max(0, Math.min(this.cur.col, maxCol));
  }

  _line() { return this.lines[this.cur.line]; }
  _ch() { return this._line()[this.cur.col] || ""; }

  // Get effective count, default 1
  _cnt() { return this.count || 1; }

  // ── Process a single key event ──
  processKey(key) {
    this.statusMsg = "";
    if (this.mode === "insert") {
      this._insertKey(key);
    } else if (this.mode === "normal" || this.mode === "visual" || this.mode === "visual-line") {
      this._normalKey(key);
    }
    this._clampCursor();
  }

  // ── Insert mode ──
  _insertKey(key) {
    if (key === "Escape") {
      this.mode = "normal";
      this.cur.col = Math.max(0, this.cur.col - 1);
      this._clampCursor();
      return;
    }
    if (key === "Backspace") {
      if (this.cur.col > 0) {
        const l = this._line();
        this.lines[this.cur.line] = l.slice(0, this.cur.col - 1) + l.slice(this.cur.col);
        this.cur.col--;
      } else if (this.cur.line > 0) {
        const prev = this.lines[this.cur.line - 1];
        this.cur.col = prev.length;
        this.lines[this.cur.line - 1] = prev + this._line();
        this.lines.splice(this.cur.line, 1);
        this.cur.line--;
      }
      return;
    }
    if (key === "Enter") {
      const l = this._line();
      const before = l.slice(0, this.cur.col);
      const after = l.slice(this.cur.col);
      // auto-indent: match leading whitespace of current line
      const indent = before.match(/^(\s*)/)[1];
      this.lines[this.cur.line] = before;
      this.lines.splice(this.cur.line + 1, 0, indent + after);
      this.cur.line++;
      this.cur.col = indent.length;
      return;
    }
    if (key === "Tab") {
      const l = this._line();
      this.lines[this.cur.line] = l.slice(0, this.cur.col) + "  " + l.slice(this.cur.col);
      this.cur.col += 2;
      return;
    }
    if (key.length === 1) {
      const l = this._line();
      this.lines[this.cur.line] = l.slice(0, this.cur.col) + key + l.slice(this.cur.col);
      this.cur.col++;
    }
  }

  // ── Normal / Visual mode ──
  _normalKey(key) {
    const pending = this.pendingKeys;
    pending.push(key);
    const seq = pending.join("");

    // ── Escape: clear everything ──
    if (key === "Escape") {
      this._resetPending();
      if (this.mode === "visual" || this.mode === "visual-line") this.mode = "normal";
      return;
    }

    // ── Count prefix ──
    if (pending.length === 1 && /^[1-9]$/.test(key)) {
      this.count = (this.count || 0) * 10 + parseInt(key);
      pending.length = 0;
      return;
    }
    if (this.count !== null && pending.length === 1 && /^[0-9]$/.test(key)) {
      this.count = this.count * 10 + parseInt(key);
      pending.length = 0;
      return;
    }

    // ── Operators waiting for motion ──
    if (!this.operator && pending.length === 1 && "dcy><".includes(key)) {
      // Check for doubled operator (dd, cc, yy, >>, <<)
      this.operator = key;
      pending.length = 0;
      return;
    }

    if (this.operator && pending.length === 1 && key === this.operator) {
      // Doubled: dd, cc, yy, >>, <<
      this._pushUndo();
      const n = this._cnt();
      if (this.operator === "d") this._deleteLines(n);
      else if (this.operator === "c") this._changeLines(n);
      else if (this.operator === "y") this._yankLines(n);
      else if (this.operator === ">") this._indentLines(n, true);
      else if (this.operator === "<") this._indentLines(n, false);
      this._resetPending();
      return;
    }

    // ── Operator + motion ──
    if (this.operator) {
      const motion = this._tryMotion(pending);
      if (motion === "partial") return; // need more keys
      if (motion) {
        this._pushUndo();
        this._execOperatorMotion(this.operator, motion);
        this._resetPending();
        return;
      }
      // Text objects: iw, aw, i", a", etc.
      const tobj = this._tryTextObject(pending);
      if (tobj === "partial") return;
      if (tobj) {
        this._pushUndo();
        this._execOperatorRange(this.operator, tobj);
        this._resetPending();
        return;
      }
      // Invalid
      this._resetPending();
      return;
    }

    // ── Visual mode actions ──
    if (this.mode === "visual" || this.mode === "visual-line") {
      if (key === "d" || key === "x") {
        this._pushUndo();
        this._visualDelete();
        this._resetPending();
        return;
      }
      if (key === "y") {
        this._visualYank();
        this._resetPending();
        return;
      }
      if (key === "c" || key === "s") {
        this._pushUndo();
        this._visualDelete();
        this.mode = "insert";
        this._resetPending();
        return;
      }
      if (key === ">") { this._pushUndo(); this._visualIndent(true); this._resetPending(); return; }
      if (key === "<") { this._pushUndo(); this._visualIndent(false); this._resetPending(); return; }
      if (key === "J") { this._pushUndo(); this._visualJoin(); this._resetPending(); return; }
      if (key === "~") { this._pushUndo(); this._visualToggleCase(); this._resetPending(); return; }
      if (key === "u") { this._pushUndo(); this._visualChangeCase(false); this._resetPending(); return; }
      if (key === "U") { this._pushUndo(); this._visualChangeCase(true); this._resetPending(); return; }

      // Movement extends selection
      const motion = this._tryMotion(pending);
      if (motion === "partial") return;
      if (motion) {
        const n = this._cnt();
        this._applyMotion(motion);
        for (let i = 1; i < n; i++) {
          const next = this._tryMotion(pending);
          if (next && next !== "partial") this._applyMotion(next);
        }
        pending.length = 0;
        this.count = null;
        return;
      }
      pending.length = 0;
      return;
    }

    // ── Normal mode commands ──

    // r + char (replace) — must be checked before motions
    if (pending.length === 2 && pending[0] === "r") {
      this._pushUndo();
      const n = this._cnt();
      const l = this._line();
      if (l.length > 0 && this.cur.col + n <= l.length) {
        this.lines[this.cur.line] = l.slice(0, this.cur.col) + key.repeat(n) + l.slice(this.cur.col + n);
        this.cur.col = this.cur.col + n - 1;
      }
      this._resetPending();
      return;
    }

    // Simple motions
    const motion = this._tryMotion(pending);
    if (motion === "partial") return;
    if (motion) {
      const n = this._cnt();
      this._applyMotion(motion);
      for (let i = 1; i < n; i++) {
        const next = this._tryMotion(pending);
        if (next && next !== "partial") this._applyMotion(next);
      }
      this._resetPending();
      return;
    }

    // Text object can't be used standalone
    const tobj = this._tryTextObject(pending);
    if (tobj === "partial") return;

    // Single-key commands
    if (pending.length === 1) {
      switch (key) {
        case "i": this._pushUndo(); this.mode = "insert"; break;
        case "a": this._pushUndo(); this.mode = "insert"; this.cur.col = Math.min(this.cur.col + 1, this._line().length); break;
        case "I": this._pushUndo(); this.mode = "insert"; this.cur.col = this._line().search(/\S/); if (this.cur.col < 0) this.cur.col = 0; break;
        case "A": this._pushUndo(); this.mode = "insert"; this.cur.col = this._line().length; break;
        case "o": this._pushUndo(); this._openLine(false); break;
        case "O": this._pushUndo(); this._openLine(true); break;
        case "s": this._pushUndo(); { const l = this._line(); this.lines[this.cur.line] = l.slice(0, this.cur.col) + l.slice(this.cur.col + 1); } this.mode = "insert"; break;
        case "S": this._pushUndo(); { const indent = this._line().match(/^(\s*)/)[1]; this.lines[this.cur.line] = indent; this.cur.col = indent.length; } this.mode = "insert"; break;

        case "x": this._pushUndo(); this._deleteChars(this._cnt()); break;
        case "X": this._pushUndo(); this._deleteCharsBefore(this._cnt()); break;
        case "D": this._pushUndo(); this._deleteToEOL(); break;
        case "C": this._pushUndo(); this._deleteToEOL(); this.mode = "insert"; break;
        case "J": this._pushUndo(); this._joinLine(); break;

        case "p": this._pushUndo(); this._paste(false); break;
        case "P": this._pushUndo(); this._paste(true); break;

        case "u": this._undo(); break;

        case "v": this.mode = "visual"; this.visualStart = { ...this.cur }; break;
        case "V": this.mode = "visual-line"; this.visualStart = { ...this.cur }; break;

        case "~": this._pushUndo(); this._toggleCase(); break;
        case ".": this._repeatLast(); break;

        case "r": return; // wait for next key (handled in multi-key section below)

        default: break;
      }
      this._resetPending();
      return;
    }

    // Multi-key commands
    if (seq === "gg") {
      const n = this.count ? this.count - 1 : 0;
      this.cur.line = Math.min(n, this.lines.length - 1);
      this.cur.col = this._firstNonBlank(this.cur.line);
      this._resetPending();
      return;
    }

    if (pending.length === 2 && pending[0] === "g") {
      if (key === "g") { /* handled above */ }
      // gu, gU for case changes would go here
      this._resetPending();
      return;
    }

    // Ctrl combos
    if (key === "Ctrl-r") { this._redo(); this._resetPending(); return; }
    if (key === "Ctrl-d") {
      const half = Math.max(1, Math.floor(15 / 2));
      this.cur.line = Math.min(this.cur.line + half, this.lines.length - 1);
      this._clampCursor();
      this._resetPending();
      return;
    }
    if (key === "Ctrl-u") {
      const half = Math.max(1, Math.floor(15 / 2));
      this.cur.line = Math.max(this.cur.line - half, 0);
      this._clampCursor();
      this._resetPending();
      return;
    }

    // Didn't match anything
    if (pending.length > 3) this._resetPending();
  }

  _resetPending() {
    this.pendingKeys = [];
    this.count = null;
    this.operator = null;
  }

  // ── Motions ──
  // Returns motion object {line, col} = destination, or "partial", or null
  _tryMotion(keys) {
    const k = keys[keys.length - 1];
    const seq = keys.join("");

    switch (k) {
      case "h": return { line: this.cur.line, col: Math.max(0, this.cur.col - 1) };
      case "l": return { line: this.cur.line, col: Math.min(this.cur.col + 1, Math.max(0, this._line().length - 1)) };
      case "j": return { line: Math.min(this.cur.line + 1, this.lines.length - 1), col: this.cur.col };
      case "k": return { line: Math.max(this.cur.line - 1, 0), col: this.cur.col };
      case "0": return { line: this.cur.line, col: 0 };
      case "^": return { line: this.cur.line, col: this._firstNonBlank(this.cur.line) };
      case "$": return { line: this.cur.line, col: Math.max(0, this._line().length - 1) };
      case "G": {
        const target = this.count ? Math.min(this.count - 1, this.lines.length - 1) : this.lines.length - 1;
        return { line: target, col: this._firstNonBlank(target) };
      }
      case "w": return this._wordMotion(1);
      case "W": return this._WORDMotion(1);
      case "b": return this._wordMotion(-1);
      case "B": return this._WORDMotion(-1);
      case "e": return this._endWordMotion(1);
      case "E": return this._endWORDMotion(1);
      case "{": return this._paraMotion(-1);
      case "}": return this._paraMotion(1);
      case "%": return this._matchBracket();
    }

    // f/F/t/T + char
    if (keys.length >= 2) {
      const cmd = keys[keys.length - 2];
      if ("fFtT".includes(cmd)) {
        if (keys.length === (this.operator ? 2 : 2)) {
          return this._findChar(cmd, k);
        }
      }
    }
    if (keys.length === 1 && "fFtT".includes(k)) return "partial";

    // gg
    if (keys.length === 1 && k === "g") return "partial";
    if (seq.endsWith("gg")) return { line: 0, col: 0 };

    return null;
  }

  _applyMotion(m) {
    this.cur.line = m.line;
    this.cur.col = m.col;
    this._clampCursor();
  }

  _firstNonBlank(lineIdx) {
    const idx = this.lines[lineIdx]?.search(/\S/);
    return idx >= 0 ? idx : 0;
  }

  _wordMotion(dir) {
    let { line, col } = this.cur;
    const lines = this.lines;
    if (dir > 0) {
      const l = lines[line];
      // skip current word chars
      while (col < l.length && !/\s/.test(l[col])) col++;
      // skip whitespace (including newlines)
      while (true) {
        while (col < lines[line].length && /\s/.test(lines[line][col])) col++;
        if (col < lines[line].length) break;
        if (line >= lines.length - 1) { col = Math.max(0, lines[line].length - 1); break; }
        line++; col = 0;
      }
    } else {
      if (col > 0) col--;
      // skip whitespace backwards
      while (true) {
        while (col > 0 && /\s/.test(lines[line][col])) col--;
        if (col > 0 || (col === 0 && !/\s/.test(lines[line][col] || ""))) break;
        if (line <= 0) { col = 0; break; }
        line--; col = Math.max(0, lines[line].length - 1);
      }
      // skip back to start of word
      while (col > 0 && !/\s/.test(lines[line][col - 1])) col--;
    }
    return { line, col, exclusive: true };
  }

  _WORDMotion(dir) { return this._wordMotion(dir); }

  _endWordMotion(dir) {
    let { line, col } = this.cur;
    const lines = this.lines;
    col++;
    // skip whitespace
    while (true) {
      while (col < lines[line].length && /\s/.test(lines[line][col])) col++;
      if (col < lines[line].length) break;
      if (line >= lines.length - 1) { col = Math.max(0, lines[line].length - 1); break; }
      line++; col = 0;
    }
    // move to end of word
    while (col < lines[line].length - 1 && !/\s/.test(lines[line][col + 1])) col++;
    return { line, col };
  }

  _endWORDMotion(dir) { return this._endWordMotion(dir); }

  _paraMotion(dir) {
    let line = this.cur.line;
    if (dir > 0) {
      line++;
      while (line < this.lines.length && this.lines[line].trim() !== "") line++;
      line = Math.min(line, this.lines.length - 1);
    } else {
      line--;
      while (line > 0 && this.lines[line].trim() !== "") line--;
      line = Math.max(line, 0);
    }
    return { line, col: 0, exclusive: true };
  }

  _findChar(cmd, ch) {
    const line = this._line();
    const forward = cmd === "f" || cmd === "t";
    const on = cmd === "f" || cmd === "F";
    let col = this.cur.col;
    if (forward) {
      for (let i = col + 1; i < line.length; i++) {
        if (line[i] === ch) return { line: this.cur.line, col: on ? i : i - 1 };
      }
    } else {
      for (let i = col - 1; i >= 0; i--) {
        if (line[i] === ch) return { line: this.cur.line, col: on ? i : i + 1 };
      }
    }
    return { line: this.cur.line, col: this.cur.col }; // not found, stay
  }

  _matchBracket() {
    const pairs = { "(": ")", ")": "(", "{": "}", "}": "{", "[": "]", "]": "[" };
    const opens = "({[";
    let ch = this._ch();
    let col = this.cur.col;
    const line = this._line();
    // If not on a bracket, scan forward to find one
    if (!pairs[ch]) {
      while (col < line.length && !pairs[line[col]]) col++;
      if (col >= line.length) return { line: this.cur.line, col: this.cur.col };
      ch = line[col];
    }
    const match = pairs[ch];
    const forward = opens.includes(ch);
    let depth = 1;
    let r = this.cur.line, c = col;
    while (depth > 0) {
      if (forward) { c++; } else { c--; }
      if (c >= this.lines[r].length) { r++; c = -1; if (r >= this.lines.length) return { line: this.cur.line, col: this.cur.col }; continue; }
      if (c < 0) { r--; if (r < 0) return { line: this.cur.line, col: this.cur.col }; c = this.lines[r].length; continue; }
      if (this.lines[r][c] === ch) depth++;
      if (this.lines[r][c] === match) depth--;
    }
    return { line: r, col: c };
  }

  // ── Text Objects ──
  _tryTextObject(keys) {
    if (keys.length === 1 && (keys[0] === "i" || keys[0] === "a")) return "partial";
    if (keys.length === 2 && (keys[0] === "i" || keys[0] === "a")) {
      const inner = keys[0] === "i";
      const obj = keys[1];
      return this._resolveTextObject(inner, obj);
    }
    return null;
  }

  _resolveTextObject(inner, obj) {
    if (obj === "w") return this._wordObject(inner);
    if (obj === "W") return this._wordObject(inner);
    const pairMap = { "(": "()", ")": "()", "b": "()", "{": "{}", "}": "{}", "B": "{}", "[": "[]", "]": "[]", "<": "<>", ">": "<>", '"': '""', "'": "''", "`": "``", "t": "tag" };
    if (pairMap[obj]) {
      if (pairMap[obj] === "tag") return this._tagObject(inner);
      return this._pairObject(inner, pairMap[obj][0], pairMap[obj][1]);
    }
    if (obj === "p") return this._paragraphObject(inner);
    if (obj === "s") return this._sentenceObject(inner);
    return null;
  }

  // Returns {startLine, startCol, endLine, endCol} range (inclusive)
  _wordObject(inner) {
    const line = this._line();
    let start = this.cur.col, end = this.cur.col;
    // expand to word boundaries
    while (start > 0 && !/\s/.test(line[start - 1])) start--;
    while (end < line.length - 1 && !/\s/.test(line[end + 1])) end++;
    if (!inner) {
      // include trailing space
      while (end < line.length - 1 && /\s/.test(line[end + 1])) end++;
    }
    return { startLine: this.cur.line, startCol: start, endLine: this.cur.line, endCol: end };
  }

  _quoteObject(inner, q) {
    // For same-char delimiters (quotes): find the pair on the current line
    const line = this._line();
    const col = this.cur.col;
    const r = this.cur.line;
    // Collect all positions of the quote char on this line
    const positions = [];
    for (let c = 0; c < line.length; c++) {
      if (line[c] === q) positions.push(c);
    }
    // Find the pair that surrounds the cursor
    for (let i = 0; i < positions.length - 1; i += 2) {
      const openC = positions[i];
      const closeC = positions[i + 1];
      if (col >= openC && col <= closeC) {
        if (inner) {
          return { startLine: r, startCol: openC + 1, endLine: r, endCol: closeC - 1 };
        }
        return { startLine: r, startCol: openC, endLine: r, endCol: closeC };
      }
    }
    return null;
  }

  _pairObject(inner, open, close) {
    // Handle same-character delimiters (quotes) separately
    if (open === close) {
      return this._quoteObject(inner, open);
    }
    // Search outward for matching pair
    let depth = 0;
    let startR = -1, startC = -1;
    // Search backward for opening
    for (let r = this.cur.line; r >= 0; r--) {
      const from = r === this.cur.line ? this.cur.col : this.lines[r].length - 1;
      for (let c = from; c >= 0; c--) {
        if (this.lines[r][c] === close && !(r === this.cur.line && c === this.cur.col)) depth++;
        if (this.lines[r][c] === open) {
          if (depth === 0) { startR = r; startC = c; break; }
          depth--;
        }
      }
      if (startR >= 0) break;
    }
    if (startR < 0) return null;
    // Search forward for closing
    depth = 0;
    let endR = -1, endC = -1;
    for (let r = startR; r < this.lines.length; r++) {
      const from = r === startR ? startC + 1 : 0;
      for (let c = from; c < this.lines[r].length; c++) {
        if (this.lines[r][c] === open) depth++;
        if (this.lines[r][c] === close) {
          if (depth === 0) { endR = r; endC = c; break; }
          depth--;
        }
      }
      if (endR >= 0) break;
    }
    if (endR < 0) return null;
    if (inner) {
      startC++;
      endC--;
      if (startC > this.lines[startR].length - 1) { startR++; startC = 0; }
      if (endC < 0) { endR--; endC = this.lines[endR].length - 1; }
    }
    return { startLine: startR, startCol: startC, endLine: endR, endCol: endC };
  }

  _tagObject(inner) {
    // Simplified tag object
    const text = this.getText();
    const pos = this._posToOffset(this.cur.line, this.cur.col);
    // find enclosing tag
    let openEnd = -1, openStart = -1;
    for (let i = pos; i >= 0; i--) {
      if (text[i] === "<" && text[i + 1] !== "/") {
        openStart = i;
        openEnd = text.indexOf(">", i);
        break;
      }
    }
    if (openStart < 0 || openEnd < 0) return null;
    const tagMatch = text.slice(openStart + 1, openEnd).match(/^(\w+)/);
    if (!tagMatch) return null;
    const tagName = tagMatch[1];
    const closeTag = `</${tagName}>`;
    const closeStart = text.indexOf(closeTag, openEnd);
    if (closeStart < 0) return null;
    const closeEnd = closeStart + closeTag.length - 1;
    if (inner) {
      const s = this._offsetToPos(openEnd + 1);
      const e = this._offsetToPos(closeStart - 1);
      return { startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col };
    }
    const s = this._offsetToPos(openStart);
    const e = this._offsetToPos(closeEnd);
    return { startLine: s.line, startCol: s.col, endLine: e.line, endCol: e.col };
  }

  _paragraphObject(inner) {
    let startLine = this.cur.line, endLine = this.cur.line;
    while (startLine > 0 && this.lines[startLine - 1].trim() !== "") startLine--;
    while (endLine < this.lines.length - 1 && this.lines[endLine + 1].trim() !== "") endLine++;
    if (!inner) {
      while (endLine < this.lines.length - 1 && this.lines[endLine + 1].trim() === "") endLine++;
    }
    return { startLine, startCol: 0, endLine, endCol: this.lines[endLine].length - 1 };
  }

  _sentenceObject(inner) {
    return this._wordObject(inner); // simplified
  }

  _posToOffset(line, col) {
    let off = 0;
    for (let i = 0; i < line; i++) off += this.lines[i].length + 1;
    return off + col;
  }

  _offsetToPos(off) {
    let remaining = off;
    for (let i = 0; i < this.lines.length; i++) {
      if (remaining <= this.lines[i].length) return { line: i, col: remaining };
      remaining -= this.lines[i].length + 1;
    }
    return { line: this.lines.length - 1, col: this.lines[this.lines.length - 1].length };
  }

  // ── Operator + Motion ──
  _execOperatorMotion(op, dest) {
    // Determine range from cur to dest
    let sL = this.cur.line, sC = this.cur.col;
    let eL = dest.line, eC = dest.col;
    // Exclusive motions: the destination char is NOT included (w, W, {, }, gg, G, etc.)
    // Back up end position by one character so the range is correct
    const isExclusive = dest.exclusive;
    if (isExclusive) {
      if (eC > 0) {
        eC--;
      } else if (eL > 0) {
        eL--;
        eC = Math.max(0, this.lines[eL].length - 1);
      }
    }
    if (sL > eL || (sL === eL && sC > eC)) {
      [sL, sC, eL, eC] = [eL, eC, sL, sC];
    }
    // If backing up made end < start (e.g. dw at end of word on same pos), just delete the char
    if (sL > eL || (sL === eL && sC > eC)) return;
    this._execOperatorRange(op, { startLine: sL, startCol: sC, endLine: eL, endCol: eC });
  }

  _execOperatorRange(op, range) {
    if (!range) return;
    const { startLine, startCol, endLine, endCol } = range;
    if (op === "d") {
      this._yankRange(range);
      this._deleteRange(range);
      this.cur.line = startLine;
      this.cur.col = startCol;
      this._clampCursor();
    } else if (op === "c") {
      this._yankRange(range);
      this._deleteRange(range);
      this.cur.line = startLine;
      this.cur.col = startCol;
      this._clampCursor();
      this.mode = "insert";
    } else if (op === "y") {
      this._yankRange(range);
      this.cur.line = startLine;
      this.cur.col = startCol;
    } else if (op === ">" || op === "<") {
      for (let i = startLine; i <= endLine; i++) {
        if (op === ">") {
          this.lines[i] = "  " + this.lines[i];
        } else {
          this.lines[i] = this.lines[i].replace(/^ {1,2}/, "");
        }
      }
    }
  }

  _deleteRange(range) {
    const { startLine, startCol, endLine, endCol } = range;
    if (startLine === endLine) {
      const l = this.lines[startLine];
      this.lines[startLine] = l.slice(0, startCol) + l.slice(endCol + 1);
    } else {
      const first = this.lines[startLine].slice(0, startCol);
      const last = this.lines[endLine].slice(endCol + 1);
      this.lines.splice(startLine, endLine - startLine + 1, first + last);
    }
    if (this.lines.length === 0) this.lines = [""];
  }

  _yankRange(range) {
    const { startLine, startCol, endLine, endCol } = range;
    if (startLine === endLine) {
      this.register = this.lines[startLine].slice(startCol, endCol + 1);
      this.registerIsLine = false;
    } else {
      let text = this.lines[startLine].slice(startCol);
      for (let i = startLine + 1; i < endLine; i++) text += "\n" + this.lines[i];
      text += "\n" + this.lines[endLine].slice(0, endCol + 1);
      this.register = text;
      this.registerIsLine = false;
    }
  }

  // ── Line operations ──
  _deleteLines(n) {
    const start = this.cur.line;
    const end = Math.min(start + n - 1, this.lines.length - 1);
    this.register = this.lines.slice(start, end + 1).join("\n");
    this.registerIsLine = true;
    this.lines.splice(start, end - start + 1);
    if (this.lines.length === 0) this.lines = [""];
    this._clampCursor();
    this.cur.col = this._firstNonBlank(this.cur.line);
  }

  _changeLines(n) {
    const indent = this._line().match(/^(\s*)/)[1];
    this._deleteLines(n);
    this.lines.splice(this.cur.line, 0, indent);
    this.cur.col = indent.length;
    this.mode = "insert";
  }

  _yankLines(n) {
    const end = Math.min(this.cur.line + n - 1, this.lines.length - 1);
    this.register = this.lines.slice(this.cur.line, end + 1).join("\n");
    this.registerIsLine = true;
    this.statusMsg = n + " lines yanked";
  }

  _indentLines(n, right) {
    for (let i = 0; i < n && this.cur.line + i < this.lines.length; i++) {
      const idx = this.cur.line + i;
      if (right) {
        this.lines[idx] = "  " + this.lines[idx];
      } else {
        this.lines[idx] = this.lines[idx].replace(/^ {1,2}/, "");
      }
    }
  }

  // ── Single commands ──
  _deleteChars(n) {
    const l = this._line();
    const end = Math.min(this.cur.col + n, l.length);
    this.register = l.slice(this.cur.col, end);
    this.registerIsLine = false;
    this.lines[this.cur.line] = l.slice(0, this.cur.col) + l.slice(end);
    this._clampCursor();
  }

  _deleteCharsBefore(n) {
    const l = this._line();
    const start = Math.max(0, this.cur.col - n);
    this.register = l.slice(start, this.cur.col);
    this.registerIsLine = false;
    this.lines[this.cur.line] = l.slice(0, start) + l.slice(this.cur.col);
    this.cur.col = start;
  }

  _deleteToEOL() {
    const l = this._line();
    this.register = l.slice(this.cur.col);
    this.registerIsLine = false;
    this.lines[this.cur.line] = l.slice(0, this.cur.col);
    this._clampCursor();
  }

  _openLine(above) {
    const indent = this._line().match(/^(\s*)/)[1];
    if (above) {
      this.lines.splice(this.cur.line, 0, indent);
      this.cur.col = indent.length;
    } else {
      this.lines.splice(this.cur.line + 1, 0, indent);
      this.cur.line++;
      this.cur.col = indent.length;
    }
    this.mode = "insert";
  }

  _joinLine() {
    if (this.cur.line >= this.lines.length - 1) return;
    const next = this.lines[this.cur.line + 1].trimStart();
    this.lines[this.cur.line] = this._line().trimEnd() + " " + next;
    this.lines.splice(this.cur.line + 1, 1);
  }

  _toggleCase() {
    const l = this._line();
    if (l.length === 0) return;
    const ch = l[this.cur.col];
    const toggled = ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    this.lines[this.cur.line] = l.slice(0, this.cur.col) + toggled + l.slice(this.cur.col + 1);
    this.cur.col = Math.min(this.cur.col + 1, l.length - 1);
  }

  _paste(before) {
    if (!this.register) return;
    if (this.registerIsLine) {
      const newLines = this.register.split("\n");
      if (before) {
        this.lines.splice(this.cur.line, 0, ...newLines);
      } else {
        this.lines.splice(this.cur.line + 1, 0, ...newLines);
        this.cur.line++;
      }
      this.cur.col = this._firstNonBlank(this.cur.line);
    } else {
      const l = this._line();
      const pos = before ? this.cur.col : this.cur.col + 1;
      this.lines[this.cur.line] = l.slice(0, pos) + this.register + l.slice(pos);
      this.cur.col = pos + this.register.length - 1;
    }
  }

  _undo() {
    if (this.undoStack.length === 0) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
    this.mode = "normal";
  }

  _redo() {
    if (this.redoStack.length === 0) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
    this.mode = "normal";
  }

  _repeatLast() {
    // Simplified: just replay last undo
    // A full implementation would record and replay keystrokes
  }

  // ── Visual mode helpers ──
  _getVisualRange() {
    if (!this.visualStart) return null;
    let sL = this.visualStart.line, sC = this.visualStart.col;
    let eL = this.cur.line, eC = this.cur.col;
    if (this.mode === "visual-line") {
      sC = 0;
      eC = this.lines[eL].length - 1;
    }
    if (sL > eL || (sL === eL && sC > eC)) [sL, sC, eL, eC] = [eL, eC, sL, sC];
    if (this.mode === "visual-line") { sC = 0; eC = this.lines[eL].length; }
    return { startLine: sL, startCol: sC, endLine: eL, endCol: eC };
  }

  _visualDelete() {
    const range = this._getVisualRange();
    if (!range) return;
    if (this.mode === "visual-line") {
      this.register = this.lines.slice(range.startLine, range.endLine + 1).join("\n");
      this.registerIsLine = true;
      this.lines.splice(range.startLine, range.endLine - range.startLine + 1);
      if (this.lines.length === 0) this.lines = [""];
      this.cur.line = Math.min(range.startLine, this.lines.length - 1);
      this.cur.col = this._firstNonBlank(this.cur.line);
    } else {
      this._yankRange(range);
      this._deleteRange(range);
      this.cur.line = range.startLine;
      this.cur.col = range.startCol;
    }
    this.mode = "normal";
    this.visualStart = null;
    this._clampCursor();
  }

  _visualYank() {
    const range = this._getVisualRange();
    if (!range) return;
    if (this.mode === "visual-line") {
      this.register = this.lines.slice(range.startLine, range.endLine + 1).join("\n");
      this.registerIsLine = true;
    } else {
      this._yankRange(range);
    }
    this.mode = "normal";
    this.visualStart = null;
    this.cur.line = range.startLine;
    this.cur.col = range.startCol;
  }

  _visualIndent(right) {
    const range = this._getVisualRange();
    if (!range) return;
    for (let i = range.startLine; i <= range.endLine; i++) {
      if (right) this.lines[i] = "  " + this.lines[i];
      else this.lines[i] = this.lines[i].replace(/^ {1,2}/, "");
    }
    this.mode = "normal";
    this.visualStart = null;
  }

  _visualJoin() {
    const range = this._getVisualRange();
    if (!range) return;
    for (let i = range.startLine; i < range.endLine && range.startLine < this.lines.length - 1; i++) {
      this.cur.line = range.startLine;
      this._joinLine();
    }
    this.mode = "normal";
    this.visualStart = null;
  }

  _visualToggleCase() {
    const range = this._getVisualRange();
    if (!range) return;
    for (let r = range.startLine; r <= range.endLine; r++) {
      const sC = r === range.startLine ? range.startCol : 0;
      const eC = r === range.endLine ? range.endCol : this.lines[r].length - 1;
      const chars = this.lines[r].split("");
      for (let c = sC; c <= eC && c < chars.length; c++) {
        chars[c] = chars[c] === chars[c].toLowerCase() ? chars[c].toUpperCase() : chars[c].toLowerCase();
      }
      this.lines[r] = chars.join("");
    }
    this.mode = "normal";
    this.visualStart = null;
  }

  _visualChangeCase(upper) {
    const range = this._getVisualRange();
    if (!range) return;
    for (let r = range.startLine; r <= range.endLine; r++) {
      const sC = r === range.startLine ? range.startCol : 0;
      const eC = r === range.endLine ? range.endCol : this.lines[r].length - 1;
      const chars = this.lines[r].split("");
      for (let c = sC; c <= eC && c < chars.length; c++) {
        chars[c] = upper ? chars[c].toUpperCase() : chars[c].toLowerCase();
      }
      this.lines[r] = chars.join("");
    }
    this.mode = "normal";
    this.visualStart = null;
  }

  // ── Visual range for rendering ──
  getVisualCells() {
    if (this.mode !== "visual" && this.mode !== "visual-line") return null;
    return this._getVisualRange();
  }
}


// ─── CHALLENGES ─────────────────────────────────────────────

const CHALLENGES = [
  // ── Movement ──
  {
    topic: "movement",
    title: "Fix the typo deep in the function",
    description: "There's a 'retrun' on line 8. Navigate there and fix it to 'return'.",
    start: `class ShoppingCart {
  constructor() {
    this.items = [];
    this.discount = 0;
  }

  calculateTotal() {
    let total = 0;
    for (const item of this.items) {
      const price = item.price * item.qty;
      const tax = price * 0.08;
      total += price + tax;
    }
    if (this.discount > 0) {
      total -= total * (this.discount / 100);
    }
    retrun total;
  }
}`,
    target: `class ShoppingCart {
  constructor() {
    this.items = [];
    this.discount = 0;
  }

  calculateTotal() {
    let total = 0;
    for (const item of this.items) {
      const price = item.price * item.qty;
      const tax = price * 0.08;
      total += price + tax;
    }
    if (this.discount > 0) {
      total -= total * (this.discount / 100);
    }
    return total;
  }
}`,
    hint: "Use 17j or 17G to get to the line, then w to jump to 'retrun', then find the extra 'r' and x to delete it. Or use cw to change the word.",
  },
  {
    topic: "movement",
    title: "Jump between matching braces",
    description: "The closing braces on the last line are wrong — two should be parentheses.",
    start: `const result = items
  .filter(item => item.active)
  .map(item => ({
    id: item.id,
    name: item.name,
    total: item.price * item.qty,
    taxed: (item.price * item.qty) * 1.08
  }}};`,
    target: `const result = items
  .filter(item => item.active)
  .map(item => ({
    id: item.id,
    name: item.name,
    total: item.price * item.qty,
    taxed: (item.price * item.qty) * 1.08
  }));`,
    hint: "Use G to go to the last line, then f} to find the first }. Use r) to replace it, then ; to repeat the f} search, and r) again.",
  },
  {
    topic: "movement",
    title: "Navigate to specific words with f and t",
    description: "Change 'error' to 'warning' on line 6. Use f or / to find it quickly.",
    start: `const logger = {
  level: "info",
  prefix: "[app]",

  log(message) {
    if (this.level === "error") {
      console.error(this.prefix, message);
    } else {
      console.log(this.prefix, message);
    }
  },

  setLevel(newLevel) {
    this.level = newLevel;
    this.log("level changed to " + newLevel);
  }
};`,
    target: `const logger = {
  level: "info",
  prefix: "[app]",

  log(message) {
    if (this.level === "warning") {
      console.error(this.prefix, message);
    } else {
      console.log(this.prefix, message);
    }
  },

  setLevel(newLevel) {
    this.level = newLevel;
    this.log("level changed to " + newLevel);
  }
};`,
    hint: "Use 5j to get to line 6, then f\" to jump to the quote, then ci\" to change inside quotes and type 'warning'.",
  },

  // ── Deleting ──
  {
    topic: "deleting",
    title: "Remove all the debug lines",
    description: "Delete every console.log line from this module.",
    start: `import { db } from './database';
import { validate } from './utils';

export async function createUser(data) {
  console.log("createUser called with:", data);
  const valid = validate(data);
  console.log("validation result:", valid);
  if (!valid) {
    console.log("validation failed, returning null");
    return null;
  }
  const user = await db.users.create({
    name: data.name,
    email: data.email,
    role: data.role || 'user',
  });
  console.log("user created:", user.id);
  await db.audit.log('user_created', user.id);
  console.log("audit log written");
  return user;
}`,
    target: `import { db } from './database';
import { validate } from './utils';

export async function createUser(data) {
  const valid = validate(data);
  if (!valid) {
    return null;
  }
  const user = await db.users.create({
    name: data.name,
    email: data.email,
    role: data.role || 'user',
  });
  await db.audit.log('user_created', user.id);
  return user;
}`,
    hint: "Move to each console.log line and use dd. After the first dd, use j to find the next one and . to repeat.",
  },
  {
    topic: "deleting",
    title: "Clean up unused imports",
    description: "Remove the unused imports (axios, lodash, moment). Keep React, useState, and useEffect.",
    start: `import React from 'react';
import axios from 'axios';
import { useState, useEffect } from 'react';
import lodash from 'lodash';
import moment from 'moment';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats')
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>Loading...</div>;
  return <div>{JSON.stringify(data)}</div>;
}`,
    target: `import React from 'react';
import { useState, useEffect } from 'react';

export default function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/stats')
      .then(res => res.json())
      .then(setData)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div>Loading...</div>;
  return <div>{JSON.stringify(data)}</div>;
}`,
    hint: "Go to the axios line (j), dd to delete. Move to lodash, dd. Move to moment, dd.",
  },
  {
    topic: "deleting",
    title: "Delete the function body",
    description: "Clear the body of the init function but keep the signature and closing brace.",
    start: `async function init(config) {
  const db = await connectDB(config.dbUrl);
  const cache = initRedis(config.redisUrl);
  const queue = initQueue(config.queueUrl);
  await runMigrations(db);
  await seedDatabase(db);
  registerMiddleware(app);
  registerRoutes(app);
  startWorkers(queue);
  console.log("server ready on port", config.port);
}`,
    target: `async function init(config) {
}`,
    hint: "Put cursor inside the braces, then use di{ to delete everything inside them.",
  },
  {
    topic: "deleting",
    title: "Delete to end of line",
    description: "Remove the inline comments from each line. Keep the code, delete from // onwards.",
    start: `const server = {
  host: "0.0.0.0",     // listen on all interfaces
  port: 8080,           // default port
  timeout: 30000,       // 30 seconds
  maxConnections: 100,  // per worker
  workers: 4,           // match CPU cores
  keepAlive: true,      // reuse connections
  compress: true,       // gzip responses
};`,
    target: `const server = {
  host: "0.0.0.0",
  port: 8080,
  timeout: 30000,
  maxConnections: 100,
  workers: 4,
  keepAlive: true,
  compress: true,
};`,
    hint: "On each line, use f/ to jump to the //, then use d$ or D to delete to end of line. Clean trailing spaces with xhhx or similar.",
  },

  // ── Changing ──
  {
    topic: "changing",
    title: "Rename the variable everywhere",
    description: "Change all 'data' to 'users' in this function.",
    start: `async function loadData() {
  const data = await fetch('/api/users').then(r => r.json());
  if (!data.length) {
    console.warn("no data found");
    return [];
  }
  const filtered = data.filter(d => d.active);
  console.log("loaded", data.length, "records");
  return data;
}`,
    target: `async function loadData() {
  const users = await fetch('/api/users').then(r => r.json());
  if (!users.length) {
    console.warn("no users found");
    return [];
  }
  const filtered = users.filter(d => d.active);
  console.log("loaded", users.length, "records");
  return users;
}`,
    hint: "Move to each 'data', use ciw to change the word to 'users'. After the first one, you can search /data then n to find next, and . to repeat the change.",
  },
  {
    topic: "changing",
    title: "Change the function arguments",
    description: "Change the arguments inside the handler's parentheses from (req, res, next) to (ctx).",
    start: `const express = require('express');
const router = express.Router();

router.get('/api/users', async function handler(req, res, next) {
  try {
    const users = await db.query("SELECT * FROM users");
    const filtered = users.filter(u => u.active);
    res.json({ data: filtered, count: filtered.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;`,
    target: `const express = require('express');
const router = express.Router();

router.get('/api/users', async function handler(ctx) {
  try {
    const users = await db.query("SELECT * FROM users");
    const filtered = users.filter(u => u.active);
    res.json({ data: filtered, count: filtered.length });
  } catch (err) {
    next(err);
  }
});

module.exports = router;`,
    hint: "Navigate to inside the parentheses after 'handler', then ci( to change inside parens. Type 'ctx'.",
  },
  {
    topic: "changing",
    title: "Update the config strings",
    description: "Change host from 'localhost' to 'db.prod.internal', port from '5432' to '3306', and database from 'myapp_dev' to 'myapp_prod'.",
    start: `const config = {
  host: "localhost",
  port: "5432",
  database: "myapp_dev",
  pool: {
    min: 2,
    max: 10,
    idle: 30000,
  },
  ssl: false,
  logging: true,
  retry: {
    maxRetries: 3,
    delay: 1000,
  },
};`,
    target: `const config = {
  host: "db.prod.internal",
  port: "3306",
  database: "myapp_prod",
  pool: {
    min: 2,
    max: 10,
    idle: 30000,
  },
  ssl: false,
  logging: true,
  retry: {
    maxRetries: 3,
    delay: 1000,
  },
};`,
    hint: "Move to 'localhost', use ci\" to change inside quotes, type the new value. Repeat for port and database.",
  },
  {
    topic: "changing",
    title: "Change the method name",
    description: "Rename 'getData' to 'fetchRecords' on line 5 and where it's called on line 13.",
    start: `class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  async getData(endpoint) {
    if (this.cache.has(endpoint)) {
      return this.cache.get(endpoint);
    }
    const res = await fetch(this.baseUrl + endpoint);
    const json = await res.json();
    this.cache.set(endpoint, json);
    return json;
  }

  clearCache() {
    this.cache.clear();
  }
}

const client = new ApiClient("https://api.example.com");
const users = await client.getData("/users");`,
    target: `class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  async fetchRecords(endpoint) {
    if (this.cache.has(endpoint)) {
      return this.cache.get(endpoint);
    }
    const res = await fetch(this.baseUrl + endpoint);
    const json = await res.json();
    this.cache.set(endpoint, json);
    return json;
  }

  clearCache() {
    this.cache.clear();
  }
}

const client = new ApiClient("https://api.example.com");
const users = await client.fetchRecords("/users");`,
    hint: "Navigate to 'getData' on line 7, use ciw to change the word. Then find the other occurrence on the last line and repeat.",
  },

  // ── Copy & Paste ──
  {
    topic: "copy-paste",
    title: "Duplicate the route and modify",
    description: "Duplicate the GET route below itself and change the copy to POST.",
    start: `const express = require('express');
const router = express.Router();
const { auth } = require('./middleware');

router.get('/users', auth, async (req, res) => {
  const users = await User.find({});
  res.json(users);
});

module.exports = router;`,
    target: `const express = require('express');
const router = express.Router();
const { auth } = require('./middleware');

router.get('/users', auth, async (req, res) => {
  const users = await User.find({});
  res.json(users);
});

router.post('/users', auth, async (req, res) => {
  const users = await User.find({});
  res.json(users);
});

module.exports = router;`,
    hint: "Go to the router.get line. V then 2j to select all 3 lines. y to yank, then move to the }); line and p to paste below. Change 'get' to 'post' with cw.",
  },
  {
    topic: "copy-paste",
    title: "Move the misplaced function",
    description: "The helper function 'formatName' is defined inside the class but should be after it. Move it outside.",
    start: `class UserService {
  constructor(db) {
    this.db = db;
  }

  formatName(user) {
    return user.first + ' ' + user.last;
  }

  async getUser(id) {
    const user = await this.db.find(id);
    user.displayName = this.formatName(user);
    return user;
  }

  async listUsers() {
    const users = await this.db.findAll();
    return users.map(u => ({
      ...u,
      displayName: this.formatName(u),
    }));
  }
}`,
    target: `class UserService {
  constructor(db) {
    this.db = db;
  }

  async getUser(id) {
    const user = await this.db.find(id);
    user.displayName = this.formatName(user);
    return user;
  }

  async listUsers() {
    const users = await this.db.findAll();
    return users.map(u => ({
      ...u,
      displayName: this.formatName(u),
    }));
  }
}

function formatName(user) {
  return user.first + ' ' + user.last;
}`,
    hint: "Go to the formatName line. V then 2j to select the 3 lines. d to cut. Go to after the closing } of the class. p to paste. Fix the indentation.",
  },
  {
    topic: "copy-paste",
    title: "Move the return to the right place",
    description: "The early return is misplaced. Move it after the validation block.",
    start: `function processPayment(order) {
  return receipt;
  if (!order.items.length) {
    throw new Error("empty order");
  }
  if (!order.paymentMethod) {
    throw new Error("no payment method");
  }
  const subtotal = order.items.reduce((s, i) => s + i.price, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  const receipt = charge(order.paymentMethod, total);
}`,
    target: `function processPayment(order) {
  if (!order.items.length) {
    throw new Error("empty order");
  }
  if (!order.paymentMethod) {
    throw new Error("no payment method");
  }
  const subtotal = order.items.reduce((s, i) => s + i.price, 0);
  const tax = subtotal * 0.08;
  const total = subtotal + tax;
  const receipt = charge(order.paymentMethod, total);
  return receipt;
}`,
    hint: "Go to the 'return receipt' line, dd to cut it, G to go to the last line, P to paste above the closing }.",
  },

  // ── Text Objects ──
  {
    topic: "text-objects",
    title: "Replace the JSX content",
    description: "Change everything inside the outer <div> to just 'Hello, World!'.",
    start: `import React from 'react';

function App() {
  return (
    <div>
      <h1>Welcome to my app</h1>
      <p>This is a paragraph with some text</p>
      <ul>
        <li>Item one</li>
        <li>Item two</li>
      </ul>
    </div>
  );
}

export default App;`,
    target: `import React from 'react';

function App() {
  return (
    <div>Hello, World!</div>
  );
}

export default App;`,
    hint: "Move cursor inside the div tags, use cit to change inner tag content, then type 'Hello, World!'.",
  },
  {
    topic: "text-objects",
    title: "Empty the array",
    description: "Clear the array contents but keep the brackets on one line.",
    start: `const defaultPlugins = [
  'eslint-plugin-react',
  'eslint-plugin-import',
  'eslint-plugin-jsx-a11y',
  'eslint-plugin-hooks',
  'eslint-plugin-prettier',
  '@typescript-eslint/parser',
  '@typescript-eslint/eslint-plugin',
];

module.exports = {
  plugins: defaultPlugins,
  rules: {},
};`,
    target: `const defaultPlugins = [];

module.exports = {
  plugins: defaultPlugins,
  rules: {},
};`,
    hint: "Place cursor inside the brackets, use di[ to delete contents, then clean up the empty lines with J or dd.",
  },
  {
    topic: "text-objects",
    title: "Rewrite the condition",
    description: "Change the condition inside the if parentheses to 'isValid && hasPermission'.",
    start: `class AuthMiddleware {
  constructor(config) {
    this.config = config;
    this.logger = config.logger;
  }

  checkAccess(user, resource) {
    if (user.role === 'admin' || user.permissions.includes(resource)) {
      this.logger.info("access granted", user.id);
      return true;
    }
    this.logger.warn("access denied", user.id);
    return false;
  }
}`,
    target: `class AuthMiddleware {
  constructor(config) {
    this.config = config;
    this.logger = config.logger;
  }

  checkAccess(user, resource) {
    if (isValid && hasPermission) {
      this.logger.info("access granted", user.id);
      return true;
    }
    this.logger.warn("access denied", user.id);
    return false;
  }
}`,
    hint: "Navigate to line 8, put cursor inside the if(), use ci( to change inside parentheses, type 'isValid && hasPermission'.",
  },
  {
    topic: "text-objects",
    title: "Replace the string argument",
    description: "Change the SQL query inside the quotes to 'SELECT id, name FROM users WHERE active = true'.",
    start: `async function getActiveUsers(db) {
  const query = "SELECT * FROM users";
  const result = await db.execute(query);
  const mapped = result.rows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    lastLogin: row.last_login,
  }));
  return mapped;
}`,
    target: `async function getActiveUsers(db) {
  const query = "SELECT id, name FROM users WHERE active = true";
  const result = await db.execute(query);
  const mapped = result.rows.map(row => ({
    id: row.id,
    name: row.name,
    email: row.email,
    lastLogin: row.last_login,
  }));
  return mapped;
}`,
    hint: "Move to the query line, use ci\" to change inside the quotes, type the new query.",
  },

  // ── Visual Mode ──
  {
    topic: "visual-mode",
    title: "Indent the function body",
    description: "The function body is not indented. Select lines 2-7 and indent them.",
    start: `function createServer(config) {
const app = express();
app.use(cors());
app.use(json());
app.use(auth(config.secret));
registerRoutes(app, config);
return app;
}`,
    target: `function createServer(config) {
  const app = express();
  app.use(cors());
  app.use(json());
  app.use(auth(config.secret));
  registerRoutes(app, config);
  return app;
}`,
    hint: "Move to line 2 with j. Press V to enter visual line mode, then 5j to select all body lines. Press > to indent.",
  },
  {
    topic: "visual-mode",
    title: "Delete the try-catch wrapper",
    description: "Remove the try-catch, keeping only the try block contents (de-indented to match).",
    start: `async function fetchData(url) {
  try {
    const response = await fetch(url);
    const headers = response.headers;
    const data = await response.json();
    const normalized = normalize(data);
    return { data: normalized, headers };
  } catch (err) {
    logger.error("fetch failed", { url, err });
    metrics.increment("fetch_error");
    throw new ApiError("fetch failed", err);
  }
}`,
    target: `async function fetchData(url) {
  const response = await fetch(url);
  const headers = response.headers;
  const data = await response.json();
  const normalized = normalize(data);
  return { data: normalized, headers };
}`,
    hint: "Delete the 'try {' line (dd), then select the catch block lines with V and delete with d. Fix indentation with < if needed.",
  },
  {
    topic: "visual-mode",
    title: "Uppercase the constant names",
    description: "Change lines 1-4 constant names to UPPERCASE. Change 'maxRetries' to 'MAX_RETRIES', etc.",
    start: `const maxRetries = 3;
const timeout = 5000;
const batchSize = 100;
const pollInterval = 1000;

function processQueue(queue) {
  let retries = 0;
  while (retries < maxRetries) {
    const batch = queue.take(batchSize);
    if (!batch.length) break;
    send(batch);
    retries = 0;
  }
}`,
    target: `const MAX_RETRIES = 3;
const TIMEOUT = 5000;
const BATCH_SIZE = 100;
const POLL_INTERVAL = 1000;

function processQueue(queue) {
  let retries = 0;
  while (retries < maxRetries) {
    const batch = queue.take(batchSize);
    if (!batch.length) break;
    send(batch);
    retries = 0;
  }
}`,
    hint: "On each line, move to the variable name and use cw to change the word. Type the UPPER_CASE version.",
  },

  // ── Real World ──
  {
    topic: "real-world",
    title: "Add error handling",
    description: "Wrap the database operations inside a try/catch block.",
    start: `async function saveUser(userData) {
  const validated = validateSchema(userData);
  const id = await db.users.insert(validated);
  await db.audit.log('user_created', id);
  await cache.invalidate('users');
  return { id, ...validated };
}`,
    target: `async function saveUser(userData) {
  const validated = validateSchema(userData);
  try {
    const id = await db.users.insert(validated);
    await db.audit.log('user_created', id);
    await cache.invalidate('users');
    return { id, ...validated };
  } catch (err) {
    throw err;
  }
}`,
    hint: "Open a line above db.insert with O, type '  try {'. Select the 4 lines below and indent with V3j>. Go below and add the catch block with o.",
  },
  {
    topic: "real-world",
    title: "Convert to arrow functions",
    description: "Convert both regular functions to arrow functions.",
    start: `const utils = {
  formatDate: function(date) {
    const d = new Date(date);
    return d.toISOString().slice(0, 10);
  },

  formatCurrency: function(amount, currency) {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    });
    return formatter.format(amount);
  },
};`,
    target: `const utils = {
  formatDate: (date) => {
    const d = new Date(date);
    return d.toISOString().slice(0, 10);
  },

  formatCurrency: (amount, currency) => {
    const formatter = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
    });
    return formatter.format(amount);
  },
};`,
    hint: "On each function keyword: use cf( to change from 'function' to '(', then move before '{' and insert ' => '. Or dw to delete 'function' and then add '=>' before {.",
  },
  {
    topic: "real-world",
    title: "Swap the order of properties",
    description: "Move the 'id' property to be the first property in the object.",
    start: `const userConfig = {
  name: "Alice Johnson",
  email: "alice@example.com",
  preferences: {
    theme: "dark",
    language: "en",
  },
  id: 42,
  role: "admin",
  createdAt: "2024-01-15",
};`,
    target: `const userConfig = {
  id: 42,
  name: "Alice Johnson",
  email: "alice@example.com",
  preferences: {
    theme: "dark",
    language: "en",
  },
  role: "admin",
  createdAt: "2024-01-15",
};`,
    hint: "Navigate to the 'id: 42' line. dd to cut it. Go to the line after '{' and P to paste above.",
  },
  {
    topic: "real-world",
    title: "Comment out the validation block",
    description: "Comment out lines 2-5 by adding // at the start of each.",
    start: `function processOrder(order) {
  if (!order) throw new Error("missing order");
  if (!order.items) throw new Error("missing items");
  if (order.items.length === 0) throw new Error("empty order");
  if (!order.customer) throw new Error("missing customer");
  const subtotal = order.items.reduce((s, i) => s + i.price, 0);
  const tax = subtotal * 0.08;
  const shipping = subtotal > 100 ? 0 : 9.99;
  const total = subtotal + tax + shipping;
  return {
    orderId: generateId(),
    customer: order.customer,
    total,
    items: order.items,
  };
}`,
    target: `function processOrder(order) {
  // if (!order) throw new Error("missing order");
  // if (!order.items) throw new Error("missing items");
  // if (order.items.length === 0) throw new Error("empty order");
  // if (!order.customer) throw new Error("missing customer");
  const subtotal = order.items.reduce((s, i) => s + i.price, 0);
  const tax = subtotal * 0.08;
  const shipping = subtotal > 100 ? 0 : 9.99;
  const total = subtotal + tax + shipping;
  return {
    orderId: generateId(),
    customer: order.customer,
    total,
    items: order.items,
  };
}`,
    hint: "Move to line 2. Use I to insert at line start, type '// ' then Esc. Press j then . to repeat on each subsequent line.",
  },
  {
    topic: "real-world",
    title: "Extract a variable",
    description: "Extract the discount calculation into its own variable above the return.",
    start: `function getPrice(item) {
  const basePrice = item.price * item.quantity;
  const shipping = item.weight > 10 ? 15.99 : 5.99;
  return basePrice - (basePrice * (item.discount / 100)) + shipping;
}`,
    target: `function getPrice(item) {
  const basePrice = item.price * item.quantity;
  const shipping = item.weight > 10 ? 15.99 : 5.99;
  const discount = basePrice * (item.discount / 100);
  return basePrice - discount + shipping;
}`,
    hint: "Use O above the return to open a new line, type the discount const. Then change the expression in the return line.",
  },
  {
    topic: "real-world",
    title: "Add a new method to the class",
    description: "Add an 'update' method after 'create' that takes (id, data) and returns db.users.update(id, data).",
    start: `class UserRepository {
  constructor(db) {
    this.db = db;
  }

  async create(data) {
    const user = await this.db.users.insert(data);
    await this.db.audit.log('created', user.id);
    return user;
  }

  async delete(id) {
    await this.db.audit.log('deleted', id);
    return this.db.users.remove(id);
  }

  async findById(id) {
    return this.db.users.findOne({ id });
  }
}`,
    target: `class UserRepository {
  constructor(db) {
    this.db = db;
  }

  async create(data) {
    const user = await this.db.users.insert(data);
    await this.db.audit.log('created', user.id);
    return user;
  }

  async update(id, data) {
    return this.db.users.update(id, data);
  }

  async delete(id) {
    await this.db.audit.log('deleted', id);
    return this.db.users.remove(id);
  }

  async findById(id) {
    return this.db.users.findOne({ id });
  }
}`,
    hint: "Go to the blank line after the create method. Use o to open a line below and type the new method. Or yank the create method, paste, and modify.",
  },
];


// ─── APP STATE & RENDERING ──────────────────────────────────

const $ = s => document.querySelector(s);
const state = {
  vim: null,
  challenge: null,
  challengeIdx: 0,
  pool: [],
  keysLog: [],
  completed: new Set(),
  mode: "challenges", // "challenges" | "free"
};

function loadProgress() {
  try {
    const d = JSON.parse(localStorage.getItem("vim-learner-v2") || "{}");
    state.completed = new Set(d.completed || []);
  } catch (e) {}
}
function saveProgress() {
  try {
    localStorage.setItem("vim-learner-v2", JSON.stringify({ completed: [...state.completed] }));
  } catch (e) {}
}
function firstIncomplete() {
  for (let i = 0; i < state.pool.length; i++) {
    if (!state.completed.has(state.pool[i].title)) return i;
  }
  return 0;
}

function buildPool() {
  state.pool = [...CHALLENGES];
}

// ── Load challenge ──
function loadChallenge() {
  const c = state.pool[state.challengeIdx];
  if (!c) return;
  state.challenge = c;
  state.vim = new VimEngine(c.start);
  state.keysLog = [];

  $("#task-title").textContent = c.title;
  $("#task-desc").textContent = c.description;
  $("#hint-bar").classList.add("hidden");
  $("#success-banner").classList.add("hidden");

  renderCounter();
  renderTargetBuffer(c.target);
  render();
  $("#editor-wrap").focus();
}

function renderCounter() {
  $("#counter").textContent = `${state.challengeIdx + 1} / ${state.pool.length}`;
}

// ── Render the live buffer ──
function render() {
  const vim = state.vim;
  if (!vim) return;

  const visual = vim.getVisualCells();
  let bufHtml = "";
  let lnHtml = "";

  for (let r = 0; r < vim.lines.length; r++) {
    const line = vim.lines[r];
    const isActiveLine = r === vim.cur.line;
    const relNum = Math.abs(r - vim.cur.line);
    lnHtml += `<span class="line-nr${isActiveLine ? " active" : ""}">${relNum}</span>`;

    bufHtml += '<span class="buffer-line">';
    if (line.length === 0) {
      // Empty line — still show cursor if on this line
      const isCur = isActiveLine;
      const isVis = visual && r >= visual.startLine && r <= visual.endLine;
      let cls = "char";
      if (isCur) cls += vim.mode === "insert" ? " cursor-line" : " cursor-block";
      if (isVis) cls += " visual-sel";
      bufHtml += `<span class="${cls}"> </span>`;
    } else {
      for (let c = 0; c < line.length; c++) {
        let cls = "char";
        if (isActiveLine && c === vim.cur.col) {
          cls += vim.mode === "insert" ? " cursor-line" : " cursor-block";
        }
        if (visual) {
          let inVisual = false;
          if (vim.mode === "visual-line") {
            const sL = Math.min(visual.startLine, visual.endLine);
            const eL = Math.max(visual.startLine, visual.endLine);
            inVisual = r >= sL && r <= eL;
          } else {
            if (r > visual.startLine && r < visual.endLine) inVisual = true;
            else if (r === visual.startLine && r === visual.endLine) inVisual = c >= visual.startCol && c <= visual.endCol;
            else if (r === visual.startLine) inVisual = c >= visual.startCol;
            else if (r === visual.endLine) inVisual = c <= visual.endCol;
          }
          if (inVisual) cls += " visual-sel";
        }
        bufHtml += `<span class="${cls}">${esc(line[c])}</span>`;
      }
      // If insert cursor is at end of line
      if (isActiveLine && vim.mode === "insert" && vim.cur.col >= line.length) {
        bufHtml += `<span class="char cursor-line"> </span>`;
      }
    }
    bufHtml += "</span>";
  }

  $("#buffer").innerHTML = bufHtml;
  $("#line-numbers").innerHTML = lnHtml;

  // Mode indicator
  const modeEl = $("#mode-indicator");
  const modeLabel = vim.operator
    ? `OPERATOR (${vim.operator})`
    : vim.mode === "visual-line" ? "V-LINE" : vim.mode.toUpperCase();
  modeEl.textContent = "-- " + modeLabel + " --";
  modeEl.className = "mode " + (vim.operator ? "operator" : vim.mode === "visual-line" ? "visual" : vim.mode);

  // Keys display
  const pending = [...(vim.count !== null ? [vim.count] : []), ...(vim.operator ? [vim.operator] : []), ...vim.pendingKeys];
  $("#keys-display").textContent = pending.join("");

  // Cursor info
  $("#cursor-info").textContent = `${vim.cur.line + 1}:${vim.cur.col + 1}`;

  // Check match
  checkMatch();
}

function renderTargetBuffer(text) {
  const lines = text.split("\n");
  let bufHtml = "";
  let lnHtml = "";
  for (let r = 0; r < lines.length; r++) {
    lnHtml += `<span class="line-nr">${r + 1}</span>`;
    bufHtml += '<span class="buffer-line">';
    for (const ch of lines[r]) {
      bufHtml += `<span class="char">${esc(ch)}</span>`;
    }
    if (lines[r].length === 0) bufHtml += `<span class="char"> </span>`;
    bufHtml += "</span>";
  }
  $("#target-buffer").innerHTML = bufHtml;
  $("#target-line-numbers").innerHTML = lnHtml;
}

function checkMatch() {
  if (state.mode === "free") return;
  const current = state.vim.getText();
  const target = state.challenge.target;
  const matched = current === target;

  const el = $("#match-status");
  if (matched) {
    el.textContent = "Matched!";
    el.className = "match-status matched";
    $("#success-banner").classList.remove("hidden");
    state.completed.add(state.challenge.title);
    saveProgress();
  } else {
    el.textContent = "Not yet matching";
    el.className = "match-status unmatched";
    $("#success-banner").classList.add("hidden");
  }
}

function esc(ch) {
  if (ch === "<") return "&lt;";
  if (ch === ">") return "&gt;";
  if (ch === "&") return "&amp;";
  if (ch === '"') return "&quot;";
  return ch;
}


// ─── KEY INPUT ──────────────────────────────────────────────

function keyToVimKey(e) {
  if (e.key === "Escape") return "Escape";
  if (e.key === "Backspace") return "Backspace";
  if (e.key === "Enter") return "Enter";
  if (e.key === "Tab") return "Tab";
  if (e.ctrlKey && e.key.length === 1) return "Ctrl-" + e.key.toLowerCase();
  if (e.key.length === 1) return e.key;
  return null;
}

$("#editor-wrap").addEventListener("keydown", (e) => {
  const vk = keyToVimKey(e);
  if (!vk) return;

  e.preventDefault();
  e.stopPropagation();

  state.vim.processKey(vk);
  state.keysLog.push(vk);
  render();
});

// Keep focus on editor
document.addEventListener("click", (e) => {
  if (!e.target.closest("button")) {
    $("#editor-wrap").focus();
  }
});


// ─── BUTTONS ────────────────────────────────────────────────

$("#btn-hint").addEventListener("click", () => {
  const c = state.challenge;
  if (!c) return;
  const el = $("#hint-bar");
  el.classList.toggle("hidden");
  el.textContent = c.hint;
  $("#editor-wrap").focus();
});

$("#btn-reset").addEventListener("click", () => {
  loadChallenge();
});

$("#btn-next").addEventListener("click", () => {
  nextChallenge();
});

function nextChallenge() {
  state.challengeIdx = (state.challengeIdx + 1) % state.pool.length;
  loadChallenge();
}

function prevChallenge() {
  state.challengeIdx = (state.challengeIdx - 1 + state.pool.length) % state.pool.length;
  loadChallenge();
}

// Nav buttons
$("#btn-prev").addEventListener("click", () => { prevChallenge(); });
$("#btn-next-nav").addEventListener("click", () => { nextChallenge(); });


// ─── FREE MODE ──────────────────────────────────────────────

const FREE_SNIPPET = `const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  database: 'myapp',
  user: 'admin',
  password: process.env.DB_PASS,
});

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/users', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email FROM users WHERE active = $1',
      [true]
    );
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('query failed:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/api/users', async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email required' });
  }
  try {
    const { rows } = await pool.query(
      'INSERT INTO users (name, email) VALUES ($1, $2) RETURNING *',
      [name, email]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('insert failed:', err.message);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.listen(3000, () => {
  console.log('server running on port 3000');
});`;

function enterFreeMode() {
  state.mode = "free";
  state.vim = new VimEngine(FREE_SNIPPET);
  state.challenge = null;

  // Toggle UI
  $("#btn-free").classList.add("active");
  $("#btn-challenges").classList.remove("active");
  $("#challenge-nav").classList.add("hidden");
  $("#task-bar").classList.add("hidden");
  $("#hint-bar").classList.add("hidden");
  $("#success-banner").classList.add("hidden");
  $("#target-panel").classList.add("hidden");
  $("#cheat-sheet").classList.remove("hidden");
  $("#free-reset-bar").classList.remove("hidden");
  $("#editor-area").classList.add("free-mode");

  render();
  $("#editor-wrap").focus();
}

function enterChallengeMode() {
  state.mode = "challenges";

  // Toggle UI
  $("#btn-challenges").classList.add("active");
  $("#btn-free").classList.remove("active");
  $("#challenge-nav").classList.remove("hidden");
  $("#task-bar").classList.remove("hidden");
  $("#target-panel").classList.remove("hidden");
  $("#cheat-sheet").classList.add("hidden");
  $("#free-reset-bar").classList.add("hidden");
  $("#editor-area").classList.remove("free-mode");

  loadChallenge();
}

$("#btn-free").addEventListener("click", () => { enterFreeMode(); });
$("#btn-challenges").addEventListener("click", () => { enterChallengeMode(); });
$("#btn-free-reset").addEventListener("click", () => { enterFreeMode(); });


// ─── INIT ───────────────────────────────────────────────────

loadProgress();
buildPool();
state.challengeIdx = firstIncomplete();
loadChallenge();
