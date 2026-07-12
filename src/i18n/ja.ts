// Machine-translated from en. Native review welcome.

export const jaDict: Record<string, string> = {
  'access.denied': 'アクセスが拒否されました。',
  'access.group_only': '設定されたフォーラムスーパーグループでのみ動作します。',

  'thread.no_binding':
    '📁 このスレッドはフォルダにバインドされていません。/bind <subdir> を使うかリストから選んでください。',
  'thread.bind_required':
    '📁 まずフォルダをバインドしてください: /bind <subdir>。エージェントはバインドされたフォルダ内でのみ動作します。',
  'thread.bound': '📁 `{subdir}` にバインドしました。\n/claude または /opencode を実行してください。',
  'thread.unbound': '📁 バインドを解除しました。',
  'thread.general_no_agent':
    'General はフォルダにバインドされていません — エージェントと話すにはトピックスレッドに切り替えてください。',
  'thread.welcome_bound':
    '👋 スレッドを作成し、`{subdir}` に自動バインドしました（スレッド名がサブフォルダと一致）。\n/claude または /opencode を実行してください。',
  'thread.welcome_pick':
    '👋 スレッドを作成しました。フォルダをバインド: /bind <subdir>、または下から選んでください。',
  'thread.bind_collision':
    '⚠️ フォルダ `{subdir}` は既にスレッドで使用中: {threads}。\nバインドを追加しました; セッションは独立しています（それぞれの tmux/SSE）。',
  'thread.no_agent_with_binding':
    '📁 フォルダ `{subdir}` がバインドされています。/claude または /opencode を実行してダイアログを開始してください。',

  'bind.usage': '使い方: /bind <subdir>\n例: /bind overview',
  'bind.current': '📂 現在のバインド: `{subdir}`',
  'bind.current_none': '📂 まだバインドされていません',
  'bind.in_general': '/bind はトピックスレッドでのみ動作します。General では使えません。',
  'bind.invalid_chars': '❌ フォルダ名に制御文字を含めることはできません。',
  'bind.not_found': '❌ フォルダ `{subdir}` が `WORK_ROOT` (`{workRoot}`) に見つかりません。',
  'bind.outside_root': '❌ パスが `WORK_ROOT` の外に出ています。',
  'bind.not_directory': '❌ `{subdir}` は存在しますが、フォルダではありません。',

  'bind.leave_button': '⬅️ 現在のディレクトリを離れる',
  'bind.create_button': '➕ 新しいフォルダを作成',
  'bind.create_prompt':
    '✏️ 新しいフォルダ名を送信してください（`WORK_ROOT` の下に作成されます）。コマンドを送るとキャンセルされます。',
  'bind.create_cb': '新しいフォルダを作成中…',
  'bind.create_empty': '❌ 名前が空です。フォルダ名を送信してください。',
  'bind.create_separator': '❌ 名前に `/` や `\\` を含めることはできません。シンプルな名前を送信してください。',
  'bind.create_dot_segment': '❌ `.` や `..` はフォルダ名として使えません。',
  'bind.create_hidden': '❌ 名前をドットで始めることはできません。',
  'bind.create_invalid_chars': '❌ フォルダ名に制御文字を含めることはできません。',
  'bind.create_exists': '📁 フォルダ `{subdir}` は既に存在します — バインドしています。',
  'bind.create_failed': '❌ フォルダの作成に失敗しました: {error}',

  'ls.header': '📁 `{workRoot}` のサブフォルダ:',
  'ls.empty': '📁 `WORK_ROOT` の下にバインド可能なサブフォルダがありません。',
  'list.header': '🧵 スレッドバインド ({count}):',
  'list.empty': '🧵 バインドがまだありません。スレッドを作成して /bind を実行してください。',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new はバインドされたトピック内で動作します — スレッドを開いて /new を実行し、エージェントセッションを再起動してください。',

  'help.general':
    '*General のコマンド:*\n' +
    '/ls — `WORK_ROOT` サブフォルダ一覧\n' +
    '/list — スレッド一覧\n' +
    '/status — 全スレッドの状態\n' +
    '/quitall — 実行中の全エージェントを終了\n' +
    '/whoami /version — デバッグ\n\n' +
    'エージェントと話すには — トピックスレッドを開いてください。',
  'help.thread_unbound':
    '*スレッドがフォルダにバインドされていません。*\n' +
    '/bind <subdir> — バインド（またはリストから選択）\n' +
    '/ls — `WORK_ROOT` サブフォルダ（General で）',
  'help.thread_bound':
    '*スレッドは `{subdir}` にバインドされています。*\n' +
    '/claude /opencode — エージェントを起動\n' +
    '/connect — OpenCode プロバイダー API key を接続（デフォルトは OpenAI）\n' +
    '/terminal — このフォルダでシェルを開く\n' +
    '/new — セッションを再起動（旧 → /sessions）\n' +
    '/model /sessions — 切り替え\n' +
    '/effort — reasoning effort レベル\n' +
    '/verbosity — 出力の詳細度（thinking/tools/サブエージェント）\n' +
    '/quit /status /output — 制御\n' +
    '/compact — エージェントのコンテキストを圧縮\n' +
    '/clear — スレッドのメッセージを削除\n' +
    '/c /y /n /enter /up /down /tab /esc — TUI キー（Claude）\n' +
    '/bind — バインドを管理',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'Bot がグループ管理者です',
  'doctor.can_manage_topics': '`can_manage_topics` が付与されました',
  'doctor.can_delete_messages': '`can_delete_messages` が付与されました',
  'doctor.can_pin_messages': '`can_pin_messages` が付与されました',
  'doctor.privacy_off': 'Privacy mode が無効です',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable、その後 Bot を削除して再追加',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} サブフォルダ)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI がインストール済み',
  'doctor.opencode_installed': 'opencode CLI がインストール済み',
  'doctor.state_valid':
    'state.json が有効です（{bindings} バインド、{active} アクティブ）',
  'doctor.state_archived':
    '以前の state.json が破損していました、アーカイブ: {path}',
  'doctor.cli_missing':
    'PATH に見つかりません（/claude または /opencode で自動インストールされます）',
  'doctor.no_admin_info':
    'Bot の権限を読めません — getChatMember が失敗しました',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    '稼働準備チェックリスト:\n' +
    '1️⃣ 私をグループ管理者にしてください。権限:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable、その後私を削除して再追加\n' +
    '3️⃣ /doctor を実行して不足を確認\n' +
    '4️⃣ 各トピックスレッドで /bind <subdir> を実行しエージェントを起動\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 `{subdir}` にバインドしました',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} サーバー',
  'binding.welcome.git': '• git: ブランチ `{branch}`{detail}',
  'binding.welcome.git_clean': ', クリーン',
  'binding.welcome.git_dirty': ', 未コミットの変更',
  'binding.welcome.git_none': '• git: 初期化されていません',
  'binding.welcome.start_prompt': '会話を開始:',

  'mcp.header': '🔌 *このスレッドの MCP サーバー:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 MCP サーバーが設定されていません。',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'スレッドのピン留め状態（Stage 7）は利用できません',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '（バインドなし）',

  'pair.success': '✅ グループをペアリングしました。id: `{groupId}`。Bot がこのスーパーグループを提供します。',
  'pair.locked':
    'ℹ️ グループ id は `ALLOWED_GROUP_ID` で設定されています — 自動ペアリングは無効です。 ' +
    'グループを切り替えるには変数を変更して Bot を再起動してください。',
  'pair.only_forum': '❌ /pair はフォーラムスーパーグループ内でのみ動作します（Topics を有効化）。',
  'pair.not_admin': '❌ グループの管理者または作成者のみが Bot をペアリングできます。',
  'pair.not_paired': 'グループはまだペアリングされていません（ペアリングモード）',
  'pair.dm': "ℹ️ DM モードでは /pair は不要です — Bot はあなたのプライベートチャットを提供します。",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '（利用不可）',
  'status.global_header': '📊 *全スレッド* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 まだスレッドがありません。',
  'language.status': '🌐 言語: {display}',
  'language.set_success': '✅ このチャットの言語を `{locale}` に設定しました。',
  'language.auto_success': '✅ 言語を自動に戻しました。現在: {display}。',
  'language.invalid': '⚠️ locale `{locale}` はサポートされていません。利用可能: {locales}。',

  'agent.ready': '{label} が `{subdir}`{argsSuffix} で準備完了\nメッセージを送信:',
  'agent.no_session': 'エージェントが実行中ではありません。/claude または /opencode で起動。',
  'agent.session_ended': '{label}: セッション終了',
  'agent.stopped': '{label} 停止',
  'agent.exit_signal_sent': 'Ctrl+C を2回送信 — {label} が終了中',
  'agent.already_active': '{label} は既にここで実行中です。メッセージを送るか /quit。',
  'agent.starting': '`{subdir}` で {label} を起動中…',
  'agent.queued_starting': '⏳ {label} はまだ起動中 — メッセージはキューに入り、準備完了次第送信されます。',
  'agent.question_hint': 'ℹ️ オプション番号（例: 1）または y/n で返答してください。他: /up /down で移動、/enter で確定、/c でキャンセル。',
  'agent.start_failed': '{label} の起動に失敗: {error}',
  'agent.question_cancelled_for_prompt': '⚠️ 前の質問をキャンセル — 新しいリクエストを実行中。',
  'agent.question_cancelled_msg_label': '❌ 質問キャンセル: {header}',
  'agent.login_code_relayed': '🔐 ログインコードを Claude に中継 — トークンを含むメッセージを履歴から削除しました。',
  'agent.workingIndicator': '{glyph} 作業中…',
  'terminal.ready': '🖥 `{subdir}`{argsSuffix} でターミナル準備完了\n各メッセージはコマンドとして実行されます。/c — Ctrl+C、/up /down — 履歴、/tab — 補完、/quit — 閉じる。',

  'effort.choose': '⚙️ 現在の effort: {current}\nレベルを選択:',
  'effort.current_none': '未設定',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ レベル `{level}` は無効です。利用可能: {valid}。',
  'effort.not_available': 'ℹ️ 現在のモデルでは reasoning effort レベルは利用できません。',
  'effort.not_supported': 'ℹ️ モデル `{model}` には reasoning effort レベルがありません。',
  'effort.start_agent_first': 'ℹ️ レベルを保存しました。エージェント未実行 — 次回起動時に適用されます。',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` をクリア: 新しいモデル `{model}` はサポートしていません。',
  'effort.unsupported_backend': '{label} の effort 制御はサポートされていません。',
  'effort.no_session': 'エージェントが実行中ではありません。/claude または /opencode で起動してください。',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 {seconds}秒間考えました',
  'thinking.choose': '☁️ 現在の thinking モード: {current}\nモードを選択:',
  'thinking.set_success': '✅ Thinking モード: {mode}',
  'thinking.invalid_mode': '⚠️ モード `{mode}` は無効です。利用可能: {valid}。',
  'thinking.mode.minimal': '最小',
  'thinking.mode.short': '短縮',
  'thinking.mode.full': '詳細',

  'toolResults.choose': '🔧 現在のツール結果モード: {current}\nモードを選択:',
  'toolResults.set_success': '✅ ツール結果モード: {mode}',
  'toolResults.invalid_mode': '⚠️ モード `{mode}` は無効です。利用可能: {valid}。',
  'toolResults.mode.minimal': '最小',
  'toolResults.mode.short': '短縮',
  'toolResults.mode.full': '詳細',
  'toolResults.truncated_footer': '…（切り詰め、/tool_results full）',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'ツール',

  'subagent.status_elapsed': '🤖 サブエージェント: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 サブエージェント作業中 …',
  'subagent.delegating_status': '🤖 委任中: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'サブエージェント',
  'subagent.choose': '🤖 現在のサブエージェントモード: {current}\nモードを選択:',
  'subagent.set_success': '✅ サブエージェントモード: {mode}',
  'subagent.invalid_mode': '⚠️ モード `{mode}` は無効です。利用可能: {valid}。',
  'subagent.mode.minimal': '最小',
  'subagent.mode.short': '短縮',
  'subagent.mode.full': '詳細',

  'verbosity.choose': '🔊 現在の出力の詳細度: {current}\nレベルを選択:',
  'verbosity.set_success': '✅ 出力の詳細度: {mode}（thinking、ツール結果、サブエージェント）',
  'verbosity.invalid_mode': '⚠️ モード `{mode}` は無効です。利用可能: {valid}。',
  'verbosity.custom': 'カスタム（thinking: {thinking} · ツール: {toolResults} · サブエージェント: {subagent}）',
  'verbosity.mode.minimal': '最小',
  'verbosity.mode.short': '短縮',
  'verbosity.mode.full': '詳細',

  'model.saved_for_next_start': 'モデルを保存: {model} — 次回エージェント起動時に適用されます。',
  'model.start_agent_first': 'アクティブなセッションがありません。先にエージェントを起動してください。',

  'rename_session.usage': '使い方: /rename_session <新しいタイトル>',
  'rename_session.start_agent_first': 'アクティブなセッションがありません。先にエージェントを起動してください（/claude または /opencode）。',
  'rename_session.unsupported_backend': '{label} ではセッションの名前変更はサポートされていません。',
  'rename_session.success': '✅ セッション名を変更: {title}',
  'rename_session.failed': '⚠️ セッション名の変更に失敗: {reason}',

  'connect.prompt_key': '🔑 次のメッセージで `{provider}` の API key を送信してください。キーを含むメッセージを履歴から削除します。',
  'connect.empty_key': '❌ API key が空です。次のメッセージでキーを送信してください。',
  'connect.invalid_provider': '❌ 無効なプロバイダー id `{provider}`。例: /connect openai',
  'connect.unsupported_provider': '⚠️ プロバイダー `{provider}` はこのフローでのシンプル API key ログインをサポートしていません。このプロバイダーには OpenCode UI/CLI を使用してください。',
  'connect.unsupported_backend': 'このビルドでは OpenCode プロバイダー認証は利用できません。',
  'connect.failed': '⚠️ `{provider}` の接続に失敗: {reason}',
  'connect.success': '✅ プロバイダー `{provider}` に接続しました。OpenCode サーバーは再起動されませんでした。',
  'connect.cancelled': 'API key 入力がキャンセルされました。',

  'quit_all.none_active': '実行中のエージェントがいません — 停止するものはありません。',
  'quit_all.summary': '🚪 アクティブなエージェント {total} 件中 {stopped} 件を終了しました。',
  'quit_all.general_only': '`/quit-all` は General トピックでのみ利用可能です。',

  'clearMessages.summary':
    '🗑 {total} 件中 {deleted} 件のメッセージを削除しました。 ' +
    'Telegram は48時間以上前のメッセージの削除を拒否します — 残りは履歴に残ります。',
  'clearMessages.no_messages': 'このスレッドに削除するメッセージはありません。',

  'edited.hint':
    '✏️ 編集されたメッセージは新しい入力として扱いません — 修正を別のメッセージとして送信してください。',

  'voice.no_api_key':
    '音声には `GROQ_API_KEY`（無料）または `OPENAI_API_KEY` が必要です。',
  'voice.failed': '音声メッセージの文字起こしに失敗しました。',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 ファイルが Bot API の制限（{cap} MB）を超えています — ダウンロードできません。より小さいファイルを送信してください。',
  'file.download_failed': '📎 ファイルのダウンロードに失敗しました。再試行してください。',

  'error.workdir.gone':
    '📁 フォルダ `{subdir}` がディスクから消滅しました。/bind <newdir> を実行してください。',
  'error.tg.thread.deleted':
    '⚠️ スレッドが Telegram で削除されました; バインドを解除しました。',
  'error.tg.thread.closed':
    '🔒 スレッド {key} は閉じています — Telegram クライアントで再度開くか、完全に削除してください。',
  'error.tg.perm.delete':
    '🔐 メッセージを削除できません。Bot に `can_delete_messages` を付与してください。',
  'error.tg.perm.manage_topics':
    '🔐 `can_manage_topics` が不足しています。私をグループ管理者にしてください。',
  'error.state.corrupted':
    '⚠️ state.json が破損していました; バインドをリセットしました。必要なところで /bind を再実行してください。',
  'error.start_in_general':
    'General でエージェントを起動できません — それはサービストピックです。トピックスレッドを開いてください。',

  'cb.access_denied': 'アクセス拒否',
  'cb.bind_only_topical': '/bind はトピックスレッドでのみ動作します',
  'cb.binding_to': '{subdir} にバインド中…',
  'cb.no_active_session': 'アクティブなセッションがありません',
  'cb.model_error': 'エラー: {error}',
  'cb.model_set': 'モデル: {model}',
  'cb.not_supported': '{label} ではサポートされていません',
  'cb.unknown_agent': '不明なエージェント',
  'cb.agent_switched': '{label} に切り替え',
  'cb.resume_only_topical': 'Resume はトピックスレッドでのみ動作します',
  'cb.bind_folder_first': 'まず /bind でフォルダをバインドしてください',
  'cb.agent_not_running': 'エージェント未実行',
  'cb.no_pending_question': '保留中の質問はありません',
  'cb.invalid_option': '無効なオプション',
  'cb.sent_option': '送信: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'エラー: {error}',
  'cb.claudeMode_already': '既にアクティブ',
  'cb.claudeMode_switching': '切り替え中…',
  'claudeMode.pick': '⚙️ Claude Code バックエンド — 現在: {label}\nバックエンドを選択（切り替えで同じ会話を維持）:',
  'claudeMode.not_claude': "このトピックは Claude Code ではありません — /claude_mode は Claude のバックエンドのみ切り替えます。",
  'claudeMode.already': '既に {label} です。',
  'claudeMode.set_idle': '⚙️ Claude バックエンド: {label} — 次回起動時に適用されます。',
  'claudeMode.switched_resumed': '⚙️ {label} に切り替え — 同じ会話を再開しました。',
  'claudeMode.switched_fresh': '⚙️ {label} に切り替え — 新しいセッションを開始しました。',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'エラー: {error}',
  'cb.toolresults_set': 'ツール結果: {mode}',
  'cb.toolresults_error': 'エラー: {error}',
  'cb.subagent_set': 'サブエージェント: {mode}',
  'cb.subagent_error': 'エラー: {error}',
  'cb.verbosity_set': '出力の詳細度: {mode}',
  'cb.verbosity_error': 'エラー: {error}',

  'session.list_header': '再開可能なセッション（{label}）:',
  'session.list_footer': '1–{max} を送信して再開 · 0 で終了',
  'session.none': 'このフォルダに再開可能なセッションはありません。',
  'session.cancelled': 'キャンセルしました。セッション選択を閉じました。',
  'session.invalid': '無効な番号です。1 から {max} までの値を入力してください。',
  'session.resumed': 'セッションを再開しました。メッセージを送信:',
  'session.resume_failed': 'セッションの再開に失敗: {error}',
  'session.expired': 'セッションリストが古くなっています。/sessions を再実行してください。',
  'session.load_failed': 'セッションの読み込みに失敗しました。',

  'resume.context_header': '↩️ 再開 — 最後の {count} メッセージ:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ Bot オフライン中に {count} 件のメッセージを見逃しました。セッションの最新:',
  'recap.restartedFallbackHeader': '🔄 Bot が再起動しました。セッションの最新:',
  'recap.stillWorkingLine': '⏳ エージェントはまだ工作中…',

  'trace.onThisThreadReply': '🔎 このスレッドのトレースを有効化しました。',
  'trace.offThisThreadReply': '🔎 このスレッドのトレースを無効化しました。',
  'trace.onAllThreadsReply': '🔎 全スレッドのトレースを有効化しました。',
  'trace.offAllThreadsReply': '🔎 すべての場所でトレースを無効化しました（«all» フラグとスレッドリストをクリア）。',
  'trace.statusReply':
    '🔎 Trace — このスレッド: {thisThread}\n全スレッド: {allThreads}\nトレース中のスレッド: {count}',
  'trace.statusOnLabel': 'オン',
  'trace.statusOffLabel': 'オフ',
  'trace.usageHint': '使い方: /trace on | off | on all | off all |（引数なし — 状態）',

  'timestamps.onReply':
    '🕐 タイムスタンプ有効: エージェントに転送される各プロンプトの最初の行に送信時刻が付きます（トピックには投稿されません）。',
  'timestamps.offReply': '🕐 このスレッドのタイムスタンプを無効化しました。',
  'timestamps.statusOnReply': '🕐 タイムスタンプ: このスレッドでオン。',
  'timestamps.statusOffReply': '🕐 タイムスタンプ: このスレッドでオフ。',
  'timestamps.usageHint': '使い方: /timestamps on | off |（引数なし — 状態）',

  'schedule.fired':
    '⏰ スケジュール「{name}」({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — {time} に見逃し、追従中',
  'schedule.pausedUnbound':
    '⏸ 一時停止中のスケジュール: {count} — トピックがフォルダからアンバインドされました。/bind で復元されます。',
  'schedule.resumedRebind': '▶️ スケジュールを再開: {count}（次回実行は現在時刻から再計算）。',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN JAPANESE what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN JAPANESE what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN JAPANESE what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API レート制限 — {minutes} 分後に自動再試行します（試行 {attempt}）。',
  'apiRetry.usageLimitDelayNotice':
    '🚧 利用量制限に到達 — {minutes} 分後に再試行します（試行 {attempt}）。',
  'apiRetry.usageLimitResetNotice':
    '🚧 利用量制限に到達 — リセット後に自動再開します（~{time}）。',
  'apiRetry.resuming': '↻ 再開中…',
  'apiRetry.giveUp':
    '⚠️ {attempts} 回の試行後に再開できませんでした。続行する時にメッセージを送ってください。',
  'apiRetry.continueNudge': '止まったところから続けてください。',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude がログアウトしています — 続行するには /login を実行してください。',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: 認証情報が無効です — opencode サーバーを再起動してください。',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ 準備完了 — ボットのスレッドとグループのトピックのメッセージを処理できます。',
  'startup.header_not_ready':
    '⚠️ セットアップが未完了です。私と作業を始めるには、次の手順を完了してください：',
  'startup.item.create_group':
    'トピックを有効にしたフォーラム・スーパーグループを作成し、そこで私にメッセージを送ってペアリングしてください。',
  'startup.item.grant_admin':
    '次の権限を付与して私を管理者にしてください：{missing}。',
  'startup.item.bind_topic':
    'トピックを作成し、/bind でフォルダーに紐付けてください。',
  'startup.item.install_agent':
    'エージェント CLI をインストールしてください — claude または opencode。',
  'startup.item.optional_groq':
    '（任意）音声入力を有効にするには、.env に GROQ_API_KEY を追加して再起動してください。',
  'startup.item.optional_owner':
    '（任意）このステータスをプライベートチャットで受け取るには OWNER_USER_ID を設定してください。',
};
