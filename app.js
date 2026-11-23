'use strict';
// Веб-версия игры SlovoMaster (СловоМастер) для iPhone - PWA.
// Повторяет Android-приложение: «Угадай слово», «Викторина», «Кроссворд дня», «Кроссворд», «Филворд».
// Игра целиком работает в телефоне: словарь (data/words.txt, выгружается из slovomaster.db
// командой export-data.bat) скачивается один раз и хранится в IndexedDB, прогресс - в localStorage.

const START_SCORE = 45;     // хватает на три подсказки
const HINT_COST = 15;
const FIFTY_COST = 10;
const MAX_MISTAKES = 5;
const QUIZ_ROUND = 10;
const DAILY_WORD_POINTS = 5;

// Уровни сложности (как Level в WordRepository.kt); длина слова ограничена, чтобы клетки помещались на экране
const LEVELS = [
  { title: 'Лёгкий', minDiff: 1, maxDiff: 2, minLen: 4, maxLen: 8, bonus: 0 },
  { title: 'Средний', minDiff: 3, maxDiff: 3, minLen: 4, maxLen: 9, bonus: 5 },
  { title: 'Сложный', minDiff: 4, maxDiff: 4, minLen: 5, maxLen: 11, bonus: 10 }
];
// Очков за слово в кроссворде и филворде и за верный ответ викторины: лёгкий 5, средний 7, сложный 10
const LEVEL_POINTS = [5, 7, 10];

// Размер большого кроссворда - по числу строк шаблона (шаблоны от 11x11 до 23x23)
const GRID_SIZES = [
  { title: 'Малый', minRows: 0, maxRows: 13, hint: '11×11 – 13×13, около 20–30 слов' },
  { title: 'Средний', minRows: 14, maxRows: 17, hint: '15×15 – 17×17, около 30–45 слов' },
  { title: 'Большой', minRows: 18, maxRows: 99, hint: '18×18 – 23×23, до 80 слов' }
];

// Буквы Ё в словаре нет - на клавиатуре её тоже нет
const KEYBOARD_ROWS = ['ЙЦУКЕНГШЩЗХЪ', 'ФЫВАПРОЛДЖЭ', 'ЯЧСМИТЬБЮ'];

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

// ==================== мелочи ====================

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Случайные числа; с seed - повторяемая последовательность (кроссворд дня)
function makeRandom(seed) {
  let s = seed === undefined ? (Math.random() * 4294967296) >>> 0 : (seed ^ 0x5BD1E995) >>> 0;
  function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    int: (n) => Math.floor(next() * n),
    bool: () => next() < 0.5,
    pick: (arr) => (arr.length ? arr[Math.floor(next() * arr.length)] : undefined),
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = a[i]; a[i] = a[j]; a[j] = t;
      }
      return a;
    }
  };
}
const rnd = makeRandom();

// Короткий ключ вопроса для учёта повторов (полный текст занял бы слишком много места в памяти браузера)
function hashText(text) {
  let h = 0x811C9DC5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function todayStamp(d = new Date()) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// Сравнение строк как в SQLite/Kotlin (по кодам символов)
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ==================== прогресс игрока (localStorage) ====================

const USAGE_SEP = '\u001F';

const Progress = {
  P: 'sm.',
  raw(key) { return localStorage.getItem(this.P + key); },
  set(key, value) {
    try { localStorage.setItem(this.P + key, value); } catch (e) { console.warn('localStorage', e); }
  },
  remove(key) { localStorage.removeItem(this.P + key); },
  keys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this.P)) out.push(k.substring(this.P.length));
    }
    return out;
  },
  getInt(key, def) {
    const n = parseInt(this.raw(key), 10);
    return isNaN(n) ? def : n;
  },
  putInt(key, v) { this.set(key, String(v)); },
  getString(key) { return this.raw(key) || ''; },
  putString(key, v) { this.set(key, v); },
  getBool(key, def) { const v = this.raw(key); return v == null ? def : v === '1'; },
  putBool(key, v) { this.set(key, v ? '1' : '0'); },

  score() { return this.getInt('score', START_SCORE); },
  solved() { return this.getInt('solved', 0); },
  earned() { return this.getInt('earned', 0); },
  possible() { return this.getInt('possible', 0); },

  // Слово сыграно: points - полученные очки (0 при проигрыше), max - максимум за это слово
  addResult(points, max) {
    this.putInt('score', this.score() + points);
    if (points > 0) this.putInt('solved', this.solved() + 1);
    this.putInt('earned', this.earned() + points);
    this.putInt('possible', this.possible() + max);
  },

  // false - очков не хватает
  spend(points) {
    if (this.score() < points) return false;
    this.putInt('score', this.score() - points);
    return true;
  },

  // Новый старт: очки - стартовые, счётчики - с нуля, кроссворд дня и начатый большой кроссворд стираются.
  // Остаются только настройки режимов (уровни, тема, размер).
  reset() {
    const settings = new Set(['big_level', 'big_size']);
    this.keys()
      .filter((k) => k.startsWith('daily_') || (k.startsWith('big_') && !settings.has(k)))
      .forEach((k) => this.remove(k));
    this.putInt('score', START_SCORE);
    this.putInt('solved', 0);
    this.putInt('earned', 0);
    this.putInt('possible', 0);
  },

  // Какие слова и вопросы уже встречались (по дням) - чтобы реже повторяться.
  // Ответ хранится как есть, вопрос - коротким ключом hashText.
  markUsed(answers, questions) {
    const day = todayStamp();
    if (answers.length) this.appendUsage('used_a_' + day, answers);
    if (questions.length) this.appendUsage('used_q_' + day, questions.map((q) => hashText(q).toString(36)));
  },
  appendUsage(key, values) {
    const old = this.getString(key);
    this.putString(key, (old ? old + USAGE_SEP : '') + values.join(USAGE_SEP));
  },
  usage(prefix, includeToday) {
    const today = todayStamp();
    const counts = new Map();
    for (const k of this.keys()) {
      if (!k.startsWith(prefix)) continue;
      if (!includeToday && parseInt(k.substring(prefix.length), 10) >= today) continue;
      for (const v of this.getString(k).split(USAGE_SEP)) {
        if (v) counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    return counts;
  },
  answerUsage(includeToday = true) { return this.usage('used_a_', includeToday); },
  // ключ - число hashText(вопрос)
  questionUsage(includeToday = true) {
    const m = new Map();
    for (const [k, v] of this.usage('used_q_', includeToday)) m.set(parseInt(k, 36), v);
    return m;
  },
  // Учёт повторов старше года не нужен, а место в браузере ограничено
  pruneUsage() {
    const limit = todayStamp() - 10000;
    for (const k of this.keys()) {
      const m = /^used_[aq]_(\d+)$/.exec(k);
      if (m && parseInt(m[1], 10) < limit) this.remove(k);
    }
  }
};

// ==================== словарь ====================

const Dict = {
  ready: false,
  error: null,
  loadedMb: 0,
  version: '',
  categoryNames: new Map(),
  categoryList: [],          // по имени
  templates: [],
  answer: [], question: [],
  cat: null, kind: null, diff: null, qual: null, qhash: null,
  byAnswer: null,            // ответ -> номера строк
  get count() { return this.answer.length; }
};

function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('slovomaster', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const r = db.transaction('files').objectStore('files').get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbPut(key, value) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite');
    tx.objectStore('files').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function download(url, onProgress) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error('Сервер ответил ' + res.status);
  if (!res.body || !res.body.getReader) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onProgress(size);
  }
  const all = new Uint8Array(size);
  let pos = 0;
  for (const c of chunks) { all.set(c, pos); pos += c.length; }
  return new TextDecoder('utf-8').decode(all);
}

// Словарь из памяти телефона; с компьютера - только при первом запуске и после обновления словаря
async function loadDictionary() {
  let serverVersion = null;
  try {
    const r = await fetch('data/version.txt', { cache: 'no-cache' });
    if (r.ok) serverVersion = (await r.text()).trim();
  } catch (e) { /* компьютер выключен - играем на сохранённом словаре */ }

  let stored = null;
  try { stored = await idbGet('words'); } catch (e) { console.warn('IndexedDB', e); }
  if (stored && stored.text && (serverVersion == null || stored.version === serverVersion)) {
    parseDictionary(stored.text);
    return;
  }
  if (serverVersion == null) {
    throw new Error('Нет связи с компьютером. Словарь скачивается один раз: включите компьютер с SlovoMaster и проверьте Wi-Fi.');
  }
  const text = await download('data/words.txt?v=' + encodeURIComponent(serverVersion), (bytes) => {
    Dict.loadedMb = bytes / 1048576;
    updateLoading();
  });
  parseDictionary(text);
  try { await idbPut('words', { version: serverVersion, text }); } catch (e) { console.warn('IndexedDB', e); }
}

function parseDictionary(text) {
  const lines = text.split('\n');
  const answer = [], question = [], cat = [], kind = [], diff = [], qual = [];
  const templates = new Map();
  for (let line of lines) {
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) continue;
    const f = line.split('\t');
    switch (f[0]) {
      case 'W':
        answer.push(f[1]); question.push(f[2]);
        cat.push(+f[3]); kind.push(+f[4]); diff.push(+f[5]); qual.push(+f[6]);
        break;
      case 'V': Dict.version = f[1]; break;
      case 'C': Dict.categoryNames.set(+f[1], f[2]); break;
      case 'T': templates.set(+f[1], { id: +f[1], rows: +f[2], cols: +f[3], slots: [] }); break;
      case 'S': {
        const t = templates.get(+f[1]);
        if (t) t.slots.push({ across: f[2] === '1', row: +f[3], col: +f[4], length: +f[5] });
        break;
      }
    }
  }
  if (!answer.length) throw new Error('Словарь пустой или повреждён');
  Dict.answer = answer;
  Dict.question = question;
  Dict.cat = Int16Array.from(cat);
  Dict.kind = Uint8Array.from(kind);
  Dict.diff = Uint8Array.from(diff);
  Dict.qual = Uint8Array.from(qual);
  Dict.qhash = Uint32Array.from(question, hashText);
  Dict.templates = [...templates.values()];
  Dict.categoryList = [...Dict.categoryNames].map(([id, name]) => ({ id, name }))
    .sort((a, b) => cmp(a.name, b.name));
  Dict.byAnswer = new Map();
  answer.forEach((a, i) => {
    const list = Dict.byAnswer.get(a);
    if (list) list.push(i); else Dict.byAnswer.set(a, [i]);
  });
}

// ==================== подбор слов (WordRepository.kt) ====================

function puzzleAt(i, aUse, qUse) {
  return {
    answer: Dict.answer[i],
    question: Dict.question[i],
    category: Dict.categoryNames.get(Dict.cat[i]) || '',
    categoryId: Dict.cat[i],
    difficulty: Dict.diff[i],
    quality: Dict.qual[i],
    answerUseCount: aUse ? aUse.get(Dict.answer[i]) || 0 : 0,
    questionUseCount: qUse ? qUse.get(Dict.qhash[i]) || 0 : 0
  };
}

