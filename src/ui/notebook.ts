import { el } from './dom.js';

/**
 * The notebook: jot down a comment, suggestion or idea while using the site,
 * from any page, and have it kept for later.
 *
 * Two properties matter more than anything else here:
 *
 * 1. **A note is never lost.** Every note is written to localStorage FIRST and
 *    only then sent to the server. If the request fails — offline, wrong
 *    passphrase, server down — the note stays queued locally and is retried,
 *    and the panel says plainly that it is unsent. Losing a thought because a
 *    network call failed would be the one unforgivable bug in a notebook.
 *
 * 2. **The page you were on is captured automatically.** "The colours are hard
 *    to read" means something different on the temperature map than on the
 *    trade tape, and remembering to say which one is exactly the sort of thing
 *    nobody does while actually using a site.
 *
 * The passphrase is held in localStorage and sent as a bearer token. The site
 * is public and this endpoint writes to a database, so it is gated; the Worker
 * refuses writes outright when no token is configured.
 */

const STORAGE_KEY = 'realtime-earth.notes.queue';
const TOKEN_KEY = 'realtime-earth.notes.token';

interface QueuedNote {
  /** Local id, so a queued note can be reconciled after it is sent. */
  localId: string;
  body: string;
  page: string;
  createdAt: string;
  sent: boolean;
  /** Why the last send attempt failed, if it did. */
  error: string | null;
}

interface ServerNote {
  id: number;
  body: string;
  page: string | null;
  status: string;
  created_at: string;
}

function readQueue(): QueuedNote[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedNote[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedNote[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage full or blocked. The in-memory copy still holds the note for
    // this session, and the panel will show it as unsent.
  }
}

function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* nothing we can do; the field simply will not persist */
  }
}

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export interface NotebookHandle {
  root: HTMLElement;
  destroy(): void;
}

