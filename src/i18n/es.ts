// Machine-translated from en. Native review welcome.

export const esDict: Record<string, string> = {
  'access.denied': 'Acceso denegado.',
  'access.group_only': 'Solo funciono en el supergrupo foro configurado.',

  'thread.no_binding':
    '📁 Este hilo no está vinculado a una carpeta. Usa /bind <subdir> o elige de la lista.',
  'thread.bind_required':
    '📁 Vincula primero una carpeta: /bind <subdir>. El agente solo funciona en la carpeta vinculada.',
  'thread.bound': '📁 Vinculado a `{subdir}`.\nEjecuta /claude o /opencode.',
  'thread.unbound': '📁 Vínculo eliminado.',
  'thread.general_no_agent':
    'General no está vinculado a una carpeta — cambia a un hilo temático para hablar con un agente.',
  'thread.welcome_bound':
    '👋 Hilo creado y vinculado automáticamente a `{subdir}` (el nombre del hilo coincidió con una subcarpeta).\nEjecuta /claude o /opencode.',
  'thread.welcome_pick':
    '👋 Hilo creado. Vincula una carpeta: /bind <subdir>, o elige una de la lista.',
  'thread.bind_collision':
    '⚠️ La carpeta `{subdir}` ya la usan los hilos: {threads}.\nVínculo añadido; las sesiones siguen siendo independientes (tmux/SSE propios).',
  'thread.no_agent_with_binding':
    '📁 La carpeta `{subdir}` está vinculada. Ejecuta /claude o /opencode para iniciar el diálogo.',

  'bind.usage': 'Uso: /bind <subdir>\nEjemplo: /bind overview',
  'bind.current': '📂 Vinculado actualmente: `{subdir}`',
  'bind.current_none': '📂 Sin vincular todavía',
  'bind.in_general': '/bind solo funciona en hilos temáticos, no en General.',
  'bind.invalid_chars': '❌ El nombre de la carpeta no debe contener caracteres de control.',
  'bind.not_found': '❌ Carpeta `{subdir}` no encontrada bajo `WORK_ROOT` (`{workRoot}`).',
  'bind.outside_root': '❌ La ruta sale de `WORK_ROOT`.',
  'bind.not_directory': '❌ `{subdir}` existe pero no es una carpeta.',

  'bind.leave_button': '⬅️ Salir del directorio actual',
  'bind.create_button': '➕ Crear nueva carpeta',
  'bind.create_prompt':
    '✏️ Envía el nombre de la nueva carpeta (se creará bajo `WORK_ROOT`). Cualquier comando cancela.',
  'bind.create_cb': 'Creando nueva carpeta…',
  'bind.create_empty': '❌ El nombre está vacío. Envía un nombre de carpeta.',
  'bind.create_separator': '❌ El nombre no debe contener `/` o `\\`. Envía un nombre simple.',
  'bind.create_dot_segment': '❌ `.` y `..` no se pueden usar como nombre de carpeta.',
  'bind.create_hidden': '❌ El nombre no debe empezar con un punto.',
  'bind.create_invalid_chars': '❌ El nombre de la carpeta no debe contener caracteres de control.',
  'bind.create_exists': '📁 La carpeta `{subdir}` ya existe — vinculando a ella.',
  'bind.create_failed': '❌ Error al crear la carpeta: {error}',

  'ls.header': '📁 Subcarpetas de `{workRoot}`:',
  'ls.empty': '📁 No hay subcarpetas vinculables bajo `WORK_ROOT`.',
  'list.header': '🧵 Vínculos de hilos ({count}):',
  'list.empty': '🧵 Aún no hay vínculos. Crea un hilo y ejecuta /bind.',
  'list.row': '• {threadId}: `{subdir}` · {agent} · {status}',
  'list.row_closed': '• {threadId}: `{subdir}` · {agent} · 🔒 closed',
  'new.general_hint':
    '/new funciona dentro de un hilo vinculado — abre un hilo y ejecuta /new para reiniciar su sesión de agente.',

  'help.general':
    '*Comandos en General:*\n' +
    '/ls — listar subcarpetas `WORK_ROOT`\n' +
    '/list — listar hilos\n' +
    '/status — estado de todos los hilos\n' +
    '/quitall — detener todos los agentes en ejecución\n' +
    '/whoami /version — depuración\n\n' +
    'Para hablar con un agente — abre un hilo temático.',
  'help.thread_unbound':
    '*El hilo no está vinculado a una carpeta.*\n' +
    '/bind <subdir> — vincular (o elegir de la lista)\n' +
    '/ls — subcarpetas `WORK_ROOT` (en General)',
  'help.thread_bound':
    '*Hilo vinculado a `{subdir}`.*\n' +
    '/claude /opencode — iniciar un agente\n' +
    '/connect — conectar una API key de provider OpenCode (OpenAI por defecto)\n' +
    '/terminal — abrir un shell en esta carpeta\n' +
    '/new — reiniciar la sesión (la anterior → /sessions)\n' +
    '/model /sessions — cambiar\n' +
    '/effort — nivel de reasoning effort\n' +
    '/verbosity — verbosidad de salida (thinking/tools/sub-agentes)\n' +
    '/quit /status /output — control\n' +
    '/compact — compactar el contexto del agente\n' +
    '/clear — eliminar mensajes del hilo\n' +
    '/c /y /n /enter /up /down /tab /esc — teclas TUI (Claude)\n' +
    '/bind — gestionar vínculo',

  'doctor.header': '🔍 *TelegramCode Doctor*',
  'doctor.ok': '✅ {label}',
  'doctor.warn': '⚠️ {label} — {hint}',
  'doctor.fail': '❌ {label} — {hint}',
  'doctor.bot_admin': 'El bot es admin del grupo',
  'doctor.can_manage_topics': '`can_manage_topics` concedido',
  'doctor.can_delete_messages': '`can_delete_messages` concedido',
  'doctor.can_pin_messages': '`can_pin_messages` concedido',
  'doctor.privacy_off': 'Privacy mode desactivado',
  'doctor.privacy_hint':
    '@BotFather → /setprivacy → Disable, luego quita y vuelve a añadir el bot',
  'doctor.workroot_subdirs':
    '`WORK_ROOT`: `{workRoot}` ({count} subcarpetas)',
  'doctor.datadir_path': '`DATA_DIR`: `{dataDir}`',
  'doctor.claude_installed': 'claude CLI instalado',
  'doctor.opencode_installed': 'opencode CLI instalado',
  'doctor.state_valid':
    'state.json válido ({bindings} vínculos, {active} activos)',
  'doctor.state_archived':
    'el state.json anterior estaba corrupto, archivo: {path}',
  'doctor.cli_missing':
    'no encontrado en PATH (la auto-instalación se ejecutará con /claude o /opencode)',
  'doctor.no_admin_info':
    'no se pueden leer los derechos del bot — getChatMember falló',

  'onboarding.welcome':
    '👋 *TelegramCode Bot 2.0*\n\n' +
    'Lista de comprobación:\n' +
    '1️⃣ Hazme admin del grupo con derechos:\n' +
    '   • Manage Topics, Delete Messages, Pin Messages\n' +
    '2️⃣ @BotFather → /setprivacy → Disable, luego quítame y vuelve a añadirme\n' +
    '3️⃣ Ejecuta /doctor para ver qué falta\n' +
    '4️⃣ En cada hilo temático ejecuta /bind <subdir> e inicia un agente\n\n' +
    '`WORK_ROOT`: `{workRoot}`',

  'binding.welcome.header': '📁 Vinculado a `{subdir}`',
  'binding.welcome.claude_md': '• CLAUDE.md: {size}',
  'binding.welcome.mcp_json': '• `.mcp.json`: {count} servidores',
  'binding.welcome.git': '• git: rama `{branch}`{detail}',
  'binding.welcome.git_clean': ', limpio',
  'binding.welcome.git_dirty': ', cambios sin confirmar',
  'binding.welcome.git_none': '• git: no inicializado',
  'binding.welcome.start_prompt': 'Inicia una conversación:',

  'mcp.header': '🔌 *Servidores MCP para este hilo:*',
  'mcp.row': '• `{name}` — {source}',
  'mcp.empty': '🔌 No hay servidores MCP configurados.',
  'mcp.source_user': 'user (~/.claude/settings.json)',
  'mcp.source_group': 'group (`DATA_DIR`/mcp.json)',
  'mcp.source_project': 'project (`{workDir}/.mcp.json`)',
  'mcp.source_thread': 'thread (`DATA_DIR`/threads/...)',

  'doctor.pin_hint': 'El estado fijado del hilo (Stage 7) no estará disponible',

  'whoami.report':
    '👤 user: `{userId}`\n💬 chat: `{chatId}`\n🧵 thread: `{threadId}`\n' +
    '🔐 allowed: {allowed}\n📁 binding: {binding}',
  'whoami.binding_unbound': '(sin vínculo)',

  'pair.success': '✅ Grupo emparejado. id: `{groupId}`. El bot ahora sirve a este supergrupo.',
  'pair.locked':
    'ℹ️ El id del grupo está definido vía `ALLOWED_GROUP_ID` — el auto-emparejamiento está desactivado. ' +
    'Para cambiar de grupo, modifica la variable y reinicia el bot.',
  'pair.only_forum': '❌ /pair solo funciona en un supergrupo foro (activa Topics).',
  'pair.not_admin': '❌ Solo un administrador o creador del grupo puede emparejar el bot.',
  'pair.not_paired': 'grupo aún no emparejado (modo pairing)',
  'pair.dm': "ℹ️ /pair no es necesario en modo DM — el bot sirve tu chat privado.",
  'version.report':
    '*TelegramCode {bot}*\n' +
    'Node: {node}\n' +
    'tmux: {tmux}\n' +
    'claude: {claude}\n' +
    'opencode: {opencode}',
  'version.unknown': '(no disponible)',
  'status.global_header': '📊 *Todos los hilos* ({total}):',
  'status.global_row': '• `{key}` → `{subdir}` · {agent} · {status}',
  'status.global_empty': '📊 Aún no hay hilos.',
  'status.thread_report': 'Estado:\n\nAgente: {agent}\nCarpeta: {subdir}\nSesión: {session}',
  'status.thread_model': 'Modelo: {model}',
  'status.thread_effort': 'Esfuerzo: {effort}',
  'status.thread_started': 'Iniciado: {started}',
  'status.thread_running': 'en ejecución',
  'status.thread_stopped': 'detenido',
  'status.thread_no_agent': 'ninguno (inicia /claude o /opencode)',
  'status.thread_no_binding': '(sin vínculo — WORK_ROOT)',
  'language.status': '🌐 Idioma: {display}',
  'language.set_success': '✅ Idioma establecido en `{locale}` para este chat.',
  'language.auto_success': '✅ Idioma restablecido a automático. Actual: {display}.',
  'language.invalid': '⚠️ La locale `{locale}` no es compatible. Disponibles: {locales}.',

  'agent.ready': '{label} listo en `{subdir}`{argsSuffix}\nEnvía un mensaje:',
  'agent.no_session': 'No hay agente en ejecución. /claude o /opencode para iniciar.',
  'agent.session_ended': '{label}: sesión finalizada',
  'agent.stopped': '{label} detenido',
  'agent.exit_signal_sent': 'Doble Ctrl+C enviado — {label} saliendo',
  'agent.already_active': '{label} ya está en ejecución aquí. Envía un mensaje o /quit.',
  'agent.starting': 'Iniciando {label} en `{subdir}`…',
  'agent.queued_starting': '⏳ {label} aún está iniciando — tu mensaje está en cola y se enviará cuando esté listo.',
  'agent.question_hint': 'ℹ️ Responde con el número de opción (ej. 1) o y/n. También: /up /down para mover, /enter para confirmar, /c para cancelar.',
  'agent.start_failed': 'Error al iniciar {label}: {error}',
  'agent.no_response': '⚠️ El agente aceptó tu solicitud pero no empezó a responder: puede que la sesión esté bloqueada. Vuelve a enviarla o usa /new para una sesión nueva.',
  'agent.question_cancelled_for_prompt': '⚠️ Pregunta anterior cancelada — ejecutando tu nueva solicitud.',
  'agent.question_cancelled_msg_label': '❌ Pregunta cancelada: {header}',
  'agent.login_code_relayed': '🔐 Código de inicio de sesión enviado a Claude — el mensaje con el token se eliminó del historial.',
  'agent.login_url': '🔐 Para iniciar sesión en Claude, abre este enlace, completa el inicio de sesión y pega el código aquí:\n{url}',
  'agent.login_success': '✅ Sesión iniciada en Claude.',
  'agent.login_failed': '⚠️ Error al iniciar sesión en Claude. Ejecuta /login para intentarlo de nuevo.',
  'agent.workingIndicator': '{glyph} trabajando…',
  'terminal.ready': '🖥 Terminal listo en `{subdir}`{argsSuffix}\nCada mensaje se ejecuta como un comando. /c — Ctrl+C, /up /down — historial, /tab — autocompletar, /quit — cerrar.',

  'effort.choose': '⚙️ Effort actual: {current}\nElige un nivel:',
  'effort.current_none': 'no establecido',
  'effort.set_success': '✅ Effort: {level}',
  'effort.invalid_level': '⚠️ Nivel `{level}` inválido. Disponibles: {valid}.',
  'effort.not_available': 'ℹ️ No hay niveles de reasoning effort disponibles para el modelo actual.',
  'effort.not_supported': 'ℹ️ El modelo `{model}` no tiene niveles de reasoning effort.',
  'effort.start_agent_first': 'ℹ️ Nivel guardado. No hay agente en ejecución — se aplicará en el próximo inicio.',
  'effort.cleared_on_model_switch': 'ℹ️ Effort `{level}` eliminado: el nuevo modelo `{model}` no lo soporta.',
  'effort.unsupported_backend': 'El control de effort no es compatible con {label}.',
  'effort.no_session': 'No hay agente en ejecución. Inicia uno con /claude o /opencode.',

  'thinking.live': '•••',
  'thinking.thoughtForSeconds': '💭 pensó durante {seconds}s',
  'thinking.choose': '☁️ Modo de thinking actual: {current}\nElige un modo:',
  'thinking.set_success': '✅ Modo de thinking: {mode}',
  'thinking.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponibles: {valid}.',
  'thinking.mode.minimal': 'mínimo',
  'thinking.mode.short': 'corto',
  'thinking.mode.full': 'completo',

  'toolResults.choose': '🔧 Modo de resultados de herramientas actual: {current}\nElige un modo:',
  'toolResults.set_success': '✅ Modo de resultados de herramientas: {mode}',
  'toolResults.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponibles: {valid}.',
  'toolResults.mode.minimal': 'mínimo',
  'toolResults.mode.short': 'corto',
  'toolResults.mode.full': 'completo',
  'toolResults.truncated_footer': '… (truncado, /tool_results full)',
  'toolResults.activity_status': '🔧 {tool} …',
  'toolResults.activity_fallback': 'herramienta',

  'subagent.status_elapsed': '🤖 sub-agente: {title} · {elapsed}',
  'subagent.panel_fold_status': '🤖 sub-agente trabajando …',
  'subagent.delegating_status': '🤖 Delegando: {title} …',
  'subagent.chunk_prefix': '🤖 ⤷',
  'subagent.fallback_title': 'sub-agente',
  'subagent.choose': '🤖 Modo de sub-agente actual: {current}\nElige un modo:',
  'subagent.set_success': '✅ Modo de sub-agente: {mode}',
  'subagent.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponibles: {valid}.',
  'subagent.mode.minimal': 'mínimo',
  'subagent.mode.short': 'corto',
  'subagent.mode.full': 'completo',

  'verbosity.choose': '🔊 Verbosidad de salida actual: {current}\nElige un nivel:',
  'verbosity.set_success': '✅ Verbosidad de salida: {mode} (thinking, resultados de herramientas, sub-agentes)',
  'verbosity.invalid_mode': '⚠️ Modo `{mode}` inválido. Disponibles: {valid}.',
  'verbosity.custom': 'personalizado (thinking: {thinking} · herramientas: {toolResults} · sub-agentes: {subagent})',
  'verbosity.mode.minimal': 'mínimo',
  'verbosity.mode.short': 'corto',
  'verbosity.mode.full': 'completo',

  'model.saved_for_next_start': 'Modelo guardado: {model} — se aplicará en el próximo inicio de agente.',
  'model.start_agent_first': 'No hay sesión activa. Inicia un agente primero.',

  'rename_session.usage': 'Uso: /rename_session <nuevo título>',
  'rename_session.start_agent_first': 'No hay sesión activa. Inicia un agente primero (/claude o /opencode).',
  'rename_session.unsupported_backend': 'El renombrado de sesión no es compatible con {label}.',
  'rename_session.success': '✅ Sesión renombrada: {title}',
  'rename_session.failed': '⚠️ Error al renombrar la sesión: {reason}',

  'connect.prompt_key': '🔑 Envía la API key para `{provider}` como próximo mensaje. Eliminaré el mensaje con la clave del historial.',
  'connect.empty_key': '❌ La API key está vacía. Envía la clave como próximo mensaje.',
  'connect.invalid_key': '❌ Eso no parece una API key (tiene espacios o caracteres no latinos). Envía solo la key como próximo mensaje, o ejecuta /connect de nuevo.',
  'connect.invalid_provider': '❌ ID de provider inválido `{provider}`. Ejemplo: /connect openai',
  'connect.unsupported_provider': '⚠️ El provider `{provider}` no soporta un inicio de sesión por API key simple mediante este flujo. Usa la UI/CLI de OpenCode para este provider.',
  'connect.unsupported_backend': 'La auth de provider OpenCode no está disponible en este build.',
  'connect.failed': '⚠️ Error al conectar `{provider}`: {reason}',
  'connect.success': '✅ Provider `{provider}` conectado. El servidor OpenCode no fue reiniciado.',
  'connect.cancelled': 'Entrada de API key cancelada.',
  'connect.pick_method': '¿Cómo quieres conectar `{provider}`? Elige un método:',
  'connect.no_methods': '⚠️ No se encontraron métodos de autenticación para `{provider}`.',
  'connect.oauth_device': '🔓 Para conectar `{provider}`: abre {url} e introduce el código `{code}`, luego autoriza. En un servidor, usa el método *headless*. Confirmaré aquí cuando termine.',
  'connect.oauth_url_only': '🔓 Para conectar `{provider}`: abre {url} y completa el inicio de sesión. Confirmaré aquí cuando termine.',
  'connect.oauth_paste': '🔑 Tras autorizar, pega el código aquí como próximo mensaje — lo eliminaré del historial.',
  'connect.oauth_waiting': '⏳ Esperando autorización…',
  'connect.oauth_loopback': '🔑 Tras autorizar, tu navegador intentará abrir una página `localhost` que no cargará — es lo esperado aquí. Copia esa URL de la barra de direcciones y pégala como próximo mensaje (o solo el valor `code`). La eliminaré del historial y completaré el inicio de sesión.',
  'connect.oauth_invalid_reply': '❌ Eso no parece una URL de callback ni un código de autorización. Tras autorizar, pega la URL de callback `localhost` de tu navegador (o el valor `code`).',
  'connect.oauth_callback_no_flow': '⚠️ Eso parece una URL de callback de OAuth, pero aquí no hay ningún inicio de sesión en curso — la eliminé. Ejecuta /connect para empezar de nuevo.',
  'connect.oauth_success': '✅ `{provider}` conectado vía OAuth. Las credenciales del servidor OpenCode se actualizaron.',
  'connect.oauth_failed': '⚠️ El inicio de sesión OAuth para `{provider}` no se completó. Ejecuta /connect de nuevo.',
  'quit_all.none_active': 'No hay agentes en ejecución — nada que detener.',
  'quit_all.summary': '🚪 Detenidos {stopped} de {total} agentes activos.',
  'quit_all.general_only': '`/quit-all` solo está disponible en el topic General.',

  'clearMessages.summary':
    '🗑 Eliminados {deleted} de {total} mensajes. ' +
    'Telegram se niega a eliminar lo anterior a 48 h — el resto permanece en el historial.',
  'clearMessages.no_messages': 'No hay mensajes que eliminar en este hilo.',

  'edited.hint':
    '✏️ No trato los mensajes editados como nueva entrada — envía la corrección como un mensaje separado.',

  'voice.no_api_key':
    'La voz requiere `GROQ_API_KEY` (gratis) o `OPENAI_API_KEY`.',
  'voice.failed': 'Error al transcribir el mensaje de voz.',
  'voice.transcribed': '🎤 {text}',

  'file.too_big':
    '📎 El archivo supera el límite de Bot API ({cap} MB) — no puedo descargarlo. Envía un archivo más pequeño.',
  'file.download_failed': '📎 Error al descargar el archivo. Inténtalo de nuevo.',

  'error.workdir.gone':
    '📁 La carpeta `{subdir}` ya no está en el disco. Ejecuta /bind <newdir>.',
  'error.tg.thread.deleted':
    '⚠️ El hilo fue eliminado en Telegram; vínculo eliminado.',
  'error.tg.thread.closed':
    '🔒 El hilo {key} está cerrado — reábrela en tu cliente de Telegram, o elimínalo por completo.',
  'error.tg.perm.delete':
    '🔐 No puedo eliminar mensajes. Concede al bot `can_delete_messages`.',
  'error.tg.perm.manage_topics':
    '🔐 Falta `can_manage_topics`. Hazme admin del grupo.',
  'error.state.corrupted':
    '⚠️ state.json estaba corrupto; vínculos reiniciados. Vuelve a ejecutar /bind donde haga falta.',
  'error.start_in_general':
    'No se puede iniciar un agente en General — es un topic de servicio. Abre un hilo temático.',

  'cb.access_denied': 'Acceso denegado',
  'cb.bind_only_topical': '/bind solo funciona en hilos temáticos',
  'cb.binding_to': 'Vinculando a {subdir}…',
  'cb.no_active_session': 'Sin sesión activa',
  'cb.model_error': 'Error: {error}',
  'cb.model_set': 'Modelo: {model}',
  'cb.not_supported': 'No compatible con {label}',
  'cb.unknown_agent': 'Agente desconocido',
  'cb.agent_switched': 'Cambiado a {label}',
  'cb.resume_only_topical': 'Resume solo funciona en hilos temáticos',
  'cb.bind_folder_first': 'Vincula primero una carpeta vía /bind',
  'cb.agent_not_running': 'Agente no en ejecución',
  'cb.no_pending_question': 'Sin pregunta pendiente',
  'cb.connect_method_expired': 'Este menú de conexión expiró — ejecuta /connect de nuevo',
  'cb.invalid_option': 'Opción inválida',
  'cb.sent_option': 'Enviado: {option}',
  'cb.effort_set': 'Effort: {level}',
  'cb.effort_error': 'Error: {error}',
  'cb.claudeMode_already': 'Ya activo',
  'cb.claudeMode_switching': 'Cambiando…',
  'claudeMode.pick': '⚙️ Backend de Claude Code — actual: {label}\nElige un backend (el cambio mantiene la misma conversación):',
  'claudeMode.not_claude': "Este topic no está en Claude Code — /claude_mode solo cambia el backend de Claude.",
  'claudeMode.already': 'Ya {label}.',
  'claudeMode.set_idle': '⚙️ Backend de Claude: {label} — se aplicará en el próximo inicio.',
  'claudeMode.switched_resumed': '⚙️ Cambiado a {label} — misma conversación reanudada.',
  'claudeMode.switched_fresh': '⚙️ Cambiado a {label} — nueva sesión iniciada.',
  'cb.thinking_set': 'Thinking: {mode}',
  'cb.thinking_error': 'Error: {error}',
  'cb.toolresults_set': 'Resultados de herramientas: {mode}',
  'cb.toolresults_error': 'Error: {error}',
  'cb.subagent_set': 'Sub-agentes: {mode}',
  'cb.subagent_error': 'Error: {error}',
  'cb.verbosity_set': 'Verbosidad de salida: {mode}',
  'cb.verbosity_error': 'Error: {error}',

  'session.list_header': 'Sesiones para reanudar ({label}):',
  'session.list_footer': 'Envía 1–{max} para reanudar · 0 para salir',
  'session.none': 'No hay sesiones reanudables en esta carpeta.',
  'session.cancelled': 'Cancelado. Selector de sesión cerrado.',
  'session.invalid': 'Número inválido. Introduce un valor de 1 a {max}.',
  'session.resumed': 'Sesión reanudada. Envía tu mensaje:',
  'session.resume_failed': 'Error al reanudar la sesión: {error}',
  'session.expired': 'La lista de sesiones está desactualizada. Ejecuta /sessions de nuevo.',
  'session.load_failed': 'Error al cargar las sesiones.',

  'resume.context_header': '↩️ Reanudado — últimos {count} mensajes:',
  'resume.context_user_label': '👤',
  'resume.context_assistant_label': '🤖',

  'recap.missedCountHeader': '⚠️ {count} mensaje(s) perdido(s) mientras el bot estuvo fuera. Último de la sesión:',
  'recap.restartedFallbackHeader': '🔄 Bot reiniciado. Último de la sesión:',
  'recap.stillWorkingLine': '⏳ El agente sigue trabajando…',

  'trace.onThisThreadReply': '🔎 Trazado activado para este hilo.',
  'trace.offThisThreadReply': '🔎 Trazado desactivado para este hilo.',
  'trace.onAllThreadsReply': '🔎 Trazado activado para TODOS los hilos.',
  'trace.offAllThreadsReply': '🔎 Trazado desactivado en todas partes (el flag «all» y la lista de hilos se han vaciado).',
  'trace.statusReply':
    '🔎 Trace — este hilo: {thisThread}\nTodos los hilos: {allThreads}\nHilos trazados: {count}',
  'trace.statusOnLabel': 'activado',
  'trace.statusOffLabel': 'desactivado',
  'trace.usageHint': 'Uso: /trace on | off | on all | off all | (sin argumento — estado)',

  'timestamps.onReply':
    '🕐 Marcas de tiempo activadas: cada prompt enviado al agente recibe la hora de envío como primera línea (nunca se publica en el topic).',
  'timestamps.offReply': '🕐 Marcas de tiempo desactivadas para este hilo.',
  'timestamps.statusOnReply': '🕐 Marcas de tiempo: activadas para este hilo.',
  'timestamps.statusOffReply': '🕐 Marcas de tiempo: desactivadas para este hilo.',
  'timestamps.usageHint': 'Uso: /timestamps on | off | (sin argumento — estado)',

  'schedule.fired':
    '⏰ Programación «{name}» ({schedule}){missedNote}\n\n{prompt}',
  'schedule.missedNote': ' — perdido a las {time}, recuperando',
  'schedule.pausedUnbound':
    '⏸ Programaciones en pausa: {count} — el topic se desvinculó de su carpeta. /bind las restaurará.',
  'schedule.resumedRebind': '▶️ Programaciones reanudadas: {count} (próxima recalculada desde ahora).',
  'schedule.noAgent':
    '⚠️ No se programó nada — no hay ningún agente activo en este tema, así que una ejecución programada no tendría nada que iniciar. Inicia primero /claude o /opencode.',
  'schedule.forwardPromptTemplate':
    'The user wants to schedule the following. Use the schedule_create / schedule_list / schedule_cancel MCP tools (cron for repeats, one-shot for a single run), translating any time phrasing into the right schedule, then confirm to the user IN SPANISH what you scheduled.\n\nRequest: {text}',
  'schedule.interviewPromptTemplate':
    'The user invoked /schedule with no details. Ask them IN SPANISH what prompt they want scheduled and WHEN (one-time or repeating). Once you have both, create it with the schedule_create MCP tool and confirm IN SPANISH what you scheduled.',

  'apiRetry.transientNotice':
    '⏳ API limitada por tasa — reintentando automáticamente en {minutes} min (intento {attempt}).',
  'apiRetry.usageLimitDelayNotice':
    '🚧 Límite de uso alcanzado — reintentando en {minutes} min (intento {attempt}).',
  'apiRetry.usageLimitResetNotice':
    '🚧 Límite de uso alcanzado — reanudación automática tras reset (~{time}).',
  'apiRetry.resuming': '↻ Reanudando…',
  'apiRetry.giveUp':
    '⚠️ No se pudo reanudar tras {attempts} intentos. Escríbeme cuándo continuar.',
  'apiRetry.continueNudge': 'Continúa desde donde te detuviste.',
  'apiRetry.loggedOutClaude':
    '⚠️ Claude está desconectado — ejecuta /login para continuar.',
  'apiRetry.loggedOutOpenCode':
    '⚠️ OpenCode: credenciales inválidas — reinicia el servidor opencode.',

  // ── startup readiness status (boot-time owner notice) ──
  'startup.ready':
    '✅ Listo — puedo procesar mensajes en los hilos del bot y los temas de grupo.',
  'startup.header_not_ready':
    '⚠️ Configuración incompleta. Para empezar a trabajar conmigo, completa estos pasos:',
  'startup.item.create_group':
    'Crea un supergrupo de foro con los Temas activados y envíame un mensaje allí para vincularlo.',
  'startup.item.grant_admin':
    'Hazme administrador con estos permisos: {missing}.',
  'startup.item.bind_topic':
    'Crea un tema y vincúlalo a una carpeta con /bind.',
  'startup.item.install_agent':
    'Instala una CLI de agente — claude u opencode.',
  'startup.item.optional_groq':
    '(opcional) Añade GROQ_API_KEY a tu .env y reinicia para habilitar la entrada de voz.',
  'startup.item.optional_owner':
    '(opcional) Configura OWNER_USER_ID para recibir este estado en tu chat privado.',
};
