require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = 3001;

// ── 디렉토리 초기화 ──────────────────────────────────────────────────────────
['data', 'uploads'].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── JSON DB ──────────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'data', 'memos.json');

function readDB() {
  if (!fs.existsSync(DB_FILE)) {
    const init = { memos: [], nextId: 1 };
    fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
    return init;
  }
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { memos: [], nextId: 1 }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ── 유사 메모 키워드 분석 ────────────────────────────────────────────────────
const STOP = new Set([
  '이','가','은','는','을','를','의','에','에서','로','으로','와','과','도','만',
  '까지','부터','이다','이고','이며','그','그리고','그래서','하지만','그러나',
  '때문에','있다','없다','것','수','등','및','또는','또','한','하다','할','더',
  '잘','못','안','아','어','오','우','이런','저런','그런','여기','저기',
  '어디','누구','뭐','왜','어떻게','언제','어떤','무슨','하면','때','위해',
]);

function keywords(text) {
  return [...new Set(
    (text || '').replace(/[^가-힣a-z0-9\s]/gi, ' ')
      .toLowerCase().split(/\s+/)
      .filter(w => w.length >= 2 && !STOP.has(w))
  )];
}

function jaccard(a, b) {
  const sa = new Set(keywords(a));
  const sb = new Set(keywords(b));
  if (!sa.size && !sb.size) return 0;
  const inter = [...sa].filter(w => sb.has(w)).length;
  const union = new Set([...sa, ...sb]).size;
  return inter / union;
}

// ── Multer (이미지 업로드) ───────────────────────────────────────────────────
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('이미지만 가능합니다.'));
  },
});

// ── 미들웨어 ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── API: 메모 목록 ───────────────────────────────────────────────────────────
app.get('/api/memos', (req, res) => {
  const db = readDB();
  const { q, tag, date, today } = req.query;
  let list = db.memos;

  if (today === 'true') {
    const d = new Date().toISOString().slice(0, 10);
    list = list.filter(m => m.createdAt.startsWith(d));
  }
  if (date) list = list.filter(m => m.createdAt.startsWith(date));
  if (tag)  list = list.filter(m => (m.tags || []).includes(tag));
  if (q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    list = list.filter(m =>
      terms.some(kw =>
        (m.title || '').toLowerCase().includes(kw) ||
        (m.content || '').toLowerCase().includes(kw) ||
        (m.tags || []).some(t => t.toLowerCase().includes(kw))
      )
    );
  }

  list = [...list].sort((a, b) => {
    if (a.pinned !== b.pinned) return b.pinned - a.pinned;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });

  res.json(list.map(m => ({
    id: m.id,
    title: m.title || '',
    content: (m.content || '').slice(0, 100),
    tags: m.tags || [],
    images: (m.images || []).length,
    pinned: !!m.pinned,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  })));
});

// ── API: 태그 전체 목록 ──────────────────────────────────────────────────────
app.get('/api/tags', (req, res) => {
  const db = readDB();
  const all = new Set();
  db.memos.forEach(m => (m.tags || []).forEach(t => all.add(t)));
  res.json([...all]);
});

// ── API: 메모 단건 조회 ──────────────────────────────────────────────────────
app.get('/api/memos/:id', (req, res) => {
  const db = readDB();
  const memo = db.memos.find(m => m.id === +req.params.id);
  if (!memo) return res.status(404).json({ error: '없음' });
  res.json(memo);
});

// ── API: 메모 생성 ───────────────────────────────────────────────────────────
app.post('/api/memos', (req, res) => {
  const db = readDB();
  const now = new Date().toISOString();
  const memo = {
    id: db.nextId++,
    title: req.body.title || '',
    content: req.body.content || '',
    tags: req.body.tags || [],
    images: req.body.images || [],
    pinned: false,
    createdAt: now,
    updatedAt: now,
  };
  db.memos.push(memo);
  writeDB(db);
  res.status(201).json(memo);
});

// ── API: 메모 수정 ───────────────────────────────────────────────────────────
app.put('/api/memos/:id', (req, res) => {
  const db = readDB();
  const memo = db.memos.find(m => m.id === +req.params.id);
  if (!memo) return res.status(404).json({ error: '없음' });

  const { title, content, tags, images, pinned } = req.body;
  if (title   !== undefined) memo.title   = title;
  if (content !== undefined) memo.content = content;
  if (tags    !== undefined) memo.tags    = tags;
  if (images  !== undefined) memo.images  = images;
  if (pinned  !== undefined) memo.pinned  = pinned;
  memo.updatedAt = new Date().toISOString();

  writeDB(db);
  res.json(memo);
});

// ── API: 메모 삭제 ───────────────────────────────────────────────────────────
app.delete('/api/memos/:id', (req, res) => {
  const db = readDB();
  const idx = db.memos.findIndex(m => m.id === +req.params.id);
  if (idx === -1) return res.status(404).json({ error: '없음' });
  db.memos.splice(idx, 1);
  writeDB(db);
  res.json({ ok: true });
});

// ── API: 핀 토글 ─────────────────────────────────────────────────────────────
app.post('/api/memos/:id/pin', (req, res) => {
  const db = readDB();
  const memo = db.memos.find(m => m.id === +req.params.id);
  if (!memo) return res.status(404).json({ error: '없음' });
  memo.pinned = !memo.pinned;
  memo.updatedAt = new Date().toISOString();
  writeDB(db);
  res.json({ pinned: memo.pinned });
});