// Слово, которое игрок видел реже всего; из равных - случайное.
// Берём только вопросы высшего и хорошего качества. Шуточных вопросов мало, поэтому для них
// сложность не учитывается, а качество - до среднего. category = 0 - все темы.
function randomPuzzle(level, humorOnly, category = 0) {
  const L = LEVELS[level];
  const aUse = Progress.answerUsage();
  const qUse = Progress.questionUsage();
  let best = [];
  let bestA = Infinity, bestQ = Infinity;
  const n = Dict.count;
  for (let i = 0; i < n; i++) {
    const len = Dict.answer[i].length;
    if (len < L.minLen || len > L.maxLen) continue;
    if (category !== 0 && Dict.cat[i] !== category) continue;
    if (humorOnly) {
      if (Dict.kind[i] !== 2 || Dict.qual[i] > 3) continue;
    } else if (Dict.qual[i] > 2 || Dict.diff[i] < L.minDiff || Dict.diff[i] > L.maxDiff) continue;
    const a = aUse.get(Dict.answer[i]) || 0;
    const q = qUse.get(Dict.qhash[i]) || 0;
    if (a < bestA || (a === bestA && q < bestQ)) {
      best = [i]; bestA = a; bestQ = q;
    } else if (a === bestA && q === bestQ) best.push(i);
  }
  if (!best.length) throw new Error('В словаре нет подходящих слов');
  const selected = puzzleAt(rnd.pick(best), aUse, qUse);
  Progress.markUsed([selected.answer], [selected.question]);
  return selected;
}

// Группы окончаний: женский род/мн. число/средний род/мягкий знак и т.д.
function endingGroup(last) {
  switch (last) {
    case 'А': case 'Я': return 'АЯ';
    case 'Ы': case 'И': return 'ЫИ';
    case 'О': case 'Е': return 'ОЕ';
    case 'У': case 'Ю': return 'УЮ';
    case 'Ь': return 'Ь';
    case 'Й': return 'Й';
    default: return 'БВГДЖЗКЛМНПРСТФХЦЧШЩ';
  }
}

// Основы значимых слов вопроса: слова от 4 букв, первые 5 букв («Азии», «Средней» → «азии», «средн»)
function stems(text) {
  const set = new Set();
  for (const w of text.toLowerCase().split(/[^а-яё]+/)) if (w.length >= 4) set.add(w.substring(0, 5));
  return set;
}

// Отбрасывает слова, которые тоже могут быть верным ответом: если в каком-то их вопросе есть
// значимое слово из нашего вопроса (кроме первого - оно задаёт только род: «Река», «Город»).
function withoutSimilarQuestions(candidates, question) {
  if (!candidates.length) return candidates;
  const space = question.indexOf(' ');
  const key = stems(space >= 0 ? question.substring(space + 1) : '');
  if (!key.size) return candidates;
  return candidates.filter((answer) => !(Dict.byAnswer.get(answer) || []).some((i) => {
    for (const s of stems(Dict.question[i])) if (key.has(s)) return true;
    return false;
  }));
}

// Вопрос викторины: ответ и 3 правдоподобных неверных варианта - из той же темы, похожей длины
// и сложности, с похожим окончанием. Если таких не хватает, условия ослабляются по очереди.
// Слова, к которым в словаре есть такой же вопрос, не берём - иначе верных ответов будет два.
function quizItem(level, humorOnly, category = 0) {
  const puzzle = randomPuzzle(level, humorOnly, category);
  const answer = puzzle.answer;
  const ending = endingGroup(answer[answer.length - 1]);
  const wrong = new Set();

  // Сначала - слова, чей вопрос начинается так же: к «Река в Ср.Азии» - другие реки
  const words = puzzle.question.split(' ').filter((w) => w.trim());
  const twoWords = words.length >= 3 ? words.slice(0, 2).join(' ') + ' ' : '';
  const first = words.length ? words[0].replace(/[,.:]+$/, '') : '';
  const oneWord = first.length >= 4 ? first + ' ' : '';

  const sameQuestion = new Set();
  for (let i = 0; i < Dict.count; i++) if (Dict.question[i] === puzzle.question) sameQuestion.add(Dict.answer[i]);

  // [своя тема, разброс длины, учитывать окончание, учитывать сложность, начало вопроса]
  const attempts = [
    [0, 3, 1, 0, twoWords], [0, 4, 0, 0, twoWords], [0, 3, 1, 0, oneWord], [0, 4, 0, 0, oneWord],
    [1, 2, 1, 1, ''], [1, 3, 1, 0, ''], [0, 2, 1, 1, ''], [0, 3, 0, 0, '']
  ].filter((a, i) => i >= 4 || a[4] !== '');

  for (const [sameCategory, spread, sameEnding, sameDiff, prefix] of attempts) {
    if (wrong.size >= 3) break;
    const found = new Set();
    for (let i = 0; i < Dict.count; i++) {
      const a = Dict.answer[i];
      if (a === answer || Dict.qual[i] > 3) continue;
      if (sameCategory && Dict.cat[i] !== puzzle.categoryId) continue;
      if (a.length < answer.length - spread || a.length > answer.length + spread) continue;
      if (sameEnding && !ending.includes(a[a.length - 1])) continue;
      if (sameDiff && (Dict.diff[i] < puzzle.difficulty - 1 || Dict.diff[i] > puzzle.difficulty + 1)) continue;
      if (prefix && !Dict.question[i].startsWith(prefix)) continue;
      if (sameQuestion.has(a)) continue;
      found.add(a);
    }
    const candidates = rnd.shuffle([...found]).slice(0, 20);
    for (const c of withoutSimilarQuestions(candidates, puzzle.question)) {
      if (wrong.size >= 3) break;
      wrong.add(c);
    }
  }
  if (wrong.size < 3) throw new Error('Не удалось подобрать варианты ответа');
  return { puzzle, options: rnd.shuffle([...wrong, answer]) };
}

// Слова для мини-кроссворда: простые, 3-9 букв, вопросы до среднего качества.
// Порядок по номеру строки, а не случайный: из одинакового пула и даты получается одинаковый кроссворд дня.
function crosswordPool(includeToday = true) {
  const aUse = Progress.answerUsage(includeToday);
  const qUse = Progress.questionUsage(includeToday);
  const choices = new Map();
  for (let i = 0; i < Dict.count; i++) {
    const len = Dict.answer[i].length;
    if (Dict.qual[i] > 3 || Dict.diff[i] > 2 || len < 3 || len > 9) continue;
    const p = puzzleAt(i, aUse, qUse);
    const old = choices.get(p.answer);
    if (!old || p.questionUseCount < old.questionUseCount ||
        (p.questionUseCount === old.questionUseCount && p.difficulty < old.difficulty)) {
      choices.set(p.answer, p);
    }
  }
  return [...choices.values()].sort((a, b) =>
    a.answerUseCount - b.answerUseCount || a.questionUseCount - b.questionUseCount || cmp(a.answer, b.answer));
}

// Вопрос к каждому слову кроссворда: лучшего качества, ближе к нужной сложности, из равных - случайный
function clues(answers, difficulty) {
  const aUse = Progress.answerUsage();
  const qUse = Progress.questionUsage();
  const result = new Map();
  for (const answer of answers) {
    const list = (Dict.byAnswer.get(answer) || []).filter((i) => Dict.qual[i] <= 3).map((i) => {
      const p = puzzleAt(i, aUse, qUse);
      return { rank: p.quality * 10 + Math.abs(p.difficulty - difficulty), p };
    });
    if (!list.length) continue;
    let best = list[0];
    for (const x of list) {
      if (x.p.questionUseCount < best.p.questionUseCount ||
          (x.p.questionUseCount === best.p.questionUseCount && x.rank < best.rank)) best = x;
    }
    result.set(answer, rnd.pick(list.filter((x) =>
      x.p.questionUseCount === best.p.questionUseCount && x.rank === best.rank)).p);
  }
  return result;
}

// Слова для филворда по длинам 3-8: нужная сложность, вопросы до среднего качества;
// с темой - из неё, а длины, которых в теме мало, добираются из всего словаря
function filwordPool(level, category) {
  const L = LEVELS[level];
  const aUse = Progress.answerUsage();
  const qUse = Progress.questionUsage();
  function load(byCategory) {
    const groups = new Map();
    for (let i = 0; i < Dict.count; i++) {
      const len = Dict.answer[i].length;
      if (Dict.qual[i] > 3 || len < 3 || len > 8 || Dict.diff[i] < L.minDiff || Dict.diff[i] > L.maxDiff) continue;
      if (byCategory && Dict.cat[i] !== category) continue;
      if (!groups.has(len)) groups.set(len, []);
      groups.get(len).push(puzzleAt(i, aUse, qUse));
    }
    return groups;
  }
  const all = load(false);
  const themed = category === 0 ? all : load(true);
  const result = new Map();
  for (let len = 3; len <= 8; len++) {
    let full;
    if (category === 0) full = all.get(len) || [];
    else {
      const own = themed.get(len) || [];
      full = own.length >= 5 ? own : own.concat(all.get(len) || []);
    }
    const seen = new Set();
    full = full.filter((p) => (seen.has(p.answer) ? false : (seen.add(p.answer), true)));
    full.sort((a, b) => a.answerUseCount - b.answerUseCount || a.questionUseCount - b.questionUseCount || cmp(a.answer, b.answer));
    result.set(len, full);
  }
  return result;
}

// Слова для решателя большого кроссворда: ответ и его наименьшая сложность, по алфавиту
function lexiconWords() {
  const m = new Map();
  for (let i = 0; i < Dict.count; i++) {
    if (Dict.qual[i] > 3) continue;
    const a = Dict.answer[i];
    const d = m.get(a);
    if (d === undefined || Dict.diff[i] < d) m.set(a, Dict.diff[i]);
  }
  const answers = [...m.keys()].sort(cmp);
  return { answers, diffs: answers.map((a) => m.get(a)) };
}

function leastUsedPuzzle(candidates, random) {
  if (!candidates.length) return null;
  let bestA = Infinity, bestQ = Infinity;
  for (const p of candidates) {
    if (p.answerUseCount < bestA || (p.answerUseCount === bestA && p.questionUseCount < bestQ)) {
      bestA = p.answerUseCount; bestQ = p.questionUseCount;
    }
  }
  return random.pick(candidates.filter((p) => p.answerUseCount === bestA && p.questionUseCount === bestQ));
}

// ==================== кроссворд ====================

const cellKey = (r, c) => r * 256 + c;
const rowOf = (k) => k >> 8;
const colOf = (k) => k & 255;

function makeSlot(number, across, row, col, puzzle) {
  const cells = [];
  for (let i = 0; i < puzzle.answer.length; i++) cells.push(across ? cellKey(row, col + i) : cellKey(row + i, col));
  return { number, across, row, col, puzzle, answer: puzzle.answer, length: puzzle.answer.length, cells };
}

function makeCrossword(rows, cols, slots) {
  const solution = [];
  for (let r = 0; r < rows; r++) solution.push(new Array(cols).fill(null));
  for (const s of slots) s.cells.forEach((k, i) => { solution[rowOf(k)][colOf(k)] = s.answer[i]; });
  // Подпись, по которой сохранённые ответы узнают свой кроссворд (при новом словаре он другой)
  const signature = slots.map((s) => s.answer + s.row + '.' + s.col + (s.across ? 'a' : 'd')).join(',');
  return { rows, cols, slots, solution, signature };
}

