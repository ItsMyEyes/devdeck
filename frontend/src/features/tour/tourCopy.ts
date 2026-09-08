// Every user-facing string the guided tour and its "?" button say, in both
// languages the tour speaks.
//
// This is the app's only translated surface, so it is a plain typed record
// rather than an i18n runtime — DevDeck's UI itself is English-only, and
// pulling in i18next to translate one feature would cost more than it explains.
// `TourCopy` being a closed type means adding a step, a chapter or a button
// forces both languages to be filled in; there is no silent fallback to
// English.
//
// Titles and descriptions are rendered as HTML by driver.js. The content is
// authored here and never interpolated from user data, so the small amount of
// `<b>`/`<i>`/`<code>` markup below is safe.
//
// The copy is organised by chapter (`TourChapter`), and each chapter's steps
// are kept in one block in the order `tourSteps.ts` narrates them, so a step
// and its neighbours read together the way the reader will meet them.

import type { TourAnchor, TourChapter } from './tourAnchors'
import type { TourLang } from './tourPrefs'

/** Steps are keyed by the anchor they highlight, plus one centred opening step
 *  per chapter that highlights nothing. */
export type TourStepId = 'welcome' | 'workspace-intro' | 'chat-intro' | 'ssh-intro' | TourAnchor

export interface TourStepCopy {
  title: string
  description: string
}

/** One row in the "?" panel's tour list. */
export interface TourChapterCopy {
  label: string
  /** One line under the label — what this chapter covers. */
  hint: string
}

export interface TourChromeCopy {
  /** Accessible name of the floating button itself. */
  helpLabel: string
  panelTitle: string
  panelHint: string
  /** Heading above the list of chapters. */
  toursLabel: string
  /** First run vs. every run after it — "Replay" makes it obvious a chapter is
   *  repeatable rather than something new. Used as each row's tooltip, since
   *  the row's own label is the chapter's name. */
  start: string
  restart: string
  /** Shown on a chapter whose screen is not open, in place of its hint. */
  unavailable: string
  languageLabel: string
  /** driver.js popover chrome. `progress` is a template; driver.js substitutes
   *  `{{current}}` and `{{total}}`. */
  next: string
  previous: string
  done: string
  progress: string
}

export interface TourCopy {
  chrome: TourChromeCopy
  chapters: Record<TourChapter, TourChapterCopy>
  steps: Record<TourStepId, TourStepCopy>
}

