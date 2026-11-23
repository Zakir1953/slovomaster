'use strict';
// Решатель большого кроссворда - перенос CrosswordSolver.kt и BigCrosswordViewModel.build().
// Работает в фоновом потоке (Web Worker), чтобы экран не замирал, пока подбираются слова.
//
// Сообщения:  {type:'init', answers:[...], diffs:[...]}  - слова словаря (один раз)
//             {type:'solve', id, usage:{слово:раз}, level:0..2, templates:[{rows, cols, slots}]}
// Ответ:      {id, index, answers:[...] | null}  - номер заполненного шаблона и слова по его местам

const LETTERS = 32;                         // А..Я без Ё (в словаре Ё нет)
const A_CODE = 'А'.charCodeAt(0);
const YA_CODE = 'Я'.charCodeAt(0);

// Битовое множество фиксированного размера (аналог java.util.BitSet)
class Bits {
  constructor(n) {
    this.n = n;
    this.w = new Uint32Array((n + 31) >>> 5);
  }
  static full(n) {
    const b = new Bits(n);
    b.w.fill(0xFFFFFFFF);
    const extra = b.w.length * 32 - n;
    if (extra > 0) b.w[b.w.length - 1] = 0xFFFFFFFF >>> extra;
    return b;
  }
  set(i) { this.w[i >>> 5] |= (1 << (i & 31)); }
  clear(i) { this.w[i >>> 5] &= ~(1 << (i & 31)); }
  and(o) { const w = this.w, v = o.w; for (let i = 0; i < w.length; i++) w[i] &= v[i]; }
  andNot(o) { const w = this.w, v = o.w; for (let i = 0; i < w.length; i++) w[i] &= ~v[i]; }
  clone() { const b = new Bits(this.n); b.w.set(this.w); return b; }
  isEmpty() { const w = this.w; for (let i = 0; i < w.length; i++) if (w[i] !== 0) return false; return true; }
  count() {
    let c = 0;
    const w = this.w;
    for (let i = 0; i < w.length; i++) {
      let x = w[i];
      if (x === 0) continue;
      x = x - ((x >>> 1) & 0x55555555);
      x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
      c += Math.imul((x + (x >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
    }
    return c;
  }
  // Первый установленный бит начиная с from или -1
  next(from) {
    if (from >= this.n) return -1;
    let i = from >>> 5;
    let x = this.w[i] & (0xFFFFFFFF << (from & 31));
    for (;;) {
      if (x !== 0) return (i << 5) + (31 - Math.clz32(x & -x));
      if (++i >= this.w.length) return -1;
      x = this.w[i];
    }
  }
}

// Словарь, разложенный для быстрого поиска: для каждой длины - маски «на позиции p стоит буква x»
class Lexicon {
  constructor(words) {
    this.byLength = new Map();
    for (const w of words) {
      const a = w.answer;
      if (a.length < 2) continue;
      let ok = true;
      for (let i = 0; i < a.length; i++) {
        const code = a.charCodeAt(i);
        if (code < A_CODE || code > YA_CODE) { ok = false; break; }
      }
      if (!ok) continue;
      let list = this.byLength.get(a.length);
      if (!list) this.byLength.set(a.length, list = []);
      list.push(w);
    }
    this.masks = new Map();
    for (const [len, list] of this.byLength) {
      const arr = [];
      for (let k = 0; k < len * LETTERS; k++) arr.push(new Bits(list.length));
      list.forEach((w, index) => {
        for (let pos = 0; pos < len; pos++) arr[pos * LETTERS + (w.answer.charCodeAt(pos) - A_CODE)].set(index);
      });
      this.masks.set(len, arr);
    }
  }
  size(len) { const l = this.byLength.get(len); return l ? l.length : 0; }
  mask(len, pos, code) { return this.masks.get(len)[pos * LETTERS + (code - A_CODE)]; }
}

// Заполнение шаблона: перебор с возвратами, первым - место с наименьшим числом вариантов.
// Слова нужной сложности пробуются раньше остальных. Одно слово - один раз.
class Solver {
  constructor(lexicon, template, preferred) {
    this.lex = lexicon;
    this.preferred = preferred;
    this.slots = template.slots.map((s) => {
      const cells = [];
      for (let i = 0; i < s.length; i++) cells.push(s.across ? [s.row, s.col + i] : [s.row + i, s.col]);
      return { length: s.length, cells, keys: cells.map(([r, c]) => r * 256 + c) };
    });
    this.grid = [];
    for (let r = 0; r < template.rows; r++) this.grid.push(new Array(template.cols).fill(0));
    this.assigned = new Array(this.slots.length).fill(-1);
    this.used = new Map();
    this.preferredMask = new Map();
    const owner = new Map();
    this.slots.forEach((slot, s) => slot.keys.forEach((k) => {
      if (!owner.has(k)) owner.set(k, []);
      owner.get(k).push(s);
    }));
    this.neighbours = this.slots.map((slot, s) => {
      const set = new Set();
      slot.keys.forEach((k) => owner.get(k).forEach((n) => { if (n !== s) set.add(n); }));
      return [...set];
    });
    this.deadline = 0;
    this.steps = 0;
  }

  solve(timeLimitMs) {
    if (this.slots.some((s) => this.lex.size(s.length) === 0)) return null;
    this.deadline = Date.now() + timeLimitMs;
    if (!this.search(0)) return null;
    return this.slots.map((s, i) => this.lex.byLength.get(s.length)[this.assigned[i]]);
  }

  candidates(s) {
    const slot = this.slots[s];
    const n = this.lex.size(slot.length);
    const result = Bits.full(n);
    for (let i = 0; i < slot.length; i++) {
      const [r, c] = slot.cells[i];
      const code = this.grid[r][c];
      if (code !== 0) result.and(this.lex.mask(slot.length, i, code));
    }
    const used = this.used.get(slot.length);
    if (used) result.andNot(used);
    return result;
  }

  search(depth) {
    if (depth === this.slots.length) return true;
    if (++this.steps % 256 === 0 && Date.now() > this.deadline) return false;

    // Самое ограниченное незаполненное место
    let best = -1, bestSet = null, bestCount = Infinity;
    for (let s = 0; s < this.slots.length; s++) {
      if (this.assigned[s] >= 0) continue;
      const set = this.candidates(s);
      const count = set.count();
      if (count === 0) return false;
      if (count < bestCount) {
        best = s; bestSet = set; bestCount = count;
        if (count === 1) break;
      }
    }
    const slot = this.slots[best];
    const n = this.lex.size(slot.length);

    // Сначала слова нужной сложности, потом остальные; внутри - со случайного места
    let pref = this.preferredMask.get(slot.length);
    if (!pref) {
      pref = new Bits(n);
      this.lex.byLength.get(slot.length).forEach((w, i) => { if (this.preferred(w.difficulty)) pref.set(i); });
      this.preferredMask.set(slot.length, pref);
    }
    const first = bestSet.clone(); first.and(pref);
    const second = bestSet.clone(); second.andNot(pref);

    for (const group of [first, second]) {
      if (group.isEmpty()) continue;
      let i = group.next(Math.floor(Math.random() * n));
      if (i < 0) i = group.next(0);
      const start = i;
      let tried = 0;
      // Не больше 40 вариантов на место: если не подошли - дальше перебирать бессмысленно
      while (i >= 0 && tried < 40) {
        if (this.place(best, i) && this.search(depth + 1)) return true;
        this.unplace(best);
        if (Date.now() > this.deadline) return false;
        tried++;
        i = group.next(i + 1);
        if (i < 0) i = group.next(0);
        if (i === start) break;
      }
    }
    return false;
  }

  // Ставит слово; false - если соседнее место осталось без вариантов
  place(s, index) {
    const slot = this.slots[s];
    const word = this.lex.byLength.get(slot.length)[index].answer;
    for (let i = 0; i < slot.length; i++) {
      const [r, c] = slot.cells[i];
      this.grid[r][c] = word.charCodeAt(i);
    }
    this.assigned[s] = index;
    let used = this.used.get(slot.length);
    if (!used) this.used.set(slot.length, used = new Bits(this.lex.size(slot.length)));
    used.set(index);
    return this.neighbours[s].every((n) => this.assigned[n] >= 0 || !this.candidates(n).isEmpty());
  }

  unplace(s) {
    const slot = this.slots[s];
    const index = this.assigned[s];
    if (index < 0) return;
    this.used.get(slot.length).clear(index);
    this.assigned[s] = -1;
    // Стираем только буквы, которые не держит другое заполненное слово
    for (let i = 0; i < slot.length; i++) {
      const k = slot.keys[i];
      const keep = this.neighbours[s].some((n) => this.assigned[n] >= 0 && this.slots[n].keys.includes(k));
      if (!keep) this.grid[slot.cells[i][0]][slot.cells[i][1]] = 0;
    }
  }
}

let words = null;

// Подбор слов: сначала только ещё не встречавшиеся игроку слова, если не вышло - понемногу
// разрешаем повторы; на каждом шаге до 6 шаблонов по 2,5 секунды
function build(usage, level, templates) {
  const values = Object.values(usage);
  const maxUsage = values.length ? Math.max(...values) : 0;
  const limits = [...new Set([0, 1, 2, 3, 5, 10, maxUsage])].sort((a, b) => a - b);
  const preferred = level === 0 ? (d) => d <= 2 : level === 1 ? (d) => d >= 2 && d <= 3 : (d) => d >= 3;
  let previous = 0;
  for (const limit of limits) {
    const eligible = words.filter((w) => (usage[w.answer] || 0) <= limit);
    if (eligible.length === previous) continue;
    previous = eligible.length;
    const lex = new Lexicon(eligible);
    for (let index = 0; index < Math.min(6, templates.length); index++) {
      const solution = new Solver(lex, templates[index], preferred).solve(2500);
      if (solution) return { index, answers: solution.map((w) => w.answer) };
    }
  }
  return null;
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    words = m.answers.map((answer, i) => ({ answer, difficulty: m.diffs[i] }));
  } else if (m.type === 'solve') {
    let result = null;
    try {
      result = build(m.usage, m.level, m.templates);
    } catch (err) {
      console.error(err);
    }
    self.postMessage({ id: m.id, index: result ? result.index : -1, answers: result ? result.answers : null });
  }
};