// Нумерация сверху вниз и слева направо; сначала все по горизонтали, потом по вертикали
function numberSlots(items) {
  const starts = [...new Set(items.map((it) => cellKey(it.row, it.col)))].sort((a, b) => a - b);
  const numbers = new Map(starts.map((k, i) => [k, i + 1]));
  return items
    .map((it) => makeSlot(numbers.get(cellKey(it.row, it.col)), it.across, it.row, it.col, it.puzzle))
    .sort((a, b) => (a.across === b.across ? a.number - b.number : a.across ? -1 : 1));
}

// Мини-кроссворд в стиле сканворда (CrosswordGenerator.kt): слова пересекаются только по общим буквам,
// новые буквы не касаются соседних слов боком. Одинаковый seed и пул слов дают одинаковый кроссворд.
function generateMiniCrossword(pool, seed) {
  const SIZE = 9, TARGET = 10, MIN = 7;
  const random = makeRandom(seed);

  function attempt() {
    const grid = [], acrossAt = [], downAt = [];
    for (let r = 0; r < SIZE; r++) {
      grid.push(new Array(SIZE).fill(' '));
      acrossAt.push(new Array(SIZE).fill(false));
      downAt.push(new Array(SIZE).fill(false));
    }
    const placed = [];
    const used = new Set();
    const ordered = random.shuffle(pool)
      .sort((a, b) => a.answerUseCount - b.answerUseCount || a.questionUseCount - b.questionUseCount);

    const put = (p) => {
      for (let i = 0; i < p.puzzle.answer.length; i++) {
        const r = p.across ? p.row : p.row + i;
        const c = p.across ? p.col + i : p.col;
        grid[r][c] = p.puzzle.answer[i];
        if (p.across) acrossAt[r][c] = true; else downAt[r][c] = true;
      }
      placed.push(p);
      used.add(p.puzzle.answer);
    };
    const inside = (r, c) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
    const empty = (r, c) => !inside(r, c) || grid[r][c] === ' ';

    // В пределах сетки, совпадает с буквами на пересечениях, хотя бы одно пересечение,
    // не продолжает чужое слово и не касается соседних слов боком
    const fits = (word, row, col, across) => {
      const dr = across ? 0 : 1, dc = across ? 1 : 0;
      const endR = row + dr * (word.length - 1), endC = col + dc * (word.length - 1);
      if (!inside(row, col) || !inside(endR, endC)) return false;
      if (!empty(row - dr, col - dc) || !empty(endR + dr, endC + dc)) return false;
      let crossings = 0;
      for (let i = 0; i < word.length; i++) {
        const r = row + dr * i, c = col + dc * i;
        if (grid[r][c] !== ' ') {
          if (grid[r][c] !== word[i]) return false;
          if ((across && acrossAt[r][c]) || (!across && downAt[r][c])) return false;
          crossings++;
        } else if (!empty(r - dc, c - dr) || !empty(r + dc, c + dr)) return false;
      }
      return crossings > 0;
    };

    // Первое слово - длинное, по горизонтали в середине
    const first = leastUsedPuzzle(ordered.filter((p) => p.answer.length >= 6 && p.answer.length <= SIZE), random);
    if (!first) return [];
    put({ puzzle: first, row: SIZE >> 1, col: (SIZE - first.answer.length) >> 1, across: true });

    let misses = 0;
    while (placed.length < TARGET && misses < 150) {
      // Случайная буква уже стоящего слова, к ней - перпендикулярное слово
      const base = random.pick(placed);
      const i = random.int(base.puzzle.answer.length);
      const r0 = base.across ? base.row : base.row + i;
      const c0 = base.across ? base.col + i : base.col;
      const across = !base.across;
      if (across ? acrossAt[r0][c0] : downAt[r0][c0]) { misses++; continue; }
      const letter = grid[r0][c0];

      let done = false, taken = 0;
      for (const p of ordered) {
        if (used.has(p.answer) || p.answer.length > SIZE) continue;
        if (++taken > 60) break;
        const word = p.answer;
        const positions = [];
        for (let j = 0; j < word.length; j++) if (word[j] === letter) positions.push(j);
        if (!positions.length) continue;
        const j = random.pick(positions);
        const row = across ? r0 : r0 - j;
        const col = across ? c0 - j : c0;
        if (fits(word, row, col, across)) {
          put({ puzzle: p, row, col, across });
          done = true;
          break;
        }
      }
      if (!done) misses++;
    }
    return placed;
  }

  // Несколько попыток с разным первым словом; берём лучшую по числу слов
  let best = [];
  for (let k = 0; k < 20; k++) {
    const placed = attempt();
    if (placed.length > best.length) best = placed;
    if (best.length >= TARGET) break;
  }
  if (best.length < MIN) throw new Error('Не удалось составить кроссворд');

  // Обрезаем пустые края
  let top = Infinity, left = Infinity, bottom = 0, right = 0;
  for (const p of best) {
    const endR = p.across ? p.row : p.row + p.puzzle.answer.length - 1;
    const endC = p.across ? p.col + p.puzzle.answer.length - 1 : p.col;
    top = Math.min(top, p.row); left = Math.min(left, p.col);
    bottom = Math.max(bottom, endR); right = Math.max(right, endC);
  }
  const slots = numberSlots(best.map((p) => ({ ...p, row: p.row - top, col: p.col - left })));
  return makeCrossword(bottom - top + 1, right - left + 1, slots);
}

// Введённые буквы для сохранения: "r,c,Б;r,c,А" (как в Android-версии)
function encodeCells(map) { return [...map].map(([k, ch]) => rowOf(k) + ',' + colOf(k) + ',' + ch).join(';'); }
function decodeCells(text) {
  const m = new Map();
  for (const part of text.split(';')) {
    if (!part) continue;
    const [r, c, ch] = part.split(',');
    m.set(cellKey(+r, +c), ch);
  }
  return m;
}
function encodeSet(set) { return [...set].map((k) => rowOf(k) + ',' + colOf(k)).join(';'); }
function decodeSet(text) {
  const s = new Set();
  for (const part of text.split(';')) {
    if (!part) continue;
    const [r, c] = part.split(',');
    s.add(cellKey(+r, +c));
  }
  return s;
}

// Общая логика решения кроссворда (CrosswordGameViewModel.kt): выбор клетки и слова, ввод, проверка, подсказка
class CrosswordGame {
  constructor() { this.s = this.blank({ loading: true }); }

  blank(extra) {
    return Object.assign({
      loading: false, crossword: null, entries: new Map(), revealed: new Set(), wrong: new Set(),
      selected: null, across: true, solved: false, practice: false, title: '', wordPoints: 5,
      message: null, error: null
    }, extra);
  }

  save() { /* в наследниках */ }

  // Выбранное слово: в текущем направлении, а если в нём нет слова через эту клетку - в другом
  selectedSlot() {
    const { crossword: cw, selected: cell, across } = this.s;
    if (!cw || cell == null) return null;
    return cw.slots.find((x) => x.across === across && x.cells.includes(cell)) ||
      cw.slots.find((x) => x.cells.includes(cell)) || null;
  }

  maxPoints() { return (this.s.crossword ? this.s.crossword.slots.length : 0) * this.s.wordPoints; }

  select(cell) {
    const s = this.s;
    const cw = s.crossword;
    if (!cw || s.solved || cw.solution[rowOf(cell)][colOf(cell)] == null) return;
    const slots = cw.slots.filter((x) => x.cells.includes(cell));
    let across;
    // повторное нажатие на пересечение переключает направление
    if (cell === s.selected && slots.length > 1) across = !s.across;
    else if (slots.some((x) => x.across === s.across)) across = s.across;
    else across = slots[0].across;
    s.selected = cell; s.across = across; s.message = null;
  }

  selectSlot(slot) {
    const s = this.s;
    s.selected = slot.cells.find((k) => !s.entries.has(k)) ?? slot.cells[0];
    s.across = slot.across;
    s.message = null;
  }

  moveSlot(delta) {
    const slots = this.s.crossword ? this.s.crossword.slots : null;
    if (!slots) return;
    const i = slots.indexOf(this.selectedSlot());
    this.selectSlot(slots[(i + delta + slots.length) % slots.length]);
  }

  // Следующая или предыдущая клетка выбранного слова; на краю слова остаёмся на месте
  step(cell, delta) {
    const slot = this.selectedSlot();
    if (!slot) return cell;
    const i = slot.cells.indexOf(cell);
    const next = slot.cells[i + delta];
    return next === undefined ? cell : next;
  }

  type(letter) {
    const s = this.s;
    const cell = s.selected;
    if (cell == null || s.solved || !s.crossword) return;
    if (!s.revealed.has(cell)) s.entries.set(cell, letter);
    s.wrong.delete(cell);
    s.selected = this.step(cell, 1);
    s.message = null;
    this.complete();
    this.save();
  }

  backspace() {
    const s = this.s;
    const cell = s.selected;
    if (cell == null || s.solved) return;
    if (s.entries.has(cell) && !s.revealed.has(cell)) {
      s.entries.delete(cell);
      s.wrong.delete(cell);
    } else {
      // клетка пустая - шаг назад и стереть там
      const prev = this.step(cell, -1);
      s.selected = prev;
      if (!s.revealed.has(prev)) { s.entries.delete(prev); s.wrong.delete(prev); }
    }
    s.message = null;
    this.save();
  }

  check() {
    const s = this.s;
    const cw = s.crossword;
    if (!cw) return;
    s.wrong = new Set([...s.entries].filter(([k, ch]) => cw.solution[rowOf(k)][colOf(k)] !== ch).map(([k]) => k));
    s.message = s.wrong.size === 0 ? 'Ошибок нет' : 'Ошибок: ' + s.wrong.size + ' - они выделены красным';
  }

  // Подсказка: открыть букву в выбранной клетке за очки
  reveal() {
    const s = this.s;
    const cw = s.crossword;
    const cell = s.selected;
    if (!cw || cell == null) return;
    const right = cw.solution[rowOf(cell)][colOf(cell)];
    if (right == null || s.solved || s.entries.get(cell) === right || !Progress.spend(HINT_COST)) return;
    s.entries.set(cell, right);
    s.revealed.add(cell);
    s.wrong.delete(cell);
    s.selected = this.step(cell, 1);
    s.message = null;
    this.complete();
    this.save();
  }

  // Все клетки заполнены: если без ошибок - кроссворд решён, очки по числу слов
  complete() {
    const s = this.s;
    const cw = s.crossword;
    const all = new Set(cw.slots.flatMap((x) => x.cells));
    for (const k of all) if (!s.entries.has(k)) return;
    for (const k of all) {
      if (s.entries.get(k) !== cw.solution[rowOf(k)][colOf(k)]) {
        s.message = 'Все клетки заполнены, но есть ошибки. Нажмите «Проверить».';
        return;
      }
    }
    for (let i = 0; i < cw.slots.length; i++) Progress.addResult(s.wordPoints, s.wordPoints);
    s.solved = true;
    s.wrong = new Set();
    s.message = null;
  }