const EN: TourCopy = {
  chrome: {
    helpLabel: 'Help and tutorial',
    panelTitle: 'Help',
    panelHint: 'Guided tours of the DevDeck interface.',
    toursLabel: 'Tours',
    start: 'Start tutorial',
    restart: 'Replay tutorial',
    unavailable: 'Open this screen to run it',
    languageLabel: 'Language',
    next: 'Next',
    previous: 'Back',
    done: 'Done',
    progress: '{{current}} of {{total}}',
  },
  chapters: {
    overview: {
      label: 'Interface overview',
      hint: 'Workspaces, the navigation rail, and the Agents screen.',
    },
    workspace: {
      label: 'Agent workspace',
      hint: 'Inside an open agent: the file sidebar and the split panes.',
    },
    chat: {
      label: 'Agent chat',
      hint: 'Every control in the conversation, from the model pill to Send.',
    },
    ssh: {
      label: 'SSH',
      hint: 'Saved hosts, and the rail inside a connected session.',
    },
  },
  steps: {
    // ── overview ──────────────────────────────────────────────────────────
    welcome: {
      title: 'Welcome to DevDeck',
      description:
        'DevDeck runs many projects’ coding agents side by side — each in its own git worktree, each with a live terminal. This tour points out the controls you will use most.<br><br>Use <b>←</b> and <b>→</b> to move between steps, <b>Esc</b> to leave at any time.',
    },
    'workspace-switcher': {
      title: 'Workspaces',
      description:
        'This badge is the workspace you are in — think “one client” or “one team”. Click it to switch workspaces, rename one, or create another. Every project lives inside a workspace.',
    },
    'sidebar-toggle': {
      title: 'The project panel',
      description:
        'Expands the rail into the project tree: every repo in this workspace, its worktrees, and its issues. Collapse it again when you want the screen back.',
    },
    'nav-rail': {
      title: 'Main navigation',
      description:
        '<b>Agents</b> is this screen. <b>SSH</b> holds your saved remote hosts, <b>Runtimes</b> the machines that actually run your projects, <b>Tools</b> the file-conversion helpers, and <b>Memory</b> what your agents remember across sessions.',
    },
    'agents-heading': {
      title: 'Everything running, at a glance',
      description:
        'The counters under the title: how many agents are active, how many are branch worktrees, and how many are root shells sitting in the project’s own checkout.',
    },
    'agents-search': {
      title: 'Filter',
      description:
        'Type to narrow the list by project, branch, model, task, or state. Useful once a workspace has more agents than fit on one screen.',
    },
    'agents-view-toggle': {
      title: 'Cards or list',
      description:
        'Cards show status, model and per-agent controls. The list packs many more rows into the same height — better when you are scanning rather than acting.',
    },
    'agents-refresh': {
      title: 'Refresh',
      description:
        'Re-reads live state from every runtime: worktree status, token counts and diff stats. The view updates on its own too — this is for when you want it now.',
    },
    'agents-new': {
      title: 'Start an agent',
      description:
        'Pick a project, a new branch and the branch to base it on, describe the task, then choose an agent CLI and model. DevDeck runs a real <code>git worktree add</code>, so your main checkout is never touched. Root mode gives you a plain shell at the project root instead.',
    },
    'agents-management': {
      title: 'Agent management',
      description:
        'Which agent CLIs were detected, the models they offer, plus MCP servers, skills and environment profiles. Start here when a model you expect is missing.',
    },
    'worktree-card': {
      title: 'One agent',
      description:
        'The dot is its state — running, waiting on you, or stopped. <b>Open</b> switches to the full tiling view: terminal, file explorer, editor and git panel, all reattaching to the same live process. <b>Details</b> edits the branch, task or model.',
    },
    'desktop-settings': {
      title: 'Desktop settings',
      description:
        'Only in the desktop app: how the bundled backend is bound, Tailscale sharing, your account, and app updates.',
    },
    'help-fab': {
      title: 'That’s the tour',
      description:
        'This button brings it back whenever you want it, offers the deeper tours of whatever screen you are standing on, and switches between English and Indonesian. Happy shipping.',
    },

    // ── workspace ─────────────────────────────────────────────────────────
    'workspace-intro': {
      title: 'Inside one agent',
      description:
        'This is where an agent actually works: a file panel on the left, and tiled panes on the right holding terminals, editors, diffs and the chat. This tour goes control by control across both.<br><br>Use <b>←</b> and <b>→</b> to move between steps, <b>Esc</b> to leave at any time.',
    },
    'shell-sidebar-toggle': {
      title: 'Show or hide the side panel',
      description:
        'Collapses the whole left panel so the terminal and the chat get the full width, and brings it back. The keyboard chord in its tooltip does the same thing without reaching for the mouse.',
    },
    'shell-sidebar-tabs': {
      title: 'Explorer · Git · Sessions',
      description:
        '<b>Explorer</b> is this worktree’s file tree. <b>Git</b> lists what has changed — clicking a file opens its diff as its own tab. <b>Sessions</b> lists every conversation held in this worktree, so an older one can be reopened in a chat pane.',
    },
    'explorer-new-file': {
      title: 'New file',
      description:
        'Creates a file inside the folder its tooltip names — the folder you have selected, or the root of the tree when nothing is. The name is typed inline in the tree itself.',
    },
    'explorer-new-folder': {
      title: 'New folder',
      description: 'The same, for a directory. Both write on the machine that hosts this worktree, not locally.',
    },
    'explorer-refresh': {
      title: 'Refresh the tree',
      description:
        'Re-reads the folder listing from the machine. Reach for it when an agent has just created, moved or deleted files and the tree still shows the old shape.',
    },
    'explorer-collapse': {
      title: 'Collapse all folders',
      description:
        'Folds every expanded folder back down to the root — the fastest way out of a tree you have opened six levels deep. Greyed out when nothing is expanded.',
    },
    'explorer-more': {
      title: 'More file actions',
      description:
        'Upload files into the selected folder, zip the current selection to download it, install the editor’s language-server dependencies for this project, and delete what is selected. Each one also has a keyboard shortcut and a right-click entry in the tree.',
    },
    'explorer-quick-open': {
      title: 'Search files and folders',
      description:
        'Fuzzy-search this tree by name and open the match directly — you never have to expand your way to it. The chord on the right opens the same thing.',
    },
    'explorer-content-search': {
      title: 'Search inside files',
      description:
        'Searches the file <i>contents</i> across the worktree rather than their names, and lists every match with the line it sits on. Clicking a result opens the file at that line.',
    },
    'pane-tabs': {
      title: 'Pane tabs',
      description:
        'One tab per terminal, editor, diff or chat. Drag a tab into another pane to move it there, or onto a pane’s edge to split against it. Middle-click closes a tab, and so does the <b>×</b> on it; a <b>*</b> means an editor has unsaved changes.',
    },
    'pane-new-tab': {
      title: 'New tab',
      description:
        'Opens another terminal, file, diff or chat inside <i>this</i> pane. The chord in its tooltip does the same for whichever pane currently has focus.',
    },
    'pane-split-right': {
      title: 'Split right',
      description:
        'Divides this pane into two side by side, so a terminal and its diff — or two agents — are readable at once. Drag the divider between them to change the ratio.',
    },
    'pane-split-down': {
      title: 'Split down',
      description:
        'The same split, stacked instead of side by side. Splits nest, so a layout can be built up as deep as the screen usefully allows.',
    },
    'pane-more-actions': {
      title: 'More actions',
      description:
        'Actions for whatever this pane is holding — the worktree’s own commands for a shell, editor actions for a file. It appears on the focused pane only, so a split never shows two competing menus.',
    },
    'pane-close': {
      title: 'Close the pane',
      description:
        'Closes the pane and every tab in it. What was behind them keeps running: closing a terminal’s view does not kill the shell, and closing a chat does not interrupt the agent’s turn — reopen it and you are reattached to the same live process.',
    },

    // ── chat ──────────────────────────────────────────────────────────────
    'chat-intro': {
      title: 'The agent conversation',
      description:
        'One thread with one agent: what you asked, everything it did, and the controls that decide how it answers next. This tour covers each of them in turn.<br><br>Use <b>←</b> and <b>→</b> to move between steps, <b>Esc</b> to leave at any time.',
    },
    'chat-header': {
      title: 'Thread header',
      description:
        'The badge names what this thread is attached to. The dot is the connection — green is live, amber is connecting, red is disconnected — and the word beside it is the agent itself: <b>Idle</b>, <b>Running</b>, <b>Waiting</b> (it has asked you something and is blocked on the answer), or <b>Stopped</b>.',
    },
    'chat-telegram': {
      title: 'Publish to Telegram',
      description:
        'Mirrors this thread into a Telegram chat, so you can keep reading it — and keep answering approvals — from your phone. It needs a bot token first; until there is one the button says so instead, and Settings → Network → Telegram is where it goes.',
    },
    'chat-transcript': {
      title: 'The transcript',
      description:
        'Your messages, the agent’s replies, and every tool call it made along the way. Tool calls and long code blocks come in collapsed — click one open to see the exact command and what it returned.',
    },
    'chat-input': {
      title: 'The prompt box',
      description:
        'Type <code>@</code> to pull a file from this worktree into the message, <code>/</code> to run a slash command such as <code>/plan</code> or <code>/build</code>, and drop or paste an image straight in. <b>Enter</b> sends; <b>Shift+Enter</b> is a newline.',
    },
    'chat-model': {
      title: 'Agent and model',
      description:
        'Which agent CLI answers, and which of its models. The list is the one actually detected on that machine — if a model is missing it is missing there, and Agent management is where you look. The pick rides your next message; it does not restart anything.',
    },
    'chat-effort': {
      title: 'Reasoning and context window',
      description:
        'The left half is how hard the model thinks before answering, from <b>Low</b> to <b>Max</b>, plus <b>Ultrathink</b>. The right half is how much conversation it carries before compacting itself — <b>200k</b>, <b>1M</b>, or a custom size between 100k and 1M.',
    },
    'chat-permission': {
      title: 'What it may do without asking',
      description:
        '<b>Approval required</b> stops for every command and every edit. <b>Auto-accept edits</b> lets it write files but still asks before running anything. <b>Auto</b> lets the agents that support it approve routine actions. <b>Full access</b> asks for nothing — keep that for a machine you are willing to lose.',
    },
    'chat-usage': {
      title: 'Context used',
      description:
        'The ring fills as the conversation grows. Click it for the exact token count against the window chosen in the pill beside it, and for how much has been processed in total.',
    },
    'chat-more-controls': {
      title: 'The same controls, folded up',
      description:
        'In a pane too narrow for the row — the SSH rail, a three-way split — the pickers move in here rather than being cut off. Model, reasoning, context window and permission, all unchanged.',
    },
    'chat-attach': {
      title: 'Attach an image',
      description:
        'Adds a screenshot or a diagram to the next message; dragging or pasting into the box does the same. Not every agent CLI accepts images — where one does not, the button says so rather than failing after the upload.',
    },
    'chat-send': {
      title: 'Send',
      description:
        'Sends the message. While a turn is running this button becomes <b>Stop</b>, which interrupts it — and a message sent <i>during</i> a turn steers the one already running instead of queueing behind it.',
    },

    // ── ssh ───────────────────────────────────────────────────────────────
    'ssh-intro': {
      title: 'SSH',
      description:
        'Your saved servers — and, once you are connected to one, the rail that turns a plain terminal into a workspace. This tour covers whichever of the two is on screen right now.<br><br>Use <b>←</b> and <b>→</b> to move between steps, <b>Esc</b> to leave at any time.',
    },
    'ssh-heading': {
      title: 'What is saved here',
      description:
        'The counters under the title: how many hosts are stored, how many have had their host key pinned on a first connect, and how many groups they are filed under.',
    },
    'ssh-search': {
      title: 'Filter hosts',
      description:
        'Matches name, group, hostname, port, username and auth type at once — so “prod”, “5432” and “root” all find something useful.',
    },
    'ssh-view-toggle': {
      title: 'Cards or list',
      description:
        'Cards give each host its own tile with the full detail. The list packs many more rows into the same height and keeps Connect, Edit and Delete on every one.',
    },
    'ssh-new-host': {
      title: 'New host',
      description:
        'Address, user, and either a password or a private key — stored encrypted, never in plain text. A host can also be given a jump host to hop through, and an executor runtime to dial from, so a server only one machine can reach is still reachable from here.',
    },
    'ssh-host-card': {
      title: 'One host',
      description:
        'The glyph says how it authenticates: a key for a private key, a server for a password. The badges repeat that in words and add the two things worth knowing at a glance — <i>via</i> the runtime that dials it, and the jump host it hops through.',
    },
    'ssh-host-connect': {
      title: 'Connect',
      description:
        'Opens the host as a shell tab in this workspace: a real terminal, with a file explorer for the remote filesystem beside it and the DevOps rail on the right.',
    },
    'ssh-host-edit': {
      title: 'Edit',
      description:
        'Re-opens the same form — address, credentials, group, jump host, executor runtime. Changes take effect on the next connect, so a session already open is not disturbed.',
    },
    'ssh-host-delete': {
      title: 'Delete',
      description: 'Removes the saved host and the credentials stored with it, after a confirmation.',
    },
    'ssh-host-key': {
      title: 'Host key',
      description:
        'The server’s fingerprint, pinned on the first connect and compared on every one after — that comparison is what tells you the machine answering is still the machine you saved. Reset it only when you know the server was genuinely rebuilt; it re-pins on the next connect.',
    },
    'ssh-rail-chat': {
      title: 'DevOps Chat',
      description:
        'An agent with a shell on <i>this</i> server. It runs on the executor runtime assigned to the connection — the machine that can actually reach the host — not on the hub. Ask it to read a log, restart a service or chase a failure, and it runs the commands here.',
    },
    'ssh-rail-stats': {
      title: 'Stats',
      description: 'Live resource usage for the server this tab is connected to, read over the same connection.',
    },
    'ssh-rail-forwards': {
      title: 'Port forwarding',
      description:
        'The tunnels for this connection: <code>-L</code> brings a remote port to you, <code>-R</code> exposes one of yours on the server, <code>-D</code> opens a SOCKS proxy through it. The way to reach a database or an internal dashboard that is not published anywhere.',
    },
    'ssh-chat-history': {
      title: 'Session history',
      description:
        'Every conversation held with this host. Picking one swaps it into the panel in place, so you never lose the chat you were reading to a full-height list.',
    },
    'ssh-chat-new-session': {
      title: 'New session',
      description:
        'Starts a fresh conversation with this host — a clean context for an unrelated job, with the previous one still listed under the history button.',
    },
  },
}

