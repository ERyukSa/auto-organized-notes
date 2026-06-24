class MemoApp {
  constructor() {
    this.memoId       = null;
    this.currentTags  = [];
    this.currentImgs  = [];
    this.saveTimer    = null;
    this.searchTimer  = null;
    this.simTimer     = null;
    this.filterTag    = null;
    this.recognition  = null;
    this.isRecording  = false;
    this.allMemos     = [];
    this.linkAcIdx    = -1;

    this.init();
  }

  async init() {
    this.bindUI();
    await this.loadList();
    this.newMemo();
    this.setupVoice();
    this.setupReminder();
    this.refreshMemoCache();
    this.setupSummary();
    this.setupMemoSummary();
  }

  // ── UI 바인딩 ──────────────────────────────────────────────────────────────

  bindUI() {
    document.getElementById('btn-new').onclick = () => this.newMemo();

    // 검색
    const searchEl = document.getElementById('search-input');
    searchEl.addEventListener('input', e => {
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.loadList(e.target.value.trim()), 280);
    });
    searchEl.addEventListener('keydown', async e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const q = searchEl.value.trim();
        if (q) await this.aiSearch(q);
      }
    });

    // 제목
    document.getElementById('memo-title').addEventListener('input', () => this.scheduleSave());

    // 본문
    const ta = document.getElementById('memo-content');
    ta.addEventListener('input', () => {
      this.scheduleSave();
      this.updateCharCount();
      this.autoResize();
      this.renderChecklist();
      this.checkLinkTrigger();
      this.renderLinks();
      clearTimeout(this.simTimer);
      this.simTimer = setTimeout(() => this.loadSimilar(), 1200);
    });
    ta.addEventListener('keydown', e => {
      const ac = document.getElementById('link-autocomplete');
      if (ac.classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); this.moveLinkAc(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.moveLinkAc(-1); }
      else if (e.key === 'Enter') {
        const active = ac.querySelector('.lac-item.active');
        if (active) { e.preventDefault(); this.selectLink(active.dataset.title); }
      } else if (e.key === 'Escape') { this.closeLinkAutocomplete(); }
    });

    // 태그 입력
    document.getElementById('tag-input').addEventListener('keydown', e => {
      const val = e.target.value.trim().replace(',', '');
      if ((e.key === 'Enter' || e.key === ',') && val) {
        e.preventDefault();
        if (!this.currentTags.includes(val)) {
          this.currentTags.push(val);
          this.renderTags();
          this.scheduleSave();
        }
        e.target.value = '';
      }
      if (e.key === 'Backspace' && !e.target.value && this.currentTags.length) {
        this.currentTags.pop();
        this.renderTags();
        this.scheduleSave();
      }
    });

    // 이미지 업로드 (파일 선택)
    document.getElementById('image-input').addEventListener('change', async e => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const f of files) await this.uploadImage(f);
    });

    // 체크리스트 항목 삽입
    document.getElementById('btn-checklist').onclick = () => this.insertChecklistItem();

    // 음성
    document.getElementById('btn-voice').onclick = () => this.toggleVoice();

    // 고정 / 삭제
    document.getElementById('btn-pin').onclick    = () => this.togglePin();
    document.getElementById('btn-delete').onclick = () => this.deleteMemo();

    // 내보내기 드롭다운
    const exportBtn  = document.getElementById('btn-export');
    const exportMenu = document.getElementById('export-menu');
    exportBtn.onclick = e => {
      e.stopPropagation();
      exportMenu.classList.toggle('hidden');
    };
    document.addEventListener('click', e => {
      exportMenu.classList.add('hidden');
      if (!e.target.closest('#link-autocomplete') && !e.target.closest('#memo-content')) {
        this.closeLinkAutocomplete();
      }
    });
    document.getElementById('exp-md').onclick   = () => { exportMenu.classList.add('hidden'); this.exportMd(); };
    document.getElementById('exp-json').onclick = () => { exportMenu.classList.add('hidden'); this.exportJson(); };

    // 오늘 메모 토글
    document.getElementById('today-toggle').onclick = () => {
      const list = document.getElementById('today-list');
      list.style.display = list.style.display === 'none' ? '' : 'none';
    };

    // 드래그&드롭 이미지
    const pane = document.getElementById('editor-pane');
    pane.addEventListener('dragover', e => { e.preventDefault(); pane.classList.add('drag-over'); });
    pane.addEventListener('dragleave', () => pane.classList.remove('drag-over'));
    pane.addEventListener('drop', async e => {
      e.preventDefault();
      pane.classList.remove('drag-over');
      const imgs = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
      for (const f of imgs) await this.uploadImage(f);
    });
  }

  // ── 메모 목록 ──────────────────────────────────────────────────────────────

  async aiSearch(query) {
    const el = document.getElementById('search-input');
    const prev = el.placeholder;
    el.disabled = true;
    el.placeholder = '🤖 AI 분석 중...';
    try {
      const { keywords } = await fetch('/api/search/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      }).then(r => r.json());
      await this.loadList(keywords.join(' '));
    } catch (e) {
      await this.loadList(query);
    } finally {
      el.disabled = false;
      el.placeholder = prev;
      el.focus();
    }
  }

  async loadList(q = '') {
    const params = new URLSearchParams();
    if (q)              params.set('q', q);
    if (this.filterTag) params.set('tag', this.filterTag);

    try {
      const [all, today, tags] = await Promise.all([
        fetch('/api/memos?' + params).then(r => r.json()),
        fetch('/api/memos?today=true').then(r => r.json()),
        fetch('/api/tags').then(r => r.json()),
      ]);

      this.renderList('today-list', 'today-count', today);
      this.renderList('all-list',   'all-count',   all);
      this.renderTagFilter(tags);
    } catch (e) { console.error(e); }
  }

  renderList(listId, countId, memos) {
    document.getElementById(countId).textContent = memos.length;
    const el = document.getElementById(listId);

    if (!memos.length) {
      el.innerHTML = '<p class="hint">메모가 없습니다.</p>';
      return;
    }

    el.innerHTML = memos.map(m => {
      const tags = (m.tags || []).slice(0, 2).map(t =>
        `<span class="mi-tag">#${this.esc(t)}</span>`).join('');
      const imgs = m.images ? `🖼️ ${m.images}` : '';
      return `
        <div class="memo-item${m.id === this.memoId ? ' active' : ''}" data-id="${m.id}">
          ${m.pinned ? '<span class="mi-pin">📌</span>' : ''}
          <div class="mi-title">${this.esc(m.title || '(제목 없음)')}</div>
          <div class="mi-preview">${this.esc(m.content || '')} ${imgs}</div>
          <div class="mi-meta">${tags}<span class="mi-date">${this.relDate(m.updatedAt)}</span></div>
        </div>`;
    }).join('');

    el.querySelectorAll('.memo-item[data-id]').forEach(el => {
      el.onclick = () => this.openMemo(+el.dataset.id);
    });
  }

  renderTagFilter(tags) {
    const el = document.getElementById('tag-filter');
    if (!tags.length) { el.innerHTML = ''; return; }

    el.innerHTML = [
      `<button class="tf-btn${!this.filterTag ? ' active' : ''}" data-tag="">전체</button>`,
      ...tags.map(t =>
        `<button class="tf-btn${this.filterTag === t ? ' active' : ''}" data-tag="${this.esc(t)}">#${this.esc(t)}</button>`)
    ].join('');

    el.querySelectorAll('.tf-btn').forEach(b => {
      b.onclick = () => {
        this.filterTag = b.dataset.tag || null;
        this.loadList(document.getElementById('search-input').value.trim());
      };
    });
  }

  // ── 메모 열기 / 새 메모 ────────────────────────────────────────────────────

  async openMemo(id) {
    if (this.memoId === id) return;
    try {
      const m = await fetch('/api/memos/' + id).then(r => r.json());
      this.memoId      = m.id;
      this.currentTags = [...(m.tags || [])];
      this.currentImgs = [...(m.images || [])];

      document.getElementById('memo-title').value   = m.title || '';
      document.getElementById('memo-content').value = m.content || '';
      document.getElementById('memo-date').textContent = this.fullDate(m.createdAt);
      document.getElementById('save-status').textContent = '저장됨';
      document.getElementById('btn-pin').classList.toggle('active', !!m.pinned);

      this.renderTags();
      this.renderImgs();
      this.updateCharCount();
      this.autoResize();
      this.renderChecklist();
      this.renderLinks();
      this.closeLinkAutocomplete();
      this.loadSimilar();
      document.getElementById('suggestions-bar').classList.add('hidden');
      document.getElementById('memo-summary-bar').classList.add('hidden');

      document.querySelectorAll('.memo-item').forEach(el =>
        el.classList.toggle('active', +el.dataset.id === id));
    } catch (e) { console.error(e); }
  }

  newMemo() {
    this.memoId      = null;
    this.currentTags = [];
    this.currentImgs = [];

    document.getElementById('memo-title').value   = '';
    document.getElementById('memo-content').value = '';
    document.getElementById('memo-date').textContent = '';
    document.getElementById('save-status').textContent = '새 메모';
    document.getElementById('btn-pin').classList.remove('active');
    document.getElementById('similar-list').innerHTML =
      '<p class="hint">메모를 작성하면<br>비슷한 내용의 메모가<br>여기 표시됩니다.</p>';

    this.renderTags();
    this.renderImgs();
    this.updateCharCount();
    document.getElementById('suggestions-bar').classList.add('hidden');
    document.getElementById('memo-summary-bar').classList.add('hidden');
    document.getElementById('checklist-preview').classList.add('hidden');
    document.getElementById('link-preview').classList.add('hidden');
    document.getElementById('link-autocomplete').classList.add('hidden');
    document.querySelectorAll('.memo-item').forEach(el => el.classList.remove('active'));
    document.getElementById('memo-title').focus();
  }

  // ── 저장 ───────────────────────────────────────────────────────────────────

  scheduleSave() {
    clearTimeout(this.saveTimer);
    document.getElementById('save-status').textContent = '입력 중...';
    this.saveTimer = setTimeout(() => this.save(), 800);
  }

  async save() {
    const title   = document.getElementById('memo-title').value.trim();
    const content = document.getElementById('memo-content').value;
    if (!title && !content && !this.currentImgs.length) return;

    const body = { title, content, tags: this.currentTags, images: this.currentImgs };
    try {
      if (this.memoId) {
        await fetch('/api/memos/' + this.memoId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } else {
        const m = await fetch('/api/memos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(r => r.json());
        this.memoId = m.id;
        document.getElementById('memo-date').textContent = this.fullDate(m.createdAt);
      }

      const t = new Date();
      document.getElementById('save-status').textContent =
        `저장됨 ${t.getHours().toString().padStart(2,'0')}:${t.getMinutes().toString().padStart(2,'0')}`;

      await this.loadList(document.getElementById('search-input').value.trim());
      this.refreshMemoCache();
      this.renderSuggestions();
    } catch (e) {
      document.getElementById('save-status').textContent = '저장 실패';
    }
  }

  // ── 삭제 / 핀 ──────────────────────────────────────────────────────────────

  async deleteMemo() {
    if (!this.memoId) return;
    if (!confirm('이 메모를 삭제할까요?')) return;
    await fetch('/api/memos/' + this.memoId, { method: 'DELETE' });
    this.memoId = null;
    this.newMemo();
    await this.loadList(document.getElementById('search-input').value.trim());
  }

  async togglePin() {
    if (!this.memoId) return;
    const res = await fetch('/api/memos/' + this.memoId + '/pin', { method: 'POST' }).then(r => r.json());
    document.getElementById('btn-pin').classList.toggle('active', res.pinned);
    await this.loadList(document.getElementById('search-input').value.trim());
  }

  // ── 태그 ───────────────────────────────────────────────────────────────────

  renderTags() {
    const el = document.getElementById('tags-display');
    el.innerHTML = this.currentTags.map((t, i) =>
      `<span class="tag-chip">#${this.esc(t)}<span class="tag-x" data-i="${i}">×</span></span>`
    ).join('');
    el.querySelectorAll('.tag-x').forEach(x => {
      x.onclick = () => {
        this.currentTags.splice(+x.dataset.i, 1);
        this.renderTags();
        this.scheduleSave();
      };
    });
  }

  // ── 이미지 ─────────────────────────────────────────────────────────────────

  async uploadImage(file) {
    const fd = new FormData();
    fd.append('image', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd }).then(r => r.json());
      const img = { filename: res.filename, url: res.url, ocrText: '' };
      this.currentImgs.push(img);
      this.renderImgs();
      this.runOCR(res.url, img);
    } catch (e) { console.error('업로드 실패:', e); }
  }

  async runOCR(url, imgData) {
    if (typeof Tesseract === 'undefined') return;
    document.getElementById('ocr-overlay').classList.remove('hidden');
    const prog = document.getElementById('ocr-progress');

    try {
      const result = await Tesseract.recognize(url, 'kor+eng', {
        logger: m => {
          if (m.status === 'recognizing text')
            prog.textContent = Math.round(m.progress * 100) + '%';
        }
      });
      const text = result.data.text.trim();
      if (text) {
        imgData.ocrText = text;
        const ta = document.getElementById('memo-content');
        ta.value += `\n\n--- 사진 텍스트 ---\n${text}`;
        this.autoResize();
        this.scheduleSave();
      }
    } catch (e) {
      console.error('OCR 실패:', e);
    } finally {
      document.getElementById('ocr-overlay').classList.add('hidden');
    }
  }

  renderImgs() {
    const el = document.getElementById('image-previews');
    el.innerHTML = this.currentImgs.map((img, i) => `
      <div class="img-wrap">
        <img class="img-thumb" src="${img.url}" alt="이미지" onclick="window.open('${img.url}','_blank')">
        <button class="img-del" data-i="${i}" title="삭제">×</button>
        ${img.ocrText ? '<span class="img-ocr-badge">OCR 완료</span>' : ''}
      </div>`).join('');

    el.querySelectorAll('.img-del').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        this.currentImgs.splice(+btn.dataset.i, 1);
        this.renderImgs();
        this.scheduleSave();
      };
    });
  }

  // ── 음성 ───────────────────────────────────────────────────────────────────

  setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      const btn = document.getElementById('btn-voice');
      btn.disabled = true;
      btn.title = '이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome 권장)';
      return;
    }

    this.recognition = new SR();
    this.recognition.lang = 'ko-KR';
    this.recognition.continuous = true;
    this.recognition.interimResults = false;

    this.recognition.onresult = e => {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript;
      }
      if (text) {
        const ta = document.getElementById('memo-content');
        ta.value += text;
        this.autoResize();
        this.scheduleSave();
      }
    };

    this.recognition.onerror = e => {
      console.error('음성 오류:', e.error);
      this.stopVoice();
    };

    this.recognition.onend = () => {
      if (this.isRecording) {
        try { this.recognition.start(); } catch (_) {}
      }
    };
  }

  toggleVoice() {
    this.isRecording ? this.stopVoice() : this.startVoice();
  }

  startVoice() {
    if (!this.recognition) return;
    this.isRecording = true;
    this.recognition.start();
    document.getElementById('btn-voice').classList.add('recording');
    document.getElementById('btn-voice').textContent = '⏹️ 중지';
    document.getElementById('voice-indicator').textContent = '● 음성 인식 중';
  }

  stopVoice() {
    this.isRecording = false;
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.stop();
      this.recognition.onend = () => {};
    }
    document.getElementById('btn-voice').classList.remove('recording');
    document.getElementById('btn-voice').textContent = '🎤 음성';
    document.getElementById('voice-indicator').textContent = '';
  }

  // ── 유사 메모 ──────────────────────────────────────────────────────────────

  async loadSimilar() {
    if (!this.memoId) return;
    try {
      const list = await fetch('/api/memos/' + this.memoId + '/similar').then(r => r.json());
      const el = document.getElementById('similar-list');

      if (!list.length) {
        el.innerHTML = '<p class="hint">비슷한 메모가 없습니다.</p>';
        return;
      }

      el.innerHTML = list.map(m => `
        <div class="sim-item" data-id="${m.id}">
          <div class="sim-title">${this.esc(m.title || '(제목 없음)')}</div>
          <div class="sim-preview">${this.esc(m.content || '')}</div>
          <div class="sim-meta">
            <span class="sim-score">유사도 ${m.score}%</span>
            <span class="sim-date">${this.relDate(m.createdAt)}</span>
          </div>
        </div>`).join('');

      el.querySelectorAll('.sim-item').forEach(el => {
        el.onclick = () => this.openMemo(+el.dataset.id);
      });
    } catch (e) { console.error(e); }
  }

  // ── 리마인더 ───────────────────────────────────────────────────────────────

  setupReminder() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') Notification.requestPermission();

    setInterval(() => {
      const now = new Date();
      if (now.getHours() === 21 && now.getMinutes() === 0
          && Notification.permission === 'granted') {
        new Notification('오늘의 메모 📝', {
          body: '오늘 하루를 기록해보세요!',
        });
      }
    }, 60_000);
  }

  // ── 체크리스트 ─────────────────────────────────────────────────────────────

  renderChecklist() {
    const ta      = document.getElementById('memo-content');
    const preview = document.getElementById('checklist-preview');
    const lines   = ta.value.split('\n');

    const items = [];
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)-\s+\[([ xX])\]\s*(.*)/);
      if (m) items.push({ lineIdx: i, done: m[2].toLowerCase() === 'x', text: m[3] });
    });

    if (!items.length) { preview.classList.add('hidden'); return; }

    preview.innerHTML = items.map(({ lineIdx, done, text }) =>
      `<label class="cl-item${done ? ' done' : ''}" data-line="${lineIdx}">
        <input type="checkbox" class="cl-cb" data-line="${lineIdx}" ${done ? 'checked' : ''}>
        <span class="cl-text">${this.esc(text)}</span>
      </label>`
    ).join('');

    preview.querySelectorAll('.cl-cb').forEach(cb => {
      cb.onchange = () => {
        const idx   = +cb.dataset.line;
        const lines = document.getElementById('memo-content').value.split('\n');
        lines[idx]  = lines[idx].replace(/\[([ xX])\]/, cb.checked ? '[x]' : '[ ]');
        document.getElementById('memo-content').value = lines.join('\n');
        this.scheduleSave();
        this.renderChecklist();
      };
    });

    preview.classList.remove('hidden');
  }

  insertChecklistItem() {
    const ta  = document.getElementById('memo-content');
    const pos = ta.selectionStart;
    const val = ta.value;
    const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
    const insert    = '- [ ] ';
    ta.value = val.slice(0, lineStart) + insert + val.slice(lineStart);
    ta.selectionStart = ta.selectionEnd = lineStart + insert.length;
    ta.focus();
    this.autoResize();
    this.scheduleSave();
    this.renderChecklist();
  }

  // ── 메모 간 링크 ───────────────────────────────────────────────────────────

  async refreshMemoCache() {
    try { this.allMemos = await fetch('/api/memos').then(r => r.json()); } catch (e) {}
  }

  checkLinkTrigger() {
    const ta = document.getElementById('memo-content');
    const before = ta.value.slice(0, ta.selectionStart);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (match) this.showLinkAutocomplete(match[1]);
    else this.closeLinkAutocomplete();
  }

  showLinkAutocomplete(query) {
    const ac = document.getElementById('link-autocomplete');
    const q = query.toLowerCase();
    const filtered = this.allMemos
      .filter(m => m.id !== this.memoId && (m.title || '').toLowerCase().includes(q))
      .slice(0, 7);
    if (!filtered.length) { this.closeLinkAutocomplete(); return; }
    this.linkAcIdx = -1;
    ac.innerHTML = '<div class="lac-header">메모 링크 삽입</div>' +
      filtered.map(m =>
        `<div class="lac-item" data-title="${this.esc(m.title || '')}">📝 ${this.esc(m.title || '(제목 없음)')}</div>`
      ).join('');
    ac.querySelectorAll('.lac-item').forEach(item => {
      item.onclick = () => this.selectLink(item.dataset.title);
    });
    ac.classList.remove('hidden');
  }

  selectLink(title) {
    const ta = document.getElementById('memo-content');
    const pos = ta.selectionStart;
    const val = ta.value;
    const before = val.slice(0, pos);
    const match = before.match(/\[\[([^\]\n]*)$/);
    if (match) {
      const start = pos - match[0].length;
      const insert = `[[${title}]]`;
      ta.value = val.slice(0, start) + insert + val.slice(pos);
      ta.selectionStart = ta.selectionEnd = start + insert.length;
    }
    this.closeLinkAutocomplete();
    this.renderLinks();
    this.scheduleSave();
    ta.focus();
  }

  closeLinkAutocomplete() {
    document.getElementById('link-autocomplete').classList.add('hidden');
    this.linkAcIdx = -1;
  }

  moveLinkAc(dir) {
    const items = document.querySelectorAll('#link-autocomplete .lac-item');
    if (!items.length) return;
    this.linkAcIdx = Math.max(0, Math.min(items.length - 1, this.linkAcIdx + dir));
    items.forEach((el, i) => el.classList.toggle('active', i === this.linkAcIdx));
  }

  renderLinks() {
    const content = document.getElementById('memo-content').value;
    const preview = document.getElementById('link-preview');
    const matches = [...content.matchAll(/\[\[([^\]]+)\]\]/g)];
    if (!matches.length) { preview.classList.add('hidden'); return; }
    const titles = [...new Set(matches.map(m => m[1]))];
    preview.innerHTML = '<span class="lp-label">🔗 링크</span>' +
      titles.map(t => `<button class="lp-link" data-title="${this.esc(t)}">${this.esc(t)}</button>`).join('');
    preview.querySelectorAll('.lp-link').forEach(btn => {
      btn.onclick = async () => {
        let target = this.allMemos.find(m => m.title === btn.dataset.title);
        if (!target) {
          await this.refreshMemoCache();
          target = this.allMemos.find(m => m.title === btn.dataset.title);
        }
        if (target) this.openMemo(target.id);
        else alert(`"${btn.dataset.title}" 메모를 찾을 수 없습니다.`);
      };
    });
    preview.classList.remove('hidden');
  }

  // ── 자동 추천 (태그 / 제목) ────────────────────────────────────────────────

  extractKeywords(text) {
    const STOP = new Set([
      '이','가','은','는','을','를','의','에','에서','로','으로','와','과','도','만',
      '까지','부터','이다','이고','이며','그','그리고','그래서','하지만','그러나',
      '때문에','있다','없다','것','수','등','및','또는','또','한','하다','할','더',
      '잘','못','안','아','어','오','우','이런','저런','그런','여기','저기',
      '어디','누구','뭐','왜','어떻게','언제','어떤','무슨','하면','때','위해',
      '있는','없는','하는','되는','같은','이번','그냥','정도','통해','대한',
    ]);
    const freq = {};
    (text || '').replace(/[^가-힣a-z0-9\s]/gi, ' ')
      .toLowerCase().split(/\s+/)
      .filter(w => w.length >= 2 && !STOP.has(w))
      .forEach(w => { freq[w] = (freq[w] || 0) + 1; });
    return Object.entries(freq)
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word);
  }

  getSuggestedTitle() {
    if (document.getElementById('memo-title').value.trim()) return null;
    const content = document.getElementById('memo-content').value.trim();
    if (!content) return null;
    const firstLine = content.split('\n').map(l => l.trim())
      .find(l => l.replace(/^[-*#>\s]+/, '').length > 2);
    if (!firstLine) return null;
    const clean = firstLine.replace(/^[-*#>\s]+/, '').split(/[.!?。]/)[0].trim();
    if (clean.length < 2) return null;
    return clean.length > 40 ? clean.slice(0, 40) + '...' : clean;
  }

  getSuggestedTags() {
    const text = document.getElementById('memo-title').value + ' '
               + document.getElementById('memo-content').value;
    return this.extractKeywords(text)
      .filter(k => !this.currentTags.includes(k))
      .slice(0, 5);
  }

  renderSuggestions() {
    const bar      = document.getElementById('suggestions-bar');
    const titleSug = this.getSuggestedTitle();
    const tagSugs  = this.getSuggestedTags();

    if (!titleSug && !tagSugs.length) { bar.classList.add('hidden'); return; }

    bar.innerHTML = '';

    if (titleSug) {
      const row = document.createElement('div');
      row.className = 'sug-row';
      row.innerHTML = `<span class="sug-label">💡 제목</span>
        <span class="sug-title-text">${this.esc(titleSug)}</span>
        <button class="sug-apply">적용</button>`;
      row.querySelector('.sug-apply').onclick = () => {
        document.getElementById('memo-title').value = titleSug;
        this.scheduleSave();
      };
      bar.appendChild(row);
    }

    if (tagSugs.length) {
      const row = document.createElement('div');
      row.className = 'sug-row';
      row.innerHTML = `<span class="sug-label">🏷️ 태그</span>`
        + tagSugs.map(t => `<button class="sug-tag" data-tag="${this.esc(t)}">#${this.esc(t)}</button>`).join('');
      row.querySelectorAll('.sug-tag').forEach(btn => {
        btn.onclick = () => {
          if (!this.currentTags.includes(btn.dataset.tag)) {
            this.currentTags.push(btn.dataset.tag);
            this.renderTags();
            this.scheduleSave();
          }
          btn.remove();
          if (!row.querySelector('.sug-tag')) row.remove();
          if (!bar.children.length) bar.classList.add('hidden');
        };
      });
      bar.appendChild(row);
    }

    bar.classList.remove('hidden');
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  exportMd() {
    const title   = document.getElementById('memo-title').value || '(제목 없음)';
    const content = document.getElementById('memo-content').value || '';
    const date    = document.getElementById('memo-date').textContent || '';
    const tags    = this.currentTags.map(t => `#${t}`).join(' ');

    const md = [
      `# ${title}`,
      '',
      date ? `> ${date}` : '',
      tags ? `> ${tags}` : '',
      '',
      '---',
      '',
      content,
    ].filter((l, i) => !(l === '' && i < 4 && !date && !tags)).join('\n');

    this.download(title.replace(/[\\/:*?"<>|]/g, '_') + '.md', md, 'text/markdown');
  }

  async exportJson() {
    try {
      const memos = await fetch('/api/memos').then(r => r.json());
      // 전체 내용 포함 (목록 API는 content를 100자로 자르므로 각 메모 풀 버전 가져오기)
      const full = await Promise.all(
        memos.map(m => fetch('/api/memos/' + m.id).then(r => r.json()))
      );
      const json = JSON.stringify({ exportedAt: new Date().toISOString(), memos: full }, null, 2);
      const date = new Date().toISOString().slice(0, 10);
      this.download(`memo-backup-${date}.json`, json, 'application/json');
    } catch (e) {
      console.error('백업 실패:', e);
    }
  }

  download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ── 메모 단건 AI 요약 ──────────────────────────────────────────────────────

  setupMemoSummary() {
    const bar     = document.getElementById('memo-summary-bar');
    const content = document.getElementById('memo-summary-content');

    document.getElementById('btn-memo-summary').onclick = async () => {
      if (!this.memoId) return alert('메모를 먼저 선택하거나 저장하세요.');

      bar.classList.remove('hidden');
      content.innerHTML = '<div class="summary-loading"><div class="spinner"></div><p>분석 중...</p></div>';

      try {
        const res  = await fetch(`/api/memos/${this.memoId}/summarize`, { method: 'POST' });
        const data = await res.json();
        if (data.error) {
          content.innerHTML = `<p class="hint">${this.esc(data.error)}</p>`;
          return;
        }
        content.innerHTML = `<div class="summary-content">${this.renderMarkdown(data.summary)}</div>`;
      } catch {
        content.innerHTML = '<p class="hint">오류가 발생했습니다.</p>';
      }
    };

    document.getElementById('msb-toggle').onclick = e => {
      if (e.target.closest('#btn-close-memo-summary')) return;
      const collapsed = bar.classList.toggle('collapsed');
      document.getElementById('msb-chevron').textContent = collapsed ? '▶' : '▼';
    };

    document.getElementById('btn-close-memo-summary').onclick = () => {
      bar.classList.add('hidden');
      bar.classList.remove('collapsed');
      document.getElementById('msb-chevron').textContent = '▼';
    };
  }

  // ── AI 요약 ────────────────────────────────────────────────────────────────

  setupSummary() {
    const modal   = document.getElementById('summary-modal');
    const dateEl  = document.getElementById('summary-date');
    const result  = document.getElementById('summary-result');

    dateEl.value = new Date().toISOString().slice(0, 10);

    document.getElementById('btn-summary').onclick        = () => modal.classList.remove('hidden');
    document.getElementById('btn-close-summary').onclick  = () => modal.classList.add('hidden');
    document.getElementById('summary-overlay').onclick    = () => modal.classList.add('hidden');

    document.getElementById('btn-today-sum').onclick = () => {
      dateEl.value = new Date().toISOString().slice(0, 10);
    };
    document.getElementById('btn-yesterday-sum').onclick = () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      dateEl.value = d.toISOString().slice(0, 10);
    };

    document.getElementById('btn-run-summary').onclick = async () => {
      result.innerHTML = '<div class="summary-loading"><div class="spinner"></div><p>AI가 메모를 분석 중...</p></div>';
      try {
        const res  = await fetch('/api/memos/summarize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ date: dateEl.value }),
        });
        const data = await res.json();

        if (data.error) {
          result.innerHTML = `<p class="hint">${this.esc(data.error)}</p>`;
          return;
        }
        if (!data.memoCount) {
          result.innerHTML = `<div class="summary-empty">📭 ${this.esc(data.date)}에 작성된 메모가 없어요.</div>`;
          return;
        }
        result.innerHTML = `
          <div class="summary-meta">${this.esc(data.date)} &nbsp;·&nbsp; 메모 ${data.memoCount}개 분석</div>
          <div class="summary-content">${this.renderMarkdown(data.summary)}</div>
        `;
      } catch {
        result.innerHTML = '<p class="hint">오류가 발생했습니다. 다시 시도해주세요.</p>';
      }
    };
  }

  renderMarkdown(md) {
    const lines = md.split('\n');
    const out   = [];
    let inList  = false;

    for (const raw of lines) {
      const safe = raw
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      if (safe.startsWith('## ')) {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<h3>${safe.slice(3)}</h3>`);
      } else if (/^[-•] /.test(safe)) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${safe.slice(2)}</li>`);
      } else if (safe === '---') {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push('<hr>');
      } else if (safe.trim() === '') {
        if (inList) { out.push('</ul>'); inList = false; }
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        out.push(`<p>${safe}</p>`);
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  // ── 유틸 ───────────────────────────────────────────────────────────────────

  updateCharCount() {
    const n = document.getElementById('memo-content').value.length;
    document.getElementById('char-count').textContent = n.toLocaleString() + '자';
  }

  autoResize() {
    const el = document.getElementById('memo-content');
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  relDate(iso) {
    if (!iso) return '';
    const d    = new Date(iso);
    const now  = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0) return `오늘 ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
    if (diff === 1) return '어제';
    if (diff <  7) return diff + '일 전';
    return `${d.getMonth()+1}/${d.getDate()}`;
  }

  fullDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일`;
  }

  esc(s) {
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
}

document.addEventListener('DOMContentLoaded', () => new MemoApp());