  selectFirst() {
    const first = this.s.crossword.slots[0];
    this.s.selected = cellKey(first.row, first.col);
    this.s.across = first.across;
  }
}

// «Кроссворд дня»: мини-кроссворд на сегодня и тренировочные
class DailyGame extends CrosswordGame {
  constructor() {
    super();
    this.pool = null;
    this.poolDate = null;
    this.loadDaily();
  }

  loadDaily() {
    const now = new Date();
    const date = todayStamp(now);
    this.load(date, false, 'Кроссворд на ' + now.getDate() + ' ' + MONTHS[now.getMonth()], date);
  }

  newPractice() {
    this.load(undefined, true, 'Тренировочный кроссворд', 0);
  }

  load(seed, practice, title, date) {
    this.s = this.blank({ loading: true, practice, title, wordPoints: DAILY_WORD_POINTS });
    const token = this.token = {};
    later(() => {
      if (this.token !== token) return;
      try {
        let words;
        if (practice) words = crosswordPool();
        else {
          if (this.poolDate !== date) { this.pool = crosswordPool(false); this.poolDate = date; }
          words = this.pool;
        }
        const crossword = generateMiniCrossword(words, seed);
        const alreadyCounted = !practice && Progress.getInt('daily_date', 0) === date &&
          Progress.getString('daily_sig') === crossword.signature;
        this.s = this.blank({ crossword, practice, title, wordPoints: DAILY_WORD_POINTS });
        this.selectFirst();
        if (!practice) this.restore(date);
        if (!alreadyCounted) Progress.markUsed(crossword.slots.map((x) => x.answer), crossword.slots.map((x) => x.puzzle.question));
      } catch (e) {
        console.error(e);
        this.s = this.blank({ practice, title, error: e.message });
      }
      render();
    });
  }

  // Кроссворд дня сохраняется, чтобы можно было закрыть и продолжить; тренировочный - нет
  save() {
    const s = this.s;
    if (!s.crossword || s.practice) return;
    Progress.putString('daily_sig', s.crossword.signature);
    Progress.putString('daily_entries', encodeCells(s.entries));
    Progress.putString('daily_revealed', encodeSet(s.revealed));
    Progress.putBool('daily_solved', s.solved);
  }

  restore(date) {
    const s = this.s;
    if (Progress.getInt('daily_date', 0) !== date || Progress.getString('daily_sig') !== s.crossword.signature) {
      // новый день или новый словарь - начинаем с чистого листа
      Progress.putInt('daily_date', date);
      Progress.putString('daily_sig', s.crossword.signature);
      Progress.putString('daily_entries', '');
      Progress.putString('daily_revealed', '');
      Progress.putBool('daily_solved', false);
      return;
    }
    s.entries = decodeCells(Progress.getString('daily_entries'));
    s.revealed = decodeSet(Progress.getString('daily_revealed'));
    s.solved = Progress.getBool('daily_solved', false);
  }
}

// «Кроссворд»: шаблон CrossMaster, заполненный решателем из словаря (решатель - в solver.js)
const FIELD = '\u001F';
const RECORD = '\u001E';

class BigGame extends CrosswordGame {
  constructor() {
    super();
    this.setup = {
      visible: false,
      level: Math.min(2, Math.max(0, Progress.getInt('big_level', 0))),
      size: Math.min(2, Math.max(0, Progress.getInt('big_size', 1))),
      generating: false,
      error: null
    };
    this.worker = null;
    this.requestId = 0;
    const restored = this.restore();
    this.s = restored || this.blank();
    if (!restored) this.setup.visible = true;
  }

  // После «Начать заново»: начатого кроссворда больше нет - сразу выбор нового
  clear() {
    this.s = this.blank();
    Object.assign(this.setup, { visible: true, generating: false, error: null });
    this.requestId++;
  }

  showSetup(visible) {
    if (!visible && !this.s.crossword) return;
    this.setup.visible = visible;
    this.setup.error = null;
  }

  setLevel(level) { Progress.putInt('big_level', level); this.setup.level = level; }
  setSize(size) { Progress.putInt('big_size', size); this.setup.size = size; }

  generate() {
    const setup = this.setup;
    if (setup.generating) return;
    setup.generating = true;
    setup.error = null;
    const level = setup.level;
    const size = GRID_SIZES[setup.size];
    const id = ++this.requestId;
    const fail = (text) => {
      if (id !== this.requestId) return;
      setup.generating = false;
      setup.error = text;
      render();
    };
    if (!this.worker) {
      try {
        this.worker = new Worker('solver.js');
        this.worker.postMessage(Object.assign({ type: 'init' }, lexiconWords()));
      } catch (e) {
        console.error(e);
        this.worker = null;
        fail('Не удалось запустить подбор слов: ' + e.message);
        return;
      }
    }
    const usage = {};
    for (const [k, v] of Progress.answerUsage()) usage[k] = v;
    const templates = rnd.shuffle(Dict.templates.filter((t) => t.rows >= size.minRows && t.rows <= size.maxRows && t.slots.length));
    this.worker.onerror = (e) => { console.error(e); fail('Ошибка подбора слов'); };
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== this.requestId) return;
      if (!m.answers) { fail('Не удалось составить кроссворд. Попробуйте ещё раз или выберите другой размер.'); return; }
      this.finish(m, templates, level, fail);
    };
    this.worker.postMessage({ type: 'solve', id, usage, level, templates: templates.slice(0, 6) });
  }

  finish(m, templates, level, fail) {
    const template = templates[m.index];
    if (!template) { fail('Ошибка подбора слов'); return; }
    const target = [1, 3, 4][level];
    const found = clues(m.answers, target);
    if (m.answers.some((a) => !found.has(a))) { fail('Не удалось составить кроссворд. Попробуйте ещё раз.'); return; }
    const slots = numberSlots(template.slots.map((x, i) => ({ across: x.across, row: x.row, col: x.col, puzzle: found.get(m.answers[i]) })));
    const crossword = makeCrossword(template.rows, template.cols, slots);
    Progress.markUsed(slots.map((x) => x.answer), slots.map((x) => x.puzzle.question));
    const title = LEVELS[level].title + ' · ' + crossword.rows + '×' + crossword.cols + ', слов: ' + slots.length;
    this.s = this.blank({ crossword, title, wordPoints: LEVEL_POINTS[level] });
    this.selectFirst();
    Progress.putInt('big_points', LEVEL_POINTS[level]);
    Progress.putString('big_title', title);
    this.save();
    Object.assign(this.setup, { visible: false, generating: false });
    if (current === 'big') bigScrollTop = true;
    render();
  }

  // Начатый кроссворд хранится целиком: решать большой можно в несколько заходов
  save() {
    const s = this.s;
    const cw = s.crossword;
    if (!cw) return;
    Progress.putString('big_crossword', cw.rows + ',' + cw.cols + RECORD + cw.slots.map((x) =>
      [x.number, x.across ? 1 : 0, x.row, x.col, x.answer, x.puzzle.question, x.puzzle.category].join(FIELD)).join(RECORD));
    Progress.putString('big_entries', encodeCells(s.entries));
    Progress.putString('big_revealed', encodeSet(s.revealed));
    Progress.putBool('big_solved', s.solved);
  }

  restore() {
    try {
      const text = Progress.getString('big_crossword');
      if (!text) return null;
      const records = text.split(RECORD);
      const [rows, cols] = records[0].split(',').map(Number);
      const slots = records.slice(1).map((r) => {
        const f = r.split(FIELD);
        return makeSlot(+f[0], f[1] === '1', +f[2], +f[3], { answer: f[4], question: f[5], category: f[6] });
      });
      const s = this.blank({
        crossword: makeCrossword(rows, cols, slots),
        title: Progress.getString('big_title'),
        wordPoints: Progress.getInt('big_points', 5),
        entries: decodeCells(Progress.getString('big_entries')),
        revealed: decodeSet(Progress.getString('big_revealed')),
        solved: Progress.getBool('big_solved', false)
      });
      this.s = s;
      this.selectFirst();
      return s;
    } catch (e) {
      console.error(e);
      return null;
    }
  }
}

// ==================== филворд ====================

// Классический филворд (FilwordGenerator.kt): поле без пустых клеток, каждое слово идёт «змейкой».
// Через всё поле - один случайный путь, он режется на куски по 3-8 клеток, в каждый встаёт слово.
function generateFilword(size, wordsByLength) {
  const random = makeRandom();

  // Гамильтонов путь: начинаем со змейки и много раз «откусываем» конец (backbite)
  const path = [];
  for (let r = 0; r < size; r++) {
    for (let i = 0; i < size; i++) path.push(cellKey(r, r % 2 === 0 ? i : size - 1 - i));
  }
  for (let k = 0; k < size * size * 30; k++) {
    if (random.bool()) path.reverse();
    const end = path[path.length - 1];
    const er = rowOf(end), ec = colOf(end);
    const neighbours = [[er - 1, ec], [er + 1, ec], [er, ec - 1], [er, ec + 1]]
      .filter(([r, c]) => r >= 0 && r < size && c >= 0 && c < size)
      .map(([r, c]) => cellKey(r, c))
      .filter((n) => n !== path[path.length - 2]);
    const n = random.pick(neighbours);
    const i = path.indexOf(n);
    // соседняя клетка на пути: переворачиваем хвост после неё - путь остаётся непрерывным
    const tail = path.splice(i + 1).reverse();
    path.push(...tail);
  }

  // Длины слов от 3 до 8, в сумме - все клетки поля; чаще 4-7
  const lengths = [];
  let left = path.length;
  while (left > 0) {
    if (left <= 8) { lengths.push(left); break; }
    const options = [3, 4, 5, 6, 7, 8].filter((l) => left - l >= 3 && (wordsByLength.get(l) || []).length);
    const preferred = options.filter((l) => l >= 4 && l <= 7);
    const len = random.pick(preferred.length ? preferred : options);
    lengths.push(len);
    left -= len;
  }

  const used = new Set();
  const words = [];
  let start = 0;
  for (const len of random.shuffle(lengths)) {
    const puzzle = leastUsedPuzzle((wordsByLength.get(len) || []).filter((p) => !used.has(p.answer)), random);
    if (!puzzle) throw new Error('Не хватает слов из ' + len + ' букв');
    used.add(puzzle.answer);
    words.push({ puzzle, cells: path.slice(start, start + len) });
    start += len;
  }
  const letters = new Map();
  for (const w of words) w.cells.forEach((k, i) => letters.set(k, w.puzzle.answer[i]));
  return { size, letters, words };
}

class FilwordGame {
  constructor() {
    this.level = Math.min(2, Math.max(0, Progress.getInt('filword_level', 0)));
    const saved = Progress.getInt('filword_category', 0);
    this.category = Dict.categoryList.find((c) => c.id === saved) || null;
    this.newGame();
  }

  get size() { return [6, 7, 8][this.level]; }
  get wordPoints() { return LEVEL_POINTS[this.level]; }
  get solved() { return !!this.fw && this.found.length === this.fw.words.length; }