export function createNotebook(currentPath: () => string): NotebookHandle {
  let queue = readQueue();
  let open = false;
  let serverNotes: ServerNote[] = [];
  let statusText = '';

  const textarea = el('textarea', {
    class: 'notebook__input',
    rows: '4',
    placeholder: 'What should change? Anything you notice, want, or dislike.',
    'aria-label': 'Your note',
  }) as HTMLTextAreaElement;

  const tokenInput = el('input', {
    class: 'notebook__token',
    type: 'password',
    placeholder: 'passphrase',
    'aria-label': 'Notebook passphrase',
  }) as HTMLInputElement;
  tokenInput.value = getToken();
  tokenInput.addEventListener('change', () => {
    setToken(tokenInput.value.trim());
    void flush();
  });

  const status = el('p', { class: 'notebook__status' });
  const list = el('ol', { class: 'notebook__list' });
  const saveButton = el('button', { class: 'notebook__save', type: 'button' }, 'Save note');

  const toggle = el(
    'button',
    { class: 'notebook__toggle', type: 'button', 'aria-expanded': 'false' },
    'Notes',
    el('span', { class: 'notebook__badge', hidden: '' }, ''),
  );

  const panel = el(
    'div',
    { class: 'notebook__panel', hidden: '' },
    el(
      'div',
      { class: 'notebook__head' },
      el('h2', { class: 'notebook__title' }, 'Notes for later'),
      el('button', { class: 'notebook__close', type: 'button', 'aria-label': 'Close' }, '×'),
    ),
    el(
      'p',
      { class: 'notebook__hint' },
      'Written from any page and kept for later. The page you are on is recorded with the note.',
    ),
    textarea,
    el('div', { class: 'notebook__row' }, tokenInput, saveButton),
    status,
    list,
  );

  const root = el('div', { class: 'notebook' }, toggle, panel);

  function unsentCount(): number {
    return queue.filter((note) => !note.sent).length;
  }

  function render(): void {
    const badge = toggle.querySelector('.notebook__badge');
    const unsent = unsentCount();
    if (badge !== null) {
      if (unsent > 0) {
        badge.textContent = String(unsent);
        badge.removeAttribute('hidden');
      } else {
        badge.setAttribute('hidden', '');
      }
    }

    status.textContent = statusText;
    status.classList.toggle('notebook__status--error', statusText.startsWith('Not saved'));

    // Unsent notes first: they are the ones that still need something to
    // happen, and burying them under the saved list would hide the problem.
    const pending = queue.filter((note) => !note.sent);
    list.replaceChildren(
      ...pending.map((note) =>
        el(
          'li',
          { class: 'notebook__note notebook__note--pending' },
          el('span', { class: 'notebook__notemeta' }, `unsent · ${note.page} · ${timeAgo(note.createdAt)}`),
          el('span', { class: 'notebook__notebody' }, note.body),
          note.error === null ? null : el('span', { class: 'notebook__noteerror' }, note.error),
        ),
      ),
      ...serverNotes.map((note) =>
        el(
          'li',
          { class: note.status === 'done' ? 'notebook__note notebook__note--done' : 'notebook__note' },
          el(
            'span',
            { class: 'notebook__notemeta' },
            `#${note.id} · ${note.status} · ${note.page ?? 'no page'} · ${timeAgo(note.created_at)}`,
          ),
          el('span', { class: 'notebook__notebody' }, note.body),
        ),
      ),
    );

    if (pending.length === 0 && serverNotes.length === 0) {
      list.replaceChildren(el('li', { class: 'notebook__empty' }, 'No notes yet.'));
    }
  }

  async function send(note: QueuedNote): Promise<boolean> {
    const token = getToken();
    if (token === '') {
      note.error = 'no passphrase set — the note is kept here until you add one';
      return false;
    }
    try {
      const response = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ body: note.body, page: note.page }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { message?: string } | null;
        note.error = detail?.message ?? `server returned HTTP ${response.status}`;
        return false;
      }
      note.sent = true;
      note.error = null;
      return true;
    } catch (error) {
      note.error = error instanceof Error ? error.message : 'the request failed';
      return false;
    }
  }

  /** Try to send everything still queued. Safe to call repeatedly. */
  async function flush(): Promise<void> {
    const pending = queue.filter((note) => !note.sent);
    if (pending.length === 0) return;
    let sentAny = false;
    for (const note of pending) {
      const ok = await send(note);
      if (ok) sentAny = true;
    }
    // Sent notes are dropped from the local queue: the server copy is now the
    // record, and keeping both would show every note twice.
    queue = queue.filter((note) => !note.sent);
    writeQueue(queue);
    const stillPending = unsentCount();
    statusText =
      stillPending === 0
        ? 'Saved.'
        : `Not saved yet — ${stillPending} note${stillPending === 1 ? '' : 's'} kept in this browser and retried.`;
    if (sentAny) await load();
    render();
  }

  async function load(): Promise<void> {
    const token = getToken();
    if (token === '') {
      serverNotes = [];
      return;
    }
    try {
      const response = await fetch('/api/notes', { headers: { authorization: `Bearer ${token}` } });
      if (!response.ok) {
        serverNotes = [];
        return;
      }
      const body = (await response.json()) as { notes?: ServerNote[] };
      serverNotes = Array.isArray(body.notes) ? body.notes : [];
    } catch {
      serverNotes = [];
    }
  }

  function save(): void {
    const body = textarea.value.trim();
    if (body === '') {
      statusText = 'Nothing to save.';
      render();
      return;
    }
    const note: QueuedNote = {
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      body,
      page: currentPath(),
      createdAt: new Date().toISOString(),
      sent: false,
      error: null,
    };
    // Stored locally BEFORE any network call. If everything else fails, the
    // note still exists.
    queue.push(note);
    writeQueue(queue);
    textarea.value = '';
    statusText = 'Saving…';
    render();
    void flush();
  }

  saveButton.addEventListener('click', save);
  textarea.addEventListener('keydown', (event) => {
    // Ctrl/Cmd+Enter saves, so a note can be written and filed without reaching
    // for the mouse.
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      save();
    }
  });

  function setOpen(next: boolean): void {
    open = next;
    toggle.setAttribute('aria-expanded', String(open));
    panel.toggleAttribute('hidden', !open);
    root.classList.toggle('notebook--open', open);
    if (open) {
      textarea.focus();
      void load().then(render);
      void flush();
    }
  }

  toggle.addEventListener('click', () => setOpen(!open));
  panel.querySelector('.notebook__close')?.addEventListener('click', () => setOpen(false));

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && open) setOpen(false);
  };
  document.addEventListener('keydown', onKey);

  // Retry queued notes when the browser regains connectivity, without the
  // reader having to reopen the panel.
  const onOnline = (): void => void flush();
  window.addEventListener('online', onOnline);

  render();
  void flush();

  return {
    root,
    destroy(): void {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('online', onOnline);
      root.remove();
    },
  };
}