// ── API: 유사 메모 ───────────────────────────────────────────────────────────
app.get('/api/memos/:id/similar', (req, res) => {
  const db   = readDB();
  const id   = +req.params.id;
  const tgt  = db.memos.find(m => m.id === id);
  if (!tgt) return res.json([]);

  const tgtText = (tgt.title || '') + ' ' + (tgt.content || '');

  const results = db.memos
    .filter(m => m.id !== id)
    .map(m => ({
      ...m,
      score: jaccard(tgtText, (m.title || '') + ' ' + (m.content || '')),
    }))
    .filter(m => m.score > 0.06)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map(m => ({
      id: m.id,
      title: m.title || '(제목 없음)',
      content: (m.content || '').slice(0, 80),
      score: Math.round(m.score * 100),
      createdAt: m.createdAt,
    }));

  res.json(results);
});

// ── Groq API 공통 호출 ───────────────────────────────────────────────────────
async function callGemini(prompt, maxTokens = 1200) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY가 설정되지 않았습니다.');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await response.json();
  if (!response.ok) console.error('[Groq 오류]', JSON.stringify(data));
  return data.choices?.[0]?.message?.content || '';
}

// ── API: AI 검색어 확장 ──────────────────────────────────────────────────────
app.post('/api/search/expand', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.json({ keywords: [query] });
  if (!process.env.GROQ_API_KEY) return res.json({ keywords: [query] });

  try {
    const text  = await callGemini(
      `검색어를 분석해서 메모 검색에 유용한 관련 키워드를 5개 이내로 추출해줘. JSON 배열로만 답해, 다른 텍스트 없이.\n검색어: "${query}"`,
      150
    );
    const match    = text.match(/\[[\s\S]*\]/);
    const keywords = match ? JSON.parse(match[0]) : [query];
    res.json({ keywords: Array.isArray(keywords) ? keywords.slice(0, 5) : [query] });
  } catch (e) {
    console.error('AI 검색 확장 오류:', e.message);
    res.json({ keywords: [query] });
  }
});

// ── API: 메모 단건 AI 요약 ───────────────────────────────────────────────────
app.post('/api/memos/:id/summarize', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: 'GROQ_API_KEY가 설정되지 않았습니다.' });

  const db   = readDB();
  const memo = db.memos.find(m => m.id === +req.params.id);
  if (!memo) return res.status(404).json({ error: '메모를 찾을 수 없습니다.' });

  const title   = memo.title   ? `제목: ${memo.title}\n` : '';
  const content = memo.content || '(내용 없음)';

  try {
    const summary = await callGemini(
      `다음 메모를 분석해서 핵심만 간결하게 정리해주세요.

형식을 정확히 따라주세요:

## 📝 핵심 요점
메모의 핵심 내용을 간결하게

## 🏷️ 키워드
핵심 키워드 5개 이내 (쉼표로 구분)

## ✅ 할 일
액션 아이템 (없으면 이 섹션 생략)

---
${title}${content}`,
      600
    );
    res.json({ summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: AI 메모 요약 ─────────────────────────────────────────────────────────
app.post('/api/memos/summarize', async (req, res) => {
  const { date } = req.body;
  if (!process.env.GROQ_API_KEY) return res.status(400).json({ error: 'GROQ_API_KEY가 설정되지 않았습니다.' });

  const db = readDB();
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const memos = db.memos.filter(m => m.createdAt.startsWith(targetDate));

  if (!memos.length) return res.json({ summary: null, memoCount: 0, date: targetDate });

  const memoText = memos.map((m, i) => {
    const title = m.title ? `제목: ${m.title}\n` : '';
    return `[메모 ${i + 1}]\n${title}${m.content || '(내용 없음)'}`;
  }).join('\n\n---\n\n');

  try {
    const summary = await callGemini(
      `다음은 ${targetDate}에 작성된 메모 ${memos.length}개입니다. 분석해서 구조화된 요약을 한국어로 작성해주세요. 중구난방이어도 맥락을 파악해서 정리해주세요.

형식을 정확히 따라주세요:

## 📌 핵심 주제
오늘 다룬 주요 주제들을 간결하게

## 💡 주요 내용
주제별로 관련 내용을 묶어서 정리

## ✅ 할 일 / 아이디어
실행 가능한 것들 (없으면 이 섹션 생략)

## 🔗 연결된 생각
서로 연결되는 내용 (없으면 이 섹션 생략)

---
${memoText}`
    );
    res.json({ summary, memoCount: memos.length, date: targetDate });
  } catch (e) {
    console.error('AI 요약 오류:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: 이미지 업로드 ───────────────────────────────────────────────────────
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: '파일 없음' });
  const ext     = path.extname(req.file.originalname) || '.jpg';
  const newName = req.file.filename + ext;
  fs.renameSync(req.file.path, path.join(__dirname, 'uploads', newName));
  res.json({ filename: newName, url: `/uploads/${newName}` });
});

app.listen(PORT, () => {
  console.log(`메모 앱 실행 중: http://localhost:${PORT}`);
});