  newGame() {
    this.loading = true;
    this.fw = null;
    this.found = [];      // номера найденных слов по порядку нахождения (для цвета)
    this.path = [];       // клетки, по которым сейчас ведут пальцем
    this.hinted = new Set();
    this.message = null;
    this.error = null;
    const token = this.token = {};
    later(() => {
      if (this.token !== token) return;
      try {
        const pool = filwordPool(this.level, this.category ? this.category.id : 0);
        this.fw = generateFilword(this.size, pool);
        Progress.markUsed(this.fw.words.map((w) => w.puzzle.answer), this.fw.words.map((w) => w.puzzle.question));
      } catch (e) {
        console.error(e);
        this.error = e.message;
      }
      this.loading = false;
      render();
    });
  }

  setLevel(level) {
    if (level === this.level) return;
    Progress.putInt('filword_level', level);
    this.level = level;
    this.newGame();
  }

  setCategory(category) {
    Progress.putInt('filword_category', category ? category.id : 0);
    this.category = category;
    this.newGame();
  }

  foundCells() {
    const set = new Set();
    for (const i of this.found) this.fw.words[i].cells.forEach((k) => set.add(k));
    return set;
  }

  // Палец коснулся клетки - начало выделения (найденные клетки не выделяются)
  startPath(cell) {
    if (!this.fw || this.solved || this.foundCells().has(cell)) return;
    this.path = [cell];
    this.message = null;
  }

  // Палец перешёл в клетку: соседняя - добавляем, предыдущая - шаг назад
  extendPath(cell) {
    const path = this.path;
    if (!path.length || cell === path[path.length - 1]) return;
    if (path.length >= 2 && cell === path[path.length - 2]) { path.pop(); return; }
    const last = path[path.length - 1];
    const adjacent = Math.abs(rowOf(cell) - rowOf(last)) + Math.abs(colOf(cell) - colOf(last)) === 1;
    if (adjacent && !path.includes(cell) && !this.foundCells().has(cell)) path.push(cell);
  }

  // Палец отпущен: выделение совпало с ненайденным словом - слово найдено
  endPath() {
    const path = this.path;
    this.path = [];
    if (!this.fw || path.length < 2) return;
    const index = this.fw.words.findIndex((w, i) => !this.found.includes(i) &&
      w.cells.length === path.length && w.cells.every((k, j) => k === path[j]));
    if (index >= 0) {
      Progress.addResult(this.wordPoints, this.wordPoints);
      this.found.push(index);
      this.message = null;
    } else {
      this.message = '«' + path.map((k) => this.fw.letters.get(k)).join('') + '» - не то слово или не тот путь';
    }
  }

  // Подсказка: первая буква одного из ненайденных слов
  hint() {
    if (!this.fw) return;
    const candidates = this.fw.words.map((w, i) => i)
      .filter((i) => !this.found.includes(i) && !this.hinted.has(this.fw.words[i].cells[0]));
    if (!candidates.length || !Progress.spend(HINT_COST)) return;
    this.hinted.add(this.fw.words[rnd.pick(candidates)].cells[0]);
    this.message = null;
  }
}

// ==================== «Угадай слово» ====================

class GuessGame {
  constructor() {
    this.level = Math.min(2, Math.max(0, Progress.getInt('guess_level', 0)));
    this.humorOnly = Progress.getBool('guess_humor', false);
    this.next();
  }

  get finished() { return this.result != null; }
  // 10 за слово + по 2 за каждую оставшуюся попытку + бонус уровня (для шуточных вопросов бонуса нет)
  get potential() { return 10 + (MAX_MISTAKES - this.mistakes) * 2 + (this.humorOnly ? 0 : LEVELS[this.level].bonus); }
  get maxPoints() { return 10 + MAX_MISTAKES * 2 + (this.humorOnly ? 0 : LEVELS[this.level].bonus); }

  next() {
    this.loading = true;
    this.puzzle = null;
    this.opened = new Set();
    this.tried = new Set();
    this.mistakes = 0;
    this.result = null;
    this.earned = 0;
    this.error = null;
    const token = this.token = {};
    later(() => {
      if (this.token !== token) return;
      try { this.puzzle = randomPuzzle(this.level, this.humorOnly); } catch (e) { this.error = e.message; }
      this.loading = false;
      render();
    });
  }

  // Выбор уровня выключает режим «С юмором»
  setLevel(level) {
    if (level === this.level && !this.humorOnly) return;
    Progress.putInt('guess_level', level);
    Progress.putBool('guess_humor', false);
    this.level = level;
    this.humorOnly = false;
    this.next();
  }

  setHumor(value) {
    Progress.putBool('guess_humor', value);
    this.humorOnly = value;
    this.next();
  }

  press(letter) {
    if (!this.puzzle || this.finished || this.tried.has(letter)) return;
    const answer = this.puzzle.answer;
    this.tried.add(letter);
    const positions = [];
    for (let i = 0; i < answer.length; i++) if (answer[i] === letter) positions.push(i);
    if (!positions.length) {
      this.mistakes++;
      if (this.mistakes >= MAX_MISTAKES) {
        Progress.addResult(0, this.maxPoints);
        this.result = 'lost';
        for (let i = 0; i < answer.length; i++) this.opened.add(i);
      }
    } else this.open(positions);
  }

  // Открывает случайную закрытую букву (все её вхождения) за очки
  hint() {
    if (!this.puzzle || this.finished) return;
    const answer = this.puzzle.answer;
    const closed = [];
    for (let i = 0; i < answer.length; i++) if (!this.opened.has(i)) closed.push(i);
    if (!closed.length || !Progress.spend(HINT_COST)) return;
    const letter = answer[rnd.pick(closed)];
    this.tried.add(letter);
    const positions = [];
    for (let i = 0; i < answer.length; i++) if (answer[i] === letter) positions.push(i);
    this.open(positions);
  }

  open(positions) {
    positions.forEach((i) => this.opened.add(i));
    if (this.opened.size < this.puzzle.answer.length) return;
    this.earned = this.potential;
    Progress.addResult(this.earned, this.maxPoints);
    this.result = 'won';
  }
}

// ==================== «Викторина» ====================

class QuizGame {
  constructor() {
    this.level = Math.min(2, Math.max(0, Progress.getInt('quiz_level', 0)));
    this.humorOnly = Progress.getBool('quiz_humor', false);
    const saved = Progress.getInt('quiz_category', 0);
    this.category = Dict.categoryList.find((c) => c.id === saved) || null;
    this.newRound();
  }

  // За верный ответ: лёгкий 5, средний 7, сложный 10, шуточные 5
  get points() { return this.humorOnly ? 5 : LEVEL_POINTS[this.level]; }
  get answered() { return this.chosen != null; }

  newRound() {
    this.number = 1;
    this.correct = 0;
    this.roundEarned = 0;
    this.roundFinished = false;
    this.load();
  }

  load() {
    this.loading = true;
    this.item = null;
    this.chosen = null;
    this.hidden = new Set();
    this.error = null;
    const token = this.token = {};
    later(() => {
      if (this.token !== token) return;
      try {
        this.item = quizItem(this.level, this.humorOnly, this.category ? this.category.id : 0);
      } catch (e) {
        console.error(e);
        this.error = this.category
          ? 'В теме «' + this.category.name + '» нет вопросов этого уровня. Выберите другую тему или уровень.'
          : e.message;
      }
      this.loading = false;
      render();
    });
  }

  next() {
    if (!this.answered) return;
    if (this.number >= QUIZ_ROUND) { this.roundFinished = true; return; }
    this.number++;
    this.load();
  }

  answer(option) {
    if (!this.item || this.answered || this.hidden.has(option)) return;
    const right = option === this.item.puzzle.answer;
    const earned = right ? this.points : 0;
    Progress.addResult(earned, this.points);
    this.chosen = option;
    if (right) this.correct++;
    this.roundEarned += earned;
  }

  // 50/50: убирает два неверных варианта за очки
  fifty() {
    if (!this.item || this.answered || this.hidden.size || !Progress.spend(FIFTY_COST)) return;
    const wrong = this.item.options.filter((o) => o !== this.item.puzzle.answer);
    this.hidden = new Set(rnd.shuffle(wrong).slice(0, 2));
  }

  setLevel(level) {
    if (level === this.level && !this.humorOnly) return;
    Progress.putInt('quiz_level', level);
    Progress.putBool('quiz_humor', false);
    this.level = level;
    this.humorOnly = false;
    this.newRound();
  }

  setHumor(value) {
    Progress.putBool('quiz_humor', value);
    this.humorOnly = value;
    this.newRound();
  }

  setCategory(category) {
    Progress.putInt('quiz_category', category ? category.id : 0);
    this.category = category;
    this.newRound();
  }
}

// ==================== экран ====================

const $app = document.getElementById('app');
const $dialog = document.getElementById('dialog-root');

let current = 'home';
const games = {};
let bigScrollTop = false;
const scrollMemory = {};

function game(name) {
  if (!games[name]) {
    games[name] = name === 'guess' ? new GuessGame()
      : name === 'quiz' ? new QuizGame()
      : name === 'daily' ? new DailyGame()
      : name === 'big' ? new BigGame()
      : new FilwordGame();
  }
  return games[name];
}

// Тяжёлый подбор слов - после того как экран успел показать «загрузку»
function later(fn) { setTimeout(fn, 30); }

const ICONS = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  bulb: '<svg viewBox="0 0 24 24"><path d="M9 21c0 .55.45 1 1 1h4c.55 0 1-.45 1-1v-1H9v1zm3-19C8.14 2 5 5.14 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.86-3.14-7-7-7z"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
  heartEmpty: '<svg viewBox="0 0 24 24"><path d="M16.5 3c-1.74 0-3.41.81-4.5 2.09C10.91 3.81 9.24 3 7.5 3 4.42 3 2 5.42 2 8.5c0 3.78 3.4 6.86 8.55 11.54L12 21.35l1.45-1.32C18.6 15.36 22 12.28 22 8.5 22 5.42 19.58 3 16.5 3zm-4.4 15.55-.1.1-.1-.1C7.14 14.24 4 11.39 4 8.5 4 6.5 5.5 5 7.5 5c1.54 0 3.04.99 3.57 2.36h1.87C13.46 5.99 14.96 5 16.5 5c2 0 3.5 1.5 3.5 3.5 0 2.89-3.14 5.74-7.9 10.05z"/></svg>',
  left: '<svg viewBox="0 0 24 24"><path d="M15.41 16.59 10.83 12l4.58-4.59L14 6l-6 6 6 6z"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>',
  backspace: '<svg viewBox="0 0 24 24"><path d="M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-3 12.59L17.59 17 14 13.41 10.41 17 9 15.59 12.59 12 9 8.41 10.41 7 14 10.59 17.59 7 19 8.41 15.41 12 19 15.59z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  topic: '<svg viewBox="0 0 24 24"><path d="M12 2l-5.5 9h11z"/><circle cx="17.5" cy="17.5" r="4.5"/><path d="M3 13.5h8v8H3z"/></svg>',
  drop: '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>',
  restart: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>',
  // значки режимов
  guess: '<svg viewBox="0 0 24 24"><rect x="2" y="8" width="6" height="8" rx="1.2"/><rect x="9" y="8" width="6" height="8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="16" y="8" width="6" height="8" rx="1.2"/></svg>',
  quiz: '<svg viewBox="0 0 24 24"><path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-5.99 13c-.59 0-1.05-.47-1.05-1.05 0-.59.47-1.04 1.05-1.04.59 0 1.04.45 1.04 1.04 0 .58-.44 1.05-1.04 1.05zm2.5-6.17c-.63.93-1.23 1.21-1.56 1.81-.13.24-.18.4-.18 1.18h-1.52c0-.41-.06-1.08.26-1.65.41-.73 1.18-1.16 1.63-1.8.48-.68.21-1.94-1.14-1.94-.88 0-1.32.67-1.5 1.23l-1.37-.57C11.51 5.96 12.52 5 13.99 5c1.23 0 2.08.56 2.51 1.26.37.61.58 1.73.01 2.57z"/></svg>',
  daily: '<svg viewBox="0 0 24 24"><path d="M19 4h-1V2h-2v2H8V2H6v2H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 16H5V10h14v10zM9 14H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2zm-8 4H7v-2h2v2zm4 0h-2v-2h2v2zm4 0h-2v-2h2v2z"/></svg>',
  big: '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM8 20H4v-4h4v4zm0-6H4v-4h4v4zm0-6H4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4zm6 12h-4v-4h4v4zm0-6h-4v-4h4v4zm0-6h-4V4h4v4z"/></svg>',
  filword: '<svg viewBox="0 0 24 24"><path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z"/></svg>'
};