const ID: TourCopy = {
  chrome: {
    helpLabel: 'Bantuan dan tutorial',
    panelTitle: 'Bantuan',
    panelHint: 'Tur berpemandu untuk antarmuka DevDeck.',
    toursLabel: 'Tur',
    start: 'Mulai tutorial',
    restart: 'Ulangi tutorial',
    unavailable: 'Buka layarnya dulu untuk menjalankan',
    languageLabel: 'Bahasa',
    next: 'Lanjut',
    previous: 'Kembali',
    done: 'Selesai',
    progress: '{{current}} dari {{total}}',
  },
  chapters: {
    overview: {
      label: 'Sekilas antarmuka',
      hint: 'Workspace, rail navigasi, dan layar Agents.',
    },
    workspace: {
      label: 'Ruang kerja agen',
      hint: 'Di dalam agen yang terbuka: panel berkas dan panel-panel terbagi.',
    },
    chat: {
      label: 'Chat agen',
      hint: 'Semua kontrol di percakapan, dari pil model sampai tombol kirim.',
    },
    ssh: {
      label: 'SSH',
      hint: 'Host tersimpan, dan rail di dalam sesi yang tersambung.',
    },
  },
  steps: {
    // ── overview ──────────────────────────────────────────────────────────
    welcome: {
      title: 'Selamat datang di DevDeck',
      description:
        'DevDeck menjalankan agen coding dari banyak proyek sekaligus — masing-masing di git worktree sendiri, lengkap dengan terminal langsung. Tur ini menunjukkan kontrol yang paling sering Anda pakai.<br><br>Gunakan <b>←</b> dan <b>→</b> untuk berpindah langkah, <b>Esc</b> untuk keluar kapan saja.',
    },
    'workspace-switcher': {
      title: 'Workspace',
      description:
        'Lencana ini adalah workspace yang sedang aktif — anggap saja “satu klien” atau “satu tim”. Klik untuk berpindah workspace, mengganti nama, atau membuat yang baru. Semua proyek berada di dalam sebuah workspace.',
    },
    'sidebar-toggle': {
      title: 'Panel proyek',
      description:
        'Membuka rail menjadi pohon proyek: seluruh repo di workspace ini beserta worktree dan issue-nya. Tutup lagi kalau Anda butuh layar yang lebih lega.',
    },
    'nav-rail': {
      title: 'Navigasi utama',
      description:
        '<b>Agents</b> adalah layar ini. <b>SSH</b> berisi host remote yang tersimpan, <b>Runtimes</b> mesin yang benar-benar menjalankan proyek Anda, <b>Tools</b> alat bantu konversi berkas, dan <b>Memory</b> ingatan agen Anda antar sesi.',
    },
    'agents-heading': {
      title: 'Ringkasan semua yang berjalan',
      description:
        'Angka di bawah judul: berapa agen yang aktif, berapa yang berupa worktree branch, dan berapa shell root yang duduk di checkout asli proyek.',
    },
    'agents-search': {
      title: 'Filter',
      description:
        'Ketik untuk menyaring daftar berdasarkan proyek, branch, model, tugas, atau status. Berguna begitu jumlah agen di satu workspace melebihi satu layar.',
    },
    'agents-view-toggle': {
      title: 'Kartu atau daftar',
      description:
        'Tampilan kartu menunjukkan status, model, dan tombol tiap agen. Tampilan daftar memuat jauh lebih banyak baris pada tinggi yang sama — lebih cocok saat Anda hanya memeriksa sekilas.',
    },
    'agents-refresh': {
      title: 'Muat ulang',
      description:
        'Membaca ulang status langsung dari setiap runtime: status worktree, jumlah token, dan statistik diff. Tampilan juga menyegarkan dirinya sendiri — tombol ini untuk saat Anda ingin sekarang juga.',
    },
    'agents-new': {
      title: 'Menjalankan agen baru',
      description:
        'Pilih proyek, nama branch baru dan branch dasarnya, tulis tugasnya, lalu pilih CLI agen dan modelnya. DevDeck menjalankan <code>git worktree add</code> yang sungguhan, jadi checkout utama Anda tidak pernah tersentuh. Mode root memberi Anda shell biasa di root proyek.',
    },
    'agents-management': {
      title: 'Pengelolaan agen',
      description:
        'Daftar CLI agen yang terdeteksi beserta model yang tersedia, ditambah server MCP, skill, dan profil environment. Mulailah dari sini kalau ada model yang seharusnya ada tapi tidak muncul.',
    },
    'worktree-card': {
      title: 'Satu agen',
      description:
        'Titik warnanya menandakan status — sedang berjalan, menunggu Anda, atau berhenti. <b>Open</b> membuka tampilan tiling penuh: terminal, file explorer, editor, dan panel git, semuanya menyambung kembali ke proses yang sama. <b>Details</b> untuk mengubah branch, tugas, atau model.',
    },
    'desktop-settings': {
      title: 'Pengaturan desktop',
      description:
        'Hanya ada di aplikasi desktop: cara backend bawaan di-bind, berbagi lewat Tailscale, akun Anda, dan pembaruan aplikasi.',
    },
    'help-fab': {
      title: 'Tur selesai',
      description:
        'Tombol ini membuka tur lagi kapan pun Anda mau, menawarkan tur mendalam untuk layar yang sedang Anda buka, sekaligus mengganti bahasanya antara Indonesia dan Inggris. Selamat bekerja.',
    },

    // ── workspace ─────────────────────────────────────────────────────────
    'workspace-intro': {
      title: 'Di dalam satu agen',
      description:
        'Di sinilah agen benar-benar bekerja: panel berkas di kiri, dan panel-panel bertiling di kanan yang berisi terminal, editor, diff, dan chat. Tur ini membahasnya satu kontrol demi satu kontrol.<br><br>Gunakan <b>←</b> dan <b>→</b> untuk berpindah langkah, <b>Esc</b> untuk keluar kapan saja.',
    },
    'shell-sidebar-toggle': {
      title: 'Menampilkan atau menyembunyikan panel samping',
      description:
        'Menutup seluruh panel kiri supaya terminal dan chat mendapat lebar penuh, lalu membukanya lagi. Pintasan keyboard di tooltip-nya melakukan hal yang sama tanpa perlu mouse.',
    },
    'shell-sidebar-tabs': {
      title: 'Explorer · Git · Sessions',
      description:
        '<b>Explorer</b> adalah pohon berkas worktree ini. <b>Git</b> menampilkan apa saja yang berubah — klik satu berkas untuk membuka diff-nya sebagai tab tersendiri. <b>Sessions</b> mendaftar semua percakapan di worktree ini, jadi obrolan lama bisa dibuka lagi di panel chat.',
    },
    'explorer-new-file': {
      title: 'Berkas baru',
      description:
        'Membuat berkas di dalam folder yang disebut tooltip-nya — folder yang sedang Anda pilih, atau root pohon kalau tidak ada yang dipilih. Namanya diketik langsung di pohonnya.',
    },
    'explorer-new-folder': {
      title: 'Folder baru',
      description: 'Sama, tetapi untuk direktori. Keduanya menulis di mesin yang menampung worktree ini, bukan di komputer Anda.',
    },
    'explorer-refresh': {
      title: 'Muat ulang pohon berkas',
      description:
        'Membaca ulang isi folder dari mesinnya. Pakai ini kalau agen baru saja membuat, memindahkan, atau menghapus berkas tetapi pohonnya masih menampilkan bentuk lama.',
    },
    'explorer-collapse': {
      title: 'Tutup semua folder',
      description:
        'Melipat kembali semua folder yang terbuka sampai ke root — cara tercepat keluar dari pohon yang sudah Anda buka enam tingkat ke dalam. Nonaktif kalau memang tidak ada yang terbuka.',
    },
    'explorer-more': {
      title: 'Aksi berkas lainnya',
      description:
        'Mengunggah berkas ke folder terpilih, mengemas pilihan Anda jadi zip untuk diunduh, memasang dependensi language server untuk editor di proyek ini, dan menghapus yang terpilih. Semuanya juga punya pintasan keyboard dan entri klik-kanan di pohon berkas.',
    },
    'explorer-quick-open': {
      title: 'Cari berkas dan folder',
      description:
        'Mencari berdasarkan nama dengan pencocokan longgar lalu langsung membuka hasilnya — Anda tidak perlu membuka folder satu per satu. Pintasan di sebelah kanan membuka hal yang sama.',
    },
    'explorer-content-search': {
      title: 'Cari di dalam berkas',
      description:
        'Mencari <i>isi</i> berkas di seluruh worktree, bukan namanya, dan mendaftar setiap kecocokan beserta barisnya. Mengklik satu hasil membuka berkasnya tepat di baris itu.',
    },
    'pane-tabs': {
      title: 'Tab panel',
      description:
        'Satu tab untuk tiap terminal, editor, diff, atau chat. Seret sebuah tab ke panel lain untuk memindahkannya, atau ke tepi sebuah panel untuk membelah di sana. Klik tengah menutup tab, sama seperti tombol <b>×</b> padanya; tanda <b>*</b> berarti ada perubahan editor yang belum disimpan.',
    },
    'pane-new-tab': {
      title: 'Tab baru',
      description:
        'Membuka terminal, berkas, diff, atau chat lain di dalam panel <i>ini</i>. Pintasan di tooltip-nya melakukan hal yang sama untuk panel mana pun yang sedang fokus.',
    },
    'pane-split-right': {
      title: 'Belah ke kanan',
      description:
        'Membagi panel ini menjadi dua berdampingan, supaya terminal dan diff-nya — atau dua agen sekaligus — bisa dibaca bersamaan. Seret pembatas di antaranya untuk mengatur perbandingannya.',
    },
    'pane-split-down': {
      title: 'Belah ke bawah',
      description:
        'Pembelahan yang sama, tetapi bertumpuk. Pembelahan bisa bersarang, jadi tata letaknya boleh dibangun sedalam yang masih masuk akal di layar Anda.',
    },
    'pane-more-actions': {
      title: 'Aksi lainnya',
      description:
        'Aksi untuk apa pun isi panel ini — perintah worktree untuk sebuah shell, aksi editor untuk sebuah berkas. Hanya muncul di panel yang sedang fokus, jadi layar terbelah tidak pernah menampilkan dua menu yang saling bersaing.',
    },
    'pane-close': {
      title: 'Tutup panel',
      description:
        'Menutup panel beserta semua tab di dalamnya. Yang ada di belakangnya tetap berjalan: menutup tampilan terminal tidak mematikan shell-nya, dan menutup chat tidak menghentikan giliran agen — buka lagi dan Anda tersambung kembali ke proses yang sama.',
    },

    // ── chat ──────────────────────────────────────────────────────────────
    'chat-intro': {
      title: 'Percakapan dengan agen',
      description:
        'Satu thread dengan satu agen: apa yang Anda minta, semua yang dikerjakannya, dan kontrol yang menentukan cara ia menjawab berikutnya. Tur ini membahas semuanya satu per satu.<br><br>Gunakan <b>←</b> dan <b>→</b> untuk berpindah langkah, <b>Esc</b> untuk keluar kapan saja.',
    },
    'chat-header': {
      title: 'Header thread',
      description:
        'Lencananya menyebut thread ini menempel pada apa. Titik warnanya adalah koneksi — hijau tersambung, kuning sedang menyambung, merah putus — dan kata di sebelahnya adalah agennya sendiri: <b>Idle</b>, <b>Running</b>, <b>Waiting</b> (ia menanyakan sesuatu dan menunggu jawaban Anda), atau <b>Stopped</b>.',
    },
    'chat-telegram': {
      title: 'Publish ke Telegram',
      description:
        'Menyalin thread ini ke sebuah chat Telegram, jadi Anda tetap bisa membacanya — dan tetap bisa menjawab permintaan izin — dari ponsel. Perlu bot token dulu; selama belum ada, tombolnya justru mengatakan itu, dan tempat mengaturnya di Settings → Network → Telegram.',
    },
    'chat-transcript': {
      title: 'Transkrip',
      description:
        'Pesan Anda, jawaban agen, dan setiap pemanggilan tool yang dilakukannya di sepanjang jalan. Pemanggilan tool dan blok kode panjang datang dalam keadaan terlipat — klik untuk melihat perintah persisnya dan apa yang dikembalikan.',
    },
    'chat-input': {
      title: 'Kotak prompt',
      description:
        'Ketik <code>@</code> untuk menarik berkas dari worktree ini ke dalam pesan, <code>/</code> untuk menjalankan slash command seperti <code>/plan</code> atau <code>/build</code>, dan gambar bisa langsung di-drop atau di-paste. <b>Enter</b> mengirim; <b>Shift+Enter</b> membuat baris baru.',
    },
    'chat-model': {
      title: 'Agen dan model',
      description:
        'CLI agen mana yang menjawab, dan model mana miliknya. Daftarnya adalah yang benar-benar terdeteksi di mesin itu — kalau ada model yang hilang, hilangnya di sana, dan Agent management tempat memeriksanya. Pilihan ini ikut pada pesan berikutnya, bukan me-restart apa pun.',
    },
    'chat-effort': {
      title: 'Kedalaman berpikir dan context window',
      description:
        'Bagian kiri adalah seberapa keras model berpikir sebelum menjawab, dari <b>Low</b> sampai <b>Max</b>, ditambah <b>Ultrathink</b>. Bagian kanan adalah seberapa banyak percakapan yang dibawa sebelum ia memadatkan dirinya — <b>200k</b>, <b>1M</b>, atau ukuran khusus antara 100k dan 1M.',
    },
    'chat-permission': {
      title: 'Apa yang boleh dilakukan tanpa bertanya',
      description:
        '<b>Approval required</b> berhenti di setiap perintah dan setiap perubahan berkas. <b>Auto-accept edits</b> membiarkannya menulis berkas tetapi tetap bertanya sebelum menjalankan sesuatu. <b>Auto</b> membiarkan agen yang mendukungnya menyetujui aksi rutin. <b>Full access</b> tidak bertanya sama sekali — simpan untuk mesin yang Anda rela kehilangan.',
    },
    'chat-usage': {
      title: 'Context yang terpakai',
      description:
        'Cincinnya terisi seiring percakapan membesar. Klik untuk melihat jumlah token persisnya terhadap window yang dipilih di pil sebelahnya, dan total yang sudah diproses.',
    },
    'chat-more-controls': {
      title: 'Kontrol yang sama, dilipat',
      description:
        'Di panel yang terlalu sempit untuk satu baris penuh — rail SSH, atau layar yang terbelah tiga — semua pemilih itu pindah ke sini alih-alih terpotong. Model, kedalaman berpikir, context window, dan izin, semuanya utuh.',
    },
    'chat-attach': {
      title: 'Lampirkan gambar',
      description:
        'Menambahkan tangkapan layar atau diagram ke pesan berikutnya; menyeret atau menempel ke kotak prompt hasilnya sama. Tidak semua CLI agen menerima gambar — kalau tidak, tombolnya mengatakan itu sejak awal, bukan gagal setelah diunggah.',
    },
    'chat-send': {
      title: 'Kirim',
      description:
        'Mengirim pesan. Selagi satu giliran berjalan, tombol ini berubah menjadi <b>Stop</b> yang menghentikannya — dan pesan yang dikirim <i>di tengah</i> giliran akan mengarahkan giliran yang sedang berjalan, bukan mengantre di belakangnya.',
    },

    // ── ssh ───────────────────────────────────────────────────────────────
    'ssh-intro': {
      title: 'SSH',
      description:
        'Server yang Anda simpan — dan, begitu tersambung ke salah satunya, rail yang mengubah terminal biasa menjadi ruang kerja. Tur ini membahas mana pun di antara keduanya yang sedang tampil.<br><br>Gunakan <b>←</b> dan <b>→</b> untuk berpindah langkah, <b>Esc</b> untuk keluar kapan saja.',
    },
    'ssh-heading': {
      title: 'Apa saja yang tersimpan',
      description:
        'Angka di bawah judul: berapa host yang tersimpan, berapa yang host key-nya sudah dipin pada koneksi pertama, dan berapa grup tempat mereka dikelompokkan.',
    },
    'ssh-search': {
      title: 'Saring host',
      description:
        'Mencocokkan nama, grup, hostname, port, username, dan jenis autentikasi sekaligus — jadi “prod”, “5432”, dan “root” sama-sama menemukan sesuatu yang berguna.',
    },
    'ssh-view-toggle': {
      title: 'Kartu atau daftar',
      description:
        'Kartu memberi tiap host ubin sendiri dengan detail lengkap. Daftar memuat jauh lebih banyak baris pada tinggi yang sama dan tetap menyertakan Connect, Edit, serta Delete di setiap barisnya.',
    },
    'ssh-new-host': {
      title: 'Host baru',
      description:
        'Alamat, user, dan salah satu dari password atau private key — disimpan terenkripsi, bukan teks biasa. Sebuah host juga bisa diberi jump host untuk dilompati, dan runtime eksekutor sebagai titik panggilnya, sehingga server yang hanya bisa dijangkau satu mesin tetap terjangkau dari sini.',
    },
    'ssh-host-card': {
      title: 'Satu host',
      description:
        'Ikonnya menandakan cara autentikasinya: kunci untuk private key, server untuk password. Lencana di bawah nama mengulang itu dalam kata, plus dua hal yang paling perlu dilihat sekilas — <i>via</i> runtime yang memanggilnya, dan jump host yang dilompatinya.',
    },
    'ssh-host-connect': {
      title: 'Connect',
      description:
        'Membuka host itu sebagai tab shell di workspace ini: terminal sungguhan, dengan file explorer untuk filesystem remote di sebelahnya dan rail DevOps di kanan.',
    },
    'ssh-host-edit': {
      title: 'Edit',
      description:
        'Membuka kembali formulir yang sama — alamat, kredensial, grup, jump host, runtime eksekutor. Perubahannya berlaku pada koneksi berikutnya, jadi sesi yang sedang terbuka tidak terganggu.',
    },
    'ssh-host-delete': {
      title: 'Delete',
      description: 'Menghapus host tersimpan beserta kredensial yang menyertainya, setelah konfirmasi.',
    },
    'ssh-host-key': {
      title: 'Host key',
      description:
        'Sidik jari server, dipin pada koneksi pertama dan dibandingkan pada setiap koneksi berikutnya — perbandingan itulah yang memberi tahu Anda bahwa mesin yang menjawab masih mesin yang Anda simpan. Reset hanya kalau Anda tahu servernya memang dibangun ulang; ia akan dipin ulang pada koneksi berikutnya.',
    },
    'ssh-rail-chat': {
      title: 'DevOps Chat',
      description:
        'Agen yang punya shell di server <i>ini</i>. Ia berjalan di runtime eksekutor yang ditetapkan untuk koneksi ini — mesin yang benar-benar bisa menjangkau host-nya — bukan di hub. Minta ia membaca log, me-restart layanan, atau mengejar sebuah kegagalan, dan perintahnya dijalankan di sini.',
    },
    'ssh-rail-stats': {
      title: 'Stats',
      description: 'Pemakaian sumber daya server yang tersambung di tab ini, dibaca lewat koneksi yang sama.',
    },
    'ssh-rail-forwards': {
      title: 'Port forwarding',
      description:
        'Terowongan untuk koneksi ini: <code>-L</code> membawa port remote ke sisi Anda, <code>-R</code> membuka port Anda di server, <code>-D</code> membuka proxy SOCKS lewatnya. Inilah cara menjangkau database atau dashboard internal yang tidak dipublikasikan ke mana pun.',
    },
    'ssh-chat-history': {
      title: 'Riwayat sesi',
      description:
        'Semua percakapan yang pernah dilakukan dengan host ini. Memilih salah satunya menggantinya di tempat, jadi obrolan yang sedang Anda baca tidak hilang tertimpa daftar setinggi panel.',
    },
    'ssh-chat-new-session': {
      title: 'Sesi baru',
      description:
        'Memulai percakapan baru dengan host ini — context yang bersih untuk pekerjaan yang tidak berhubungan, sementara yang lama tetap terdaftar di tombol riwayat.',
    },
  },
}

export const TOUR_COPY: Record<TourLang, TourCopy> = { en: EN, id: ID }

export function tourCopy(lang: TourLang): TourCopy {
  return TOUR_COPY[lang]
}

/** Label shown next to each language choice, in that language — a reader who
 *  landed on the wrong one still recognises their own. */
export const TOUR_LANG_LABEL: Record<TourLang, string> = {
  id: 'Bahasa Indonesia',
  en: 'English',
}

/** Two-letter badge for the compact toggle in the help panel. */
export const TOUR_LANG_SHORT: Record<TourLang, string> = { id: 'ID', en: 'EN' }
