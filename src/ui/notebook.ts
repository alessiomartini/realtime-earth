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
 * Notes go to the shared site-notes Worker (one D1 for all of Alessio's sites,
 * repo alessiomartini/site-notes, site = "realtime-earth"). It is write-only, with
 * no token: Claude reads the D1 directly and turns notes into ROADMAP items, so
 * the page never reads them back.
 */

const NOTES_URL = 'https://site-notes.alemarti-2001.workers.dev/realtime-earth/notes';

const STORAGE_KEY = 'realtime-earth.notes.queue';
const AUTHOR_KEY = 'site-notes.author';

/** Opening the site once with `?sono-alessio` marks this browser as Alessio's: a label, not a login. */
function noteAuthor(): string | undefined {
  try {
    if (new URLSearchParams(location.search).has('sono-alessio')) localStorage.setItem(AUTHOR_KEY, 'alessio');
    return localStorage.getItem(AUTHOR_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

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
  let statusText = '';

  const textarea = el('textarea', {
    class: 'notebook__input',
    rows: '4',
    placeholder: 'What should change? Anything you notice, want, or dislike.',
    'aria-label': 'Your note',
  }) as HTMLTextAreaElement;

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
      'Written from any page and sent for later; Claude reads them and adds them to the roadmap. The page you are on is recorded with the note.',
    ),
    textarea,
    el('div', { class: 'notebook__row' }, saveButton),
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

    // Only unsent notes are listed: sent ones live in the D1, not on the page.
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
    );

    if (pending.length === 0) {
      list.replaceChildren(el('li', { class: 'notebook__empty' }, 'No unsent notes.'));
    }
  }

  async function send(note: QueuedNote): Promise<boolean> {
    try {
      const response = await fetch(NOTES_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: note.body, page: note.page, author: noteAuthor() }),
      });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        note.error = detail?.error ?? `server returned HTTP ${response.status}`;
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
    for (const note of pending) await send(note);
    // Sent notes are dropped from the local queue: the server copy is now the record.
    queue = queue.filter((note) => !note.sent);
    writeQueue(queue);
    const stillPending = unsentCount();
    statusText =
      stillPending === 0
        ? 'Saved.'
        : `Not saved yet — ${stillPending} note${stillPending === 1 ? '' : 's'} kept in this browser and retried.`;
    render();
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

  noteAuthor(); // picks up ?sono-alessio
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