function scoreBadge() {
  return '<div class="score">Запас: <span class="star">' + ICONS.star + '</span><b>' + Progress.score() + '</b></div>';
}

function topBar(title) {
  return '<div class="topbar"><div class="topbar-inner">' +
    '<button class="icon-btn" data-act="home" aria-label="Назад">' + ICONS.back + '</button>' +
    '<div class="topbar-title">' + esc(title) + '</div>' + scoreBadge() + '</div></div>';
}

function spinner() { return '<div class="center-box"><div class="spinner"></div></div>'; }

function segments(items, selectedIndex, act, extra = '') {
  return '<div class="segments">' + items.map((title, i) =>
    '<button class="segment' + (i === selectedIndex ? ' on' : '') + '" data-act="' + act + '" data-v="' + i + '">' + esc(title) + '</button>'
  ).join('') + extra + '</div>';
}

// Выбор уровня - общий для всех режимов; для шуточных вопросов уровни выключены
function levelChips(level, humorOnly, showHumor) {
  const humor = showHumor
    ? '<button class="segment' + (humorOnly ? ' on' : '') + '" data-act="humor">С юмором</button>' : '';
  return segments(LEVELS.map((l) => l.title), humorOnly ? -1 : level, 'level', humor);
}

function topicPicker(category) {
  return '<button class="outlined topic" data-act="topic">' + '<span class="ic brand">' + ICONS.topic + '</span>' +
    'Тема: ' + esc(category ? category.name : 'все темы') + '<span class="ic muted">' + ICONS.drop + '</span></button>';
}

function questionCard(category, question) {
  return '<div class="card question-card"><div class="caption">' + esc(category.toUpperCase()) + '</div>' +
    '<div class="question">' + esc(question) + '</div></div>';
}

function pointsCard(lines) {
  return '<div class="card points">' + lines.map(([label, value]) =>
    '<div class="points-line"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>').join('') + '</div>';
}

function totalsLines() {
  return [['Набрано всего', Progress.earned() + ' из ' + Progress.possible()], ['Угадано слов', String(Progress.solved())]];
}

function hintButton(act, text, enabled) {
  return '<button class="outlined" data-act="' + act + '"' + (enabled ? '' : ' disabled') + '>' +
    '<span class="ic gold">' + ICONS.bulb + '</span>' + esc(text) + '</button>';
}

function contentWidth() { return Math.min(window.innerWidth, 600); }

// ----- главный экран -----

function renderHome() {
  let status = '';
  if (Dict.error) {
    status = '<div class="card error-card">Не удалось открыть словарь: ' + esc(Dict.error) +
      '<br><button class="btn" data-act="retry">Повторить</button></div>';
  } else if (!Dict.ready) {
    status = '<div class="card loading-card"><div class="spinner small"></div><div id="load-text">' + loadingText() + '</div></div>';
  }
  const modes = [
    ['guess', 'Угадай слово', 'Вопрос и пустые клетки — открывайте буквы'],
    ['quiz', 'Викторина', 'Вопрос и четыре варианта ответа'],
    ['daily', 'Кроссворд дня', 'Новый мини-кроссворд каждый день'],
    ['big', 'Кроссворд', 'Классический по шаблонам'],
    ['filword', 'Филворд', 'Найдите слова-змейки в поле из букв']
  ];
  return '<div class="screen">' +
    '<div class="home-header"><div class="home-header-inner"><div class="home-title">' +
    '<div class="brand-name">СловоМастер</div><div class="brand-sub">Кроссворды и загадки</div>' +
    '<div class="brand-by">By Zakir Veliyev</div></div>' +
    '<div class="home-stats">' + scoreBadge() +
    '<div>Набрано: ' + Progress.earned() + ' из ' + Progress.possible() + '</div>' +
    '<div>Угадано слов: ' + Progress.solved() + '</div></div></div></div>' +
    '<div class="scroll"><div class="content">' + status +
    modes.map(([id, title, sub]) =>
      '<button class="card mode' + (Dict.ready ? '' : ' disabled') + '" data-act="open" data-v="' + id + '">' +
      '<span class="mode-icon">' + ICONS[id] + '</span>' +
      '<span class="mode-text"><span class="mode-title">' + title + '</span><span class="mode-sub">' + sub + '</span></span>' +
      '<span class="mode-play">' + ICONS.play + '</span></button>').join('') +
    '<button class="text-btn restart" data-act="reset"><span class="ic muted">' + ICONS.restart + '</span>Начать заново</button>' +
    '</div></div></div>';
}

function loadingText() {
  return Dict.loadedMb > 0
    ? 'Загружаю словарь… ' + Dict.loadedMb.toFixed(1) + ' из ~13 МБ<br><small>Только при первом запуске</small>'
    : 'Открываю словарь…';
}

function updateLoading() {
  const el = document.getElementById('load-text');
  if (el) el.innerHTML = loadingText();
}

// ----- «Угадай слово» -----

function renderGuess() {
  const g = game('guess');
  let body = levelChips(g.level, g.humorOnly, true);
  let keyboard = '';
  if (g.loading) body += spinner();
  else if (g.error) body += '<div class="error">Ошибка: ' + esc(g.error) + '</div>';
  else if (g.puzzle) {
    const answer = g.puzzle.answer;
    const gap = 4;
    const cell = Math.min(44, (contentWidth() - 32 - gap * (answer.length - 1)) / answer.length);
    body += questionCard(g.puzzle.category, g.puzzle.question);
    body += '<div class="letters" style="gap:' + gap + 'px">' + [...answer].map((ch, i) => {
      const open = g.opened.has(i);
      // после проигрыша неотгаданные буквы показываем красным
      const missed = g.result === 'lost' && open && !g.tried.has(ch);
      return '<div class="letter' + (open ? ' open' : '') + (missed ? ' missed' : '') + '" style="width:' + cell + 'px;height:' + cell +
        'px;font-size:' + (cell * 0.55) + 'px">' + (open ? ch : '') + '</div>';
    }).join('') + '</div>';
    let hearts = '';
    for (let i = 0; i < MAX_MISTAKES; i++) {
      const alive = i < MAX_MISTAKES - g.mistakes;
      hearts += '<span class="heart' + (alive ? '' : ' dead') + '">' + (alive ? ICONS.heart : ICONS.heartEmpty) + '</span>';
    }
    body += '<div class="row">' + hearts + '<span class="grow"></span>' +
      hintButton('hint', 'Подсказка (' + HINT_COST + ' очков)', !g.finished && Progress.score() >= HINT_COST) + '</div>';
    if (g.finished) {
      const won = g.result === 'won';
      body += '<div class="card result ' + (won ? 'won' : 'lost') + '"><div class="result-text">' +
        (won ? 'Верно! +' + g.earned + ' из ' + g.maxPoints + ' очков' : 'Не угадали. Ответ: ' + esc(answer)) +
        '</div><button class="btn" data-act="next">Следующее слово</button></div>';
    }
    const lines = g.finished ? [] : [['За это слово', 'до ' + g.potential + ' из ' + g.maxPoints]];
    body += pointsCard(lines.concat(totalsLines()));
    keyboard = '<div class="keyboard">' + KEYBOARD_ROWS.map((row) => '<div class="kb-row">' + [...row].map((ch) => {
      const tried = g.tried.has(ch);
      const cls = tried ? (answer.includes(ch) ? ' hit' : ' miss') : '';
      return '<button class="key' + cls + '" data-act="key" data-v="' + ch + '"' + (tried || g.finished ? ' disabled' : '') + '>' + ch + '</button>';
    }).join('') + '</div>').join('') + '</div>';
  }
  return '<div class="screen">' + topBar('Угадай слово') + '<div class="scroll"><div class="content">' + body +
    '</div></div>' + keyboard + '</div>';
}

// ----- «Викторина» -----

function renderQuiz() {
  const q = game('quiz');
  let body = levelChips(q.level, q.humorOnly, true) + '<div>' + topicPicker(q.category) + '</div>';
  if (q.roundFinished) {
    body += '<div class="card round-result"><div class="round-title">Раунд окончен</div>' +
      '<div>Верных ответов: ' + q.correct + ' из ' + QUIZ_ROUND + '</div>' +
      '<div class="gold-text">Очков: +' + q.roundEarned + ' из ' + QUIZ_ROUND * q.points + '</div>' +
      '<button class="btn" data-act="round">Новый раунд</button></div>';
  } else if (q.loading) body += spinner();
  else if (q.error) body += '<div class="error">' + esc(q.error) + '</div>';
  else if (q.item) {
    const answer = q.item.puzzle.answer;
    body += '<div class="muted small">Вопрос ' + q.number + ' из ' + QUIZ_ROUND + ' · верно: ' + q.correct + '</div>';
    body += questionCard(q.item.puzzle.category, q.item.puzzle.question);
    body += q.item.options.map((option, i) => {
      let cls = '';
      let mark = '';
      if (q.answered) {
        if (option === answer) { cls = ' right'; mark = ICONS.check; }
        else if (option === q.chosen) { cls = ' wrong'; mark = ICONS.close; }
        else cls = ' dim';
      }
      if (q.hidden.has(option)) cls += ' hidden';
      return '<button class="option' + cls + '" data-act="answer" data-v="' + i + '"' +
        (q.answered || q.hidden.has(option) ? ' disabled' : '') + '><span>' + esc(option) + '</span>' +
        (mark ? '<span class="ic">' + mark + '</span>' : '') + '</button>';
    }).join('');
    body += '<div class="row"><button class="outlined" data-act="fifty"' +
      (!q.answered && !q.hidden.size && Progress.score() >= FIFTY_COST ? '' : ' disabled') + '>50/50 (' + FIFTY_COST + ' очков)</button>' +
      '<span class="grow"></span>' +
      (q.answered ? '<button class="btn" data-act="next">' + (q.number >= QUIZ_ROUND ? 'Итоги' : 'Дальше') + '</button>' : '') + '</div>';
  }
  body += pointsCard([['За верный ответ', String(q.points)]].concat(totalsLines()));
  return '<div class="screen">' + topBar('Викторина') + '<div class="scroll"><div class="content">' + body + '</div></div></div>';
}

// ----- кроссворды -----

function clueBar(g) {
  const slot = g.selectedSlot();
  if (!slot) return '';
  return '<div class="card clue-bar">' +
    '<button class="icon-btn brand" data-act="prev-slot" aria-label="Предыдущее слово">' + ICONS.left + '</button>' +
    '<div class="clue-text"><div class="caption">' + esc((slot.number + ' ' + (slot.across ? 'по горизонтали' : 'по вертикали') +
      (slot.puzzle.category ? ' · ' + slot.puzzle.category : '')).toUpperCase()) + '</div>' +
    '<div class="clue-question">' + esc(slot.puzzle.question) + '</div></div>' +
    '<button class="icon-btn brand" data-act="next-slot" aria-label="Следующее слово">' + ICONS.right + '</button></div>';
}

function crosswordCellSize(cw) {
  const width = contentWidth() - 24;
  // Клетки до 42px. Если сетка помещается в экран при клетке от 24px - показываем её целиком;
  // шаблоны шире не сжимаем мельче 30px - они прокручиваются вбок.
  const fit = Math.floor(width / cw.cols);
  return fit >= 24 ? Math.min(42, fit) : Math.max(30, fit);
}

function crosswordGrid(g) {
  const s = g.s;
  const cw = s.crossword;
  const slot = g.selectedSlot();
  const slotCells = new Set(slot ? slot.cells : []);
  const cell = crosswordCellSize(cw);
  // Пустая клетка внутри фигуры - чёрная, как в настоящих кроссвордах
  const rowSpan = [], colSpan = [];
  for (let r = 0; r < cw.rows; r++) {
    let a = -1, b = -1;
    for (let c = 0; c < cw.cols; c++) if (cw.solution[r][c] != null) { if (a < 0) a = c; b = c; }
    rowSpan.push([a, b]);
  }
  for (let c = 0; c < cw.cols; c++) {
    let a = -1, b = -1;
    for (let r = 0; r < cw.rows; r++) if (cw.solution[r][c] != null) { if (a < 0) a = r; b = r; }
    colSpan.push([a, b]);
  }
  const numbers = new Map();
  for (const x of cw.slots) numbers.set(cellKey(x.row, x.col), x.number);
  let html = '<div class="grid-wrap" id="grid-wrap"><div class="cw-grid" style="grid-template-columns:repeat(' + cw.cols + ',' + cell +
    'px);grid-auto-rows:' + cell + 'px;--num:' + (cell * 0.24) + 'px;--let:' + (cell * 0.5) + 'px">';
  for (let r = 0; r < cw.rows; r++) {
    for (let c = 0; c < cw.cols; c++) {
      const answer = cw.solution[r][c];
      if (answer == null) {
        const inside = c >= rowSpan[r][0] && c <= rowSpan[r][1] && r >= colSpan[c][0] && r <= colSpan[c][1];
        html += '<div class="' + (inside ? 'cw-block' : 'cw-none') + '"></div>';
        continue;
      }
      const k = cellKey(r, c);
      let cls = 'cw-cell';
      if (s.solved) cls += ' solved';
      else if (k === s.selected) cls += ' sel';
      else if (slotCells.has(k)) cls += ' in-slot';
      const ch = s.entries.get(k);
      let letterCls = 'cw-letter';
      if (s.wrong.has(k)) letterCls += ' wrong';
      else if (s.revealed.has(k)) letterCls += ' revealed';
      else if (s.solved) letterCls += ' ok';
      const number = numbers.get(k);
      html += '<div class="' + cls + '" data-act="cell" data-v="' + k + '">' +
        (number ? '<span class="cw-num">' + number + '</span>' : '') +
        (ch ? '<span class="' + letterCls + '">' + ch + '</span>' : '') + '</div>';
    }
  }
  return html + '</div></div>';
}

function clueList(g) {
  const s = g.s;
  const cw = s.crossword;
  const selected = g.selectedSlot();
  let html = '<div class="card clue-list">';
  for (const [across, title] of [[true, 'По горизонтали'], [false, 'По вертикали']]) {
    html += '<div class="clue-head">' + title + '</div>';
    cw.slots.forEach((slot, i) => {
      if (slot.across !== across) return;
      // слово заполнено целиком - вопрос красным жирным, как найденные слова в филворде
      const filled = slot.cells.every((k) => s.entries.has(k));
      const cls = 'clue' + (filled ? ' filled' : '') + (slot === selected && !s.solved ? ' current' : '');
      html += '<div class="' + cls + '" data-act="slot" data-v="' + i + '">' + slot.number + '. ' + esc(slot.puzzle.question) +
        ' (' + slot.length + ')</div>';
    });
  }
  return html + '</div>';
}

function solvedCard(g, act, text) {
  return '<div class="card result won"><div class="result-text">Кроссворд решён!</div>' +
    '<div>Слов: ' + g.s.crossword.slots.length + ' · очков: +' + g.maxPoints() + '</div>' +
    '<button class="btn" data-act="' + act + '">' + text + '</button></div>';
}

function crosswordTools(g) {
  return '<div class="row"><button class="outlined" data-act="check">Проверить</button>' +
    hintButton('reveal', 'Буква (' + HINT_COST + ' очков)', Progress.score() >= HINT_COST) + '</div>';
}

function messageLine(text) {
  return text ? '<div class="message' + (text === 'Ошибок нет' ? ' good' : '') + '">' + esc(text) + '</div>' : '';
}

function ruKeyboard() {
  return '<div class="keyboard">' + KEYBOARD_ROWS.map((row, i) => '<div class="kb-row">' +
    [...row].map((ch) => '<button class="key" data-act="type" data-v="' + ch + '">' + ch + '</button>').join('') +
    (i === KEYBOARD_ROWS.length - 1 ? '<button class="key wide" data-act="erase" aria-label="Стереть">' + ICONS.backspace + '</button>' : '') +
    '</div>').join('') + '</div>';
}

function renderDaily() {
  const g = game('daily');
  const s = g.s;
  let body = '<div class="row"><div class="cw-title grow">' + esc(s.title) + '</div>' +
    (s.practice ? '<button class="text-btn" data-act="to-daily">К кроссворду дня</button>' : '') + '</div>';
  let keyboard = '';
  if (s.loading) body += spinner();
  else if (s.error) body += '<div class="error">Ошибка: ' + esc(s.error) + '</div>';
  else if (s.crossword) {
    body += s.solved ? solvedCard(g, 'practice', 'Ещё кроссворд') : clueBar(g);
    body += crosswordGrid(g);
    if (!s.solved) body += crosswordTools(g);
    body += messageLine(s.message) + clueList(g);
    if (!s.solved) keyboard = ruKeyboard();
  }
  return '<div class="screen">' + topBar('Кроссворд дня') + '<div class="scroll"><div class="content tight">' + body +
    '</div></div>' + keyboard + '</div>';
}

function renderBig() {
  const g = game('big');
  const s = g.s;
  const setup = g.setup;
  let body = '';
  let keyboard = '';
  if (setup.visible || !s.crossword) {
    body += '<div class="card setup"><div class="setup-title">Новый кроссворд</div>' +
      '<div class="muted">Классический кроссворд по одному из ' + Dict.templates.length +
      ' шаблонов. Слова подбираются из словаря под выбранную сложность.</div>' +
      '<div class="label">Сложность</div>' + segments(LEVELS.map((l) => l.title), setup.level, 'big-level') +
      '<div class="label">Размер</div>' + segments(GRID_SIZES.map((x) => x.title), setup.size, 'big-size') +
      '<div class="muted small">' + GRID_SIZES[setup.size].hint + '</div>' +
      (setup.error ? '<div class="error">' + esc(setup.error) + '</div>' : '') +
      (setup.generating
        ? '<div class="row"><div class="spinner small"></div><span>Составляю кроссворд…</span></div>'
        : '<div class="row"><button class="btn" data-act="generate">Составить кроссворд</button>' +
          (s.crossword ? '<button class="text-btn" data-act="cancel-setup">К текущему</button>' : '') + '</div>') +
      '</div>';
  } else {
    body += '<div class="row"><div class="cw-title grow">' + esc(s.title) + '</div>' +
      '<button class="text-btn" data-act="new-big">Новый</button></div>';
    body += s.solved ? solvedCard(g, 'new-big', 'Ещё кроссворд') : clueBar(g);
    body += crosswordGrid(g);
    if (!s.solved) {
      body += crosswordTools(g);
      const filled = s.crossword.slots.filter((x) => x.cells.every((k) => s.entries.has(k))).length;
      body += '<div class="muted small">Заполнено слов: ' + filled + ' из ' + s.crossword.slots.length +
        ' · за слово ' + s.wordPoints + ' очков</div>';
      keyboard = ruKeyboard();
    }
    body += messageLine(s.message) + clueList(g);
  }
  return '<div class="screen">' + topBar('Кроссворд') + '<div class="scroll"><div class="content tight">' + body +
    '</div></div>' + keyboard + '</div>';
}

// ----- «Филворд» -----

// Цвета найденных слов - по очереди нахождения
const FOUND_COLORS = ['#B9E4C9', '#FFD6A5', '#BDE0FE', '#FFC8DD', '#D0F4DE', '#E2C2FF',
  '#FDFFB6', '#A0E7E5', '#FFADAD', '#CAFFBF', '#C7CEEA', '#FFE5B4'];

function filwordCellSize(fw) { return Math.min(56, Math.floor((contentWidth() - 24) / fw.size)); }

function renderFilword() {
  const g = game('filword');
  let body = levelChips(g.level, false, false) +
    '<div class="row">' + topicPicker(g.category) + '<span class="grow"></span><button class="text-btn" data-act="new-filword">Новый</button></div>';
  if (g.loading) body += spinner();
  else if (g.error) body += '<div class="error">Ошибка: ' + esc(g.error) + '</div>';
  else if (g.fw) {
    const fw = g.fw;
    if (g.solved) {
      body += '<div class="card result won"><div class="result-text">Все слова найдены!</div>' +
        '<div>Слов: ' + fw.words.length + ' · очков: +' + fw.words.length * g.wordPoints + '</div>' +
        '<button class="btn" data-act="new-filword">Новый филворд</button></div>';
    } else {
      body += '<div class="muted small">Проведите пальцем по буквам слова - от первой до последней, по соседним клеткам.</div>';
    }
    const colorOf = new Map();
    g.found.forEach((index, order) => fw.words[index].cells.forEach((k) => colorOf.set(k, FOUND_COLORS[order % FOUND_COLORS.length])));
    const cell = filwordCellSize(fw);
    let grid = '<div class="fw-grid" id="fw-grid" style="grid-template-columns:repeat(' + fw.size + ',' + cell + 'px);grid-auto-rows:' +
      cell + 'px;font-size:' + (cell * 0.48) + 'px">';
    for (let r = 0; r < fw.size; r++) {
      for (let c = 0; c < fw.size; c++) {
        const k = cellKey(r, c);
        const color = colorOf.get(k);
        const hinted = g.hinted.has(k) && !color;
        grid += '<div class="fw-cell' + (color ? ' found' : '') + (hinted ? ' hinted' : '') + '" data-k="' + k + '"' +
          (color ? ' style="background:' + color + '"' : '') + '>' + fw.letters.get(k) + '</div>';
      }
    }
    body += '<div class="center">' + grid + '</div></div>';
    if (!g.solved) {
      body += '<div class="row"><span class="muted small grow">Найдено: ' + g.found.length + ' из ' + fw.words.length +
        ' · за слово ' + g.wordPoints + '</span>' + hintButton('fw-hint', 'Буква (' + HINT_COST + ')', Progress.score() >= HINT_COST) + '</div>';
    }
    body += messageLine(g.message);
    // Короткие слова первыми - с них проще начинать
    const order = fw.words.map((w, i) => i).sort((a, b) => fw.words[a].cells.length - fw.words[b].cells.length);
    body += '<div class="card clue-list"><div class="clue-head">Найдите слова</div>' + order.map((index) => {
      const w = fw.words[index];
      const found = g.found.includes(index);
      return '<div class="fw-clue' + (found ? ' filled' : '') + '"><span class="grow">' + esc(w.puzzle.question) + ' (' + w.cells.length + ')</span>' +
        (found ? '<b>' + esc(w.puzzle.answer) + '</b>' : '') + '</div>';
    }).join('') + '</div>';
  }
  return '<div class="screen">' + topBar('Филворд') + '<div class="scroll"><div class="content tight">' + body + '</div></div></div>';
}

// Ведение пальцем по полю филворда: во время движения меняются только цвета клеток, без перерисовки экрана
function attachFilword() {
  const grid = document.getElementById('fw-grid');
  const g = games.filword;
  if (!grid || !g || !g.fw) return;
  const size = g.fw.size;
  let active = false;

  // Клетка под пальцем; у краёв клетки не срабатывает, чтобы при движении наискосок
  // не захватывать соседей по диагонали
  const cellAt = (e, strict) => {
    const rect = grid.getBoundingClientRect();
    const cellPx = rect.width / size;
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const c = Math.floor(x / cellPx), r = Math.floor(y / cellPx);
    if (r < 0 || r >= size || c < 0 || c >= size) return null;
    if (strict) {
      if (Math.abs(x - (c + 0.5) * cellPx) > cellPx * 0.38 || Math.abs(y - (r + 0.5) * cellPx) > cellPx * 0.38) return null;
    }
    return cellKey(r, c);
  };
  const paint = () => {
    const path = new Set(g.path);
    grid.querySelectorAll('.fw-cell').forEach((el) => el.classList.toggle('path', path.has(+el.dataset.k)));
  };
  grid.addEventListener('pointerdown', (e) => {
    const k = cellAt(e, false);
    if (k == null) return;
    g.startPath(k);
    if (!g.path.length) return;
    active = true;
    try { grid.setPointerCapture(e.pointerId); } catch (err) { /* не важно */ }
    paint();
    e.preventDefault();
  });
  grid.addEventListener('pointermove', (e) => {
    if (!active) return;
    const k = cellAt(e, true);
    if (k == null) return;
    g.extendPath(k);
    paint();
  });
  const end = () => {
    if (!active) return;
    active = false;
    g.endPath();
    render();
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
}

// ----- перерисовка -----

function render() {
  const old = $app.querySelector('.scroll');
  if (old) scrollMemory[renderedScreen] = old.scrollTop;
  const oldGrid = document.getElementById('grid-wrap');
  const gridLeft = oldGrid ? oldGrid.scrollLeft : 0;

  const html = current === 'guess' ? renderGuess()
    : current === 'quiz' ? renderQuiz()
    : current === 'daily' ? renderDaily()
    : current === 'big' ? renderBig()
    : current === 'filword' ? renderFilword()
    : renderHome();
  $app.innerHTML = html;
  renderedScreen = current;

  const scroll = $app.querySelector('.scroll');
  if (scroll) {
    if (bigScrollTop) { scrollMemory[current] = 0; bigScrollTop = false; }
    scroll.scrollTop = scrollMemory[current] || 0;
  }
  // Выбранная клетка большого кроссворда - всегда в видимой части сетки
  const wrap = document.getElementById('grid-wrap');
  if (wrap && wrap.scrollWidth > wrap.clientWidth) {
    const g = games[current];
    wrap.scrollLeft = gridLeft;
    if (g && g.s && g.s.selected != null) {
      const cell = crosswordCellSize(g.s.crossword);
      const target = cell * colOf(g.s.selected) - wrap.clientWidth / 2 + cell / 2;
      wrap.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
    }
  }
  if (current === 'filword') attachFilword();
}
let renderedScreen = 'home';

// ----- окна -----

function showDialog(html) {
  $dialog.innerHTML = '<div class="overlay" data-act="dialog-close"><div class="dialog" data-stop="1">' + html + '</div></div>';
}
function closeDialog() { $dialog.innerHTML = ''; }

let topicTarget = null;

function showTopics(target) {
  topicTarget = target;
  showDialog('<div class="dialog-title">Тема</div><div class="topic-list">' +
    '<button class="topic-item strong" data-act="pick-topic" data-v="0">Все темы</button>' +
    Dict.categoryList.map((c) => '<button class="topic-item" data-act="pick-topic" data-v="' + c.id + '">' + esc(c.name) + '</button>').join('') +
    '</div><div class="dialog-buttons"><button class="text-btn" data-act="dialog-close">Отмена</button></div>');
}

function showReset() {
  showDialog('<div class="dialog-title">Начать заново?</div><div class="dialog-text">Запас очков станет ' + START_SCORE +
    ', «Набрано» и «Угадано слов» обнулятся. Кроссворд дня и начатый кроссворд будут стёрты. Настройки уровней сохранятся.</div>' +
    '<div class="dialog-buttons"><button class="text-btn" data-act="dialog-close">Отмена</button>' +
    '<button class="text-btn" data-act="do-reset">Начать заново</button></div>');
}

// ----- действия -----

function act(name, v) {
  switch (name) {
    case 'home': current = 'home'; break;
    case 'retry': startLoading(); return;
    case 'open':
      if (!Dict.ready) return;
      current = v;
      game(v);
      break;
    case 'reset': showReset(); return;
    case 'do-reset':
      closeDialog();
      // Сбросить и сохранённое, и то, что уже открыто в режимах
      Progress.reset();
      if (games.daily) games.daily.loadDaily();
      if (games.big) games.big.clear();
      if (games.quiz) games.quiz.newRound();
      if (games.guess) games.guess.next();
      if (games.filword) games.filword.newGame();
      break;
    case 'dialog-close': closeDialog(); return;
    case 'topic': if (Dict.ready) showTopics(current); return;
    case 'pick-topic': {
      closeDialog();
      const category = Dict.categoryList.find((c) => c.id === +v) || null;
      if (topicTarget === 'quiz') game('quiz').setCategory(category);
      if (topicTarget === 'filword') game('filword').setCategory(category);
      break;
    }
    default: screenAct(name, v);
  }
  render();
}

function screenAct(name, v) {
  const g = games[current];
  if (!g) return;
  if (current === 'guess') {
    if (name === 'level') g.setLevel(+v);
    else if (name === 'humor') g.setHumor(!g.humorOnly);
    else if (name === 'key') g.press(v);
    else if (name === 'hint') g.hint();
    else if (name === 'next') g.next();
  } else if (current === 'quiz') {
    if (name === 'level') g.setLevel(+v);
    else if (name === 'humor') g.setHumor(!g.humorOnly);
    else if (name === 'answer' && g.item) g.answer(g.item.options[+v]);
    else if (name === 'fifty') g.fifty();
    else if (name === 'next') g.next();
    else if (name === 'round') g.newRound();
  } else if (current === 'daily' || current === 'big') {
    if (name === 'cell') g.select(+v);
    else if (name === 'slot') g.selectSlot(g.s.crossword.slots[+v]);
    else if (name === 'prev-slot') g.moveSlot(-1);
    else if (name === 'next-slot') g.moveSlot(1);
    else if (name === 'type') g.type(v);
    else if (name === 'erase') g.backspace();
    else if (name === 'check') g.check();
    else if (name === 'reveal') g.reveal();
    else if (name === 'practice') { g.newPractice(); scrollMemory.daily = 0; }
    else if (name === 'to-daily') { g.loadDaily(); scrollMemory.daily = 0; }
    else if (name === 'new-big') { g.showSetup(true); scrollMemory.big = 0; }
    else if (name === 'cancel-setup') g.showSetup(false);
    else if (name === 'big-level') g.setLevel(+v);
    else if (name === 'big-size') g.setSize(+v);
    else if (name === 'generate') g.generate();
  } else if (current === 'filword') {
    if (name === 'level') g.setLevel(+v);
    else if (name === 'new-filword') { g.newGame(); scrollMemory.filword = 0; }
    else if (name === 'fw-hint') g.hint();
  }
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  // нажатие внутри окна не закрывает его
  if (el.dataset.act === 'dialog-close' && el.classList.contains('overlay') && e.target.closest('[data-stop]')) return;
  act(el.dataset.act, el.dataset.v);
});

// Клавиатура компьютера (для проверки на ПК): буквы и стирание
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const g = games[current];
  if (!g) return;
  let ch = e.key.length === 1 ? e.key.toUpperCase() : '';
  if (ch === 'Ё') ch = 'Е';
  const letter = ch >= 'А' && ch <= 'Я';
  if (current === 'guess' && letter) { g.press(ch); render(); }
  else if ((current === 'daily' || current === 'big') && g.s.crossword && !(current === 'big' && g.setup.visible)) {
    if (letter) g.type(ch);
    else if (e.key === 'Backspace') g.backspace();
    else return;
    e.preventDefault();
    render();
  }
});

// Поворот телефона и смена размера окна - пересчитать клетки
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 150);
});

// После возврата в приложение (оно могло пролежать в фоне до следующего дня) - обновить экран
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const daily = games.daily;
  if (daily && !daily.s.practice && daily.poolDate !== null && daily.poolDate !== todayStamp()) daily.loadDaily();
  render();
});

function startLoading() {
  Dict.error = null;
  Dict.loadedMb = 0;
  render();
  loadDictionary()
    .then(() => { Dict.ready = true; })
    .catch((e) => { console.error(e); Dict.error = e.message || String(e); })
    .finally(render);
}

Progress.pruneUsage();
render();
startLoading();

// Офлайн-работа (только по https:// и на localhost - так требует браузер)
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
}
// Просим браузер не удалять словарь и прогресс при нехватке места
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
